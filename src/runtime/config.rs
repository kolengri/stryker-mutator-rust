use std::{
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
    Mocha,
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

fn merge(target: &mut Value, source: &Value) {
    if let (Some(target), Some(source)) = (target.as_object_mut(), source.as_object()) {
        for (key, value) in source {
            if key == "__proto__" {
                continue;
            }
            if target.get(key).is_some_and(Value::is_object) && value.is_object() {
                merge(target.get_mut(key).expect("key exists"), value);
            } else {
                target.insert(key.clone(), value.clone());
            }
        }
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

pub(super) fn prepare(request: Request) -> Result<Config, String> {
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
    merge(&mut arguments, &request.overrides);
    let config_file = if let Some(path) = arguments.get("configFile") {
        Some(PathBuf::from(
            path.as_str().ok_or("configFile must be a string")?,
        ))
    } else {
        let mut found = None;
        'discovery: for prefix in ["", "."] {
            for suffix in [".conf", ".config"] {
                for extension in ["json", "js", "mjs", "cjs"] {
                    let name = format!("{prefix}stryker{suffix}.{extension}");
                    if cwd.join(&name).is_file() {
                        found = Some(name.into());
                        break 'discovery;
                    }
                }
            }
        }
        found
    };
    let mut supplied = if let Some(path) = config_file {
        if path.extension().and_then(|part| part.to_str()) != Some("json") {
            return Err(
                "Executable configuration requires the JavaScript compatibility bridge".into(),
            );
        }
        serde_json::from_slice::<Value>(
            &fs::read(cwd.join(path))
                .map_err(|error| format!("Cannot read configuration: {error}"))?,
        )
        .map_err(|error| format!("Invalid JSON configuration: {error}"))?
    } else {
        json!({})
    };
    if !supplied.is_object() {
        return Err("Configuration must be a JSON object".into());
    }
    merge(&mut supplied, &arguments);
    let schema: Value =
        serde_json::from_str(include_str!("schema.json")).expect("bundled schema is valid JSON");
    let requested_mocha = supplied["testRunner"]
        .as_str()
        .is_some_and(|value| value.eq_ignore_ascii_case("mocha"));
    for key in supplied.as_object().expect("object").keys() {
        if schema["properties"].get(key).is_none()
            && !(requested_mocha && key == "mochaOptions")
            && !matches!(key.as_str(), "$schema" | "configFile")
            && !key.ends_with("_comment")
        {
            return Err(format!("Unsupported configuration option: {key}"));
        }
    }
    let mut options = defaults();
    merge(&mut options, &supplied);
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
    if options["ignoreStatic"] == true && options["coverageAnalysis"] != "perTest" {
        return Err("Config option ignoreStatic requires coverageAnalysis to be perTest".into());
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
    let runner = match options["testRunner"]
        .as_str()
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("command") => Runner::Command,
        Some("mocha") => Runner::Mocha,
        _ => {
            return Err(
                "Native runtime currently supports only command and Mocha test runners".into(),
            );
        }
    };
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
    } else {
        if options["plugins"] != json!(["@stryker-mutator/mocha-runner"]) {
            return Err("Native Mocha currently requires only the built-in @stryker-mutator/mocha-runner plugin".into());
        }
        if request.node_executable.is_none() || request.bridge_module.is_none() {
            return Err("Native Mocha requires nodeExecutable and bridgeModule".into());
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
        node_executable: request.node_executable.map(PathBuf::from),
        bridge_module: request.bridge_module.map(PathBuf::from),
        modules,
    })
}

pub(super) fn normalize_plugin_options(
    config: &mut Config,
    core_schema: &Value,
    contributions: &[Value],
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
    fn apply(value: &mut Value, rule: &Value, root: &Value, depth: usize) -> Result<(), String> {
        if depth > 128 {
            return Err("Plugin schema default recursion exceeds the supported limit".into());
        }
        if let Some(reference) = rule["$ref"].as_str() {
            let referenced = reference
                .strip_prefix('#')
                .and_then(|path| root.pointer(path))
                .ok_or("Plugin schema defaults require local references")?;
            return apply(value, referenced, root, depth + 1);
        }
        if let Some(object) = value.as_object_mut()
            && let Some(properties) = rule["properties"].as_object()
        {
            for (key, property) in properties {
                if !object.contains_key(key)
                    && let Some(default) = property.get("default")
                {
                    object.insert(key.clone(), default.clone());
                }
                if let Some(value) = object.get_mut(key) {
                    apply(value, property, root, depth + 1)?;
                }
            }
        }
        if let Some(values) = value.as_array_mut()
            && let Some(items) = rule.get("items")
        {
            for value in values {
                apply(value, items, root, depth + 1)?;
            }
        }
        if let Some(rules) = rule["allOf"].as_array() {
            for rule in rules {
                apply(value, rule, root, depth + 1)?;
            }
        }
        Ok(())
    }
    apply(&mut config.options, &schema, &schema, 0)?;
    let validator = jsonschema::validator_for(&schema)
        .map_err(|error| format!("Invalid plugin validation schema: {error}"))?;
    validator
        .validate(&config.options)
        .map_err(|error| format!("Invalid plugin options: {error}"))?;
    Ok(())
}
