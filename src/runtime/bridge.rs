//! A single JavaScript plugin process. Rust retains scheduling and deadlines.

use std::{
    collections::VecDeque,
    fmt,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    net::{TcpListener, tcp::OwnedReadHalf, tcp::OwnedWriteHalf},
    process::{Child, Command},
    sync::{mpsc, watch},
    task::JoinHandle,
    time::Instant,
};

use super::process::{Group, cancelled, terminate_group};

const MAX_FRAME: usize = 8 * 1024 * 1024;
const MAX_SAFE_ID: u64 = 9_007_199_254_740_991;
const OUTPUT_LIMIT: usize = 1024 * 1024;
const EVENT_LIMIT: usize = 256;
const EVENT_BYTES_LIMIT: usize = 1024 * 1024;
const DRAIN_DEADLINE: Duration = Duration::from_secs(2);

pub(super) struct BridgeSpec {
    pub node_executable: PathBuf,
    pub bridge_module: PathBuf,
    pub cwd: PathBuf,
    pub trace_output: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RemoteError {
    pub name: String,
    pub message: String,
    pub stack: Option<String>,
    pub errors: Option<Vec<RemoteError>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum BridgeError {
    Remote(RemoteError),
    Timeout { operation: String },
    Cancelled,
    Protocol(String),
    Process(String),
    Cleanup(String),
}

impl fmt::Display for BridgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Remote(error) => write!(f, "{}: {}", error.name, error.message),
            Self::Timeout { operation } => write!(
                f,
                "Compatibility worker deadline exceeded during {operation}"
            ),
            Self::Cancelled => f.write_str("Compatibility worker cancelled"),
            Self::Protocol(message) | Self::Process(message) | Self::Cleanup(message) => {
                f.write_str(message)
            }
        }
    }
}

impl std::error::Error for BridgeError {}

#[derive(Debug, Clone, Default)]
pub(super) struct BridgeDiagnostics {
    pub stdout: String,
    pub stderr: String,
    pub output_truncated: bool,
    pub dropped_events: usize,
}

#[derive(Default)]
struct Capture {
    stdout: VecDeque<u8>,
    stderr: VecDeque<u8>,
    output_truncated: bool,
    events: VecDeque<(Value, usize)>,
    event_bytes: usize,
    dropped_events: usize,
}

struct Response {
    id: u64,
    result: Result<Value, BridgeError>,
}

type Drain = JoinHandle<Result<(), BridgeError>>;

#[must_use = "Dispose a bridge session to await child cleanup and reaping."]
pub(super) struct BridgeSession {
    child: Option<Child>,
    pid: u32,
    group: Option<Group>,
    writer: Option<OwnedWriteHalf>,
    reader: Option<Drain>,
    responses: mpsc::Receiver<Result<Response, BridgeError>>,
    stdout: Option<Drain>,
    stderr: Option<Drain>,
    capture: Arc<Mutex<Capture>>,
    cancellation: watch::Receiver<bool>,
    next_id: u64,
    closed: bool,
    disposal: Option<Result<(), BridgeError>>,
    cleanup_failure: Option<BridgeError>,
}

