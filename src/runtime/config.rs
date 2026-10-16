use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
    sync::OnceLock,
};

use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Request {
    pub version: u32,
    pub cwd: PathBuf,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default = "empty_object")]
    pub overrides: Value,
    pub node_executable: Option<String>,
    pub bridge_module: Option<String>,
}

fn empty_object() -> Value {
    json!({})
}

pub(super) struct Config {
    pub cwd: PathBuf,
    pub options: Value,
    pub concurrency: usize,
    pub command: String,
    pub runner: Runner,
    pub node_executable: Option<PathBuf>,
    pub bridge_module: Option<PathBuf>,
    pub modules: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Runner {
    Command,
    Sdk(SdkRunner),
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum SdkRunner {
    Mocha,
    Vitest,
}

impl Runner {
    pub fn sdk(self) -> Option<SdkRunner> {
        match self {
            Self::Command => None,
            Self::Sdk(runner) => Some(runner),
        }
    }
}

impl SdkRunner {
    pub fn name(self) -> &'static str {
        match self {
            Self::Mocha => "mocha",
            Self::Vitest => "vitest",
        }
    }

    pub fn module(self) -> &'static str {
        match self {
            Self::Mocha => "@stryker-mutator/mocha-runner",
            Self::Vitest => "@stryker-mutator/vitest-runner",
        }
    }

    fn option_key(self) -> &'static str {
        match self {
            Self::Mocha => "mochaOptions",
            Self::Vitest => "vitest",
        }
    }

    pub fn schema(self) -> Value {
        serde_json::from_str(match self {
            Self::Mocha => include_str!("mocha-schema.json"),
            Self::Vitest => include_str!("vitest-schema.json"),
        })
        .expect("pinned SDK runner schema")
    }
}

pub(super) fn defaults() -> Value {
    serde_json::from_str(include_str!("defaults.json"))
        .expect("bundled Stryker defaults are valid JSON")
}

/// Keep filesystem identities compatible with Node's ordinary drive paths.
/// Dunce preserves verbatim paths when stripping their prefix would change
/// their meaning; reject those instead of silently disagreeing with Node cwd.
pub(super) fn canonicalize(path: &Path) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let path = dunce::canonicalize(path).map_err(|error| error.to_string())?;
        if !matches!(path.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), std::path::Prefix::Disk(_)))
        {
            return Err(
                "Native Windows project and sandbox paths require a compatible absolute drive path"
                    .into(),
            );
        }
        Ok(path)
    }
    #[cfg(not(windows))]
    {
        fs::canonicalize(path).map_err(|error| error.to_string())
    }
}

pub(super) fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Include mount-point junctions and other reparse tags, not just symlinks.
        metadata.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

pub(super) fn relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(format!(
            "Native command runtime requires a relative project path: {value}"
        ));
    }
    Ok(path.to_path_buf())
}

fn owned_output_path(cwd: &Path, value: &str) -> Result<(), String> {
    let mut path = cwd.to_path_buf();
    for component in relative_path(value)?.components() {
        path.push(component);
        if fs::symlink_metadata(&path).is_ok_and(|metadata| is_link(&metadata)) {
            return Err(format!(
                "Native output paths cannot traverse project symlinks: {value}"
            ));
        }
    }
    Ok(())
}

fn report_output_path(cwd: &Path, value: &str) -> Result<(), String> {
    let path = Path::new(value);
    #[cfg(windows)]
    let path = dunce::simplified(path);
    if !path.is_absolute() {
        return owned_output_path(cwd, value);
    }
    if path.file_name().is_none() || path.components().any(|part| !normal_report_component(part)) {
        return Err(format!(
            "Native JSON report path must be normalized: {value}"
        ));
    }
    for ancestor in path.ancestors() {
        if fs::symlink_metadata(ancestor).is_ok_and(|metadata| is_link(&metadata)) {
            return Err(format!(
                "Native output paths cannot traverse symlinks: {value}"
            ));
        }
    }
    Ok(())
}

fn normal_report_component(component: Component<'_>) -> bool {
    #[cfg(windows)]
    if let Component::Prefix(prefix) = component {
        return matches!(
            prefix.kind(),
            std::path::Prefix::Disk(_) | std::path::Prefix::UNC(_, _)
        );
    }
    matches!(component, Component::RootDir | Component::Normal(_))
}

