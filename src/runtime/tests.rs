use super::*;
use serde_json::{Value, json};
use std::{fs, path::Path, time::Duration};
use tokio::sync::watch;

const SOURCE: &str = "export function add(a,b) { if (a > b) { return a + b; } return a - b; }\n";

fn fixture(script: &str) -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    fs::create_dir(directory.path().join("src")).unwrap();
    fs::write(directory.path().join("src/add.js"), SOURCE).unwrap();
    fs::write(
        directory.path().join("package.json"),
        "{\"type\":\"module\"}",
    )
    .unwrap();
    fs::write(directory.path().join("test.mjs"), script).unwrap();
    let options = json!({"testRunner":"command","commandRunner":{"command":"node test.mjs"},"coverageAnalysis":"off","plugins":[],
        "appendPlugins":[],"checkers":[],"reporters":["json"],"mutate":["src/**/*.js"],"concurrency":2,
        "timeoutMS":2000,"timeoutFactor":0,"cleanTempDir":"always","jsonReporter":{"fileName":"reports/mutation.json"},"logLevel":"off"});
    fs::write(
        directory.path().join("stryker.config.json"),
        options.to_string(),
    )
    .unwrap();
    directory
}

fn request(directory: &Path, overrides: Value) -> String {
    json!({"version":1,"cwd":directory,"args":[],"overrides":overrides}).to_string()
}

async fn execute(directory: &Path, overrides: Value) -> Result<Value, String> {
    let (cancel, _) = watch::channel(false);
    run(&request(directory, overrides), cancel).await
}

fn clean(directory: &Path) {
    assert!(
        !directory.join(".stryker-tmp").exists(),
        "owned sandboxes must be cleaned"
    );
    assert_eq!(
        fs::read_to_string(directory.join("src/add.js")).unwrap(),
        SOURCE
    );
}

#[tokio::test]
async fn complete_command_run_uses_actual_instrumentation_outcomes_and_full_report() {
    let directory =
        fixture("import { add } from './src/add.js'; if (add(4,2) !== 6) process.exitCode = 1;");
    let response = execute(directory.path(), json!({})).await.unwrap();
    assert_eq!(response["supported"], true);
    assert_eq!(response["stats"]["coordinator"], "rust");
    assert_eq!(response["stats"]["nativeInstrumentationBatches"], 1);
    assert_eq!(response["stats"]["nativePlanningBatches"], 1);
    assert_eq!(response["stats"]["compatibilityCalls"], 0);
    let mutants = response["mutants"].as_array().unwrap();
    assert!(!mutants.is_empty());
    assert_eq!(
        response["stats"]["commandStarts"].as_u64().unwrap(),
        mutants.len() as u64 + 1
    );
    assert!(mutants.iter().any(|mutant| mutant["status"] == "Killed"));
    assert!(mutants.iter().any(|mutant| mutant["status"] == "Survived"));
    for mutant in mutants {
        assert_eq!(mutant["testsCompleted"], 1);
        assert!(mutant["location"]["start"]["line"].as_u64().unwrap() >= 1);
        assert!(mutant["location"]["start"]["column"].as_u64().unwrap() >= 1);
        assert!(Path::new(mutant["fileName"].as_str().unwrap()).is_absolute());
        if mutant["status"] == "Killed" {
            assert_eq!(mutant["killedBy"], json!(["0"]));
            assert_eq!(mutant["statusReason"], "");
        }
    }
    assert_eq!(response["report"]["files"]["src/add.js"]["source"], SOURCE);
    assert_eq!(
        response["report"]["testFiles"],
        json!({"":{"tests":[{"id":"0","name":"All tests"}]}})
    );
    let saved: Value =
        serde_json::from_slice(&fs::read(directory.path().join("reports/mutation.json")).unwrap())
            .unwrap();
    assert_eq!(saved, response["report"]);
    clean(directory.path());
}