impl BridgeSession {
    pub async fn start(
        spec: BridgeSpec,
        startup_deadline: Duration,
        cancellation: watch::Receiver<bool>,
    ) -> Result<Self, BridgeError> {
        if *cancellation.borrow() {
            return Err(BridgeError::Cancelled);
        }
        if !cfg!(unix) {
            return Err(BridgeError::Process(
                "Compatibility worker process groups require POSIX support".into(),
            ));
        }
        if !spec.cwd.is_absolute()
            || !spec.node_executable.is_absolute()
            || !spec.bridge_module.is_absolute()
        {
            return Err(BridgeError::Process(
                "Compatibility worker paths must be absolute".into(),
            ));
        }
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|error| {
                BridgeError::Process(format!(
                    "Cannot bind compatibility worker listener: {error}"
                ))
            })?;
        let address = listener
            .local_addr()
            .map_err(|error| BridgeError::Process(error.to_string()))?;
        let mut entropy = [0_u8; 32];
        getrandom::fill(&mut entropy).map_err(|_| {
            BridgeError::Process("Cannot generate compatibility worker authentication token".into())
        })?;
        let token: String = entropy.iter().map(|byte| format!("{byte:02x}")).collect();
        let mut command = Command::new(spec.node_executable);
        command
            .arg(spec.bridge_module)
            .current_dir(spec.cwd)
            .env("STRYKER_RUST_BRIDGE_ADDRESS", address.to_string())
            .env("STRYKER_RUST_BRIDGE_TOKEN", &token)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if std::env::var_os("STRYKER_MUTATOR_WORKER").is_none() {
            command.env("STRYKER_MUTATOR_WORKER", super::worker_id());
        }
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|error| {
            BridgeError::Process(format!("Cannot spawn compatibility worker: {error}"))
        })?;
        let pid = child.id().expect("a newly spawned child has a PID");
        let capture = Arc::new(Mutex::new(Capture::default()));
        let stdout = tokio::spawn(drain(
            child.stdout.take().expect("stdout is piped"),
            capture.clone(),
            false,
            spec.trace_output,
        ));
        let stderr = tokio::spawn(drain(
            child.stderr.take().expect("stderr is piped"),
            capture.clone(),
            true,
            spec.trace_output,
        ));
        let (sender, responses) = mpsc::channel(1);
        let mut session = Self {
            child: Some(child),
            pid,
            group: Some(Group { pid, armed: true }),
            writer: None,
            reader: None,
            responses,
            stdout: Some(stdout),
            stderr: Some(stderr),
            capture,
            cancellation,
            next_id: 1,
            closed: false,
            disposal: None,
            cleanup_failure: None,
        };
        let handshake = async {
            let (stream, _) = listener.accept().await.map_err(|error| {
                BridgeError::Process(format!("Cannot accept compatibility worker: {error}"))
            })?;
            stream
                .set_nodelay(true)
                .map_err(|error| BridgeError::Process(error.to_string()))?;
            let (read, write) = stream.into_split();
            let mut read = BufReader::new(read);
            let hello = read_frame(&mut read).await?;
            if hello.get("version").and_then(Value::as_u64) != Some(1)
                || hello.get("event").and_then(Value::as_str) != Some("hello")
                || hello.pointer("/params/token").and_then(Value::as_str) != Some(token.as_str())
                || hello.pointer("/params/pid").and_then(Value::as_u64) != Some(u64::from(pid))
                || hello.get("id").is_some()
            {
                return Err(BridgeError::Protocol(
                    "Compatibility worker authentication failed".into(),
                ));
            }
            Ok((read, write))
        };
        let result = tokio::select! {
            biased;
            _ = cancelled(&session.cancellation) => Err(BridgeError::Cancelled),
            status = session.child.as_mut().expect("child exists").wait() => Err(process_exit(status)),
            result = handshake => result,
            _ = tokio::time::sleep(startup_deadline) => Err(BridgeError::Timeout { operation: "startup".into() }),
        };
        match result {
            Ok((read, write)) => {
                session.writer = Some(write);
                session.reader = Some(tokio::spawn(read_control(
                    read,
                    sender,
                    session.capture.clone(),
                )));
                Ok(session)
            }
            Err(error) => {
                session.terminate().await?;
                Err(session.with_process_output(error))
            }
        }
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn diagnostics(&self) -> BridgeDiagnostics {
        let mut capture = self
            .capture
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        BridgeDiagnostics {
            stdout: String::from_utf8_lossy(capture.stdout.make_contiguous()).into_owned(),
            stderr: String::from_utf8_lossy(capture.stderr.make_contiguous()).into_owned(),
            output_truncated: capture.output_truncated,
            dropped_events: capture.dropped_events,
        }
    }

    pub fn take_events(&mut self) -> Vec<Value> {
        let mut capture = self
            .capture
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        capture.event_bytes = 0;
        capture.events.drain(..).map(|(event, _)| event).collect()
    }

    pub async fn call(
        &mut self,
        method: &str,
        params: Value,
        deadline: Duration,
    ) -> Result<Value, BridgeError> {
        if self.closed {
            return Err(self.cleanup_failure.clone().unwrap_or_else(|| {
                BridgeError::Protocol("Compatibility worker session is closed".into())
            }));
        }
        let id = self.next_id;
        if id > MAX_SAFE_ID {
            self.terminate().await?;
            return Err(BridgeError::Protocol(
                "Compatibility worker request IDs exhausted".into(),
            ));
        }
        self.next_id += 1;
        let mut request = serde_json::to_vec(
            &json!({ "version": 1, "id": id, "method": method, "params": params }),
        )
        .map_err(|error| BridgeError::Protocol(error.to_string()))?;
        if request.len() > MAX_FRAME {
            self.terminate().await?;
            return Err(BridgeError::Protocol(
                "Compatibility worker request exceeded the frame limit".into(),
            ));
        }
        request.push(b'\n');
        let cancellation = self.cancellation.clone();
        let operation = async {
            self.writer
                .as_mut()
                .expect("active session has a writer")
                .write_all(&request)
                .await
                .map_err(|error| {
                    BridgeError::Process(format!(
                        "Cannot write compatibility worker request: {error}"
                    ))
                })?;
            let response = self.responses.recv().await.ok_or_else(|| {
                BridgeError::Process("Compatibility worker control reader stopped".into())
            })??;
            if response.id != id {
                return Err(BridgeError::Protocol(
                    "Compatibility worker response ID did not match the active request".into(),
                ));
            }
            response.result
        };
        let result = tokio::select! {
            biased;
            _ = cancelled(&cancellation) => Err(BridgeError::Cancelled),
            result = operation => result,
            _ = tokio::time::sleep(deadline) => Err(BridgeError::Timeout { operation: method.into() }),
        };
        if matches!(&result, Err(error) if !matches!(error, BridgeError::Remote(_))) {
            self.terminate().await?;
        }
        result.map_err(|error| self.with_process_output(error))
    }

    pub async fn dispose(&mut self, deadline: Duration) -> Result<(), BridgeError> {
        if let Some(result) = &self.disposal {
            return result.clone();
        }
        if self.closed {
            let result = self.cleanup_failure.clone().map_or(Ok(()), Err);
            self.disposal = Some(result.clone());
            return result;
        }
        let started = Instant::now();
        let result = match self.call("dispose", Value::Null, deadline).await {
            Err(error) => {
                self.terminate().await?;
                Err(error)
            }
            Ok(_) => {
                let remaining = deadline.saturating_sub(started.elapsed());
                let cancellation = self.cancellation.clone();
                let shutdown = async {
                    if let Some(mut writer) = self.writer.take() {
                        writer.shutdown().await.map_err(|error| {
                            BridgeError::Process(format!(
                                "Cannot close compatibility worker control stream: {error}"
                            ))
                        })?;
                    }
                    let status = self
                        .child
                        .as_mut()
                        .expect("child exists")
                        .wait()
                        .await
                        .map_err(|error| {
                            BridgeError::Process(format!(
                                "Cannot reap compatibility worker: {error}"
                            ))
                        })?;
                    if !status.success() {
                        return Err(BridgeError::Process(format!(
                            "Compatibility worker exited with {status}"
                        )));
                    }
                    Ok(())
                };
                let result = tokio::select! {
                    biased;
                    _ = cancelled(&cancellation) => Err(BridgeError::Cancelled),
                    result = shutdown => result,
                    _ = tokio::time::sleep(remaining) => Err(BridgeError::Timeout { operation: "dispose".into() }),
                };
                // Also kill descendants left after the worker itself exits.
                let result = match self.terminate().await {
                    Ok(()) => result,
                    Err(error) => Err(error),
                };
                result.map_err(|error| self.with_process_output(error))
            }
        };
        self.disposal = Some(result.clone());
        result
    }

    fn with_process_output(&self, error: BridgeError) -> BridgeError {
        let BridgeError::Process(mut message) = error else {
            return error;
        };
        let diagnostics = self.diagnostics();
        if diagnostics.output_truncated {
            message.push_str("\n[worker output truncated; retained last 1048576 bytes per stream]");
        }
        if !diagnostics.stdout.is_empty() {
            message.push_str("\nWorker stdout tail:\n");
            message.push_str(&diagnostics.stdout);
        }
        if !diagnostics.stderr.is_empty() {
            message.push_str("\nWorker stderr tail:\n");
            message.push_str(&diagnostics.stderr);
        }
        BridgeError::Process(message)
    }

    async fn terminate(&mut self) -> Result<(), BridgeError> {
        if self.closed {
            return self.cleanup_failure.clone().map_or(Ok(()), Err);
        }
        self.closed = true;
        self.writer.take();
        if let Some(reader) = self.reader.take() {
            reader.abort();
            let _ = reader.await;
        }
        let mut termination = self
            .group
            .as_ref()
            .map(|group| terminate_group(group.pid))
            .transpose()
            .map_err(BridgeError::Process);
        let reaped = if let Some(child) = &mut self.child {
            let _ = child.start_kill();
            child.wait().await.map(|_| ()).map_err(|error| {
                BridgeError::Process(format!("Cannot reap compatibility worker: {error}"))
            })
        } else {
            Ok(())
        };
        // Darwin's killpg1 skips SZOMB members and can return EPERM for a
        // zombie-only group. Reap our leader, then require a real successful
        // group termination/ESRCH retry; absence of the leader alone is no proof.
        if termination.is_err() && reaped.is_ok() {
            termination = self
                .group
                .as_ref()
                .map(|group| terminate_group(group.pid))
                .transpose()
                .map_err(BridgeError::Process);
        }
        if termination.is_ok()
            && reaped.is_ok()
            && let Some(group) = &mut self.group
        {
            group.armed = false;
        }
        let (stdout, stderr) = tokio::join!(
            join_drain(self.stdout.take()),
            join_drain(self.stderr.take())
        );
        let errors: Vec<_> = [termination.map(|_| ()), reaped, stdout, stderr]
            .into_iter()
            .filter_map(Result::err)
            .map(|error| error.to_string())
            .collect();
        if errors.is_empty() {
            Ok(())
        } else {
            let error = BridgeError::Cleanup(errors.join("; "));
            self.cleanup_failure = Some(error.clone());
            Err(error)
        }
    }
}

