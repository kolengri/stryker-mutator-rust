//! The ordinary JSONC subset is validated before any sandbox is created.
use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
};

use serde_json::{Map, Value};

use super::{Config, Project, name};

pub(super) fn normalize(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            _ => result.push(component.as_os_str()),
        }
    }
    result
}

fn relative(from: &Path, to: &Path) -> Result<String, String> {
    let from = from.components().collect::<Vec<_>>();
    let to = to.components().collect::<Vec<_>>();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut path = PathBuf::new();
    for _ in common..from.len() {
        path.push("..");
    }
    for part in &to[common..] {
        path.push(part.as_os_str());
    }
    if path.as_os_str().is_empty() {
        Ok(".".into())
    } else {
        name(&path)
    }
}

fn path_string<'a>(value: &'a Value, context: &str) -> Result<&'a str, String> {
    let path = value
        .as_str()
        .ok_or_else(|| format!("Unsupported TSConfig {context}: expected a string"))?;
    if path.is_empty() || path.contains(['\\', '\0']) {
        return Err(format!(
            "Unsupported TSConfig {context}: empty or platform-dependent path"
        ));
    }
    Ok(path)
}

// JSON.stringify uses integer property keys first and loses precision beyond
// JavaScript's safe integer range. Reject uncertain numeric forms, and preserve
// the defined key order rather than silently emitting a different configuration.
fn validate_json(value: &mut Value) -> Result<(), String> {
    match value {
        Value::Number(number) => {
            let safe = number
                .as_i64()
                .is_some_and(|n| n.unsigned_abs() <= 9_007_199_254_740_991)
                || number.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991);
            if !safe {
                return Err("Unsupported TSConfig number: expected a safe integer".into());
            }
        }
        Value::Array(values) => {
            for value in values {
                validate_json(value)?;
            }
        }
        Value::Object(object) => {
            if object.contains_key("__proto__") {
                return Err("Unsupported TSConfig property: __proto__".into());
            }
            for value in object.values_mut() {
                validate_json(value)?;
            }
            let old = std::mem::take(object);
            let mut integer_keys = old
                .keys()
                .filter_map(|key| {
                    let number = key.parse::<u32>().ok()?;
                    (number != u32::MAX && number.to_string() == *key)
                        .then_some((number, key.clone()))
                })
                .collect::<Vec<_>>();
            integer_keys.sort_by_key(|(number, _)| *number);
            for (_, key) in integer_keys {
                object.insert(key.clone(), old[&key].clone());
            }
            for (key, value) in old {
                if !object.contains_key(&key) {
                    object.insert(key, value);
                }
            }
        }
        _ => {}
    }
    Ok(())
}

struct Rewriter<'a> {
    config: &'a Config,
    selected: HashSet<PathBuf>,
    touched: HashSet<PathBuf>,
    sandbox: PathBuf,
    rewritten: Vec<(PathBuf, String)>,
}

