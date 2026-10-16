use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use serde_json::{Value, json};
use tokio::sync::watch;

fn node() -> PathBuf {
    let output = Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().trim().into()
}

fn fixture(source: &str, test: &str) -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    fs::create_dir(directory.path().join("src")).unwrap();
    fs::create_dir(directory.path().join("test")).unwrap();
    fs::write(
        directory.path().join("package.json"),
        r#"{"type":"module"}"#,
    )
    .unwrap();
    fs::write(directory.path().join("src/math.js"), source).unwrap();
    fs::write(directory.path().join("test/math.test.js"), test).unwrap();
    std::os::unix::fs::symlink(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("node_modules"),
        directory.path().join("node_modules"),
    )
    .unwrap();
    directory
}

fn request(cwd: &Path, overrides: Value) -> String {
    let mut options = json!({"testRunner":"mocha","plugins":["@stryker-mutator/mocha-runner"],"mutate":["src/**/*.js"],"reporters":[],"coverageAnalysis":"perTest","concurrency":2,"timeoutMS":300,"timeoutFactor":2,"cleanTempDir":"always","logLevel":"off","mochaOptions":{"spec":["test/**/*.test.js"],"no-config":true,"no-package":true}});
    options
        .as_object_mut()
        .unwrap()
        .extend(overrides.as_object().unwrap().clone());
    json!({"version":1,"cwd":cwd.canonicalize().unwrap(),"args":[],"overrides":options,"nodeExecutable":node(),"bridgeModule":Path::new(env!("CARGO_MANIFEST_DIR")).join("lib/compat/worker.js")}).to_string()
}

async fn execute(cwd: &Path, overrides: Value) -> Result<Value, String> {
    super::run(&request(cwd, overrides), watch::channel(false).0).await
}

fn mutants(response: &Value) -> Vec<&Value> {
    response["report"]["files"]
        .as_object()
        .unwrap()
        .values()
        .flat_map(|file| file["mutants"].as_array().unwrap())
        .collect()
}

#[tokio::test]
async fn actual_mocha_uses_native_coverage_plans_real_tests_and_preserves_source() {
    let source =
        "export function add(a,b) { return a+b; }\nexport function unused(v) { return v*2; }\n";
    let test = "import assert from 'node:assert/strict';import fs from 'node:fs'; import {add} from '../src/math.js';\ndescribe('math',()=>{ let ready; beforeEach(async()=>{fs.writeFileSync('mocha.lock','owned',{flag:'wx'});await new Promise(r=>setTimeout(r,20));ready=true;}); afterEach(()=>{ready=false;fs.unlinkSync('mocha.lock');}); it('adds',async()=>{assert.notEqual(process.env.STRYKER_MUTATOR_WORKER,undefined);assert.ok(ready); assert.equal(add(2,3),5);}); it.skip('pending',()=>{throw Error('pending executed');}); });\n";
    let directory = fixture(source, test);
    let response = execute(directory.path(), json!({})).await.unwrap();
    assert_eq!(response["supported"], true, "{response}");
    let records = mutants(&response);
    assert!(records.iter().any(|mutant| mutant["status"] == "Killed"));
    assert!(
        records.iter().all(|mutant| !mutant["statusReason"]
            .as_str()
            .is_some_and(|reason| reason.contains("EEXIST"))),
        "concurrent SDK calls must have distinct filesystem state: {response}"
    );
    assert!(
        records
            .iter()
            .any(|mutant| mutant["status"] == "NoCoverage")
    );
    assert!(
        records
            .iter()
            .filter(|mutant| mutant["status"] == "Killed")
            .all(|mutant| mutant["killedBy"] == json!(["0"]))
    );
    assert_eq!(
        response["report"]["testFiles"]["test/math.test.js"]["tests"],
        json!([{"id":"0","name":"math adds"}])
    );
    assert_eq!(
        response["report"]["testFiles"]["test/math.test.js"]["source"],
        test
    );
    assert_eq!(response["stats"]["nativeCoverageBatches"], 1);
    assert_eq!(response["stats"]["nativePlanningBatches"], 1);
    assert_eq!(response["stats"]["maximumConcurrency"], 2);
    assert!(response["stats"]["compatibilityCalls"].as_u64().unwrap() > 0);
    assert_eq!(
        fs::read_to_string(directory.path().join("src/math.js")).unwrap(),
        source
    );
    assert!(!directory.path().join(".stryker-tmp").exists());
}

