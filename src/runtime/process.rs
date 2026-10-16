use std::{
    path::Path,
    process::{ExitStatus, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    sync::watch,
};

#[cfg(windows)]
#[path = "windows_process.rs"]
mod windows;

// Drain both pipes completely, but bound retained diagnostics independently of
// command volume. Unlike exec's maxBuffer failure this never kills a passing test.
const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const DRAIN_DEADLINE: Duration = Duration::from_secs(2);

#[derive(Default)]
struct Capture {
    combined: Vec<u8>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    truncated: bool,
}

pub(super) struct Outcome {
    pub status: Option<ExitStatus>,
    pub timed_out: bool,
    pub duration_ms: f64,
    pub output: String,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
}

pub(super) async fn cancelled(receiver: &watch::Receiver<bool>) {
    let mut receiver = receiver.clone();
    let _ = receiver.wait_for(|cancelled| *cancelled).await;
}

#[cfg(not(windows))]
fn terminate_group(pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use nix::{
            errno::Errno,
            sys::signal::{Signal, killpg},
            unistd::Pid,
        };
        match killpg(Pid::from_raw(pid as i32), Signal::SIGKILL) {
            Ok(()) | Err(Errno::ESRCH) => Ok(()),
            Err(error) => Err(format!(
                "Cannot terminate command process group {pid}: {error}"
            )),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        Err("Process group cleanup is not supported on this platform".into())
    }
}

pub(super) struct Group {
    pub pid: u32,
    pub armed: bool,
    #[cfg(windows)]
    job: windows::Job,
}

impl Group {
    /// The Windows child cannot execute user code until it belongs to our job.
    pub async fn spawn(command: &mut Command, description: &str) -> Result<(Child, Self), String> {
        #[cfg(windows)]
        let (child, job) = windows::spawn(command, description).await?;
        #[cfg(not(windows))]
        let child = {
            #[cfg(unix)]
            command.process_group(0);
            command
                .spawn()
                .map_err(|error| format!("Cannot spawn {description}: {error}"))?
        };
        let pid = child.id().expect("a newly spawned child has a PID");
        Ok((
            child,
            Self {
                pid,
                armed: true,
                #[cfg(windows)]
                job,
            },
        ))
    }

    pub fn terminate(&self) -> Result<(), String> {
        #[cfg(windows)]
        {
            self.job.terminate()
        }
        #[cfg(not(windows))]
        {
            terminate_group(self.pid)
        }
    }

    pub async fn wait_empty(&self) -> Result<(), String> {
        #[cfg(windows)]
        {
            self.job.wait_empty(DRAIN_DEADLINE).await
        }
        #[cfg(not(windows))]
        {
            Ok(())
        }
    }
}

impl Drop for Group {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.terminate();
        }
    }
}

pub(super) async fn reap(child: &mut Child, description: &str) -> Result<(), String> {
    #[cfg(windows)]
    let status = tokio::time::timeout(DRAIN_DEADLINE, child.wait())
        .await
        .map_err(|_| format!("Timed out reaping {description} after process termination"))?;
    #[cfg(not(windows))]
    let status = child.wait().await;
    status
        .map(|_| ())
        .map_err(|error| format!("Cannot reap {description}: {error}"))
}

fn shell_command(command: &str) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut builder =
            Command::new(std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into()));
        // Match Node's shell:true cmd.exe invocation: do not apply CRT argument
        // escaping to authored shell syntax, including its outer quote pair.
        builder
            .as_std_mut()
            .raw_arg(format!("/D /S /C \"{command}\""));
        builder
    }
    #[cfg(not(windows))]
    {
        let mut builder = Command::new("/bin/sh");
        builder.arg("-c").arg(command);
        builder
    }
}

async fn drain(
    mut pipe: impl AsyncRead + Unpin,
    capture: Arc<Mutex<Capture>>,
    stderr: bool,
) -> Result<(), String> {
    let mut bytes = [0_u8; 16384];
    loop {
        let count = pipe
            .read(&mut bytes)
            .await
            .map_err(|error| format!("Cannot read command output: {error}"))?;
        if count == 0 {
            break;
        }
        let mut capture = capture
            .lock()
            .map_err(|_| "Command output capture poisoned")?;
        let take = count.min(OUTPUT_LIMIT.saturating_sub(capture.combined.len()));
        capture.combined.extend_from_slice(&bytes[..take]);
        if stderr {
            capture.stderr.extend_from_slice(&bytes[..take]);
        } else {
            capture.stdout.extend_from_slice(&bytes[..take]);
        }
        capture.truncated |= take < count;
    }
    Ok(())
}

