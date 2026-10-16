//! Windows runtime evidence must come from executing these tests on Windows.

use std::{fs::OpenOptions, os::windows::fs::OpenOptionsExt, process::Command};

use serde_json::json;
use tokio::sync::watch;

use super::*;
use crate::runtime::{config, report};

const SOURCE: &str = "export const enabled = true;\n";

fn request(root: &Path, overrides: Value) -> config::Request {
    let mut options = json!({
        "testRunner":"command", "commandRunner":{"command":"exit /B 0"},
        "coverageAnalysis":"off", "plugins":[], "appendPlugins":[], "checkers":[],
        "mutate":[], "allowEmpty":true, "reporters":[], "cleanTempDir":"always",
        "disableTypeChecks":false, "logLevel":"off",
    });
    options
        .as_object_mut()
        .unwrap()
        .extend(overrides.as_object().unwrap().clone());
    config::Request {
        version: 1,
        cwd: root.into(),
        args: vec![],
        overrides: options,
        node_executable: None,
        bridge_module: None,
    }
}

fn prepared(root: &Path, overrides: Value) -> Config {
    config::prepare(request(root, overrides)).unwrap()
}

fn write(root: &Path, path: &str, source: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, source).unwrap();
}

fn dependency_fixture(root: &Path) -> (Config, Project) {
    write(
        root,
        "node_modules/original-sentinel",
        "dependency target must survive",
    );
    write(root, "src/ordinary.js", SOURCE);
    let config = prepared(root, json!({}));
    let project = prepare(&config).unwrap();
    assert_eq!(project.dependencies, [PathBuf::from("node_modules")]);
    (config, project)
}

fn node() -> PathBuf {
    let output = Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().trim().into()
}

#[test]
fn drive_report_paths_and_canonical_project_and_sandbox_paths_match_node_cwd() {
    let directory = tempfile::Builder::new()
        .prefix("native Windows space ")
        .tempdir()
        .unwrap();
    let ordinary = config::canonicalize(directory.path()).unwrap();
    let verbatim = fs::canonicalize(directory.path()).unwrap();
    assert!(
        matches!(verbatim.components().next(), Some(std::path::Component::Prefix(prefix)) if matches!(prefix.kind(), std::path::Prefix::VerbatimDisk(_)))
    );
    let destination = ordinary.join("nested reports/deeper/mutation.json");
    let config = prepared(
        &verbatim,
        json!({"reporters":["json"], "jsonReporter":{"fileName":destination}}),
    );
    assert_eq!(config.cwd, ordinary);
    let project = prepare(&config).unwrap();
    let mut sandbox = Sandbox::create(&config, &project).unwrap();
    for cwd in [&config.cwd, &sandbox.path] {
        let output = Command::new(node())
            .current_dir(cwd)
            .args(["-p", "JSON.stringify(process.cwd())"])
            .output()
            .unwrap();
        assert!(output.status.success());
        let node_cwd: String = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(Path::new(&node_cwd), cwd);
    }
    let assembled = report::assemble(&config, &project, &[]);
    report::write(&config, &assembled).unwrap();
    let saved: Value = serde_json::from_slice(&fs::read(&destination).unwrap()).unwrap();
    assert_eq!(saved, assembled);
    assert_eq!(saved["projectRoot"], json!(ordinary));
    sandbox.cleanup().unwrap();
}

#[test]
fn reserved_verbatim_project_paths_reject_before_runtime_effects() {
    let directory = tempfile::tempdir().unwrap();
    let reserved = fs::canonicalize(directory.path()).unwrap().join("CON");
    fs::create_dir(&reserved).unwrap();
    let error = config::prepare(request(&reserved, json!({})))
        .err()
        .unwrap();
    assert!(error.contains("compatible absolute drive path"), "{error}");
    assert!(!reserved.join(".stryker-tmp").exists());
    assert!(!reserved.join("reports").exists());
}

#[test]
fn junction_cleanup_preserves_original_dependency_and_is_idempotent() {
    let directory = tempfile::Builder::new()
        .prefix("junction target spaces ")
        .tempdir()
        .unwrap();
    let (config, project) = dependency_fixture(directory.path());
    let mut sandbox = Sandbox::create(&config, &project).unwrap();
    let link = sandbox.path.join("node_modules");
    assert!(junction::exists(&link).unwrap());
    assert_eq!(
        fs::read_to_string(link.join("original-sentinel")).unwrap(),
        "dependency target must survive"
    );
    sandbox.cleanup().unwrap();
    sandbox.cleanup().unwrap();
    assert!(!sandbox.path.exists());
    assert_eq!(
        fs::read_to_string(config.cwd.join("node_modules/original-sentinel")).unwrap(),
        "dependency target must survive"
    );
}