#[tokio::test]
async fn unsupported_preflight_has_no_commands_sandbox_or_report_effects() {
    let directory = fixture("throw new Error('must never execute');");
    for overrides in [
        json!({"plugins":["custom-plugin"]}),
        json!({"checkers":["typescript"]}),
        json!({"reporters":["html"]}),
        json!({"testRunner":"mocha"}),
        json!({"coverageAnalysis":"perTest"}),
        json!({"buildCommand":"echo forbidden"}),
        json!({"incremental":true}),
        json!({"ignoreStatic":true}),
        json!({"testFiles":["test.mjs"]}),
        json!({"concurrency":0}),
        json!({"customOption":true}),
        json!({"mutate":["src/!(add).js"]}),
        json!({"mutate":["src/*.js:1-2"]}),
        json!({"jsonReporter":{"fileName":"../outside.json"}}),
    ] {
        let response = execute(directory.path(), overrides.clone()).await.unwrap();
        assert_eq!(response["supported"], false, "{overrides}: {response}");
        assert!(
            response["reason"]
                .as_str()
                .is_some_and(|reason| !reason.is_empty())
        );
        assert!(!directory.path().join("reports").exists());
        clean(directory.path());
    }
    fs::write(
        directory.path().join("src/add.js"),
        "export const view = <div />;",
    )
    .unwrap();
    let response = execute(directory.path(), json!({})).await.unwrap();
    assert_eq!(response["supported"], false);
    assert!(!directory.path().join(".stryker-tmp").exists());
    assert!(!directory.path().join("reports").exists());
}

#[tokio::test]
async fn invalid_ignore_static_coverage_combinations_reject_before_compatibility_or_run_effects() {
    let directory = fixture("throw Error('configured command must not execute');");
    let marker = directory.path().join("compatibility-started");
    let probe = directory.path().join("compatibility-probe.mjs");
    fs::write(
        &probe,
        format!(
            "import fs from 'node:fs';fs.writeFileSync({},'unexpected bridge');process.exit(7);",
            serde_json::to_string(&marker.to_string_lossy()).unwrap()
        ),
    )
    .unwrap();
    let node = std::process::Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .unwrap();
    assert!(node.status.success());
    let node = String::from_utf8(node.stdout).unwrap();
    for overrides in [
        json!({"ignoreStatic":true,"coverageAnalysis":"off"}),
        json!({"testRunner":"mocha","plugins":["@stryker-mutator/mocha-runner"],"ignoreStatic":true,"coverageAnalysis":"all"}),
    ] {
        let mut input: Value = serde_json::from_str(&request(directory.path(), overrides)).unwrap();
        input["nodeExecutable"] = node.trim().into();
        input["bridgeModule"] = json!(probe);
        let response = run(&input.to_string(), watch::channel(false).0)
            .await
            .unwrap();
        assert_eq!(response["supported"], false, "{response}");
        let reason = response["reason"].as_str().unwrap();
        assert!(
            reason.contains("ignoreStatic") && reason.contains("coverageAnalysis"),
            "{reason}"
        );
        assert!(
            !marker.exists(),
            "metadata worker must not start before custom option validation"
        );
        assert!(!directory.path().join("reports").exists());
        clean(directory.path());
    }
}