/// Ordered writes to the shallow caller copy. Paths identify current targets;
/// replay never substitutes existing records, including detached export children.
#[derive(Default)]
pub(super) struct Effects {
    enabled: bool,
    operations: Vec<Value>,
    null_prototypes: HashSet<Vec<String>>,
}
impl Effects {
    pub fn capture(paths: Vec<Vec<String>>) -> Self {
        Self {
            enabled: true,
            null_prototypes: paths.into_iter().collect(),
            ..Self::default()
        }
    }
    fn replaced(&mut self, path: &[String], key: &str) {
        let mut prefix = path.to_vec();
        prefix.push(key.into());
        self.null_prototypes
            .retain(|candidate| !candidate.starts_with(&prefix));
    }
    fn set(&mut self, path: &[String], key: &str, value: &Value) {
        self.replaced(path, key);
        if self.enabled {
            self.operations
                .push(json!({"kind":"set","path":path,"key":key,"value":value}));
        }
    }
    fn delete(&mut self, path: &[String], key: &str) {
        self.replaced(path, key);
        if self.enabled {
            self.operations
                .push(json!({"kind":"delete","path":path,"key":key}));
        }
    }
    pub fn response(&self) -> String {
        json!({"version":1,"operations":self.operations}).to_string()
    }
}
fn set_property(
    target: &mut Value,
    path: &[String],
    key: &str,
    value: Value,
    effects: &mut Effects,
) {
    effects.set(path, key, &value);
    target
        .as_object_mut()
        .expect("validated record")
        .insert(key.into(), value);
}
fn delete_property(target: &mut Value, path: &[String], key: &str, effects: &mut Effects) {
    effects.delete(path, key);
    target
        .as_object_mut()
        .expect("validated record")
        .shift_remove(key);
}

// Pinned util/deep-merge.js is asymmetric: an array replacing an object
// contributes numeric keys; null recursions throw rather than replacing.
fn merge(target: &mut Value, source: &Value) -> Result<(), String> {
    merge_effects(target, source, &mut Vec::new(), &mut Effects::default())
}
fn merge_effects(
    target: &mut Value,
    source: &Value,
    path: &mut Vec<String>,
    effects: &mut Effects,
) -> Result<(), String> {
    let entries: Vec<(String, Value)> = match source {
        Value::Object(object) => object.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        Value::Array(array) => array
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect(),
        Value::Null => {
            return Err("Cannot convert undefined or null to object during option merge".into());
        }
        _ => return Err("Unsupported primitive option merge".into()),
    };
    for (key, value) in entries {
        if key == "__proto__" {
            continue;
        }
        let object = target
            .as_object_mut()
            .ok_or("Cannot merge options into null")?;
        if let Some(existing) = object.get_mut(&key)
            && (existing.is_object() || existing.is_null())
            && (value.is_object() || value.is_array() || value.is_null())
        {
            path.push(key.clone());
            let result = merge_effects(existing, &value, path, effects);
            path.pop();
            result?;
        } else {
            effects.set(path, &key, &value);
            object.insert(key, value);
        }
    }
    Ok(())
}

// JS object enumeration puts canonical array indices first, even when a merge
// inserted them after string properties. serde_json preserve_order alone does
// not reproduce this rule (notably object <- array merges).
fn normalize_key_order(value: &mut Value) {
    fn index(key: &str) -> Option<u32> {
        key.parse::<u32>()
            .ok()
            .filter(|value| *value != u32::MAX && value.to_string() == key)
    }
    match value {
        Value::Object(object) => {
            for child in object.values_mut() {
                normalize_key_order(child);
            }
            let mut entries = std::mem::take(object).into_iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| match (index(left), index(right)) {
                (Some(left), Some(right)) => left.cmp(&right),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            });
            object.extend(entries);
        }
        Value::Array(array) => array.iter_mut().for_each(normalize_key_order),
        _ => {}
    }
}

