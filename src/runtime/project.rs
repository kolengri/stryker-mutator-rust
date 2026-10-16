use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use serde_json::{Value, json};

use super::config::Config;

#[path = "selection.rs"]
mod selection;
use selection::{Ignore, Pattern};
#[cfg(test)]
#[path = "project_tests.rs"]
mod project_tests;
#[path = "tsconfig.rs"]
mod tsconfig;
#[cfg(all(test, windows))]
#[path = "windows_integration_tests.rs"]
mod windows_tests;

pub(super) struct Project {
    pub files: Vec<PathBuf>,
    pub descriptions: Value,
    pub test_files: Vec<PathBuf>,
    pub dependencies: Vec<PathBuf>,
    pub originals: serde_json::Map<String, Value>,
    pub instrumented: Vec<(PathBuf, String)>,
    pub preprocessed: Vec<(PathBuf, String)>,
    pub mutants: Vec<Value>,
}

fn walk(
    root: &Path,
    directory: &Path,
    ignored: &[Ignore],
    project: &mut Project,
) -> Result<(), String> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| format!("Cannot enumerate {}: {error}", directory.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|error| error.to_string())?
            .to_path_buf();
        let name = name(&relative)?;
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        if entry.file_name() == "node_modules" && path.is_dir() {
            project.dependencies.push(relative);
            continue;
        }
        if !selection::included(ignored, &name, kind.is_dir()) {
            continue;
        }
        #[cfg(windows)]
        let reparse = super::config::is_link(
            &fs::symlink_metadata(&path).map_err(|error| error.to_string())?,
        );
        #[cfg(not(windows))]
        let reparse = false;
        if kind.is_symlink() || reparse {
            return Err(format!(
                "Project symlink requires compatibility handling: {name}"
            ));
        }
        if kind.is_dir() {
            walk(root, &path, ignored, project)?;
        } else if kind.is_file() {
            project.files.push(relative);
        } else {
            return Err(format!("Unsupported project entry: {name}"));
        }
    }
    Ok(())
}

pub(super) fn name(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(|name| name.replace(std::path::MAIN_SEPARATOR, "/"))
        .ok_or_else(|| "Non-UTF8 project path requires compatibility handling".into())
}

fn default_match(path: &str) -> bool {
    let mut parts = path.split('/');
    if !matches!(parts.next(), Some("src" | "lib"))
        || path
            .split('/')
            .any(|part| part.starts_with('.') || part == "__tests__")
    {
        return false;
    }
    let file = path.rsplit('/').next().unwrap_or(path);
    let Some((stem, extension)) = file.rsplit_once('.') else {
        return false;
    };
    // The default +(...) extglobs repeat both test prefixes and extension tokens.
    static FILE_PARTS: OnceLock<(regex::Regex, regex::Regex)> = OnceLock::new();
    let (extensions, test_suffix) = FILE_PARTS.get_or_init(|| {
        (
            regex::Regex::new(r"\A(?:cjs|mjs|js|ts|mts|cts|jsx|tsx|html|vue|svelte)+\z")
                .expect("fixed default extension regex"),
            regex::Regex::new(r"\.(?:[sS]+pec|[tT]+est)\z")
                .expect("fixed default test suffix regex"),
        )
    });
    extensions.is_match(extension) && !test_suffix.is_match(stem)
}

struct MutationPattern {
    matcher: Pattern,
    negative: bool,
    range: Option<Value>,
}

impl MutationPattern {
    fn new(value: &str) -> Result<Self, String> {
        let negative = value.starts_with('!');
        let value = value.strip_prefix('!').unwrap_or(value);
        let (path, range) = if let Some((path, value)) = value.split_once(':') {
            if path.contains(['*', '?', '[', '{']) {
                return Err("Cannot combine a glob with a mutation range".into());
            }
            let (start, end) = value.split_once('-').ok_or("Invalid mutation range")?;
            fn position(value: &str, end: bool) -> Result<Value, String> {
                let (line, column) = value
                    .split_once(':')
                    .map_or((value, None), |(line, column)| (line, Some(column)));
                let line: u64 = line.parse().map_err(|_| "Invalid mutation range line")?;
                if line == 0 {
                    return Err("Mutation range lines start at 1".into());
                }
                let column = column
                    .map(str::parse::<u32>)
                    .transpose()
                    .map_err(|_| "Invalid mutation range column")?
                    .unwrap_or(if end { u32::MAX } else { 0 });
                Ok(json!({"line": line - 1, "column": column}))
            }
            let start = position(start, false)?;
            let end = position(end, true)?;
            if (start["line"].as_u64(), start["column"].as_u64())
                > (end["line"].as_u64(), end["column"].as_u64())
            {
                return Err("Mutation range start exceeds its end".into());
            }
            (path, Some(json!({"start":start,"end":end})))
        } else {
            (value, None)
        };
        if Path::new(path).is_absolute() || path.split('/').any(|part| part == "..") {
            return Err("Native mutate paths must stay in the project".into());
        }
        Ok(Self {
            matcher: Pattern::new(path, false)?,
            negative,
            range,
        })
    }
}