fn process_exit(result: std::io::Result<std::process::ExitStatus>) -> BridgeError {
    BridgeError::Process(match result {
        Ok(status) => format!("Compatibility worker exited before startup completed: {status}"),
        Err(error) => format!("Cannot wait for compatibility worker: {error}"),
    })
}

async fn join_drain(handle: Option<Drain>) -> Result<(), BridgeError> {
    let Some(mut handle) = handle else {
        return Ok(());
    };
    match tokio::time::timeout(DRAIN_DEADLINE, &mut handle).await {
        Ok(result) => result.map_err(|error| {
            BridgeError::Process(format!(
                "Compatibility worker output reader failed: {error}"
            ))
        })?,
        Err(_) => {
            handle.abort();
            let _ = handle.await;
            Err(BridgeError::Process(
                "Compatibility worker output pipes remained open after group termination".into(),
            ))
        }
    }
}

async fn drain(
    pipe: impl AsyncRead + Unpin,
    capture: Arc<Mutex<Capture>>,
    stderr: bool,
    trace_output: bool,
) -> Result<(), BridgeError> {
    let forward: Option<Box<dyn AsyncWrite + Unpin + Send>> = if trace_output {
        Some(if stderr {
            Box::new(tokio::io::stderr())
        } else {
            Box::new(tokio::io::stdout())
        })
    } else {
        None
    };
    drain_to(pipe, capture, stderr, forward).await
}

