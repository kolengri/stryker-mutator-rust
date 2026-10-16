use std::{fs, path::Path, process::Command, time::Duration};

use serde_json::json;
use tokio::sync::watch;

use super::bridge::{BridgeError, BridgeSession, BridgeSpec};

const DEADLINE: Duration = Duration::from_secs(10);

fn node() -> std::path::PathBuf {
    let output = Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .expect("Node is installed");
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().trim().into()
}

fn spec(directory: &Path, worker: impl Into<std::path::PathBuf>) -> BridgeSpec {
    BridgeSpec {
        node_executable: node(),
        bridge_module: worker.into(),
        cwd: directory.into(),
        trace_output: false,
    }
}

fn alive(pid: u32) -> bool {
    use nix::{errno::Errno, sys::signal::kill, unistd::Pid};
    !matches!(kill(Pid::from_raw(pid as i32), None), Err(Errno::ESRCH))
}

fn fake_worker(directory: &Path, body: &str) -> std::path::PathBuf {
    let worker = directory.join("worker.mjs");
    fs::write(
        &worker,
        format!(
            r#"
import net from 'node:net';
import fs from 'node:fs';
import {{ spawn }} from 'node:child_process';
fs.writeFileSync('worker.pid', String(process.pid));
const token = process.env.STRYKER_RUST_BRIDGE_TOKEN;
const [host, port] = process.env.STRYKER_RUST_BRIDGE_ADDRESS.split(':');
const socket = net.createConnection({{ host, port: Number(port) }});
const send = (frame) => socket.write(JSON.stringify(frame) + '\n');
socket.on('end', () => socket.end());
socket.on('error', () => {{}});
{body}
"#
        ),
    )
    .unwrap();
    worker
}

#[tokio::test]
async fn real_worker_di_logs_output_and_remote_errors_keep_sdk_payloads() {
    let directory = tempfile::tempdir().unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let (cancel, cancellation) = watch::channel(false);
    let mut bridge = BridgeSession::start(
        spec(directory.path(), root.join("lib/compat/worker.js")),
        DEADLINE,
        cancellation,
    )
    .await
    .unwrap();
    let pid = bridge.pid();
    let metadata = bridge.call("prepare", json!({
        "cwd":directory.path(), "modules":[root.join("test/fixtures/compatibility-bridge/plugin.js")],
    }), DEADLINE).await.unwrap();
    assert_eq!(metadata["sdkVersion"], "10.0.0");
    assert!(
        bridge.diagnostics().stdout.is_empty(),
        "prepare must not construct plugins"
    );
    let initialized = bridge.call("initialize", json!({
        "cwd": directory.path(), "options": {"nested":{}, "logLevel":"debug"}, "fileDescriptions":{},
        "modules":[root.join("test/fixtures/compatibility-bridge/plugin.js")],
        "plugin":{"kind":"TestRunner","name":"class"},
    }), DEADLINE).await.unwrap();
    assert_eq!(initialized["plugin"]["name"], "class");
    bridge
        .call("runner.init", json!(null), DEADLINE)
        .await
        .unwrap();
    let result = bridge
        .call("runner.dryRun", json!({"label":"actual"}), DEADLINE)
        .await
        .unwrap();
    assert_eq!(result["params"], json!({"label":"actual"}));
    let error = bridge
        .call("runner.dryRun", json!({"error":"error"}), DEADLINE)
        .await
        .unwrap_err();
    match error {
        BridgeError::Remote(error) => {
            assert_eq!(error.name, "TypeError");
            assert_eq!(error.message, "plugin failure");
            assert!(error.stack.unwrap().contains("plugin.js"));
        }
        other => panic!("Expected remote plugin error, got {other:?}"),
    }
    assert!(
        alive(pid),
        "recoverable SDK rejection retains its owned worker"
    );
    assert_eq!(
        bridge
            .call("runner.dryRun", json!({"label":"recovered"}), DEADLINE)
            .await
            .unwrap()["status"],
        "complete"
    );
    bridge.dispose(DEADLINE).await.unwrap();
    bridge.dispose(DEADLINE).await.unwrap();
    assert!(!alive(pid));
    let diagnostics = bridge.diagnostics();
    assert!(
        diagnostics
            .stdout
            .contains("direct stdout without a newline")
    );
    assert!(diagnostics.stderr.contains("plugin stderr"));
    assert!(!diagnostics.output_truncated);
    assert_eq!(diagnostics.dropped_events, 0);
    assert!(
        bridge
            .take_events()
            .iter()
            .any(|frame| frame["params"]["category"] == "ExampleRunner")
    );
    drop(cancel);
}