#[tokio::test]
async fn literal_json_and_cli_signed_zero_deadlines_complete_native_planning() {
    let directory = fixture("");
    let path = directory.path().join("stryker.config.json");
    let original = fs::read_to_string(&path).unwrap();
    let literal = original.replace("\"timeoutFactor\":0", "\"timeoutFactor\":-0");
    assert_ne!(
        literal, original,
        "fixture must retain a literal signed zero"
    );
    fs::write(&path, &literal).unwrap();
    let response = execute(directory.path(), json!({})).await.unwrap();
    assert_eq!(response["supported"], true, "{response}");
    assert_eq!(response["stats"]["nativePlanningBatches"], 1);
    assert!(response["stats"]["nativePlannedMutants"].as_u64().unwrap() > 0);
    assert_eq!(response["report"]["config"]["timeoutFactor"], 0);
    let mut input: Value = serde_json::from_str(&request(directory.path(), json!({}))).unwrap();
    input["args"] = json!(["--timeoutMS=-0"]);
    let response = run(&input.to_string(), watch::channel(false).0)
        .await
        .unwrap();
    assert_eq!(response["supported"], true, "{response}");
    assert_eq!(response["stats"]["nativePlanningBatches"], 1);
    assert!(response["stats"]["nativePlannedMutants"].as_u64().unwrap() > 0);
    assert_eq!(response["report"]["config"]["timeoutMS"], 0);
    // A zero-minute baseline is still an immediate deadline. Check its accepted
    // numeric configuration without asserting that the external command passes.
    let all_signed = literal.replace("\"timeoutMS\":2000", "\"timeoutMS\":-0");
    let mut all_signed: Value = serde_json::from_str(&all_signed).unwrap();
    all_signed
        .as_object_mut()
        .unwrap()
        .remove("dryRunTimeoutMinutes");
    let all_signed = all_signed.to_string();
    // Serialize all other fields first, then insert literal -0 so no serializer
    // can normalize away the input whose acceptance this regression exercises.
    let all_signed = format!("{{\"dryRunTimeoutMinutes\":-0,{}", &all_signed[1..]);
    fs::write(path, all_signed).unwrap();
    let prepared =
        config::prepare(serde_json::from_str(&request(directory.path(), json!({}))).unwrap())
            .unwrap();
    for key in ["timeoutMS", "timeoutFactor", "dryRunTimeoutMinutes"] {
        let value = prepared.options[key].as_f64().unwrap();
        assert_eq!(value, 0.0, "{key}");
        assert!(
            !value.is_sign_negative(),
            "{key} must be canonical positive zero"
        );
    }
    clean(directory.path());
}

#[tokio::test]
async fn absolute_json_report_paths_write_the_selected_target_and_reject_symlink_ancestors() {
    let directory = fixture("");
    let output = tempfile::tempdir().unwrap();
    let root = output.path().canonicalize().unwrap();
    let path = root.join("nested/mutation.json");
    let response = execute(
        directory.path(),
        json!({"reporters":["json"],"jsonReporter":{"fileName":path}}),
    )
    .await
    .unwrap();
    assert_eq!(response["supported"], true, "{response}");
    let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved, response["report"]);
    assert_eq!(saved["config"]["jsonReporter"]["fileName"], json!(path));
    std::os::unix::fs::symlink(root.join("nested"), root.join("linked")).unwrap();
    let rejected = execute(
        directory.path(),
        json!({"jsonReporter":{"fileName":root.join("linked/forbidden.json")}}),
    )
    .await
    .unwrap();
    assert_eq!(rejected["supported"], false, "{rejected}");
    assert!(!root.join("nested/forbidden.json").exists());
    clean(directory.path());
}

#[tokio::test]
async fn cli_precedence_json_discovery_and_unknown_arguments_are_explicit() {
    let directory = fixture("");
    let input = json!({"version":1,"cwd":directory.path(),"args":["stryker.config.json","--concurrency=1","--mutate","src/add.js:1:0-1:40","--reporters",""],"overrides":{"concurrency":2}});
    let response = run(&input.to_string(), watch::channel(false).0)
        .await
        .unwrap();
    assert_eq!(response["supported"], true);
    assert_eq!(response["report"]["config"]["concurrency"], 2);
    assert_eq!(
        response["report"]["config"]["configFile"],
        "stryker.config.json"
    );
    assert_eq!(
        response["report"]["config"]["mutate"],
        json!(["src/add.js:1:0-1:40"])
    );
    assert!(!directory.path().join("reports").exists());
    let bad = json!({"version":1,"cwd":directory.path(),"args":["--unknown"]});
    assert_eq!(
        run(&bad.to_string(), watch::channel(false).0)
            .await
            .unwrap()["supported"],
        false
    );
    fs::rename(
        directory.path().join("stryker.config.json"),
        directory.path().join("stryker.conf.js"),
    )
    .unwrap();
    assert_eq!(
        execute(directory.path(), json!({})).await.unwrap()["supported"],
        false
    );
    clean(directory.path());
}