#[tokio::test]
async fn selected_test_files_execute_without_filename_as_title_filter_for_off_and_static_runs() {
    let source = "export const startup = true;\nexport function add(a,b) { return a+b; }\n";
    let directory = fixture(
        source,
        "import assert from 'node:assert/strict'; import {startup,add} from '../src/math.js'; describe('selected suite',()=>{it('has an unrelated title',()=>{assert.equal(startup,true);assert.equal(add(2,3),5);});});",
    );
    fs::write(
        directory.path().join("test/nonselected.test.js"),
        "throw Error('NONSELECTED FILE EXECUTED');",
    )
    .unwrap();
    for coverage in ["off", "perTest"] {
        let response = execute(
            directory.path(),
            json!({"coverageAnalysis":coverage,"testFiles":["test/math.test.js"]}),
        )
        .await
        .unwrap();
        assert_eq!(response["supported"], true, "{response}");
        let records = mutants(&response);
        let startup = records
            .iter()
            .find(|mutant| mutant["mutatorName"] == "BooleanLiteral")
            .unwrap();
        assert_eq!(startup["status"], "Killed", "{response}");
        assert_eq!(startup["testsCompleted"], 1);
        if coverage == "perTest" {
            assert_eq!(startup["static"], true);
        }
        assert!(
            records.iter().all(|mutant| mutant["status"] == "Killed"),
            "{records:?}"
        );
        assert_eq!(
            response["report"]["testFiles"].as_object().unwrap().len(),
            1
        );
        assert!(!directory.path().join(".stryker-tmp").exists());
    }
}

#[tokio::test]
async fn plugin_schema_defaults_are_rust_normalized_and_invalid_options_have_no_run_effects() {
    let directory = fixture(
        "export const ok=true;",
        "import assert from 'node:assert/strict'; import {ok} from '../src/math.js'; it('ok',()=>assert.equal(ok,true));",
    );
    let invalid = execute(
        directory.path(),
        json!({"mochaOptions":{"unknownOption":true}}),
    )
    .await
    .unwrap();
    assert_eq!(invalid["supported"], false, "{invalid}");
    assert!(
        invalid["reason"]
            .as_str()
            .unwrap()
            .contains("plugin options")
    );
    assert!(!directory.path().join(".stryker-tmp").exists());
    let mut request: Value = serde_json::from_str(&request(directory.path(), json!({}))).unwrap();
    request["overrides"]
        .as_object_mut()
        .unwrap()
        .remove("mochaOptions");
    let response = super::run(&request.to_string(), watch::channel(false).0)
        .await
        .unwrap();
    assert_eq!(response["supported"], true, "{response}");
    assert_eq!(response["report"]["config"]["mochaOptions"], json!({}));
}

#[tokio::test]
async fn allowed_empty_mocha_runs_return_without_planning_or_touching_reports_and_dispose_baseline()
{
    let directory = fixture("export const startup=true;", "import '../src/math.js';");
    fs::create_dir(directory.path().join("reports")).unwrap();
    let existing = directory.path().join("reports/existing.json");
    let sentinel = "existing report must remain byte-for-byte unchanged\n";
    fs::write(&existing, sentinel).unwrap();
    for file_name in ["reports/existing.json", "new-reports/mutation.json"] {
        let response = execute(directory.path(), json!({"allowEmpty":true,"reporters":["json"],"jsonReporter":{"fileName":file_name},"cleanTempDir":true})).await.unwrap();
        assert_eq!(response["supported"], true, "{response}");
        assert_eq!(response["exitCode"], 0);
        assert_eq!(response["mutants"], json!([]));
        assert!(
            response.get("report").is_none(),
            "no mutation report was produced"
        );
        for key in [
            "nativeCoverageBatches",
            "nativePlanningBatches",
            "nativePlannedMutants",
            "maximumConcurrency",
        ] {
            assert_eq!(response["stats"][key], 0, "{key}: {response}");
        }
        assert_eq!(response["stats"]["nativeInstrumentationBatches"], 1);
        assert_eq!(response["stats"]["workerStarts"], 1);
        assert_eq!(
            response["stats"]["compatibilityCalls"], 7,
            "metadata/disposal, initialize/init, dryRun, capabilities and disposal only"
        );
        for pid in response["stats"]["workerPids"].as_array().unwrap() {
            assert!(
                matches!(
                    nix::sys::signal::kill(
                        nix::unistd::Pid::from_raw(pid.as_u64().unwrap() as i32),
                        None
                    ),
                    Err(nix::errno::Errno::ESRCH)
                ),
                "baseline worker must be reaped"
            );
        }
        assert_eq!(fs::read_to_string(&existing).unwrap(), sentinel);
        assert!(!directory.path().join("new-reports").exists());
        assert!(!directory.path().join(".stryker-tmp").exists());
    }
    let error = execute(directory.path(), json!({"allowEmpty":false,"reporters":["json"],"jsonReporter":{"fileName":"reports/existing.json"},"cleanTempDir":"always"})).await.unwrap_err();
    assert!(error.contains("No tests were executed"), "{error}");
    assert_eq!(fs::read_to_string(existing).unwrap(), sentinel);
    assert!(!directory.path().join(".stryker-tmp").exists());
}