fn cli(args: &[String]) -> Result<Value, String> {
    let mut result = json!({});
    let mut index = 0;
    while index < args.len() {
        let argument = &args[index];
        if !argument.starts_with('-') {
            if result.get("configFile").is_some() {
                return Err("Only one configuration file is supported".into());
            }
            result["configFile"] = argument.clone().into();
            index += 1;
            continue;
        }
        let (flag, inline) = argument
            .split_once('=')
            .map_or((argument.as_str(), None), |(key, value)| (key, Some(value)));
        let key = match flag {
            "-m" => "mutate",
            "-c" => "concurrency",
            "-t" => "testFiles",
            "-b" => "buildCommand",
            _ => flag
                .strip_prefix("--")
                .ok_or_else(|| format!("Unsupported run argument: {flag}"))?,
        };
        let boolean = matches!(
            key,
            "dryRunOnly"
                | "incremental"
                | "force"
                | "ignoreStatic"
                | "disableBail"
                | "allowEmpty"
                | "inPlace"
        );
        let raw = if boolean && inline.is_none() {
            "true".to_owned()
        } else if let Some(value) = inline {
            value.to_owned()
        } else {
            index += 1;
            args.get(index)
                .ok_or_else(|| format!("Missing value for {flag}"))?
                .clone()
        };
        let value = match key {
            "mutate" | "testFiles" | "plugins" | "appendPlugins" | "reporters" | "checkers"
            | "ignorePatterns" => Value::Array(if raw.is_empty() {
                vec![]
            } else {
                raw.split(',')
                    .map(|part| Value::String(part.trim().into()))
                    .collect()
            }),
            "checkerNodeArgs" | "testRunnerNodeArgs" => {
                Value::Array(raw.split_whitespace().map(|part| part.into()).collect())
            }
            "timeoutMS"
            | "timeoutFactor"
            | "dryRunTimeoutMinutes"
            | "maxConcurrentTestRunners"
            | "maxTestRunnerReuse" => serde_json::from_str::<Value>(&raw)
                .ok()
                .filter(Value::is_number)
                .ok_or_else(|| format!("Invalid number for {flag}"))?,
            "concurrency" if !raw.ends_with('%') => serde_json::from_str::<Value>(&raw)
                .ok()
                .filter(Value::is_number)
                .ok_or("Invalid concurrency")?,
            "dryRunOnly" | "incremental" | "force" | "ignoreStatic" | "disableBail"
            | "allowEmpty" | "inPlace" | "allowConsoleColors" | "symlinkNodeModules" => {
                match raw.as_str() {
                    "true" => true.into(),
                    "false" => false.into(),
                    _ => return Err(format!("Invalid boolean for {flag}")),
                }
            }
            "cleanTempDir" => match raw.as_str() {
                "true" => true.into(),
                "false" => false.into(),
                "always" => "always".into(),
                _ => return Err("Invalid cleanTempDir".into()),
            },
            "concurrency" | "testRunner" | "coverageAnalysis" | "configFile" | "logLevel"
            | "fileLogLevel" | "tempDirName" | "incrementalFile" | "buildCommand" => raw.into(),
            _ => return Err(format!("Unsupported run argument: {flag}")),
        };
        result[key] = value;
        index += 1;
    }
    Ok(result)
}

pub(super) struct Discovered {
    pub request: Request,
    pub cwd: PathBuf,
    arguments: Value,
    pub executable: Option<(String, PathBuf)>,
    supplied: Option<Value>,
}

fn accessible(path: &Path) -> Result<bool, String> {
    // Like fs.access(F_OK), follow links and accept directories. Only ENOENT
    // continues discovery; permission and non-directory errors are failures.
    match fs::metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "Cannot access configuration {}: {error}",
            path.display()
        )),
    }
}

pub(super) fn discover(request: Request) -> Result<Discovered, String> {
    if request.version != 1 {
        return Err("Unsupported native runtime request version".into());
    }
    if !cfg!(any(unix, windows)) {
        return Err("Native process containment is unsupported on this platform".into());
    }
    if !request.cwd.is_absolute() || !request.cwd.is_dir() {
        return Err("cwd must be an existing absolute project directory".into());
    }
    if !request.overrides.is_object() {
        return Err("overrides must be a JSON object".into());
    }
    // These are compatibility metadata, not alternate command coordinators.
    for path in [&request.node_executable, &request.bridge_module]
        .into_iter()
        .flatten()
    {
        if !Path::new(path).is_absolute() {
            return Err("Compatibility executable/module paths must be absolute".into());
        }
    }
    let cwd = canonicalize(&request.cwd)?;
    let mut arguments = cli(&request.args)?;
    merge(&mut arguments, &request.overrides)?;
    let config_file = if let Some(path) = arguments.get("configFile").and_then(Value::as_str) {
        if path.is_empty() || !accessible(&cwd.join(path))? {
            return Err(format!(
                "Invalid config file \"{path}\". File does not exist!"
            ));
        }
        Some(PathBuf::from(path))
    } else {
        let mut found = None;
        'discovery: for prefix in ["", "."] {
            for suffix in [".conf", ".config"] {
                for extension in ["json", "js", "mjs", "cjs"] {
                    let name = format!("{prefix}stryker{suffix}.{extension}");
                    if accessible(&cwd.join(&name))? {
                        found = Some(name.into());
                        break 'discovery;
                    }
                }
            }
        }
        found
    };
    let (supplied, executable) = if let Some(path) = config_file {
        if path
            .extension()
            .and_then(|part| part.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
        {
            let bytes = fs::read(cwd.join(&path))
                .map_err(|error| format!("Cannot read configuration: {error}"))?;
            let value = serde_json::from_slice::<Value>(&bytes).map_err(|error| {
                format!(
                    "Invalid config file \"{}\". File contains invalid JSON: {error}",
                    path.display()
                )
            })?;
            (Some(value), None)
        } else {
            (
                None,
                Some((path.to_string_lossy().into_owned(), cwd.join(&path))),
            )
        }
    } else {
        (Some(json!({})), None)
    };
    Ok(Discovered {
        request,
        cwd,
        arguments,
        supplied,
        executable,
    })
}