#[tokio::test]
async fn file_walk_negative_mutate_ranges_and_assets_preserve_selection_and_bytes() {
    let directory = fixture("");
    fs::write(
        directory.path().join("src/excluded.js"),
        "const unsupported = /regex/;",
    )
    .unwrap();
    fs::write(
        directory.path().join("src/add.test.js"),
        "const unsupported = /regex/;",
    )
    .unwrap();
    fs::write(
        directory.path().join("src/.hidden.js"),
        "const unsupported = /regex/;",
    )
    .unwrap();
    fs::create_dir(directory.path().join("ignored")).unwrap();
    fs::write(
        directory.path().join("ignored/unreadable.js"),
        "const unsupported = /regex/;",
    )
    .unwrap();
    fs::write(directory.path().join("binary.bin"), [0, 255, 1]).unwrap();
    fs::write(directory.path().join("test.mjs"), "import fs from 'node:fs'; if (fs.existsSync('ignored')) process.exit(3); if (fs.readFileSync('binary.bin')[1] !== 255) process.exit(4);").unwrap();
    let response = execute(directory.path(), json!({"mutate":["src/**/*.js","!src/excluded.js","!src/add.test.js","!src/add.js","src/add.js:1:34-1:70"],"ignorePatterns":["ignored"]})).await.unwrap();
    assert_eq!(response["supported"], true, "{response}");
    for mutant in response["mutants"].as_array().unwrap() {
        assert!(mutant["fileName"].as_str().unwrap().ends_with("src/add.js"));
        assert!(mutant["location"]["start"]["column"].as_u64().unwrap() >= 35);
    }
    clean(directory.path());
}

#[tokio::test]
async fn default_mutate_excludes_tests_and_hidden_sources() {
    let directory = fixture("");
    for name in ["add.spec.js", "add.Test.js", ".hidden.js"] {
        fs::write(
            directory.path().join("src").join(name),
            "const unsupported = /regex/;",
        )
        .unwrap();
    }
    let response = execute(
        directory.path(),
        json!({"mutate":config::defaults()["mutate"]}),
    )
    .await
    .unwrap();
    assert_eq!(response["supported"], true, "{response}");
    assert_eq!(
        response["report"]["files"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        vec!["src/add.js"]
    );
    clean(directory.path());
}

#[tokio::test]
async fn type_check_preprocessing_preserves_leading_comments_and_directive_strings() {
    let script = "/* leading framework comment */\n// @ts-expect-error obsolete\nimport fs from 'node:fs'; const literal='@ts-check'; const source=fs.readFileSync(new URL(import.meta.url),'utf8'); if(!source.startsWith('/* leading framework comment */\\n// @ts-nocheck\\n')) process.exit(2); if(source.includes(['@ts','-expect-error'].join(''))) process.exit(3); if(literal !== '@ts-check') process.exit(4);";
    let directory = fixture(script);
    let response = execute(directory.path(), json!({})).await.unwrap();
    assert_eq!(response["supported"], true, "{response}");
    assert!(
        response["mutants"]
            .as_array()
            .unwrap()
            .iter()
            .all(|mutant| mutant["status"] == "Survived")
    );
    assert_eq!(
        fs::read_to_string(directory.path().join("test.mjs")).unwrap(),
        script
    );
    clean(directory.path());
}

#[tokio::test]
async fn selected_tsconfig_and_ambient_babel_preflight_reject_without_effects() {
    let directory = fixture("");
    fs::write(
        directory.path().join("tsconfig.json"),
        "{\"extends\":\"../base.json\", broken }",
    )
    .unwrap();
    let response = execute(directory.path(), json!({"disableTypeChecks":false}))
        .await
        .unwrap();
    assert_eq!(response["supported"], false);
    assert!(response["reason"].as_str().unwrap().contains("TSConfig"));
    assert!(!directory.path().join(".stryker-tmp").exists());
    let response = execute(
        directory.path(),
        json!({"ignorePatterns":["tsconfig.json"]}),
    )
    .await
    .unwrap();
    assert_eq!(response["supported"], true, "{response}");
    fs::remove_file(directory.path().join("tsconfig.json")).unwrap();
    fs::write(directory.path().join("src/.babelrc"), "{}").unwrap();
    let response = execute(directory.path(), json!({})).await.unwrap();
    assert_eq!(response["supported"], false);
    assert!(response["reason"].as_str().unwrap().contains("Babel"));
    clean(directory.path());
}

#[tokio::test]
async fn source_and_output_symlinks_reject_before_writes() {
    let directory = fixture("");
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), directory.path().join(".stryker-tmp")).unwrap();
    let response = execute(directory.path(), json!({})).await.unwrap();
    assert_eq!(response["supported"], false);
    assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
    fs::remove_file(directory.path().join(".stryker-tmp")).unwrap();
    std::os::unix::fs::symlink(
        directory.path().join("src/add.js"),
        directory.path().join("link.js"),
    )
    .unwrap();
    assert_eq!(
        execute(directory.path(), json!({})).await.unwrap()["supported"],
        false
    );
    clean(directory.path());
}