async fn join_drain(mut task: tokio::task::JoinHandle<Result<(), String>>) -> Result<(), String> {
    match tokio::time::timeout(DRAIN_DEADLINE, &mut task).await {
        Ok(result) => result.map_err(|error| format!("Command output reader failed: {error}"))?,
        Err(_) => {
            task.abort();
            let _ = task.await;
            Err(
                "Configured command output pipes remained open after process-group termination"
                    .into(),
            )
        }
    }
}

pub(super) async fn run(
    command: &str,
    cwd: &Path,
    mutant: Option<&str>,
    worker_id: &str,
    timeout_ms: f64,
    cancellation: watch::Receiver<bool>,
) -> Result<Outcome, String> {
    if *cancellation.borrow() {
        return Err("Native mutation run cancelled".into());
    }
    let timeout = Duration::try_from_secs_f64(timeout_ms / 1000.0)
        .map_err(|error| format!("Invalid command deadline: {error}"))?;
    let started = Instant::now();
    let mut builder = shell_command(command);
    builder
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Baseline must never inherit a caller's stale active-mutant selection.
    builder.env_remove("__STRYKER_ACTIVE_MUTANT__");
    if std::env::var_os("STRYKER_MUTATOR_WORKER").is_none() {
        builder.env("STRYKER_MUTATOR_WORKER", worker_id);
    }
    if let Some(id) = mutant {
        builder.env("__STRYKER_ACTIVE_MUTANT__", id);
    }
    let (mut child, mut group) = Group::spawn(&mut builder, "configured command").await?;
    let capture = Arc::new(Mutex::new(Capture::default()));
    let stdout = tokio::spawn(drain(
        child.stdout.take().ok_or("Missing command stdout")?,
        capture.clone(),
        false,
    ));
    let stderr = tokio::spawn(drain(
        child.stderr.take().ok_or("Missing command stderr")?,
        capture.clone(),
        true,
    ));
    let mut was_cancelled = false;
    let mut timed_out = false;
    let status = tokio::select! {
        biased;
        _ = cancelled(&cancellation) => { was_cancelled = true; Ok(None) },
        status = child.wait() => status.map(Some).map_err(|error| format!("Cannot wait for configured command: {error}")),
        _ = tokio::time::sleep(timeout) => { timed_out = true; Ok(None) },
    };
    // Always terminate descendants, including background processes whose shell
    // has already exited, before waiting for pipe EOF and settling the run.
    #[allow(unused_mut)]
    let mut termination = group.terminate();
    let (reap, empty) = tokio::join!(
        async {
            if !matches!(status, Ok(Some(_))) {
                let _ = child.start_kill();
                reap(&mut child, "configured command").await
            } else {
                Ok(())
            }
        },
        group.wait_empty()
    );
    // XNU returns EPERM for a zombie-only group before its own child is
    // reaped. Retry the real group operation after successful reaping; a live
    // descendant or an actual permission failure must never be inferred away.
    #[cfg(unix)]
    if termination.is_err() && reap.is_ok() {
        termination = group.terminate();
    }
    group.armed = termination.is_err() || reap.is_err() || empty.is_err();
    let (stdout, stderr) = tokio::join!(join_drain(stdout), join_drain(stderr));
    let mut failures = [
        termination.err(),
        reap.err(),
        empty.err(),
        stdout.err(),
        stderr.err(),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    if let Err(error) = &status {
        failures.push(error.clone());
    }
    if !failures.is_empty() {
        group.armed = true;
        return Err(failures.join("; "));
    }
    if was_cancelled {
        return Err("Native mutation run cancelled".into());
    }
    let capture = capture
        .lock()
        .map_err(|_| "Command output capture poisoned")?;
    let mut output = String::from_utf8_lossy(&capture.combined).into_owned();
    if capture.truncated {
        output.push_str("\n[command output truncated after 8388608 bytes]");
    }
    Ok(Outcome {
        status: status?,
        timed_out,
        duration_ms: started.elapsed().as_secs_f64() * 1000.0,
        output,
        stdout: String::from_utf8_lossy(&capture.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&capture.stderr).into_owned(),
        truncated: capture.truncated,
    })
}