pub(super) fn prepare(request: Request) -> Result<Config, String> {
    let discovered = discover(request)?;
    if discovered.executable.is_some() {
        return Err("Executable configuration requires the caller preparation handshake".into());
    }
    finish(discovered, None)
}

pub(super) fn finish(discovered: Discovered, imported: Option<Value>) -> Result<Config, String> {
    finish_effects(discovered, imported, &mut Effects::default())
}

pub(super) fn finish_effects(
    discovered: Discovered,
    imported: Option<Value>,
    effects: &mut Effects,
) -> Result<Config, String> {
    let Discovered {
        request,
        cwd,
        arguments,
        supplied,
        ..
    } = discovered;
    let mut supplied = imported
        .or(supplied)
        .ok_or("Executable configuration was not supplied")?;
    if !supplied.is_object() {
        return Err("Configuration must be a JSON object".into());
    }
    merge_effects(&mut supplied, &arguments, &mut Vec::new(), effects)?;
    normalize_key_order(&mut supplied);
    remove_deprecated(&mut supplied, effects)?;
    let schema: Value =
        serde_json::from_str(include_str!("schema.json")).expect("bundled schema is valid JSON");
    let mut options = supplied;
    apply_defaults_effects(&mut options, &schema, &schema, 0, &mut Vec::new(), effects)?;
    // JSON.parse and CLI numeric parsing accept -0. Preserve that accepted
    // configuration while passing canonical zero to the finite-number planner.
    for key in ["timeoutMS", "timeoutFactor", "dryRunTimeoutMinutes"] {
        if options[key]
            .as_f64()
            .is_some_and(|value| value == 0.0 && value.is_sign_negative())
        {
            options[key] = 0.into();
        }
    }
    static VALIDATOR: OnceLock<jsonschema::Validator> = OnceLock::new();
    let validator = VALIDATOR.get_or_init(|| {
        jsonschema::validator_for(
            &serde_json::from_str::<Value>(include_str!("schema.json")).expect("schema JSON"),
        )
        .expect("bundled schema compiles")
    });
    validator
        .validate(&options)
        .map_err(|error| format!("Invalid Stryker options: {error}"))?;
    custom_validation(&mut options, effects)?;
    finalize(
        cwd,
        options,
        request.node_executable.map(PathBuf::from),
        request.bridge_module.map(PathBuf::from),
    )
}