#[tokio::test]
async fn baseline_failure_aborts_before_mutants_and_honors_cleanup_policy() {
    let directory = fixture("process.stderr.write('baseline detail'); process.exitCode = 7;");
    let error = execute(directory.path(), json!({})).await.unwrap_err();
    assert!(
        error.contains("Baseline command failed") && error.contains("baseline detail"),
        "{error}"
    );
    assert!(!directory.path().join("reports").exists());
    clean(directory.path());
    assert!(
        execute(directory.path(), json!({"cleanTempDir":false}))
            .await
            .is_err()
    );
    assert!(
        fs::read_dir(directory.path().join(".stryker-tmp"))
            .unwrap()
            .next()
            .is_some()
    );
}

#[tokio::test]
async fn successful_runs_preserve_sandboxes_only_when_requested_and_enforce_threshold() {
    let directory = fixture("");
    let response = execute(
        directory.path(),
        json!({"cleanTempDir":false,"thresholds":{"break":100}}),
    )
    .await
    .unwrap();
    assert_eq!(response["exitCode"], 1);
    let sandboxes = fs::read_dir(directory.path().join(".stryker-tmp"))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(sandboxes.len(), 2);
    for sandbox in sandboxes {
        assert!(sandbox.path().join("src/add.js").is_file());
    }
    assert_eq!(
        fs::read_to_string(directory.path().join("src/add.js")).unwrap(),
        SOURCE
    );
}

#[tokio::test]
async fn stdout_and_stderr_larger_than_exec_maxbuffer_are_fully_drained() {
    let directory = fixture(
        "process.stdout.write('x'.repeat(2*1024*1024)); process.stderr.write('y'.repeat(2*1024*1024));",
    );
    let response = execute(directory.path(), json!({"mutate":[]}))
        .await
        .unwrap();
    assert_eq!(response["supported"], true);
    assert_eq!(response["stats"]["commandStarts"], 1);
    assert_eq!(response["stats"]["outputTruncations"], 0);
    clean(directory.path());
}

#[tokio::test]
async fn command_output_is_concatenated_without_invented_chunk_newlines_and_is_bounded() {
    let directory = fixture("");
    let (cancel, _) = watch::channel(false);
    let outcome = process::run(
        "printf first; sleep 0.03; printf second",
        directory.path(),
        None,
        "test-output-worker",
        2000.0,
        cancel.subscribe(),
    )
    .await
    .unwrap();
    assert_eq!(outcome.output, "firstsecond");
    let outcome = process::run(
        "node -e \"process.stdout.write('x'.repeat(9*1024*1024))\"",
        directory.path(),
        None,
        "test-output-worker",
        5000.0,
        cancel.subscribe(),
    )
    .await
    .unwrap();
    assert!(outcome.status.unwrap().success());
    assert!(outcome.truncated);
    assert!(outcome.output.len() < 8 * 1024 * 1024 + 100);
}