#[tokio::test]
async fn startup_authentication_failure_and_startup_timeout_reap_the_worker() {
    for (body, timed_out) in [
        (
            "socket.on('connect', () => send({version:1,event:'hello',params:{token:'wrong',pid:process.pid}}));",
            false,
        ),
        ("setInterval(() => {}, 1000);", true),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let worker = fake_worker(directory.path(), body);
        let (_cancel, cancellation) = watch::channel(false);
        let result = BridgeSession::start(
            spec(directory.path(), worker),
            if timed_out {
                Duration::from_millis(300)
            } else {
                DEADLINE
            },
            cancellation,
        )
        .await;
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("Invalid worker must fail startup"),
        };
        assert!(if timed_out {
            matches!(error, BridgeError::Timeout { .. })
        } else {
            matches!(error, BridgeError::Protocol(_))
        });
        let pid = fs::read_to_string(directory.path().join("worker.pid"))
            .unwrap()
            .parse()
            .unwrap();
        assert!(!alive(pid), "startup errors must settle after reaping");
    }
}

#[tokio::test]
async fn request_protocol_failure_and_worker_exit_are_fatal_and_reaped() {
    for (response, protocol) in [
        ("send({version:1,id:request.id+1,result:{}});", true),
        ("socket.write('{bad JSON\\n');", true),
        (
            "send({version:1,id:request.id,result:{},error:{name:'Error',message:'both'}});",
            true,
        ),
        ("socket.write('x'.repeat(8*1024*1024+1));", true),
        ("process.exit(7);", false),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let worker = fake_worker(
            directory.path(),
            &format!(
                r#"
socket.on('connect', () => send({{version:1,event:'hello',params:{{token,pid:process.pid}}}}));
socket.on('data', (chunk) => {{ const request = JSON.parse(chunk.toString()); {response} }});
"#
            ),
        );
        let (_cancel, cancellation) = watch::channel(false);
        let mut bridge =
            BridgeSession::start(spec(directory.path(), worker), DEADLINE, cancellation)
                .await
                .unwrap();
        let pid = bridge.pid();
        let error = bridge
            .call("initialize", json!({}), DEADLINE)
            .await
            .unwrap_err();
        assert!(
            if protocol {
                matches!(error, BridgeError::Protocol(_))
            } else {
                matches!(error, BridgeError::Process(_))
            },
            "{error:?}"
        );
        assert!(!alive(pid));
        bridge.dispose(DEADLINE).await.unwrap();
    }
}