pub(super) fn refresh(config: Config) -> Result<Config, String> {
    finalize(
        config.cwd,
        config.options,
        config.node_executable,
        config.bridge_module,
    )
}
fn finalize(
    cwd: PathBuf,
    options: Value,
    node_executable: Option<PathBuf>,
    bridge_module: Option<PathBuf>,
) -> Result<Config, String> {
    let schema: Value = serde_json::from_str(include_str!("schema.json")).expect("pinned schema");
    let runner = match options["testRunner"]
        .as_str()
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("command") => Runner::Command,
        Some("mocha") => Runner::Sdk(SdkRunner::Mocha),
        Some("vitest") => Runner::Sdk(SdkRunner::Vitest),
        _ => {
            return Err(
                "Native runtime currently supports only command, Mocha and Vitest test runners"
                    .into(),
            );
        }
    };
    for key in options.as_object().expect("object").keys() {
        if schema["properties"].get(key).is_none()
            && !runner
                .sdk()
                .is_some_and(|runner| key == runner.option_key())
            && !matches!(key.as_str(), "$schema" | "configFile")
            && !key.ends_with("_comment")
        {
            return Err(format!("Unsupported configuration option: {key}"));
        }
    }
    // Reject unimplemented behavior rather than retaining it only in the report.
    let original = defaults();
    for key in [
        "buildCommand",
        "incremental",
        "inPlace",
        "dryRunOnly",
        "fileLogLevel",
        "maxConcurrentTestRunners",
        "packageManager",
    ] {
        if options.get(key) != original.get(key) {
            return Err(format!("Unsupported native command option: {key}"));
        }
    }
    if runner == Runner::Command && options["coverageAnalysis"] != "off" {
        return Err("Native command runtime requires coverageAnalysis: off".into());
    }
    for key in [
        "appendPlugins",
        "checkers",
        "checkerNodeArgs",
        "testRunnerNodeArgs",
        "ignorers",
    ] {
        if !options[key].as_array().is_some_and(Vec::is_empty) {
            return Err(format!(
                "Native command runtime requires an empty {key} list"
            ));
        }
    }
    if runner == Runner::Command {
        for key in ["plugins", "testFiles"] {
            if !options[key].as_array().is_some_and(Vec::is_empty) {
                return Err(format!(
                    "Native command runtime requires an empty {key} list"
                ));
            }
        }
        if options["maxTestRunnerReuse"] != original["maxTestRunnerReuse"] {
            return Err("Unsupported native command option: maxTestRunnerReuse".into());
        }
    } else if let Some(runner) = runner.sdk() {
        if options["plugins"] != json!([runner.module()]) {
            return Err(format!(
                "Native {} currently requires only the explicit {} plugin",
                runner.name(),
                runner.module()
            ));
        }
        if node_executable.is_none() || bridge_module.is_none() {
            return Err("Native SDK runner requires nodeExecutable and bridgeModule".into());
        }
        if options["maxTestRunnerReuse"].as_u64().is_none() {
            return Err("maxTestRunnerReuse must be a nonnegative integer".into());
        }
    }
    if options["reporters"]
        .as_array()
        .expect("validated reporters")
        .iter()
        .any(|name| name != "json")
    {
        return Err(
            "Native command runtime supports only the built-in json reporter or no reporters"
                .into(),
        );
    }
    owned_output_path(
        &cwd,
        options["tempDirName"]
            .as_str()
            .expect("validated temp directory"),
    )?;
    report_output_path(
        &cwd,
        options["jsonReporter"]["fileName"]
            .as_str()
            .expect("validated JSON report path"),
    )?;
    let cpus = std::thread::available_parallelism().map_or(1, usize::from);
    let concurrency = match options.get("concurrency") {
        None => {
            if cpus > 4 {
                cpus - 1
            } else {
                cpus
            }
        }
        Some(Value::String(value)) => ((cpus as f64
            * value
                .trim_end_matches('%')
                .parse::<f64>()
                .map_err(|_| "Invalid concurrency")?
            / 100.0)
            .round() as usize)
            .max(1),
        Some(value) => value
            .as_u64()
            .filter(|value| *value > 0 && *value <= 4096)
            .ok_or("Concurrency must be an integer from 1 through 4096")?
            as usize,
    };
    for key in ["timeoutMS", "timeoutFactor", "dryRunTimeoutMinutes"] {
        let value = options[key]
            .as_f64()
            .ok_or_else(|| format!("Invalid {key}"))?;
        if !value.is_finite() || value < 0.0 || value > 86_400_000.0 {
            return Err(format!(
                "{key} is outside the supported finite deadline range"
            ));
        }
    }
    if options["thresholds"]["low"].as_f64() > options["thresholds"]["high"].as_f64() {
        return Err("thresholds.low must not exceed thresholds.high".into());
    }
    let command = options["commandRunner"]["command"]
        .as_str()
        .expect("validated command")
        .to_owned();
    if command.contains('\0') {
        return Err("Command contains a NUL byte".into());
    }
    let modules = options["plugins"]
        .as_array()
        .expect("validated plugins")
        .iter()
        .map(|module| module.as_str().expect("plugin string").to_owned())
        .collect();
    Ok(Config {
        cwd,
        options,
        concurrency,
        command,
        runner,
        node_executable,
        bridge_module,
        modules,
    })
}

pub(super) fn normalize_plugin_options(
    config: &mut Config,
    core_schema: &Value,
    contributions: &[Value],
) -> Result<(), String> {
    normalize_plugin_effects(config, core_schema, contributions, &mut Effects::default())
}