#[test]
fn junction_unlink_and_directory_removal_failures_block_recursive_cleanup_and_can_retry() {
    const BACKUP_SEMANTICS: u32 = 0x02000000;
    const OPEN_REPARSE_POINT: u32 = 0x00200000;
    for (share, phase) in [
        (0, "Cannot unlink owned sandbox junction"),
        (3, "Cannot remove owned junction directory"),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let (config, project) = dependency_fixture(directory.path());
        let mut sandbox = Sandbox::create(&config, &project).unwrap();
        let link = sandbox.path.join("node_modules");
        write(
            &sandbox.path,
            "owned-sentinel",
            "must not recurse after unlink failure",
        );
        // Access=0 permits reparse control; denying DELETE sharing blocks the
        // nonrecursive directory removal. Denying all sharing blocks unlink too.
        let held = OpenOptions::new()
            .access_mode(0)
            .share_mode(share)
            .custom_flags(BACKUP_SEMANTICS | OPEN_REPARSE_POINT)
            .open(&link)
            .unwrap();
        let first = sandbox.cleanup().unwrap_err();
        assert!(first.contains(phase), "{first}");
        assert_eq!(sandbox.cleanup().unwrap_err(), first);
        assert!(sandbox.path.join("owned-sentinel").exists());
        assert!(config.cwd.join("node_modules/original-sentinel").exists());
        drop(held);
        sandbox.cleanup().unwrap();
        assert!(!sandbox.path.exists());
        assert!(config.cwd.join("node_modules/original-sentinel").exists());
    }
}

#[test]
fn report_reparse_ancestors_and_project_junctions_reject_without_target_writes() {
    let directory = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    write(external.path(), "sentinel", "external");
    let link = directory.path().join("reports");
    junction::create(external.path(), &link).unwrap();
    for destination in [
        PathBuf::from("reports/nested/mutation.json"),
        link.join("nested/mutation.json"),
    ] {
        let error = config::prepare(request(
            directory.path(),
            json!({"jsonReporter":{"fileName":destination}}),
        ))
        .err()
        .unwrap();
        assert!(error.contains("cannot traverse"), "{error}");
    }
    junction::delete(&link).unwrap();
    fs::remove_dir(&link).unwrap();
    let source_link = directory.path().join("src");
    junction::create(external.path(), &source_link).unwrap();
    let config = prepared(directory.path(), json!({}));
    assert!(
        prepare(&config)
            .err()
            .unwrap()
            .contains("symlink requires compatibility handling")
    );
    junction::delete(&source_link).unwrap();
    fs::remove_dir(&source_link).unwrap();
    assert_eq!(fs::read_dir(external.path()).unwrap().count(), 1);
    assert_eq!(
        fs::read_to_string(external.path().join("sentinel")).unwrap(),
        "external"
    );
}