#[tokio::test]
async fn timeout_and_cancellation_kill_the_worker_group_and_reap_before_settlement() {
    for cancel_run in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let worker = fake_worker(
            directory.path(),
            r#"
socket.on('connect', () => send({version:1,event:'hello',params:{token,pid:process.pid}}));
socket.on('data', () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'inherit'});
  fs.writeFileSync('descendant.pid', String(child.pid));
  setInterval(() => {}, 1000);
});
"#,
        );
        let (cancel, cancellation) = watch::channel(false);
        let mut bridge =
            BridgeSession::start(spec(directory.path(), worker), DEADLINE, cancellation)
                .await
                .unwrap();
        let pid = bridge.pid();
        let descendant_file = directory.path().join("descendant.pid");
        let trigger = async {
            if !cancel_run {
                return;
            }
            tokio::time::timeout(DEADLINE, async {
                while !descendant_file.exists() {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                cancel.send_replace(true);
            })
            .await
            .unwrap();
        };
        let (result, ()) = tokio::join!(
            bridge.call(
                "runner.dryRun",
                json!({}),
                if cancel_run {
                    DEADLINE
                } else {
                    Duration::from_millis(300)
                }
            ),
            trigger
        );
        let error = result.unwrap_err();
        assert!(if cancel_run {
            matches!(error, BridgeError::Cancelled)
        } else {
            matches!(error, BridgeError::Timeout { .. })
        });
        assert!(!alive(pid));
        let descendant: u32 = fs::read_to_string(descendant_file)
            .unwrap()
            .parse()
            .unwrap();
        // An orphan descendant can briefly remain a zombie until its system
        // parent reaps it; it must no longer be executing after settlement.
        let status = Command::new("ps")
            .args(["-o", "stat=", "-p", &descendant.to_string()])
            .output()
            .unwrap();
        let state = String::from_utf8_lossy(&status.stdout);
        assert!(
            !alive(descendant) || state.trim_start().starts_with('Z'),
            "descendant still running: {state}"
        );
    }
}

#[tokio::test]
async fn output_and_idle_log_capture_are_bounded_without_corrupting_responses() {
    let directory = tempfile::tempdir().unwrap();
    let worker = fake_worker(
        directory.path(),
        r#"
socket.on('connect', () => {
  send({version:1,event:'hello',params:{token,pid:process.pid}});
  fs.writeSync(1, 'o'.repeat(2*1024*1024));
  fs.writeSync(2, 'e'.repeat(2*1024*1024));
  for (let i=0;i<400;i++) send({version:1,event:'log',params:{level:'info',category:'fixture',message:String(i),args:[]}});
});
socket.on('data', (chunk) => { const request=JSON.parse(chunk.toString()); send({version:1,id:request.id,result:{ok:true}}); });
"#,
    );
    let (_cancel, cancellation) = watch::channel(false);
    let mut bridge = BridgeSession::start(spec(directory.path(), worker), DEADLINE, cancellation)
        .await
        .unwrap();
    assert_eq!(
        bridge
            .call("runner.capabilities", json!(null), DEADLINE)
            .await
            .unwrap(),
        json!({"ok":true})
    );
    bridge.dispose(DEADLINE).await.unwrap();
    let diagnostics = bridge.diagnostics();
    assert_eq!(diagnostics.stdout.len(), 1024 * 1024);
    assert_eq!(diagnostics.stderr.len(), 1024 * 1024);
    assert!(diagnostics.output_truncated);
    assert_eq!(diagnostics.dropped_events, 144);
    let events = bridge.take_events();
    assert_eq!(events.len(), 256);
    assert_eq!(events.first().unwrap()["params"]["message"], "144");
    assert!(bridge.take_events().is_empty());
}

#[tokio::test]
async fn remote_disposal_failure_is_retained_and_child_reaped_once() {
    let directory = tempfile::tempdir().unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let (_cancel, cancellation) = watch::channel(false);
    let mut bridge = BridgeSession::start(
        spec(directory.path(), root.join("lib/compat/worker.js")),
        DEADLINE,
        cancellation,
    )
    .await
    .unwrap();
    let pid = bridge.pid();
    bridge.call("initialize", json!({
        "cwd":directory.path(), "options":{}, "fileDescriptions":{},
        "modules":[root.join("test/fixtures/compatibility-bridge/plugin.js")], "plugin":{"kind":"TestRunner","name":"bad-dispose"},
    }), DEADLINE).await.unwrap();
    let cleanup_file = directory.path().join("cleanup.txt");
    bridge
        .call(
            "runner.dryRun",
            json!({"cleanupFile":cleanup_file}),
            DEADLINE,
        )
        .await
        .unwrap();
    let first = bridge.dispose(DEADLINE).await.unwrap_err();
    assert!(matches!(first, BridgeError::Remote(_)));
    assert_eq!(bridge.dispose(DEADLINE).await.unwrap_err(), first);
    assert!(!alive(pid));
    assert_eq!(fs::read_to_string(cleanup_file).unwrap(), "bad dispose\n");
}