impl Rewriter<'_> {
    fn target(&self, origin: &Path, value: &str) -> PathBuf {
        normalize(
            &origin
                .parent()
                .expect("absolute TSConfig parent")
                .join(value),
        )
    }

    fn rewrite_path(&self, origin: &Path, original: &str) -> Result<String, String> {
        let target = self.target(origin, original);
        let origin_relative = origin
            .strip_prefix(&self.config.cwd)
            .expect("selected origin inside cwd");
        let sandbox_origin = self.sandbox.join(origin_relative);
        let sandbox_directory = sandbox_origin.parent().expect("sandbox config parent");
        if let Ok(inside) = target.strip_prefix(&self.config.cwd) {
            if normalize(&sandbox_directory.join(original)) != self.sandbox.join(inside) {
                let rewritten = relative(sandbox_directory, &self.sandbox.join(inside))?;
                return Ok(
                    if rewritten.starts_with("./") || rewritten.starts_with("../") {
                        rewritten
                    } else {
                        format!("./{rewritten}")
                    },
                );
            }
            return Ok(original.into());
        }
        if Path::new(original).is_absolute() {
            return Ok(original.into());
        }
        relative(sandbox_directory, &target)
    }

    fn extends(&mut self, origin: &Path, value: &mut Value) -> Result<(), String> {
        if let Value::Array(values) = value {
            for value in values {
                path_string(value, "extends array member")?;
                self.extends(origin, value)?;
            }
        } else {
            let original = path_string(value, "extends")?.to_owned();
            self.visit(self.target(origin, &original))?;
            *value = Value::String(self.rewrite_path(origin, &original)?);
        }
        Ok(())
    }

    fn rewrite(&mut self, origin: &Path, object: &mut Map<String, Value>) -> Result<(), String> {
        if let Some(value) = object.get_mut("extends") {
            self.extends(origin, value)?;
        }
        if let Some(value) = object.get_mut("references") {
            let references = value
                .as_array_mut()
                .ok_or("Unsupported TSConfig references: expected an array")?;
            for reference in references {
                let reference = reference
                    .as_object_mut()
                    .ok_or("Unsupported TSConfig reference: expected an object")?;
                let original = path_string(
                    reference
                        .get("path")
                        .ok_or("TSConfig reference requires path")?,
                    "reference path",
                )?;
                let resolved = if original.ends_with(".json") {
                    original.to_owned()
                } else {
                    format!("{}/tsconfig.json", original.trim_end_matches('/'))
                };
                self.visit(self.target(origin, &resolved))?;
                let rewritten = self.rewrite_path(origin, &resolved)?;
                // Preserve the original directory form when no relocation is needed.
                if rewritten != resolved {
                    reference.insert("path".into(), rewritten.into());
                }
            }
        }
        for key in ["include", "exclude", "files"] {
            if let Some(value) = object.get_mut(key) {
                let values = value
                    .as_array_mut()
                    .ok_or_else(|| format!("Unsupported TSConfig {key}: expected an array"))?;
                for value in values {
                    let original = path_string(value, key)?;
                    *value = self.rewrite_path(origin, original)?.into();
                }
            }
        }
        Ok(())
    }

    fn visit(&mut self, origin: PathBuf) -> Result<(), String> {
        if !self.touched.insert(origin.clone()) || !self.selected.contains(&origin) {
            return Ok(());
        }
        let source = fs::read_to_string(&origin).map_err(|error| {
            format!(
                "Cannot read selected TSConfig {}: {error}",
                origin.display()
            )
        })?;
        let options = jsonc_parser::ParseOptions {
            allow_comments: true,
            allow_loose_object_property_names: false,
            allow_trailing_commas: true,
            allow_missing_commas: false,
            allow_single_quoted_strings: false,
            allow_hexadecimal_numbers: false,
            allow_unary_plus_numbers: false,
            allow_bare_decimal_point_numbers: false,
            allow_non_finite_numbers: false,
            allow_extended_string_escapes: false,
        };
        let mut value: Value =
            jsonc_parser::parse_to_serde_value(source.trim_start_matches('\u{feff}'), &options)
                .map_err(|error| {
                    format!("Unsupported TSConfig JSONC {}: {error}", origin.display())
                })?;
        validate_json(&mut value)?;
        let object = value
            .as_object_mut()
            .ok_or("Unsupported TSConfig root: expected an object")?;
        self.rewrite(&origin, object)?;
        self.rewritten.push((
            origin
                .strip_prefix(&self.config.cwd)
                .expect("selected origin")
                .to_path_buf(),
            serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?,
        ));
        Ok(())
    }
}

pub(super) fn prepare(config: &Config, project: &mut Project) -> Result<(), String> {
    if config.options["inPlace"] == true {
        return Ok(());
    }
    let root = normalize(
        &config.cwd.join(
            config.options["tsconfigFile"]
                .as_str()
                .expect("validated tsconfig path"),
        ),
    );
    let mut rewriter = Rewriter {
        config,
        selected: project
            .files
            .iter()
            .map(|file| config.cwd.join(file))
            .collect(),
        touched: HashSet::new(),
        // The generated sandbox name changes no relative route to a file outside
        // cwd. Its parent depth, however, depends on tempDirName.
        sandbox: config
            .cwd
            .join(
                config.options["tempDirName"]
                    .as_str()
                    .expect("validated temp path"),
            )
            .join("sandbox-placeholder"),
        rewritten: vec![],
    };
    rewriter.visit(root)?;
    project.preprocessed.extend(rewriter.rewritten);
    Ok(())
}