async fn drain_to(
    mut pipe: impl AsyncRead + Unpin,
    capture: Arc<Mutex<Capture>>,
    stderr: bool,
    mut forward: Option<Box<dyn AsyncWrite + Unpin + Send>>,
) -> Result<(), BridgeError> {
    let mut bytes = [0_u8; 16 * 1024];
    loop {
        let count = pipe.read(&mut bytes).await.map_err(|error| {
            BridgeError::Process(format!("Cannot read compatibility worker output: {error}"))
        })?;
        if count == 0 {
            if let Some(forward) = &mut forward {
                forward.flush().await.map_err(|error| {
                    BridgeError::Process(format!(
                        "Cannot flush compatibility worker output: {error}"
                    ))
                })?;
            }
            return Ok(());
        }
        {
            let mut capture = capture.lock().map_err(|_| {
                BridgeError::Process("Compatibility worker output capture poisoned".into())
            })?;
            let output = if stderr {
                &mut capture.stderr
            } else {
                &mut capture.stdout
            };
            let overflow = (output.len() + count).saturating_sub(OUTPUT_LIMIT);
            output.drain(..overflow);
            output.extend(&bytes[..count]);
            capture.output_truncated |= overflow > 0;
        }
        if let Some(forward) = &mut forward {
            forward.write_all(&bytes[..count]).await.map_err(|error| {
                BridgeError::Process(format!(
                    "Cannot forward compatibility worker output: {error}"
                ))
            })?;
        }
    }
}