pub(super) fn normalize_plugin_effects(
    config: &mut Config,
    core_schema: &Value,
    contributions: &[Value],
    effects: &mut Effects,
) -> Result<(), String> {
    let mut schema: Value =
        serde_json::from_str(include_str!("schema.json")).expect("bundled schema JSON");
    if &schema != core_schema {
        return Err("Compatibility SDK core schema differs from pinned 10.0.0".into());
    }
    for contribution in contributions {
        for key in ["properties", "definitions"] {
            if let Some(values) = contribution.get(key) {
                let values = values
                    .as_object()
                    .ok_or("Plugin schema properties/definitions must be JSON objects")?;
                schema[key]
                    .as_object_mut()
                    .ok_or("Invalid core schema object")?
                    .extend(values.clone());
            }
        }
    }
    remove_deprecated(&mut config.options, effects)?;
    apply_defaults_effects(
        &mut config.options,
        &schema,
        &schema,
        0,
        &mut Vec::new(),
        effects,
    )?;
    let validator = jsonschema::validator_for(&schema)
        .map_err(|error| format!("Invalid plugin validation schema: {error}"))?;
    validator
        .validate(&config.options)
        .map_err(|error| format!("Invalid plugin options: {error}"))?;
    custom_validation(&mut config.options, effects)?;
    Ok(())
}