#[tokio::test]
async fn each_concurrent_worker_has_its_own_persistent_sandbox() {
    let directory = fixture(
        "import fs from 'node:fs'; const worker=process.env.STRYKER_MUTATOR_WORKER;if(worker===undefined)throw Error('missing worker ID');if(fs.existsSync('worker-id')&&fs.readFileSync('worker-id','utf8')!==worker)throw Error('worker ID changed');fs.writeFileSync('worker-id',worker); if (fs.existsSync('command.lock')) process.exit(17); fs.writeFileSync('command.lock','owned'); await new Promise(r => setTimeout(r,80)); fs.unlinkSync('command.lock'); const previous = fs.existsSync('state') ? Number(fs.readFileSync('state','utf8')) : 0; fs.writeFileSync('state',String(previous+1));",
    );
    let response = execute(directory.path(), json!({"cleanTempDir":false}))
        .await
        .unwrap();
    assert_eq!(response["supported"], true);
    assert_eq!(response["stats"]["maximumConcurrency"], 2);
    assert!(
        response["mutants"]
            .as_array()
            .unwrap()
            .iter()
            .all(|mutant| mutant["status"] == "Survived"),
        "{response}"
    );
    let sandboxes = fs::read_dir(directory.path().join(".stryker-tmp"))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(sandboxes.len(), 2);
    let mut executions = 0;
    let mut ids = std::collections::HashSet::new();
    for sandbox in sandboxes {
        ids.insert(fs::read_to_string(sandbox.path().join("worker-id")).unwrap());
        assert!(!sandbox.path().join("command.lock").exists());
        let count = fs::read_to_string(sandbox.path().join("state"))
            .unwrap()
            .parse::<usize>()
            .unwrap();
        assert!(
            count > 1,
            "state must persist across sequential fresh commands on a worker"
        );
        executions += count;
    }
    assert_eq!(
        executions as u64,
        response["stats"]["commandStarts"].as_u64().unwrap()
    );
    if let Ok(inherited) = std::env::var("STRYKER_MUTATOR_WORKER") {
        assert_eq!(ids, std::collections::HashSet::from([inherited]));
    } else {
        assert_eq!(ids.len(), 2);
    }
    assert!(!directory.path().join("state").exists());
}

#[tokio::test]
async fn baseline_and_mutant_deadlines_kill_commands_and_cleanup() {
    let directory = fixture("await new Promise(r => setTimeout(r,30000));");
    let error = execute(directory.path(), json!({"dryRunTimeoutMinutes":0.002}))
        .await
        .unwrap_err();
    assert!(error.contains("Baseline command timed out"));
    clean(directory.path());
    fs::write(
        directory.path().join("test.mjs"),
        "if(process.env.__STRYKER_ACTIVE_MUTANT__) await new Promise(r=>setTimeout(r,30000));",
    )
    .unwrap();
    let response = execute(directory.path(), json!({"timeoutMS":100}))
        .await
        .unwrap();
    assert!(
        response["mutants"]
            .as_array()
            .unwrap()
            .iter()
            .all(|mutant| mutant["status"] == "Timeout")
    );
    assert_eq!(
        response["stats"]["timeouts"].as_u64().unwrap(),
        response["mutants"].as_array().unwrap().len() as u64
    );
    clean(directory.path());
}