pub(super) fn prepare(config: &Config) -> Result<Project, String> {
    fn check_babel(origin: &Path, checked: &mut HashSet<PathBuf>) -> Result<(), String> {
        for directory in origin.ancestors() {
            if !checked.insert(directory.to_path_buf()) {
                break;
            }
            for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name == ".babelignore"
                    || name == ".babelrc"
                    || name.starts_with(".babelrc.")
                    || name.starts_with("babel.config.")
                {
                    return Err(
                        "Ambient Babel configuration requires JavaScript compatibility handling"
                            .into(),
                    );
                }
            }
            if let Ok(bytes) = fs::read(directory.join("package.json"))
                && let Ok(value) = serde_json::from_slice::<Value>(&bytes)
                && value.get("babel").is_some()
            {
                return Err(
                    "Ambient package.json Babel configuration requires compatibility handling"
                        .into(),
                );
            }
        }
        Ok(())
    }
    let mut checked = HashSet::new();
    check_babel(&config.cwd, &mut checked)?;
    let mut ignored = [
        "node_modules",
        ".git",
        "*.tsbuildinfo",
        "/stryker.log",
        ".next",
        ".nuxt",
        ".svelte-kit",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    for key in ["tempDirName", "incrementalFile"] {
        ignored.push(
            config.options[key]
                .as_str()
                .expect("validated path")
                .to_owned(),
        );
    }
    for key in ["htmlReporter", "jsonReporter"] {
        ignored.push(
            config.options[key]["fileName"]
                .as_str()
                .expect("validated path")
                .to_owned(),
        );
    }
    ignored.extend(
        config.options["ignorePatterns"]
            .as_array()
            .expect("validated ignored patterns")
            .iter()
            .map(|value| value.as_str().expect("string").to_owned()),
    );
    let ignored = ignored
        .iter()
        .map(|value| Ignore::new(value))
        .collect::<Result<Vec<_>, _>>()?;
    let defaults = super::config::defaults();
    let use_default = config.options["mutate"] == defaults["mutate"];
    let patterns = if use_default {
        vec![]
    } else {
        config.options["mutate"]
            .as_array()
            .expect("validated mutate")
            .iter()
            .map(|value| MutationPattern::new(value.as_str().expect("string")))
            .collect::<Result<Vec<_>, _>>()?
    };
    let mut project = Project {
        files: vec![],
        descriptions: json!({}),
        test_files: vec![],
        dependencies: vec![],
        originals: serde_json::Map::new(),
        instrumented: vec![],
        preprocessed: vec![],
        mutants: vec![],
    };
    walk(&config.cwd, &config.cwd, &ignored, &mut project)?;
    if project.files.is_empty() {
        return Err("No input files found".into());
    }
    let mut seen_tests = HashSet::new();
    for pattern in config.options["testFiles"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let matcher = selection::file_pattern(
            &config.cwd,
            pattern.as_str().ok_or("Invalid testFiles pattern")?,
        )?;
        for path in &project.files {
            if matcher.matches(&name(&config.cwd.join(path))?, false)
                && seen_tests.insert(path.clone())
            {
                project.test_files.push(path.clone());
            }
        }
    }
    tsconfig::prepare(config, &mut project)?;
    let mut files = vec![];
    for path in &project.files {
        let name = name(path)?;
        let mut selection = Value::Bool(use_default && default_match(&name));
        for pattern in &patterns {
            if pattern.matcher.matches(&name, false) {
                if pattern.negative {
                    selection = false.into();
                } else if let Some(range) = &pattern.range {
                    match &mut selection {
                        Value::Bool(true) => {}
                        Value::Array(ranges) => ranges.push(range.clone()),
                        _ => selection = json!([range]),
                    }
                } else {
                    selection = true.into();
                }
            }
        }
        project
            .descriptions
            .as_object_mut()
            .expect("description object")
            .insert(
                self::name(&config.cwd.join(path))?,
                json!({"mutate":selection.clone()}),
            );
        if selection == false {
            continue;
        }
        check_babel(
            config
                .cwd
                .join(path)
                .parent()
                .ok_or("Source has no parent")?,
            &mut checked,
        )?;
        let content = fs::read_to_string(config.cwd.join(path))
            .map_err(|error| format!("Cannot read mutation source {name}: {error}"))?;
        project
            .originals
            .insert(name.clone(), Value::String(content.clone()));
        files.push(json!({"name": name, "content":content,"mutate": selection}));
    }
    if !files.is_empty() {
        let response = serde_json::to_value(crate::instrument::instrument_batch(
            &json!({"files":files,"options":config.options["mutator"]}).to_string(),
        ))
        .map_err(|error| error.to_string())?;
        if response["supported"] != true {
            return Err(format!(
                "Native instrumentation preflight: {}",
                response["reason"].as_str().unwrap_or("unsupported source")
            ));
        }
        project.instrumented = response["result"]["files"]
            .as_array()
            .ok_or("Missing instrumented files")?
            .iter()
            .map(|file| {
                (
                    PathBuf::from(file["name"].as_str().expect("instrumented file name")),
                    file["content"]
                        .as_str()
                        .expect("instrumented source")
                        .to_owned(),
                )
            })
            .collect();
        project.mutants = response["result"]["mutants"]
            .as_array()
            .ok_or("Missing mutant batch")?
            .clone();
    }
    let disable = &config.options["disableTypeChecks"];
    if disable
        .as_str()
        .is_some_and(|pattern| Path::new(pattern).is_absolute())
    {
        return Err("Absolute disableTypeChecks patterns require compatibility handling".into());
    }
    let matcher = disable
        .as_str()
        .map(|pattern| Pattern::new(pattern, false))
        .transpose()?;
    if disable != false {
        for path in &project.files {
            let name = name(path)?;
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            let matched = matcher.as_ref().map_or(
                matches!(
                    extension,
                    "js" | "ts" | "jsx" | "tsx" | "html" | "vue" | "mjs" | "mts" | "cts" | "cjs"
                ),
                |matcher| matcher.matches(&name, true),
            );
            if !matched {
                continue;
            }
            if matches!(extension, "html" | "vue" | "svelte") {
                return Err(
                    "HTML/Vue/Svelte type-check preprocessing requires compatibility handling"
                        .into(),
                );
            }
            if !matches!(
                extension,
                "js" | "ts" | "jsx" | "tsx" | "mjs" | "mts" | "cts" | "cjs"
            ) {
                continue;
            }
            let content = if let Some((_, content)) =
                project.instrumented.iter().find(|(file, _)| file == path)
            {
                content.clone()
            } else {
                fs::read_to_string(config.cwd.join(path))
                    .map_err(|error| format!("Cannot preprocess {name}: {error}"))?
            };
            project
                .preprocessed
                .push((path.clone(), disable_type_checks(&content, path)));
        }
    }
    Ok(project)
}