#[cfg(test)]
pub(super) fn apply_schema_defaults(
    value: &mut Value,
    rule: &Value,
    root: &Value,
    depth: usize,
) -> Result<(), String> {
    apply_defaults_effects(
        value,
        rule,
        root,
        depth,
        &mut Vec::new(),
        &mut Effects::default(),
    )
}
fn apply_defaults_effects(
    value: &mut Value,
    rule: &Value,
    root: &Value,
    depth: usize,
    path: &mut Vec<String>,
    effects: &mut Effects,
) -> Result<(), String> {
    if depth > 128 {
        return Err("Plugin schema default recursion exceeds the supported limit".into());
    }
    if let Some(reference) = rule["$ref"].as_str() {
        let referenced = reference
            .strip_prefix('#')
            .and_then(|path| root.pointer(path))
            .ok_or("Plugin schema defaults require local references")?;
        return apply_defaults_effects(value, referenced, root, depth + 1, path, effects);
    }
    if let Some(object) = value.as_object_mut()
        && let Some(properties) = rule["properties"].as_object()
    {
        // Pinned Ajv emits all defaults at this object level before validating
        // children. allErrors keeps visiting later fields on validation failure.
        for (key, property) in properties {
            if !object.contains_key(key)
                && let Some(default) = property.get("default")
            {
                effects.set(path, key, default);
                object.insert(key.clone(), default.clone());
            }
        }
        for (key, property) in properties {
            if let Some(child) = object.get_mut(key) {
                path.push(key.clone());
                let result =
                    apply_defaults_effects(child, property, root, depth + 1, path, effects);
                path.pop();
                result?;
            }
        }
    }
    if let Some(values) = value.as_array_mut()
        && let Some(items) = rule.get("items")
    {
        for (index, child) in values.iter_mut().enumerate() {
            path.push(index.to_string());
            let result = apply_defaults_effects(child, items, root, depth + 1, path, effects);
            path.pop();
            result?;
        }
    }
    if let Some(rules) = rule["allOf"].as_array() {
        for rule in rules {
            apply_defaults_effects(value, rule, root, depth + 1, path, effects)?;
        }
    }
    Ok(())
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}
fn data_string(value: &Value, path: &mut Vec<String>, effects: &Effects) -> Result<String, String> {
    use oxc_syntax::number::ToJsString;
    match value {
        Value::Null => Ok("null".into()),
        Value::Bool(value) => Ok(value.to_string()),
        Value::String(value) => Ok(value.clone()),
        Value::Number(value) => Ok(value.as_f64().expect("JSON number").to_js_string()),
        Value::Object(object) => {
            if effects.null_prototypes.contains(path) || object.contains_key("toString") {
                Err("Cannot convert object to primitive value".into())
            } else {
                Ok("[object Object]".into())
            }
        }
        Value::Array(values) => {
            let mut parts = Vec::with_capacity(values.len());
            for (index, value) in values.iter().enumerate() {
                if value.is_null() {
                    parts.push(String::new());
                    continue;
                }
                path.push(index.to_string());
                let result = data_string(value, path, effects);
                path.pop();
                parts.push(result?);
            }
            Ok(parts.join(","))
        }
    }
}
// Deliberately model ordinary Windows paths and bare drives only. Namespace,
// UNC and other drive-relative/colon forms need a separate path contract.
#[cfg(any(windows, test))]
fn windows_legacy_html_base(value: &str) -> Result<Option<String>, String> {
    let bytes = value.as_bytes();
    let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if drive && bytes.len() == 2 {
        // Node joins with a separator; Rust Path::push intentionally omits it.
        return Ok(Some(format!(r"{value}\index.html")));
    }
    let separator = |byte: u8| matches!(byte, b'/' | b'\\');
    if (bytes.len() >= 2 && separator(bytes[0]) && separator(bytes[1]))
        || (drive && !separator(bytes[2]))
        || value[if drive { 2 } else { 0 }..].contains(':')
        || value.contains('\0')
    {
        return Err("Unsupported executable configuration capability: Windows htmlReporter.baseDir requires an ordinary relative/rooted path, absolute drive path or bare drive".into());
    }
    Ok(None)
}
fn legacy_html_path(value: &str) -> Result<String, String> {
    #[cfg(windows)]
    if let Some(path) = windows_legacy_html_base(value)? {
        return Ok(path);
    }
    let joined = Path::new(value).join("index.html");
    let mut result = PathBuf::new();
    for part in joined.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir if result.file_name().is_some_and(|name| name != "..") => {
                result.pop();
            }
            Component::ParentDir if result.has_root() => {}
            _ => result.push(part.as_os_str()),
        }
    }
    Ok(result.to_string_lossy().into_owned())
}
fn remove_deprecated(options: &mut Value, effects: &mut Effects) -> Result<(), String> {
    if options.get("mutator").is_some_and(Value::is_string) {
        delete_property(options, &[], "mutator", effects);
    }
    if options.get("mutator").is_some_and(Value::is_null) {
        return Err("Cannot read properties of null (reading 'name')".into());
    }
    if options.get("mutator").is_some_and(Value::is_object) && truthy(&options["mutator"]["name"]) {
        delete_property(
            &mut options["mutator"],
            &["mutator".into()],
            "name",
            effects,
        );
    }
    if options.get("testFramework").is_some() {
        delete_property(options, &[], "testFramework", effects);
    }
    if options.get("transpilers").is_some_and(Value::is_array) {
        delete_property(options, &[], "transpilers", effects);
    }
    if let Some(files) = options.get("files").and_then(Value::as_array) {
        let mut patterns = vec![Value::from("**")];
        patterns.extend(files.iter().filter_map(Value::as_str).map(|file| {
            Value::from(
                file.strip_prefix('!')
                    .map_or_else(|| format!("!{file}"), str::to_owned),
            )
        }));
        patterns.extend(
            options["ignorePatterns"]
                .as_array()
                .into_iter()
                .flatten()
                .cloned(),
        );
        delete_property(options, &[], "files", effects);
        set_property(
            options,
            &[],
            "ignorePatterns",
            Value::Array(patterns),
            effects,
        );
    }
    if let Some(enable) = options
        .get("jest")
        .and_then(|value| value.get("enableBail"))
    {
        let disable = !truthy(enable);
        set_property(options, &[], "disableBail", Value::Bool(disable), effects);
        delete_property(
            &mut options["jest"],
            &["jest".into()],
            "enableBail",
            effects,
        );
    }
    if truthy(&options["htmlReporter"]["baseDir"]) {
        if !truthy(&options["htmlReporter"]["fileName"]) {
            let base = data_string(
                &options["htmlReporter"]["baseDir"],
                &mut vec!["htmlReporter".into(), "baseDir".into()],
                effects,
            )?;
            set_property(
                &mut options["htmlReporter"],
                &["htmlReporter".into()],
                "fileName",
                legacy_html_path(&base)?.into(),
                effects,
            );
        }
        delete_property(
            &mut options["htmlReporter"],
            &["htmlReporter".into()],
            "baseDir",
            effects,
        );
    }
    Ok(())
}
fn custom_validation(options: &mut Value, effects: &mut Effects) -> Result<(), String> {
    let cpus = std::thread::available_parallelism().map_or(1, usize::from);
    if options["maxConcurrentTestRunners"]
        .as_f64()
        .is_some_and(|value| {
            value != 9_007_199_254_740_991.0 && value < cpus.saturating_sub(1) as f64
        })
        && !options.get("concurrency").is_some_and(truthy)
    {
        set_property(
            options,
            &[],
            "concurrency",
            options["maxConcurrentTestRunners"].clone(),
            effects,
        );
    }
    if options["thresholds"]["low"].as_f64() > options["thresholds"]["high"].as_f64() {
        return Err("thresholds.low must not exceed thresholds.high".into());
    }
    if options["ignoreStatic"] == true && options["coverageAnalysis"] != "perTest" {
        return Err("Config option ignoreStatic requires coverageAnalysis to be perTest".into());
    }
    Ok(())
}