#[tokio::test]
async fn baseline_failure_aborts_and_mutant_deadlines_restart_without_leaving_sandboxes() {
    let failed = fixture(
        "export const ok=true;",
        "it('fails',()=>{throw Error('BASELINE FAILURE');});",
    );
    let error = execute(failed.path(), json!({})).await.unwrap_err();
    assert!(error.contains("BASELINE FAILURE"), "{error}");
    assert!(!failed.path().join(".stryker-tmp").exists());
    let directory = fixture(
        "export function loop() { for(let i=0;i<1;i++) {} return true; }",
        "import assert from 'node:assert/strict'; import {loop} from '../src/math.js'; it('terminates',()=>assert.equal(loop(),true));",
    );
    let response = execute(directory.path(), json!({"timeoutMS":60,"concurrency":1}))
        .await
        .unwrap();
    assert_eq!(response["supported"], true, "{response}");
    assert!(
        mutants(&response)
            .iter()
            .any(|mutant| mutant["status"] == "Timeout"),
        "{response}"
    );
    assert!(mutants(&response).iter().any(|mutant| {
        mutant["statusReason"]
            .as_str()
            .is_some_and(|reason| reason.starts_with("Hit limit reached"))
    }));
    assert!(!directory.path().join(".stryker-tmp").exists());
    let deadline = fixture(
        "export function value(){return true;}",
        "import {value} from '../src/math.js'; it('terminates',async()=>{if(!value())await new Promise(()=>{});});",
    );
    let response = execute(deadline.path(), json!({"timeoutMS":60,"concurrency":1}))
        .await
        .unwrap();
    assert!(
        mutants(&response)
            .iter()
            .any(|mutant| mutant["status"] == "Timeout"),
        "{response}"
    );
    assert!(response["stats"]["workerRestarts"].as_u64().unwrap() > 0);
    assert!(!deadline.path().join(".stryker-tmp").exists());
}

#[tokio::test]
async fn mocha_retries_duplicate_titles_bail_and_maximum_reuse_keep_sdk_semantics() {
    let directory = fixture(
        "export function add(a,b){return a+b;}",
        "import assert from 'node:assert/strict';import {add} from '../src/math.js';describe('suite',()=>{it('retries',function(){this.retries(1);if(this.test.currentRetry()===0)throw Error('first attempt');assert.equal(add(2,3),5);});it('duplicate',()=>assert.equal(add(2,3),5));it('duplicate',()=>assert.equal(add(-2,3),1));});",
    );
    let response = execute(
        directory.path(),
        json!({"disableBail":true,"maxTestRunnerReuse":1,"concurrency":1}),
    )
    .await
    .unwrap();
    assert_eq!(response["supported"], true, "{response}");
    assert_eq!(
        response["report"]["testFiles"]["test/math.test.js"]["tests"],
        json!([{"id":"0","name":"suite retries"},{"id":"1","name":"suite duplicate"}])
    );
    assert!(
        mutants(&response)
            .iter()
            .all(|mutant| mutant["status"] == "Killed" && mutant["testsCompleted"] == 3),
        "{response}"
    );
    assert!(response["stats"]["workerRestarts"].as_u64().unwrap() > 0);
    assert!(!directory.path().join(".stryker-tmp").exists());
}