#[test]
fn nested_mutant_and_test_report_keys_preserve_sources_and_identifier_mappings() {
    let directory = tempfile::Builder::new()
        .prefix("nested report spaces ")
        .tempdir()
        .unwrap();
    write(directory.path(), "src/nested/flag.js", SOURCE);
    let test_source = "import {enabled} from '../../src/nested/flag.js';\n";
    write(directory.path(), "test/nested/flag.test.js", test_source);
    let config = prepared(directory.path(), json!({"mutate":["src/**/*.js"]}));
    let project = prepare(&config).unwrap();
    let mut mutants: Vec<_> = project
        .mutants
        .iter()
        .cloned()
        .map(|mutant| report::complete(mutant, None, &config.cwd))
        .collect();
    assert!(!mutants.is_empty());
    mutants[0]["coveredBy"] = json!(["original-test"]);
    mutants[0]["killedBy"] = json!(["original-test"]);
    let tests = vec![
        json!({"id":"original-test", "name":"flag", "fileName":config.cwd.join("test/nested/flag.test.js"), "startPosition":{"line":0,"column":0}}),
    ];
    let assembled = report::assemble_mocha(&config, &project, &mutants, &tests, &[0]).unwrap();
    assert_eq!(
        assembled["files"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        ["src/nested/flag.js"]
    );
    assert_eq!(assembled["files"]["src/nested/flag.js"]["source"], SOURCE);
    assert_eq!(
        assembled["testFiles"]["test/nested/flag.test.js"]["source"],
        test_source
    );
    assert_eq!(
        assembled["testFiles"]["test/nested/flag.test.js"]["tests"][0]["id"],
        "0"
    );
    assert_eq!(
        assembled["files"]["src/nested/flag.js"]["mutants"][0]["coveredBy"],
        json!(["0"])
    );
    assert_eq!(
        assembled["files"]["src/nested/flag.js"]["mutants"][0]["killedBy"],
        json!(["0"])
    );
}

#[tokio::test]
async fn actual_command_and_mocha_runs_preserve_nested_reports_paths_and_dependency_targets() {
    for mocha in [false, true] {
        let directory = tempfile::Builder::new()
            .prefix("native integration spaces ")
            .tempdir()
            .unwrap();
        write(directory.path(), "package.json", r#"{"type":"module"}"#);
        write(directory.path(), "src/nested/flag.js", SOURCE);
        let test_source = if mocha {
            "import assert from 'node:assert/strict'; import {enabled} from '../../src/nested/flag.js'; describe('flag', () => it('enabled', () => assert.equal(enabled,true)));\n"
        } else {
            "import assert from 'node:assert/strict'; import {enabled} from './src/nested/flag.js'; assert.equal(enabled,true);\n"
        };
        write(
            directory.path(),
            if mocha {
                "test/nested/flag.test.js"
            } else {
                "test.mjs"
            },
            test_source,
        );
        // A junction to the installed tool dependencies needs no symlink privilege.
        let dependencies = Path::new(env!("CARGO_MANIFEST_DIR")).join("node_modules");
        let project_dependencies = directory.path().join("node_modules");
        junction::create(&dependencies, &project_dependencies).unwrap();
        let manifest_before = fs::read(dependencies.join("mocha/package.json")).unwrap();
        let cwd = config::canonicalize(directory.path()).unwrap();
        let destination = cwd.join("reports/nested absolute/mutation.json");
        let overrides = if mocha {
            json!({"testRunner":"mocha", "plugins":["@stryker-mutator/mocha-runner"], "coverageAnalysis":"perTest", "mutate":["src/**/*.js"], "concurrency":1,"reporters":["json"],"jsonReporter":{"fileName":destination},"mochaOptions":{"spec":["test/**/*.test.js"],"no-config":true,"no-package":true},"timeoutMS":2000})
        } else {
            json!({"commandRunner":{"command":format!("\"{}\" test.mjs", node().display())},"mutate":["src/**/*.js"],"concurrency":1,"reporters":["json"],"jsonReporter":{"fileName":destination},"timeoutMS":2000})
        };
        let request = request(&fs::canonicalize(&cwd).unwrap(), overrides);
        let input = json!({"version":request.version,"cwd":request.cwd,"overrides":request.overrides,"nodeExecutable":node(),"bridgeModule":Path::new(env!("CARGO_MANIFEST_DIR")).join("lib/compat/worker.js")}).to_string();
        let (cancel, _) = watch::channel(false);
        let result = crate::runtime::run(&input, cancel).await.unwrap();
        assert_eq!(result["supported"], true, "{result}");
        assert_eq!(result["stats"]["coordinator"], "rust");
        assert!(
            result["mutants"]
                .as_array()
                .unwrap()
                .iter()
                .any(|mutant| mutant["status"] == "Killed"),
            "{result}"
        );
        let saved: Value = serde_json::from_slice(&fs::read(destination).unwrap()).unwrap();
        assert_eq!(saved, result["report"]);
        assert_eq!(saved["projectRoot"], json!(cwd));
        assert_eq!(saved["files"]["src/nested/flag.js"]["source"], SOURCE);
        if mocha {
            assert_eq!(
                saved["testFiles"]["test/nested/flag.test.js"]["source"],
                test_source
            );
            assert!(
                !saved["testFiles"]
                    .as_object()
                    .unwrap()
                    .keys()
                    .any(|key| key.contains("sandbox-") || key.contains('\\'))
            );
        }
        assert!(!cwd.join(".stryker-tmp").exists());
        assert_eq!(
            fs::read(dependencies.join("mocha/package.json")).unwrap(),
            manifest_before
        );
        assert!(junction::exists(&project_dependencies).unwrap());
        junction::delete(&project_dependencies).unwrap();
        fs::remove_dir(&project_dependencies).unwrap();
    }
}
