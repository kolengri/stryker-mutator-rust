use super::{config::Config, process::Outcome, project::Project};
use serde_json::{Value, json};
use std::{fs, path::Path};

pub(super) fn complete(mut mutant: Value, outcome: Option<Outcome>, cwd: &Path) -> Value {
    if let Some(outcome) = outcome {
        if outcome.timed_out {
            mutant["status"] = "Timeout".into();
        } else if outcome.status.is_some_and(|status| status.success()) {
            mutant["status"] = "Survived".into();
            mutant["testsCompleted"] = 1.into();
        } else {
            mutant["status"] = "Killed".into();
            mutant["testsCompleted"] = 1.into();
            mutant["killedBy"] = json!(["0"]);
            mutant["statusReason"] = outcome.output.into();
        }
    }
    for position in ["start", "end"] {
        for coordinate in ["line", "column"] {
            mutant["location"][position][coordinate] = (mutant["location"][position][coordinate]
                .as_u64()
                .expect("native position")
                + 1)
            .into();
        }
    }
    let file_name = mutant["fileName"].as_str().expect("native file name");
    mutant["fileName"] = cwd.join(file_name).to_string_lossy().as_ref().into();
    mutant
}

fn dependencies(cwd: &Path) -> Value {
    let mut result = json!({});
    for specifier in [
        "@stryker-mutator/mocha-runner",
        "@stryker-mutator/karma-runner",
        "@stryker-mutator/jasmine-runner",
        "@stryker-mutator/jest-runner",
        "@stryker-mutator/typescript-checker",
        "karma",
        "karma-chai",
        "karma-chrome-launcher",
        "karma-jasmine",
        "karma-mocha",
        "mocha",
        "jasmine",
        "jasmine-core",
        "jest",
        "react-scripts",
        "typescript",
        "@angular/cli",
        "webpack",
        "webpack-cli",
        "ts-jest",
    ] {
        for directory in cwd.ancestors() {
            let path = directory
                .join("node_modules")
                .join(specifier)
                .join("package.json");
            if path.is_file() {
                if let Ok(bytes) = fs::read(path)
                    && let Ok(value) = serde_json::from_slice::<Value>(&bytes)
                    && let Some(version) = value["version"].as_str()
                {
                    result[specifier] = version.into();
                }
                break;
            }
        }
    }
    result
}

pub(super) fn assemble(config: &Config, project: &Project, mutants: &[Value]) -> Value {
    let mut files = json!({});
    for mutant in mutants {
        let file_name = mutant["fileName"].as_str().expect("completed mutant file");
        let relative = Path::new(file_name)
            .strip_prefix(&config.cwd)
            .expect("owned mutant source");
        let name = super::project::name(relative).expect("validated UTF-8 mutant source");
        if files.get(name.as_str()).is_none() {
            let language = match relative.extension().and_then(|value| value.to_str()) {
                Some("ts" | "tsx") => "typescript",
                Some("html" | "vue") => "html",
                _ => "javascript",
            };
            files[name.as_str()] = json!({"language":language,"source": project.originals[name.as_str()],"mutants":[]});
        }
        let mut record = mutant.clone();
        record
            .as_object_mut()
            .expect("mutant object")
            .remove("fileName");
        files[name.as_str()]["mutants"]
            .as_array_mut()
            .expect("report mutant list")
            .push(record);
    }
    let mut framework: Value =
        serde_json::from_str(include_str!("framework.json")).expect("bundled framework metadata");
    framework["dependencies"] = dependencies(&config.cwd);
    json!({"files": files, "schemaVersion":"1.0", "thresholds": config.options["thresholds"],
        "testFiles":{"":{"tests":[{"id":"0","name":"All tests"}]}},"projectRoot":config.cwd,
        "config":config.options,"framework": framework})
}

pub(super) fn assemble_sdk(
    config: &Config,
    project: &Project,
    mutants: &[Value],
    tests: &[Value],
    slots: &[usize],
) -> Result<Value, String> {
    let mut report = assemble(config, project, mutants);
    let ids = slots
        .iter()
        .enumerate()
        .map(|(slot, &index)| {
            tests[index]["id"]
                .as_str()
                .map(|id| (id, slot.to_string()))
                .ok_or("SDK test result omitted ID")
        })
        .collect::<Result<std::collections::HashMap<_, _>, _>>()?;
    let mut files = json!({});
    for &index in slots {
        let test = &tests[index];
        let file_name = test["fileName"].as_str().unwrap_or("");
        let relative = Path::new(file_name)
            .strip_prefix(&config.cwd)
            .unwrap_or_else(|_| Path::new(file_name));
        let name = super::project::name(relative)?;
        if files.get(name.as_str()).is_none() {
            files[name.as_str()] = json!({"tests":[]});
            if !file_name.is_empty() && project.files.iter().any(|file| file == relative) {
                let source = fs::read_to_string(config.cwd.join(relative))
                    .map_err(|error| format!("Cannot read original test source: {error}"))?;
                files[name.as_str()]["source"] = source.into();
            }
        }
        let mut definition = json!({"id":ids.get(test["id"].as_str().ok_or("SDK test omitted ID")?).ok_or("Missing test slot")?,"name":test["name"]});
        if let Some(position) = test.get("startPosition") {
            definition["location"] = json!({"start":{"line":position["line"].as_u64().ok_or("Invalid test line")?+1,"column":position["column"].as_u64().ok_or("Invalid test column")?+1}});
        }
        files[name.as_str()]["tests"]
            .as_array_mut()
            .expect("test list")
            .push(definition);
    }
    report["testFiles"] = files;
    for file in report["files"]
        .as_object_mut()
        .expect("report files")
        .values_mut()
    {
        for mutant in file["mutants"].as_array_mut().expect("report mutants") {
            for key in ["coveredBy", "killedBy"] {
                if let Some(test_ids) = mutant.get_mut(key).and_then(Value::as_array_mut) {
                    for id in test_ids {
                        if let Some(replacement) = id.as_str().and_then(|id| ids.get(id)) {
                            *id = replacement.clone().into();
                        }
                    }
                }
            }
        }
    }
    Ok(report)
}

pub(super) fn write(config: &Config, report: &Value) -> Result<(), String> {
    if config.options["reporters"]
        .as_array()
        .expect("validated reporters")
        .iter()
        .any(|name| name == "json")
    {
        let path = config.cwd.join(
            config.options["jsonReporter"]["fileName"]
                .as_str()
                .expect("validated report path"),
        );
        fs::create_dir_all(path.parent().ok_or("Invalid report parent")?)
            .map_err(|error| format!("Cannot create report directory: {error}"))?;
        fs::write(path, report.to_string())
            .map_err(|error| format!("Cannot write JSON report: {error}"))?;
    }
    Ok(())
}

pub(super) fn exit_code(config: &Config, mutants: &[Value]) -> i32 {
    let mut detected = 0;
    let mut undetected = 0;
    for mutant in mutants {
        match mutant["status"].as_str() {
            Some("Killed" | "Timeout") => detected += 1,
            Some("Survived" | "NoCoverage") => undetected += 1,
            _ => {}
        }
    }
    let score = if detected + undetected == 0 {
        100.0
    } else {
        100.0 * f64::from(detected) / f64::from(detected + undetected)
    };
    i32::from(
        config.options["thresholds"]["break"]
            .as_f64()
            .is_some_and(|threshold| score < threshold),
    )
}