fn disable_type_checks(source: &str, path: &Path) -> String {
    let mut content = source.to_owned();
    if source.contains("@ts-") {
        let allocator = oxc_allocator::Allocator::default();
        let source_type = oxc_span::SourceType::from_path(path).unwrap_or_default();
        let parsed = oxc_parser::Parser::new(&allocator, source, source_type).parse();
        // Like upstream's warning-only preprocessor, leave unparsable test input
        // untouched. Source eligibility was already settled by instrumentation.
        if !parsed.diagnostics.is_empty() {
            return content;
        }
        static DIRECTIVE: OnceLock<regex::Regex> = OnceLock::new();
        let directive = DIRECTIVE.get_or_init(|| {
            regex::Regex::new(r"^(\s*)@(ts-[a-z-]+).*$").expect("fixed directive regex")
        });
        let mut ranges = vec![];
        for comment in &parsed.program.comments {
            let span = comment.content_span();
            let value = &source[span.start as usize..span.end as usize];
            if let Some(captures) = directive.captures(value) {
                let start =
                    span.start as usize + captures.get(1).expect("whitespace capture").len();
                ranges.push(start..start + captures.get(2).expect("directive capture").len() + 1);
            }
        }
        for range in ranges.into_iter().rev() {
            content.replace_range(range, "");
        }
    }
    if content.starts_with('#') {
        if let Some(index) = content.find('\n') {
            content.insert_str(index + 1, "// @ts-nocheck\n");
        }
        content
    } else {
        let whitespace = content.len() - content.trim_start().len();
        let insertion = if content[whitespace..].starts_with("/*") {
            content[whitespace + 2..]
                .find("*/")
                .map(|end| whitespace + 2 + end + 2)
        } else {
            None
        };
        match insertion {
            Some(index) => format!(
                "{}\n// @ts-nocheck\n{}",
                &content[..index],
                &content[index..]
            ),
            None => format!("// @ts-nocheck\n{content}"),
        }
    }
}