#[cfg(test)]
mod handshake_tests {
    use super::*;

    #[test]
    fn windows_legacy_html_paths_match_bare_drive_oracle_and_reject_unmodeled_forms() {
        let cases: Value =
            serde_json::from_str(include_str!("../../test/fixtures/windows-html-paths.json"))
                .unwrap();
        for case in cases.as_array().unwrap() {
            let base = case["base"].as_str().unwrap();
            let narrow = windows_legacy_html_base(base).unwrap();
            if case["bare"] == true {
                assert_eq!(narrow.as_deref(), case["joined"].as_str());
            } else {
                assert!(narrow.is_none());
            }
            #[cfg(windows)]
            assert_eq!(
                legacy_html_path(base).unwrap(),
                case["joined"].as_str().unwrap()
            );
        }
        for base in [
            r"C:logs",
            r"C:..",
            r"\\server\share",
            r"\\?\C:\logs",
            r"//server",
            r"logs:stream",
            r"1:",
            "bad\0path",
        ] {
            assert!(windows_legacy_html_base(base).is_err(), "{base}");
        }
    }

    #[test]
    fn pinned_merge_is_asymmetric_and_preserves_order() {
        let mut target = json!({"z":true,"value":{"first":1},"array":[1],"a":0});
        merge(
            &mut target,
            &json!({"value":[2,3],"array":{"key":4},"new":null,"__proto__":{"bad":true}}),
        )
        .unwrap();
        normalize_key_order(&mut target);
        assert_eq!(target["value"].to_string(), r#"{"0":2,"1":3,"first":1}"#);
        assert_eq!(target["array"], json!({"key":4}));
        assert_eq!(
            target
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["z", "value", "array", "a", "new"]
        );
        assert!(merge(&mut json!({"value":null}), &json!({"value":{"key":1}})).is_err());
        assert!(merge(&mut json!({"value":{}}), &json!({"value":null})).is_err());
        assert!(merge(&mut json!({"value":null}), &json!({"value":{}})).is_ok());
    }

    #[test]
    fn ordered_effects_survive_partial_merge_and_default_failure() {
        let mut options = json!({"warnings":{},"thresholds":null});
        let mut effects = Effects::capture(vec![]);
        assert!(
            merge_effects(
                &mut options,
                &json!({"warnings":{"slow":false},"thresholds":{"high":95}}),
                &mut Vec::new(),
                &mut effects
            )
            .is_err()
        );
        assert_eq!(
            effects.operations,
            vec![json!({"kind":"set","path":["warnings"],"key":"slow","value":false})]
        );
        let mut options = json!({"thresholds":{"high":95},"htmlReporter":{"baseDir":"reports"}});
        let mut effects = Effects::capture(vec![]);
        remove_deprecated(&mut options, &mut effects).unwrap();
        let schema: Value = serde_json::from_str(include_str!("schema.json")).unwrap();
        apply_defaults_effects(
            &mut options,
            &schema,
            &schema,
            0,
            &mut Vec::new(),
            &mut effects,
        )
        .unwrap();
        assert_eq!(effects.operations[0]["key"], "fileName");
        assert_eq!(effects.operations[1]["kind"], "delete");
        let nested: Vec<_> = effects
            .operations
            .iter()
            .filter(|effect| effect["path"] == json!(["thresholds"]))
            .map(|effect| effect["key"].as_str().unwrap())
            .collect();
        assert_eq!(nested, ["low", "break"]);
    }

    #[test]
    fn schema_defaults_fill_missing_without_merging_null_or_arrays() {
        let schema: Value = serde_json::from_str(include_str!("schema.json")).unwrap();
        let mut options = json!({"thresholds":{"high":90},"warnings":{"slow":false},"plugins":[]});
        apply_schema_defaults(&mut options, &schema, &schema, 0).unwrap();
        assert_eq!(
            options["thresholds"],
            json!({"high":90,"low":60,"break":null})
        );
        assert_eq!(options["warnings"]["slow"], false);
        assert_eq!(options["plugins"], json!([]));
        let mut options = json!({"thresholds":null});
        apply_schema_defaults(&mut options, &schema, &schema, 0).unwrap();
        assert!(options["thresholds"].is_null());
    }
}