#[tokio::test]
async fn aggregate_disposal_errors_preserve_nested_details_after_ancestor_cleanup_and_reaping() {
    let directory = tempfile::tempdir().unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let (_cancel, cancellation) = watch::channel(false);
    let mut bridge = BridgeSession::start(
        spec(directory.path(), root.join("lib/compat/worker.js")),
        DEADLINE,
        cancellation,
    )
    .await
    .unwrap();
    let pid = bridge.pid();
    let cleanup_file = directory.path().join("cleanup.txt");
    bridge.call("initialize", json!({
        "cwd":directory.path(), "options":{"cleanupFile":cleanup_file}, "fileDescriptions":{},
        "modules":[root.join("test/fixtures/compatibility-bridge/plugin.js")], "plugin":{"kind":"TestRunner","name":"cleanup-errors"},
    }), DEADLINE).await.unwrap();
    let error = bridge.dispose(DEADLINE).await.unwrap_err();
    match &error {
        BridgeError::Remote(error) => {
            assert_eq!(error.name, "AggregateError");
            let nested = error.errors.as_ref().unwrap();
            assert_eq!(nested.len(), 2);
            assert!(
                nested
                    .iter()
                    .any(|error| error.name == "TypeError"
                        && error.message == "sync cleanup failure")
            );
            assert!(nested.iter().any(
                |error| error.name == "RangeError" && error.message == "async cleanup failure"
            ));
            assert!(
                nested
                    .iter()
                    .all(|error| error.stack.as_ref().unwrap().contains("plugin.js"))
            );
        }
        other => panic!("Expected aggregate remote error, got {other:?}"),
    }
    assert_eq!(bridge.dispose(DEADLINE).await.unwrap_err(), error);
    assert!(!alive(pid));
    let cleanup = fs::read_to_string(cleanup_file).unwrap();
    let events: Vec<_> = cleanup.lines().collect();
    assert_eq!(events.len(), 3);
    assert_eq!(events.last(), Some(&"ancestor plugin disposed"));
}