#[cfg(windows)]
struct DependencyJunction {
    path: PathBuf,
    detached: bool,
}

pub(super) struct Sandbox {
    pub path: PathBuf,
    parent: PathBuf,
    cleanup: bool,
    always: bool,
    #[cfg(windows)]
    junctions: Vec<DependencyJunction>,
}

impl Sandbox {
    pub fn create(config: &Config, project: &Project) -> Result<Self, String> {
        let parent = config.cwd.join(
            config.options["tempDirName"]
                .as_str()
                .expect("validated directory"),
        );
        fs::create_dir_all(&parent)
            .map_err(|error| format!("Cannot create sandbox parent: {error}"))?;
        let temporary = tempfile::Builder::new()
            .prefix("sandbox-")
            .tempdir_in(&parent)
            .map_err(|error| error.to_string())?;
        #[cfg(windows)]
        let path = {
            let path = super::config::canonicalize(temporary.path())?;
            let _ = temporary.keep();
            path
        };
        #[cfg(not(windows))]
        let path = temporary.keep();
        #[allow(unused_mut)]
        let mut sandbox = Self {
            path,
            parent,
            cleanup: config.options["cleanTempDir"] == "always",
            always: config.options["cleanTempDir"] == "always",
            #[cfg(windows)]
            junctions: Vec::new(),
        };
        for relative in &project.files {
            let target = sandbox.path.join(relative);
            fs::create_dir_all(target.parent().ok_or("Invalid sandbox file parent")?)
                .map_err(|error| error.to_string())?;
            fs::copy(config.cwd.join(relative), target)
                .map_err(|error| format!("Cannot copy sandbox file: {error}"))?;
        }
        for (relative, source) in &project.instrumented {
            fs::write(sandbox.path.join(relative), source).map_err(|error| error.to_string())?;
        }
        for (relative, source) in &project.preprocessed {
            fs::write(sandbox.path.join(relative), source).map_err(|error| error.to_string())?;
        }
        if config.options["symlinkNodeModules"] == true {
            for relative in &project.dependencies {
                let target = sandbox.path.join(relative);
                fs::create_dir_all(target.parent().ok_or("Invalid dependency parent")?)
                    .map_err(|error| error.to_string())?;
                #[cfg(unix)]
                std::os::unix::fs::symlink(config.cwd.join(relative), target)
                    .map_err(|error| format!("Cannot link sandbox dependencies: {error}"))?;
                #[cfg(windows)]
                {
                    if let Err(error) = junction::create(config.cwd.join(relative), &target) {
                        // create may leave its owned empty directory behind. A
                        // nonrecursive removal cannot walk into the dependency.
                        let rollback = fs::remove_dir(&target);
                        return Err(format!(
                            "Cannot link sandbox dependencies: {error}{}",
                            rollback
                                .err()
                                .filter(|error| error.kind() != std::io::ErrorKind::NotFound)
                                .map(|error| format!("; cannot remove failed junction: {error}"))
                                .unwrap_or_default()
                        ));
                    }
                    sandbox.junctions.push(DependencyJunction {
                        path: target,
                        detached: false,
                    });
                }
            }
        }
        Ok(sandbox)
    }

    pub fn finish(&mut self, config: &Config) {
        self.cleanup = self.always || config.options["cleanTempDir"] == true;
    }

    pub fn cleanup(&mut self) -> Result<(), String> {
        if !self.cleanup {
            return Ok(());
        }
        #[cfg(windows)]
        while let Some(link) = self.junctions.last_mut() {
            if !link.detached {
                match junction::delete(&link.path) {
                    Ok(()) => link.detached = true,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        self.junctions.pop();
                        continue;
                    }
                    Err(error) => {
                        return Err(format!(
                            "Cannot unlink owned sandbox junction {}: {error}",
                            link.path.display()
                        ));
                    }
                }
            }
            // The reparse point is gone. Remove only its owned empty directory;
            // on failure retain the stage and never recurse through this path.
            if let Err(error) = fs::remove_dir(&link.path)
                && error.kind() != std::io::ErrorKind::NotFound
            {
                return Err(format!(
                    "Cannot remove owned junction directory {}: {error}",
                    link.path.display()
                ));
            }
            self.junctions.pop();
        }
        match fs::remove_dir_all(&self.path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Cannot clean owned sandbox {}: {error}",
                    self.path.display()
                ));
            }
        }
        self.cleanup = false;
        match fs::remove_dir(&self.parent) {
            Ok(()) => Ok(()),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
                ) =>
            {
                Ok(())
            }
            Err(error) => Err(format!(
                "Cannot remove empty sandbox parent {}: {error}",
                self.parent.display()
            )),
        }
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}