async fn read_frame(reader: &mut BufReader<OwnedReadHalf>) -> Result<Value, BridgeError> {
    let mut frame = Vec::new();
    loop {
        let available = reader.fill_buf().await.map_err(|error| {
            BridgeError::Process(format!(
                "Cannot read compatibility worker control stream: {error}"
            ))
        })?;
        if available.is_empty() {
            return Err(BridgeError::Process(
                "Compatibility worker closed its control stream".into(),
            ));
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.unwrap_or(available.len());
        if frame.len() + take > MAX_FRAME {
            return Err(BridgeError::Protocol(
                "Compatibility worker response exceeded the frame limit".into(),
            ));
        }
        frame.extend_from_slice(&available[..take]);
        reader.consume(take + usize::from(newline.is_some()));
        if newline.is_some() {
            return serde_json::from_slice(&frame).map_err(|_| {
                BridgeError::Protocol("Compatibility worker sent invalid UTF-8 JSON".into())
            });
        }
    }
}

async fn read_control(
    mut reader: BufReader<OwnedReadHalf>,
    responses: mpsc::Sender<Result<Response, BridgeError>>,
    capture: Arc<Mutex<Capture>>,
) -> Result<(), BridgeError> {
    loop {
        let frame = match read_frame(&mut reader).await {
            Ok(frame) => frame,
            Err(error) => {
                let _ = responses.send(Err(error)).await;
                return Ok(());
            }
        };
        match parse_frame(frame, &capture) {
            Ok(Some(response)) => {
                if responses.send(Ok(response)).await.is_err() {
                    return Ok(());
                }
            }
            Ok(None) => {}
            Err(error) => {
                let _ = responses.send(Err(error)).await;
                return Ok(());
            }
        }
    }
}

fn parse_frame(frame: Value, capture: &Mutex<Capture>) -> Result<Option<Response>, BridgeError> {
    let invalid =
        || BridgeError::Protocol("Compatibility worker sent an invalid response envelope".into());
    let object = frame.as_object().ok_or_else(invalid)?;
    if object.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(invalid());
    }
    if let Some(event) = object.get("event") {
        let params = object
            .get("params")
            .and_then(Value::as_object)
            .ok_or_else(invalid)?;
        if event.as_str() != Some("log")
            || object.contains_key("id")
            || object.contains_key("result")
            || object.contains_key("error")
            || !matches!(
                params.get("level").and_then(Value::as_str),
                Some("trace" | "debug" | "info" | "warn" | "error" | "fatal")
            )
            || params.get("category").and_then(Value::as_str).is_none()
            || params.get("message").and_then(Value::as_str).is_none()
            || !params.get("args").is_some_and(Value::is_array)
        {
            return Err(invalid());
        }
        let size = serde_json::to_vec(&frame).map_err(|_| invalid())?.len();
        let mut capture = capture.lock().map_err(|_| {
            BridgeError::Process("Compatibility worker event capture poisoned".into())
        })?;
        if size > EVENT_BYTES_LIMIT {
            capture.dropped_events += 1;
            return Ok(None);
        }
        while capture.events.len() >= EVENT_LIMIT || capture.event_bytes + size > EVENT_BYTES_LIMIT
        {
            if let Some((_, bytes)) = capture.events.pop_front() {
                capture.event_bytes -= bytes;
                capture.dropped_events += 1;
            }
        }
        capture.event_bytes += size;
        capture.events.push_back((frame, size));
        return Ok(None);
    }
    let id = object
        .get("id")
        .and_then(Value::as_u64)
        .filter(|id| (1..=MAX_SAFE_ID).contains(id))
        .ok_or_else(invalid)?;
    let result = match (object.get("result"), object.get("error")) {
        (Some(result), None) => Ok(result.clone()),
        (None, Some(error)) => Err(BridgeError::Remote(parse_remote_error(error, 0)?)),
        _ => return Err(invalid()),
    };
    Ok(Some(Response { id, result }))
}

fn parse_remote_error(error: &Value, depth: usize) -> Result<RemoteError, BridgeError> {
    let invalid =
        || BridgeError::Protocol("Compatibility worker sent invalid remote error details".into());
    if depth > 16 {
        return Err(invalid());
    }
    let object = error.as_object().ok_or_else(invalid)?;
    let stack = match object.get("stack") {
        Some(value) => Some(value.as_str().ok_or_else(invalid)?.into()),
        None => None,
    };
    let errors = match object.get("errors") {
        Some(value) => Some(
            value
                .as_array()
                .ok_or_else(invalid)?
                .iter()
                .map(|nested| parse_remote_error(nested, depth + 1))
                .collect::<Result<Vec<_>, _>>()?,
        ),
        None => None,
    };
    Ok(RemoteError {
        name: object
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?
            .into(),
        message: object
            .get("message")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?
            .into(),
        stack,
        errors,
    })
}