#[tokio::test]
async fn failed_output_cleanup_is_distinct_from_cancellation_and_retained() {
    struct EscapedFixture(u32);
    impl Drop for EscapedFixture {
        fn drop(&mut self) {
            use nix::{
                sys::signal::{Signal, killpg},
                unistd::Pid,
            };
            let _ = killpg(Pid::from_raw(self.0 as i32), Signal::SIGKILL);
        }
    }
    let directory = tempfile::tempdir().unwrap();
    let worker = fake_worker(
        directory.path(),
        r#"
socket.on('connect', () => send({version:1,event:'hello',params:{token,pid:process.pid}}));
socket.on('data', () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached:true,stdio:'inherit'});
  fs.writeFileSync('escaped.pid', String(child.pid));
  child.unref();
});
"#,
    );
    let (cancel, cancellation) = watch::channel(false);
    let mut bridge = BridgeSession::start(spec(directory.path(), worker), DEADLINE, cancellation)
        .await
        .unwrap();
    let pid = bridge.pid();
    let escaping_pid_file = directory.path().join("escaped.pid");
    let trigger = async {
        tokio::time::timeout(DEADLINE, async {
            while !escaping_pid_file.exists() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let escaped = EscapedFixture(
            fs::read_to_string(escaping_pid_file)
                .unwrap()
                .parse()
                .unwrap(),
        );
        cancel.send_replace(true);
        escaped
    };
    let (result, _escaped_cleanup) =
        tokio::join!(bridge.call("runner.dryRun", json!({}), DEADLINE), trigger);
    let error = result.unwrap_err();
    assert!(
        matches!(&error, BridgeError::Cleanup(message) if message.contains("output pipes remained open")),
        "{error:?}"
    );
    assert!(!alive(pid));
    assert_eq!(bridge.dispose(DEADLINE).await.unwrap_err(), error);
    assert_eq!(
        bridge
            .call("runner.capabilities", json!(null), DEADLINE)
            .await
            .unwrap_err(),
        error
    );
}

#[tokio::test]
async fn trace_visibility_and_caller_worker_marker_are_verified_in_isolated_processes() {
    const FLAG: &str = "STRYKER_BRIDGE_TRACE_VISIBILITY_TEST";
    const RAW_STDOUT: &str = "TRACE_BRIDGE_RAW_STDOUT_MARKER\n";
    const RAW_STDERR: &str = "TRACE_BRIDGE_RAW_STDERR_MARKER\n";
    if let Ok(mode) = std::env::var(FLAG) {
        let directory = tempfile::tempdir().unwrap();
        let worker = fake_worker(
            directory.path(),
            r#"
socket.on('connect', () => {
  send({version:1,event:'hello',params:{token,pid:process.pid}});
  fs.writeSync(1, 'TRACE_BRIDGE_RAW_STDOUT_MARKER\n');
  fs.writeSync(2, 'TRACE_BRIDGE_RAW_STDERR_MARKER\n');
});
socket.on('data', (chunk) => {
  const request=JSON.parse(chunk.toString());
  send({version:1,id:request.id,result:{worker:process.env.STRYKER_MUTATOR_WORKER}});
});
"#,
        );
        let mut specification = spec(directory.path(), worker);
        specification.trace_output = mode == "trace";
        let (_cancel, cancellation) = watch::channel(false);
        let mut bridge = BridgeSession::start(specification, DEADLINE, cancellation)
            .await
            .unwrap();
        let first = bridge
            .call("runner.capabilities", json!(null), DEADLINE)
            .await
            .unwrap();
        let second = bridge
            .call("runner.capabilities", json!(null), DEADLINE)
            .await
            .unwrap();
        assert_eq!(first, json!({"worker":"explicit-caller-worker"}));
        assert_eq!(second, first);
        bridge.dispose(DEADLINE).await.unwrap();
        assert_eq!(bridge.diagnostics().stdout, RAW_STDOUT);
        assert_eq!(bridge.diagnostics().stderr, RAW_STDERR);
        return;
    }
    for mode in ["off", "trace"] {
        let output = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "runtime::bridge_tests::trace_visibility_and_caller_worker_marker_are_verified_in_isolated_processes", "--nocapture"])
            .env(FLAG, mode).env("STRYKER_MUTATOR_WORKER", "explicit-caller-worker")
            .output().await.unwrap();
        assert!(
            output.status.success(),
            "isolated {mode} fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).contains(RAW_STDOUT),
            mode == "trace"
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stderr).contains(RAW_STDERR),
            mode == "trace"
        );
    }
}

#[tokio::test]
async fn generated_worker_markers_are_stable_per_physical_session() {
    let mut markers = Vec::new();
    for _ in 0..2 {
        let directory = tempfile::tempdir().unwrap();
        let worker = fake_worker(
            directory.path(),
            r#"
socket.on('connect', () => send({version:1,event:'hello',params:{token,pid:process.pid}}));
socket.on('data', (chunk) => {
  const request=JSON.parse(chunk.toString());
  send({version:1,id:request.id,result:{worker:process.env.STRYKER_MUTATOR_WORKER}});
});
"#,
        );
        let (_cancel, cancellation) = watch::channel(false);
        let mut bridge =
            BridgeSession::start(spec(directory.path(), worker), DEADLINE, cancellation)
                .await
                .unwrap();
        let first = bridge
            .call("runner.capabilities", json!(null), DEADLINE)
            .await
            .unwrap();
        let second = bridge
            .call("runner.capabilities", json!(null), DEADLINE)
            .await
            .unwrap();
        assert_eq!(first, second);
        let marker = first["worker"]
            .as_str()
            .expect("worker marker must exist")
            .to_owned();
        if let Ok(inherited) = std::env::var("STRYKER_MUTATOR_WORKER") {
            assert_eq!(marker, inherited);
        } else {
            assert!(marker.parse::<u64>().is_ok());
        }
        markers.push(marker);
        bridge.dispose(DEADLINE).await.unwrap();
    }
    if std::env::var_os("STRYKER_MUTATOR_WORKER").is_none() {
        assert_ne!(markers[0], markers[1]);
    }
}

