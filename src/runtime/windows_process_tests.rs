//! These tests require a real Windows host. Cross-compiling is not execution.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
};

use tokio::sync::watch;
use windows_sys::Win32::{
    Foundation::{ERROR_INVALID_HANDLE, GetHandleInformation, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::Threading::{
        GetCurrentProcess, GetCurrentThreadId, OpenProcess, PROCESS_SYNCHRONIZE,
        WaitForSingleObject,
    },
};

use super::*;
use crate::runtime::process::{Group, run};

const FIXTURE: &str = "runtime::process::windows::tests::fixture_entry";
const READY_DEADLINE: Duration = Duration::from_secs(20);

fn fixture_command(directory: &Path, mode: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", FIXTURE, "--nocapture"])
        .env("STRYKER_WINDOWS_FIXTURE", mode)
        .env("STRYKER_WINDOWS_FIXTURE_DIR", directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

fn wait_file_sync(path: &Path) {
    let deadline = std::time::Instant::now() + READY_DEADLINE;
    while !path.exists() {
        assert!(std::time::Instant::now() < deadline, "{}", path.display());
        std::thread::sleep(Duration::from_millis(10));
    }
}

async fn wait_file(path: &Path) {
    tokio::time::timeout(READY_DEADLINE, async {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

fn record_pid(directory: &Path, name: &str) {
    // Rename publishes a complete PID rather than a just-created empty file.
    let temporary = directory.join(format!("{name}.tmp"));
    fs::write(&temporary, std::process::id().to_string()).unwrap();
    fs::rename(temporary, directory.join(format!("{name}.pid"))).unwrap();
}

#[test]
#[allow(clippy::zombie_processes)] // Deliberately leave descendants for the owning job to terminate.
fn fixture_entry() {
    let Ok(mode) = std::env::var("STRYKER_WINDOWS_FIXTURE") else {
        return;
    };
    let directory = PathBuf::from(std::env::var_os("STRYKER_WINDOWS_FIXTURE_DIR").unwrap());
    let _nested = (mode == "nested").then(|| {
        let job = Job::new().unwrap();
        // SAFETY: this fixture is already in the outer owned job. The empty
        // inner job has no UI limits and can become its child on Windows 8+.
        assert_ne!(
            unsafe { AssignProcessToJobObject(job.raw(), GetCurrentProcess()) },
            0,
            "{}",
            io::Error::last_os_error()
        );
        job
    });
    if mode == "leaf" {
        record_pid(&directory, "leaf");
    } else if mode == "branch" {
        record_pid(&directory, "branch");
        let mut command = fixture_command(&directory, "leaf");
        // Both descendants deliberately keep the root's captured pipes open.
        command.stdout(Stdio::inherit()).stderr(Stdio::inherit());
        let _child = command.as_std_mut().spawn().unwrap();
        wait_file_sync(&directory.join("leaf.pid"));
    } else {
        record_pid(&directory, "root");
        if mode == "deferred" {
            fs::write(directory.join("waiting"), b"waiting").unwrap();
            wait_file_sync(&directory.join("release"));
        }
        let mut command = fixture_command(&directory, "branch");
        command.stdout(Stdio::inherit()).stderr(Stdio::inherit());
        let _child = command.as_std_mut().spawn().unwrap();
        wait_file_sync(&directory.join("leaf.pid"));
        fs::write(directory.join("ready"), b"ready").unwrap();
        if mode == "exit" {
            return;
        }
    }
    std::thread::sleep(Duration::from_secs(120));
    panic!("Windows fixture outlived its owner");
}

fn process_handle(pid: u32) -> OwnedHandle {
    // SAFETY: requesting only a waitable, non-inheritable process handle.
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    assert!(!handle.is_null(), "{}", io::Error::last_os_error());
    // SAFETY: OpenProcess returned one unique handle.
    unsafe { OwnedHandle::from_raw_handle(handle) }
}

fn descendant_handles(directory: &Path) -> Vec<OwnedHandle> {
    ["branch", "leaf"]
        .into_iter()
        .map(|name| {
            let pid = fs::read_to_string(directory.join(format!("{name}.pid")))
                .unwrap()
                .parse()
                .unwrap();
            process_handle(pid)
        })
        .collect()
}

fn assert_exited(handles: &[OwnedHandle]) {
    for (index, handle) in handles.iter().enumerate() {
        // SAFETY: the process handle is retained, so PID reuse cannot fool this.
        assert_eq!(
            unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) },
            WAIT_OBJECT_0,
            "process handle {index} was not signaled at cleanup settlement"
        );
    }
}

fn assert_handle_closed(raw: HANDLE) {
    let mut flags = 0;
    // SAFETY: querying an invalid handle is documented to fail; no ownership is
    // reconstructed or closed here. No handles are allocated after owner drop.
    assert_eq!(unsafe { GetHandleInformation(raw, &mut flags) }, 0);
    assert_eq!(
        io::Error::last_os_error().raw_os_error(),
        Some(ERROR_INVALID_HANDLE as i32)
    );
}

#[tokio::test]
async fn process_creation_failure_is_reported_without_resuming_any_child() {
    let directory = tempfile::tempdir().unwrap();
    let result = spawn(
        &mut Command::new(directory.path().join("missing.exe")),
        "fixture",
    )
    .await;
    assert!(matches!(result, Err(message) if message.contains("Cannot spawn fixture")));
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn successful_root_exit_retains_the_job_and_terminates_live_grandchildren() {
    let directory = tempfile::tempdir().unwrap();
    let (mut child, mut group) =
        Group::spawn(&mut fixture_command(directory.path(), "exit"), "fixture")
            .await
            .unwrap();
    wait_file(&directory.path().join("ready")).await;
    let descendants = descendant_handles(directory.path());
    assert!(
        tokio::time::timeout(READY_DEADLINE, child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    assert!(
        child.raw_handle().is_none(),
        "native Tokio wait has consumed the root handle"
    );
    assert_eq!(group.job.active_processes().unwrap(), 2);
    group.terminate().unwrap();
    group.wait_empty().await.unwrap();
    assert_exited(&descendants);
    group.armed = false;
    let raw = group.job.raw();
    drop(group);
    assert_handle_closed(raw);
}

#[tokio::test]
async fn live_job_deadline_is_an_error_and_drop_is_only_an_emergency_kill() {
    let directory = tempfile::tempdir().unwrap();
    let (mut child, group) =
        Group::spawn(&mut fixture_command(directory.path(), "hold"), "fixture")
            .await
            .unwrap();
    wait_file(&directory.path().join("ready")).await;
    let descendants = descendant_handles(directory.path());
    let error = group
        .job
        .wait_empty(Duration::from_millis(30))
        .await
        .unwrap_err();
    assert!(error.contains("cleanup deadline exceeded"), "{error}");
    assert_eq!(group.job.active_processes().unwrap(), 3);
    for handle in &descendants {
        assert_eq!(
            unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) },
            WAIT_TIMEOUT
        );
    }
    drop(group);
    // Drop requests the kill; this separate wait is the proof in this test.
    tokio::time::timeout(READY_DEADLINE, child.wait())
        .await
        .unwrap()
        .unwrap();
    for handle in &descendants {
        assert_eq!(
            unsafe { WaitForSingleObject(handle.as_raw_handle(), 2000) },
            WAIT_OBJECT_0
        );
    }
}

#[tokio::test]
async fn zero_accounting_does_not_complete_with_an_unsignaled_retained_process() {
    let directory = tempfile::tempdir().unwrap();
    let job = Job::new().unwrap();
    // A real waitable process models the interval between job accounting
    // removal and the process object's signal. No fake wait result is involved.
    let mut child = fixture_command(directory.path(), "leaf").spawn().unwrap();
    let pid = child.id().unwrap();
    job.completion
        .lock()
        .unwrap()
        .pending
        .push((pid, process_handle(pid)));
    assert_eq!(job.active_processes().unwrap(), 0);
    let error = job.wait_empty(Duration::from_millis(30)).await.unwrap_err();
    assert!(
        error.contains("0 active processes, 1 unsignaled process handles"),
        "{error}"
    );
    assert!(child.try_wait().unwrap().is_none());
    child.kill().await.unwrap();
}

#[tokio::test]
async fn a_missing_process_notification_cannot_turn_zero_accounting_into_success() {
    let directory = tempfile::tempdir().unwrap();
    let job = Job::new().unwrap();
    let mut child = fixture_command(directory.path(), "leaf")
        .creation_flags(CREATE_SUSPENDED)
        .spawn()
        .unwrap();
    job.assign(&child).unwrap();
    // Dequeue the real NEW_PROCESS notification, then erase its coverage to
    // model documented non-delivery. The suspended root cannot create children.
    tokio::time::timeout(READY_DEADLINE, async {
        loop {
            job.poll_completion().unwrap();
            if job.completion.lock().unwrap().reported == 1 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    job.completion.lock().unwrap().reported = 0;
    job.terminate().unwrap();
    child.wait().await.unwrap();
    let error = job.wait_empty(Duration::from_millis(30)).await.unwrap_err();
    assert!(error.contains("0 active processes"), "{error}");
    assert!(error.contains("0/1 process notifications"), "{error}");
}

#[tokio::test]
async fn completion_wait_covers_descendants_created_after_waiting_started() {
    let directory = tempfile::tempdir().unwrap();
    let (mut child, mut group) = Group::spawn(
        &mut fixture_command(directory.path(), "deferred"),
        "fixture",
    )
    .await
    .unwrap();
    wait_file(&directory.path().join("waiting")).await;
    // Consume the root notification before descendants exist, then cancel
    // this first wait. The job must retain that coverage across cancellation.
    let mut first = Box::pin(group.wait_empty());
    tokio::select! {
        result = &mut first => panic!("live root completed prematurely: {result:?}"),
        observed = tokio::time::timeout(READY_DEADLINE, async {
            loop {
                if group.job.completion.lock().unwrap().reported == 1 { break; }
                tokio::task::yield_now().await;
            }
        }) => { observed.unwrap(); }
    }
    drop(first);
    fs::write(directory.path().join("release"), b"release").unwrap();
    wait_file(&directory.path().join("ready")).await;
    let descendants = descendant_handles(directory.path());
    group.terminate().unwrap();
    let (empty, reaped) = tokio::join!(
        group.wait_empty(),
        tokio::time::timeout(READY_DEADLINE, child.wait())
    );
    empty.unwrap();
    reaped.unwrap().unwrap();
    assert_exited(&descendants);
    let completion = group.job.completion.lock().unwrap();
    assert_eq!(completion.reported, 3);
    assert!(completion.pending.is_empty());
    drop(completion);
    group.armed = false;
}

#[tokio::test]
async fn nested_job_notifications_reconcile_with_outer_accounting_and_process_signals() {
    let directory = tempfile::tempdir().unwrap();
    let (mut child, mut group) =
        Group::spawn(&mut fixture_command(directory.path(), "nested"), "fixture")
            .await
            .unwrap();
    wait_file(&directory.path().join("ready")).await;
    let mut handles = descendant_handles(directory.path());
    handles.push(process_handle(child.id().unwrap()));
    assert_eq!(group.job.active_processes().unwrap(), 3);
    group.terminate().unwrap();
    let (empty, reaped) = tokio::join!(
        group.wait_empty(),
        tokio::time::timeout(READY_DEADLINE, child.wait())
    );
    empty.unwrap();
    reaped.unwrap().unwrap();
    assert_exited(&handles);
    let completion = group.job.completion.lock().unwrap();
    assert_eq!(completion.reported, 3);
    assert!(completion.pending.is_empty());
    drop(completion);
    group.armed = false;
}

#[tokio::test]
async fn spawn_rollback_before_assignment_after_assignment_and_after_resume_reaps_and_closes() {
    for stage in 0..3 {
        let directory = tempfile::tempdir().unwrap();
        let job = Job::new().unwrap();
        let raw = job.raw();
        let child = fixture_command(directory.path(), "hold")
            .creation_flags(CREATE_SUSPENDED)
            .spawn()
            .unwrap();
        let root = process_handle(child.id().unwrap());
        let mut descendants = Vec::new();
        let result = finish_spawn(child, job, |job, child, pid| {
            if stage >= 1 {
                job.assign(child)?;
            }
            if stage >= 2 {
                resume_threads(pid)?;
                wait_file_sync(&directory.path().join("ready"));
                descendants = descendant_handles(directory.path());
            }
            Err("injected spawn setup failure".into())
        })
        .await;
        assert!(matches!(result, Err(ref message) if message == "injected spawn setup failure"));
        assert_handle_closed(raw);
        assert_exited(&[root]);
        assert_exited(&descendants);
        if stage < 2 {
            assert!(!directory.path().join("root.pid").exists());
        }
    }
}

#[tokio::test]
async fn unrelated_thread_is_rejected_before_resume_and_spawn_rollback_reaps_root() {
    let directory = tempfile::tempdir().unwrap();
    let job = Job::new().unwrap();
    let raw = job.raw();
    let child = fixture_command(directory.path(), "hold")
        .creation_flags(CREATE_SUSPENDED)
        .spawn()
        .unwrap();
    let root = process_handle(child.id().unwrap());
    let result = finish_spawn(child, job, |job, child, pid| {
        job.assign(child)?;
        // SAFETY: retrieving this executing test thread's identifier.
        let thread_id = unsafe { GetCurrentThreadId() };
        let verified = open_owned_thread(thread_id, std::process::id())?;
        drop(verified);
        // Model a snapshot ID reused by another process: the actual acquired
        // handle belongs to this test process, not our suspended child.
        let _foreign = open_owned_thread(thread_id, pid)?;
        Err("An unrelated thread was incorrectly admitted for resume".into())
    })
    .await;
    assert!(
        matches!(result, Err(ref error) if error.starts_with("Windows child thread owner changed:"))
    );
    assert_handle_closed(raw);
    assert_exited(&[root]);
    assert!(!directory.path().join("root.pid").exists());
}

fn authored_fixture(directory: &Path, executable: &Path, mode: &str) -> String {
    format!(
        "set \"STRYKER_WINDOWS_FIXTURE={mode}\" && set \"STRYKER_WINDOWS_FIXTURE_DIR={}\" && \"{}\" --exact {FIXTURE} --nocapture",
        directory.display(),
        executable.display(),
    )
}

#[tokio::test]
async fn cmd_raw_quoting_preserves_executable_spaces_metacharacters_and_held_pipes() {
    let directory = tempfile::Builder::new()
        .prefix("stryker space & shell ")
        .tempdir()
        .unwrap();
    let executable = directory.path().join("runner with spaces.exe");
    fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
    let (_cancel, cancellation) = watch::channel(false);
    let outcome = run(
        &authored_fixture(directory.path(), &executable, "exit"),
        directory.path(),
        None,
        "windows-test",
        20_000.0,
        cancellation,
    )
    .await
    .unwrap();
    assert!(outcome.status.unwrap().success(), "{}", outcome.output);
    assert!(!outcome.timed_out);
    // The root exited successfully while both descendants inherited its pipes.
    // A successful drain therefore also exercises job termination after exit.
    assert!(directory.path().join("leaf.pid").exists());
}

#[tokio::test]
async fn command_cancellation_and_timeout_settle_only_after_tree_exit() {
    for cancel_run in [true, false] {
        let directory = tempfile::tempdir().unwrap();
        let (cancel, cancellation) = watch::channel(false);
        let executable = std::env::current_exe().unwrap();
        let command = authored_fixture(directory.path(), &executable, "hold");
        let observe = async {
            wait_file(&directory.path().join("ready")).await;
            let mut handles = descendant_handles(directory.path());
            let root_pid = fs::read_to_string(directory.path().join("root.pid"))
                .unwrap()
                .parse()
                .unwrap();
            handles.push(process_handle(root_pid));
            if cancel_run {
                cancel.send_replace(true);
            }
            handles
        };
        let (result, handles) = tokio::join!(
            run(
                &command,
                directory.path(),
                None,
                "windows-test",
                5000.0,
                cancellation
            ),
            observe
        );
        assert_exited(&handles);
        if cancel_run {
            assert!(matches!(result, Err(ref error) if error == "Native mutation run cancelled"));
        } else {
            assert!(result.unwrap().timed_out);
        }
    }
}

#[tokio::test]
async fn a_held_output_pipe_returns_a_bounded_cleanup_error() {
    let (pipe, _held_writer) = tokio::io::duplex(64);
    let capture = std::sync::Arc::new(std::sync::Mutex::new(super::super::Capture::default()));
    let reader = tokio::spawn(super::super::drain(pipe, capture, false));
    let result = tokio::time::timeout(Duration::from_secs(3), super::super::join_drain(reader))
        .await
        .unwrap();
    assert!(result.unwrap_err().contains("output pipes remained open"));
}
