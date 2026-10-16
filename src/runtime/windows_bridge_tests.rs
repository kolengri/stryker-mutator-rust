use std::{
    fs,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    path::Path,
    process::Command,
};

use windows_sys::Win32::{
    Foundation::WAIT_OBJECT_0,
    System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
};

use super::*;

const DEADLINE: Duration = Duration::from_secs(20);

fn spec(directory: &Path) -> BridgeSpec {
    let node = Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .expect("Node is installed");
    assert!(node.status.success());
    let module = directory.join("worker with spaces.mjs");
    fs::write(&module, r#"
import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const code = `
  const {spawn} = require('node:child_process');
  const fs = require('node:fs');
  const leaf = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'inherit'});
  fs.writeFileSync('descendants.json', JSON.stringify([process.pid, leaf.pid]));
  setInterval(() => {}, 1000);
`;
const [host, port] = process.env.STRYKER_RUST_BRIDGE_ADDRESS.split(':');
const token = process.env.STRYKER_RUST_BRIDGE_TOKEN;
delete process.env.STRYKER_RUST_BRIDGE_TOKEN;
spawn(process.execPath, ['-e', code], {stdio:'inherit'});
const socket = net.createConnection({host,port:Number(port)});
const send = frame => socket.write(JSON.stringify(frame)+'\n');
socket.on('connect', () => send({version:1,event:'hello',params:{token,pid:process.pid}}));
let input = '';
socket.on('data', chunk => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf('\n')) >= 0) {
    const request = JSON.parse(input.slice(0,newline));
    input = input.slice(newline+1);
    if (request.method === 'exit') process.exit(0);
    if (request.method === 'dispose') {
      socket.write(JSON.stringify({version:1,id:request.id,result:null})+'\n', () => process.exit(0));
    }
  }
});
socket.on('error', () => {});
"#).unwrap();
    BridgeSpec {
        node_executable: String::from_utf8(node.stdout).unwrap().trim().into(),
        bridge_module: module,
        cwd: directory.into(),
        trace_output: false,
    }
}

async fn process_handles(directory: &Path, root: u32) -> Vec<OwnedHandle> {
    let path = directory.join("descendants.json");
    let mut pids: Vec<u32> = tokio::time::timeout(DEADLINE, async {
        loop {
            if let Ok(bytes) = fs::read(&path)
                && let Ok(pids) = serde_json::from_slice::<Vec<u32>>(&bytes)
            {
                break pids;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    pids.push(root);
    pids.into_iter()
        .map(|pid| {
            // SAFETY: only a non-inheritable waitable process handle is requested.
            let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
            assert!(!raw.is_null(), "{}", std::io::Error::last_os_error());
            // SAFETY: successful OpenProcess returns exactly one owned handle.
            unsafe { OwnedHandle::from_raw_handle(raw) }
        })
        .collect()
}

fn assert_exited(handles: &[OwnedHandle]) {
    for (index, handle) in handles.iter().enumerate() {
        // SAFETY: the retained handle prevents PID reuse from affecting proof.
        assert_eq!(
            unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) },
            WAIT_OBJECT_0,
            "process handle {index} was not signaled at bridge settlement"
        );
    }
}

#[tokio::test]
async fn windows_bridge_cancellation_timeout_root_exit_and_dispose_await_the_entire_job() {
    for mode in ["cancel", "timeout", "exit", "dispose"] {
        let directory = tempfile::Builder::new()
            .prefix("bridge & spaces ")
            .tempdir()
            .unwrap();
        let (cancel, cancellation) = watch::channel(false);
        let mut bridge = BridgeSession::start(spec(directory.path()), DEADLINE, cancellation)
            .await
            .unwrap();
        let handles = process_handles(directory.path(), bridge.pid()).await;
        match mode {
            "dispose" => {
                bridge.dispose(DEADLINE).await.unwrap();
            }
            "cancel" => {
                cancel.send_replace(true);
                assert_eq!(
                    bridge
                        .call("pending", json!(null), DEADLINE)
                        .await
                        .unwrap_err(),
                    BridgeError::Cancelled
                );
            }
            "timeout" => {
                assert!(matches!(
                    bridge
                        .call("pending", json!(null), Duration::from_millis(30))
                        .await,
                    Err(BridgeError::Timeout { .. })
                ));
            }
            _ => {
                assert!(matches!(
                    bridge.call("exit", json!(null), DEADLINE).await,
                    Err(BridgeError::Process(_))
                ));
            }
        }
        assert_exited(&handles);
        bridge.dispose(DEADLINE).await.unwrap();
    }
}

#[tokio::test]
async fn windows_bridge_retains_cleanup_failure_instead_of_cancellation() {
    let directory = tempfile::tempdir().unwrap();
    let (cancel, cancellation) = watch::channel(false);
    let mut bridge = BridgeSession::start(spec(directory.path()), DEADLINE, cancellation)
        .await
        .unwrap();
    let handles = process_handles(directory.path(), bridge.pid()).await;
    // Hold an actual AsyncRead pipe independently of the owned job to exercise
    // the bounded-drain failure path without pretending detached:true escapes a job.
    let old_reader = bridge.stdout.take().unwrap();
    old_reader.abort();
    let _ = old_reader.await;
    let (pipe, _held_writer) = tokio::io::duplex(64);
    bridge.stdout = Some(tokio::spawn(drain(
        pipe,
        bridge.capture.clone(),
        false,
        false,
    )));
    cancel.send_replace(true);
    let error = bridge
        .call("pending", json!(null), DEADLINE)
        .await
        .unwrap_err();
    assert!(
        matches!(&error, BridgeError::Cleanup(message) if message.contains("output pipes remained open")),
        "{error}"
    );
    assert_exited(&handles);
    assert_eq!(bridge.dispose(DEADLINE).await.unwrap_err(), error);
    assert_eq!(
        bridge
            .call("pending", json!(null), DEADLINE)
            .await
            .unwrap_err(),
        error
    );
}