#[tokio::test]
async fn crashes_include_bounded_last_output_tails_instead_of_discarded_heads() {
    let directory = tempfile::tempdir().unwrap();
    let worker = fake_worker(
        directory.path(),
        r#"
socket.on('connect', () => send({version:1,event:'hello',params:{token,pid:process.pid}}));
socket.on('data', () => {
  fs.writeSync(1, 'DISCARDED_STDOUT_HEAD' + 'o'.repeat(2*1024*1024) + '\nFINAL_STDOUT_TAIL');
  fs.writeSync(2, 'DISCARDED_STDERR_HEAD' + 'e'.repeat(2*1024*1024) + '\nFINAL_STDERR_TAIL');
  process.exit(7);
});
"#,
    );
    let (_cancel, cancellation) = watch::channel(false);
    let mut bridge = BridgeSession::start(spec(directory.path(), worker), DEADLINE, cancellation)
        .await
        .unwrap();
    let pid = bridge.pid();
    let error = bridge
        .call("runner.dryRun", json!({}), DEADLINE)
        .await
        .unwrap_err();
    let BridgeError::Process(message) = error else {
        panic!("Expected retryable process failure: {error:?}");
    };
    assert!(message.contains("worker output truncated"));
    assert!(message.contains("Worker stdout tail:\n"));
    assert!(message.contains("FINAL_STDOUT_TAIL"));
    assert!(message.contains("Worker stderr tail:\n"));
    assert!(message.ends_with("FINAL_STDERR_TAIL"));
    assert!(!message.contains("DISCARDED_STDOUT_HEAD"));
    assert!(!message.contains("DISCARDED_STDERR_HEAD"));
    let diagnostics = bridge.diagnostics();
    assert_eq!(diagnostics.stdout.len(), 1024 * 1024);
    assert_eq!(diagnostics.stderr.len(), 1024 * 1024);
    assert!(diagnostics.stdout.ends_with("FINAL_STDOUT_TAIL"));
    assert!(diagnostics.stderr.ends_with("FINAL_STDERR_TAIL"));
    assert!(!alive(pid));
    bridge.dispose(DEADLINE).await.unwrap();
}

#[tokio::test]
async fn an_exited_group_leader_does_not_hide_live_descendants() {
    let directory = tempfile::tempdir().unwrap();
    let worker = fake_worker(
        directory.path(),
        r#"
socket.on('connect', () => send({version:1,event:'hello',params:{token,pid:process.pid}}));
socket.on('data', () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'inherit'});
  fs.writeFileSync('descendant.pid', String(child.pid));
  process.exit(7);
});
"#,
    );
    let (_cancel, cancellation) = watch::channel(false);
    let mut bridge = BridgeSession::start(spec(directory.path(), worker), DEADLINE, cancellation)
        .await
        .unwrap();
    let pid = bridge.pid();
    assert!(matches!(
        bridge.call("runner.dryRun", json!({}), DEADLINE).await,
        Err(BridgeError::Process(_))
    ));
    assert!(!alive(pid));
    let descendant: u32 = fs::read_to_string(directory.path().join("descendant.pid"))
        .unwrap()
        .parse()
        .unwrap();
    let status = Command::new("ps")
        .args(["-o", "stat=", "-p", &descendant.to_string()])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&status.stdout);
    assert!(
        !alive(descendant) || state.trim_start().starts_with('Z'),
        "descendant still running: {state}"
    );
    bridge.dispose(DEADLINE).await.unwrap();
}