#[tokio::test]
async fn static_ignore_and_preignored_results_keep_coverage_metadata() {
    let directory = fixture(
        "export const startup=true;export function add(a,b){return a+b;}",
        "import assert from 'node:assert/strict';import {startup,add} from '../src/math.js';it('values',()=>{assert.equal(startup,true);assert.equal(add(2,3),5);});",
    );
    let ignored = execute(directory.path(), json!({"ignoreStatic":true}))
        .await
        .unwrap();
    let startup = mutants(&ignored)
        .into_iter()
        .find(|mutant| mutant["mutatorName"] == "BooleanLiteral")
        .unwrap();
    assert_eq!(startup["status"], "Ignored");
    assert_eq!(startup["static"], true);
    assert_eq!(startup["coveredBy"], json!([]));
    let excluded = execute(
        directory.path(),
        json!({"mutator":{"excludedMutations":["BooleanLiteral"]}}),
    )
    .await
    .unwrap();
    let startup = mutants(&excluded)
        .into_iter()
        .find(|mutant| mutant["mutatorName"] == "BooleanLiteral")
        .unwrap();
    assert_eq!(startup["status"], "Ignored");
    assert_eq!(startup["static"], false);
    assert!(startup.get("coveredBy").is_none());
}

#[tokio::test]
async fn crashed_mocha_workers_are_retried_twice_and_reaped_before_runtime_error_results() {
    let directory = fixture(
        "export function value(){return true;}",
        "import {value} from '../src/math.js';it('crashes for mutants',()=>{if(!value())process.exit(7);});",
    );
    let response = execute(directory.path(), json!({"concurrency":1}))
        .await
        .unwrap();
    assert_eq!(response["supported"], true, "{response}");
    assert!(
        mutants(&response)
            .iter()
            .all(|mutant| mutant["status"] == "RuntimeError"
                && mutant["statusReason"]
                    .as_str()
                    .is_some_and(|reason| reason.starts_with(
                        "Test runner crashed. Tried twice to restart it without any luck."
                    ))),
        "{response}"
    );
    assert!(response["stats"]["workerRestarts"].as_u64().unwrap() >= 6);
    assert!(!directory.path().join(".stryker-tmp").exists());
}

#[tokio::test]
async fn timeout_replacement_stays_pristine_for_the_next_static_mutant() {
    let directory = fixture(
        "export const startup=true;export const label='ok';",
        "import assert from 'node:assert/strict';import {startup,label} from '../src/math.js';it('initialization',async()=>{if(!startup)await new Promise(()=>{});assert.equal(label,'ok');});",
    );
    let response = execute(directory.path(), json!({"concurrency":1,"timeoutMS":60}))
        .await
        .unwrap();
    assert_eq!(response["supported"], true, "{response}");
    let records = mutants(&response);
    assert_eq!(records.len(), 2, "{response}");
    assert_eq!(records[0]["status"], "Timeout");
    assert_eq!(records[1]["status"], "Killed");
    assert_eq!(response["stats"]["workerStarts"], 3, "{response}");
    assert_eq!(response["stats"]["workerRestarts"], 2);
    assert!(!directory.path().join(".stryker-tmp").exists());
}

#[tokio::test]
async fn cancellation_waits_for_active_mocha_process_and_sandbox_cleanup() {
    let directory = fixture(
        "export function value() { return true; }",
        "import {value} from '../src/math.js'; import fs from 'node:fs'; it('waits',async()=>{if(!value()){fs.writeFileSync('active.pid',String(process.pid));await new Promise(()=>{});}});",
    );
    let input = request(directory.path(), json!({"timeoutMS":10000,"concurrency":2}));
    let (cancel, _) = watch::channel(false);
    let task_cancel = cancel.clone();
    let running = tokio::spawn(async move { super::run(&input, task_cancel).await });
    let root = directory.path().join(".stryker-tmp");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let pid = loop {
        let mut found = None;
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.flatten() {
                if let Ok(value) = fs::read_to_string(entry.path().join("active.pid")) {
                    found = Some(value.parse::<i32>().unwrap());
                    break;
                }
            }
        }
        if let Some(pid) = found {
            break pid;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "No active mutant worker"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    cancel.send_replace(true);
    assert_eq!(
        running.await.unwrap().unwrap_err(),
        "Native mutation run cancelled"
    );
    assert!(matches!(
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None),
        Err(nix::errno::Errno::ESRCH)
    ));
    assert!(!root.exists());
}