#[cfg(unix)]
fn running(pid: i32) -> bool {
    use nix::{sys::signal::kill, unistd::Pid};
    if kill(Pid::from_raw(pid), None).is_err() {
        return false;
    }
    // Container PID 1 may defer adopted-grandchild reaping; a zombie is dead,
    // while every direct Rust child was already waited before run settlement.
    if let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat"))
        && stat
            .rsplit_once(") ")
            .is_some_and(|(_, tail)| tail.starts_with('Z'))
    {
        return false;
    }
    true
}

async fn wait_for_lines(path: &Path, count: usize) -> Vec<i32> {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let pids = fs::read_to_string(path)
                .unwrap_or_default()
                .lines()
                .filter_map(|line| line.parse().ok())
                .collect::<Vec<_>>();
            if pids.len() >= count {
                return pids;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("commands must start")
}

#[tokio::test]
#[cfg(unix)]
async fn cancellation_waits_for_all_running_process_groups_and_cleanup() {
    let directory = fixture("");
    let pid_file = directory.path().join("pids");
    let encoded = serde_json::to_string(&pid_file.to_string_lossy()).unwrap();
    let script = format!(
        "import fs from 'node:fs'; import {{spawn}} from 'node:child_process'; if(process.env.__STRYKER_ACTIVE_MUTANT__) {{ const child=spawn(process.execPath,['-e','setInterval(()=>{{}},1000)'],{{stdio:'ignore'}}); fs.appendFileSync({encoded}, process.pid+'\\n'+child.pid+'\\n'); await new Promise(r=>setTimeout(r,30000)); }}"
    );
    fs::write(directory.path().join("test.mjs"), script).unwrap();
    let (cancel, _) = watch::channel(false);
    let input = request(directory.path(), json!({"timeoutMS":30000}));
    let task = tokio::spawn({
        let cancel = cancel.clone();
        async move { run(&input, cancel).await }
    });
    let pids = wait_for_lines(&pid_file, 4).await;
    assert!(pids.iter().all(|pid| running(*pid)));
    cancel.send_replace(true);
    let error = task.await.unwrap().unwrap_err();
    assert!(error.contains("cancelled"));
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(
        pids.iter().all(|pid| !running(*pid)),
        "all command descendants must be dead after cancellation settles"
    );
    clean(directory.path());
}

#[tokio::test]
async fn escaped_command_pipe_holder_returns_cleanup_failure_instead_of_false_cancellation() {
    struct EscapedHolder(i32);
    impl Drop for EscapedHolder {
        fn drop(&mut self) {
            use nix::{
                sys::signal::{Signal, killpg},
                unistd::Pid,
            };
            let _ = killpg(Pid::from_raw(self.0), Signal::SIGKILL);
        }
    }
    let directory = fixture("");
    let pid_file = directory.path().join("escaped-pids");
    let encoded = serde_json::to_string(&pid_file.to_string_lossy()).unwrap();
    let script = format!(
        "import fs from 'node:fs';import {{spawn}} from 'node:child_process';const child=spawn(process.execPath,['-e','setInterval(()=>{{}},1000)'],{{detached:true,stdio:'inherit'}});fs.writeFileSync({encoded},process.pid+'\\n'+child.pid+'\\n');child.unref();await new Promise(r=>setTimeout(r,30000));"
    );
    fs::write(directory.path().join("test.mjs"), script).unwrap();
    let input = request(directory.path(), json!({}));
    let (cancel, _) = watch::channel(false);
    let task_cancel = cancel.clone();
    let task = tokio::spawn(async move { run(&input, task_cancel).await });
    let pids = wait_for_lines(&pid_file, 2).await;
    let _holder = EscapedHolder(pids[1]);
    cancel.send_replace(true);
    let error = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("held pipe must not hang native cancellation")
        .unwrap()
        .unwrap_err();
    assert!(error.contains("output pipes remained open"), "{error}");
    assert_ne!(error, "Native mutation run cancelled");
    assert!(
        running(pids[1]),
        "escaped fixture remains alive until the test guard kills it"
    );
    clean(directory.path());
}

#[tokio::test]
async fn sibling_pipe_cleanup_failure_is_not_masked_by_an_earlier_cancelled_command() {
    struct FixtureProcesses {
        cancellation: watch::Sender<bool>,
        registrations: Vec<std::path::PathBuf>,
    }
    impl Drop for FixtureProcesses {
        fn drop(&mut self) {
            use nix::{
                sys::signal::{Signal, killpg},
                unistd::{Pid, getpgid},
            };
            self.cancellation.send_replace(true);
            for path in &self.registrations {
                if let Ok(value) = fs::read_to_string(path)
                    && let Ok(pid) = value.parse::<i32>()
                    && let Ok(group) = getpgid(Some(Pid::from_raw(pid)))
                {
                    let _ = killpg(group, Signal::SIGKILL);
                }
            }
        }
    }
    let directory = fixture("");
    let fast_pid = directory.path().join("fast.pid");
    let slow_pid = directory.path().join("slow.pid");
    let holder_pid = directory.path().join("holder.pid");
    let holder_ready = directory.path().join("holder.ready");
    let encoded = |path: &Path| serde_json::to_string(&path.to_string_lossy()).unwrap();
    let holder_script = format!(
        "require('node:fs').writeFileSync({},String(process.pid));setInterval(()=>{{}},1000);",
        encoded(&holder_ready)
    );
    let script = format!(
        "import fs from 'node:fs';import {{spawn}} from 'node:child_process';const id=process.env.__STRYKER_ACTIVE_MUTANT__;if(id===undefined)process.exit(0);if(id==='0'){{fs.writeFileSync({},String(process.pid));}}else{{fs.writeFileSync({},String(process.pid));const child=spawn(process.execPath,['-e',{}],{{detached:true,stdio:'inherit'}});fs.writeFileSync({},String(child.pid));child.unref();}}await new Promise(r=>setTimeout(r,30000));",
        encoded(&fast_pid),
        encoded(&slow_pid),
        serde_json::to_string(&holder_script).unwrap(),
        encoded(&holder_pid)
    );
    fs::write(directory.path().join("test.mjs"), script).unwrap();
    let input = request(directory.path(), json!({"concurrency":2,"timeoutMS":30000}));
    let (cancel, _) = watch::channel(false);
    let _processes = FixtureProcesses {
        cancellation: cancel.clone(),
        registrations: vec![holder_pid, slow_pid, fast_pid.clone()],
    };
    let task_cancel = cancel.clone();
    let task = tokio::spawn(async move { run(&input, task_cancel).await });
    let holder = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if fs::read_to_string(&fast_pid).is_ok()
                && let Ok(value) = fs::read_to_string(&holder_ready)
                && let Ok(pid) = value.parse::<i32>()
            {
                break pid;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("both mutant commands and the escaped holder must be ready");
    cancel.send_replace(true);
    let error = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("all command tasks must settle after bounded pipe draining")
        .unwrap()
        .unwrap_err();
    assert!(error.contains("output pipes remained open"), "{error}");
    assert_ne!(error, "Native mutation run cancelled");
    assert!(
        running(holder),
        "the escaped fixture must hold the sibling pipe until test cleanup"
    );
    clean(directory.path());
}

#[tokio::test]
async fn cancellation_before_compute_starts_no_children_or_file_writes() {
    let directory = fixture("throw new Error('must not start');");
    let (cancel, _) = watch::channel(false);
    cancel.send_replace(true);
    assert!(
        run(&request(directory.path(), json!({})), cancel)
            .await
            .unwrap_err()
            .contains("cancelled")
    );
    assert!(!directory.path().join("reports").exists());
    clean(directory.path());
}

#[test]
fn cancellation_ids_are_registered_before_queue_and_released_on_task_drop() {
    let id = format!("rust-unit-{}", std::process::id());
    let queued = task("{}".into(), Some(id.clone())).unwrap();
    assert!(cancel(&id));
    assert!(task("{}".into(), Some(id.clone())).is_err());
    drop(queued);
    assert!(!cancel(&id));
}
