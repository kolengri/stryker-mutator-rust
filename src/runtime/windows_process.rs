//! Owned Windows jobs. Dropping a handle is only an emergency kill request;
//! normal settlement also reaps the root and waits for member process handles.

use std::{
    io,
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr::{null, null_mut},
    sync::Mutex,
    time::Duration,
};

use tokio::{
    process::{Child, Command},
    time::Instant,
};
use windows_sys::Win32::{
    Foundation::{
        ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
        WAIT_TIMEOUT,
    },
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
        },
        IO::{CreateIoCompletionPort, GetQueuedCompletionStatus},
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_ASSOCIATE_COMPLETION_PORT, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectAssociateCompletionPortInformation,
            JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
            QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
        },
        SystemServices::JOB_OBJECT_MSG_NEW_PROCESS,
        Threading::{
            CREATE_SUSPENDED, GetProcessIdOfThread, OpenProcess, OpenThread, PROCESS_SYNCHRONIZE,
            ResumeThread, THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
            WaitForSingleObject,
        },
    },
};

const CLEANUP_DEADLINE: Duration = Duration::from_secs(2);
const COMPLETION_INTERVAL: Duration = Duration::from_millis(10);

pub(super) struct Job {
    handle: OwnedHandle,
    port: OwnedHandle,
    completion: Mutex<Completion>,
}

#[derive(Default)]
struct Completion {
    reported: u64,
    pending: Vec<(u32, OwnedHandle)>,
}

struct Progress {
    active: u32,
    total: u32,
    reported: u64,
    pending: usize,
    full_batch: bool,
}

fn last_error(operation: &str) -> String {
    format!("Cannot {operation}: {}", io::Error::last_os_error())
}

impl Job {
    fn new() -> Result<Self, String> {
        // SAFETY: null attributes/name create a new unnamed, non-inheritable job.
        let handle = unsafe { CreateJobObjectW(null(), null()) };
        if handle.is_null() {
            return Err(last_error("create Windows process job"));
        }
        // SAFETY: successful creation returns one owned handle. OwnedHandle is
        // its only closing owner, including on every setup error below.
        let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
        // SAFETY: INVALID_HANDLE_VALUE creates a private completion port.
        let port = unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, null_mut(), 0, 0) };
        if port.is_null() {
            return Err(last_error("create Windows process job completion port"));
        }
        let job = Self {
            handle,
            // SAFETY: successful creation returns one uniquely owned handle.
            port: unsafe { OwnedHandle::from_raw_handle(port) },
            completion: Mutex::new(Completion::default()),
        };
        let association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
            CompletionKey: null_mut(),
            CompletionPort: job.port.as_raw_handle(),
        };
        // Associate while empty, before any process can execute or exit. The
        // port and job remain owned together, including across cancelled waits.
        // SAFETY: the live handles and correctly sized input are not transferred.
        if unsafe {
            SetInformationJobObject(
                job.raw(),
                JobObjectAssociateCompletionPortInformation,
                (&association as *const JOBOBJECT_ASSOCIATE_COMPLETION_PORT).cast(),
                size_of::<JOBOBJECT_ASSOCIATE_COMPLETION_PORT>() as u32,
            )
        } == 0
        {
            return Err(last_error("associate Windows process job completion port"));
        }
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: the handle and correctly sized, initialized input remain live.
        if unsafe {
            SetInformationJobObject(
                job.raw(),
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(last_error("configure Windows process job"));
        }
        Ok(job)
    }

    fn raw(&self) -> HANDLE {
        self.handle.as_raw_handle()
    }

    fn assign(&self, child: &Child) -> Result<(), String> {
        let process = child
            .raw_handle()
            .ok_or("Suspended Windows child has no process handle")?;
        // SAFETY: neither handle is transferred; both owners remain live.
        if unsafe { AssignProcessToJobObject(self.raw(), process) } == 0 {
            return Err(last_error("assign suspended child to Windows process job"));
        }
        Ok(())
    }

    pub(super) fn terminate(&self) -> Result<(), String> {
        // SAFETY: this job handle stays owned even after the root exits.
        if unsafe { TerminateJobObject(self.raw(), 1) } == 0 {
            return Err(last_error("terminate Windows process job"));
        }
        Ok(())
    }

    fn accounting(&self) -> Result<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, String> {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        // SAFETY: info is writable for exactly the declared information class
        // and length; Windows does not retain the pointer.
        if unsafe {
            QueryInformationJobObject(
                self.raw(),
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                null_mut(),
            )
        } == 0
        {
            return Err(last_error("query Windows process job accounting"));
        }
        Ok(info)
    }

    #[cfg(test)]
    fn active_processes(&self) -> Result<u32, String> {
        Ok(self.accounting()?.ActiveProcesses)
    }

    fn retain_reported_process(&self, pid: u32, state: &mut Completion) -> Result<(), String> {
        if pid == 0 {
            return Err("Windows job reported an invalid process identifier".into());
        }
        // A notification contains a PID, not a retained identity. A recycled
        // PID can make us wait for an unrelated process and fail the deadline;
        // it cannot produce false success. Never terminate through this PID.
        // SAFETY: request only non-inheritable synchronization access.
        let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if raw.is_null() {
            let error = io::Error::last_os_error();
            // A PID that no longer exists cannot execute or own pending I/O.
            // Access denied and other failures are NOT evidence of completion.
            if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                return Ok(());
            }
            return Err(format!("Cannot retain Windows job process {pid}: {error}"));
        }
        // SAFETY: OpenProcess returned one uniquely owned handle.
        let process = unsafe { OwnedHandle::from_raw_handle(raw) };
        state.pending.push((pid, process));
        Ok(())
    }

    fn poll_completion(&self) -> Result<Progress, String> {
        let mut state = self
            .completion
            .lock()
            .map_err(|_| "Windows process job completion state poisoned")?;
        // Bound each poll so a busy creator cannot monopolize the runtime or
        // bypass the cleanup deadline. Later polls continue the same owned state.
        let mut full_batch = true;
        for _ in 0..64 {
            let mut message = 0;
            let mut key = 0;
            let mut value = null_mut();
            // SAFETY: the port is live; output pointers are writable. No kernel
            // wait blocks the async runtime. Job values are PIDs, never dereferenced.
            if unsafe {
                GetQueuedCompletionStatus(
                    self.port.as_raw_handle(),
                    &mut message,
                    &mut key,
                    &mut value,
                    0,
                )
            } == 0
            {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(WAIT_TIMEOUT as i32) {
                    full_batch = false;
                    break;
                }
                return Err(format!("Cannot read Windows job completion port: {error}"));
            }
            if key != 0 {
                return Err("Unexpected Windows job completion key".into());
            }
            if message == JOB_OBJECT_MSG_NEW_PROCESS {
                self.retain_reported_process(value as usize as u32, &mut state)?;
                state.reported += 1;
            }
        }
        let mut index = 0;
        while index < state.pending.len() {
            let (pid, process) = &state.pending[index];
            // SAFETY: the owned process handle cannot be closed during this poll.
            match unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } {
                WAIT_OBJECT_0 => {
                    state.pending.swap_remove(index);
                }
                WAIT_TIMEOUT => {
                    index += 1;
                }
                _ => return Err(last_error(&format!("wait for Windows job process {pid}"))),
            }
        }
        let info = self.accounting()?;
        Ok(Progress {
            active: info.ActiveProcesses,
            total: info.TotalProcesses,
            reported: state.reported,
            pending: state.pending.len(),
            full_batch,
        })
    }

    pub(super) async fn wait_empty(&self, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        loop {
            let Progress {
                active,
                total,
                reported,
                pending,
                full_batch,
            } = self.poll_completion()?;
            // Accounting/ACTIVE_PROCESS_ZERO is only a membership boundary,
            // not proof that every process handle is signaled. NEW_PROCESS
            // delivery is not guaranteed: reconcile the lifetime count and
            // fail closed at the deadline if any notification was lost. This
            // also covers descendants created concurrently with termination.
            if active == 0 && u64::from(total) == reported && pending == 0 {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "Windows process job cleanup deadline exceeded with {active} active processes, \
                     {pending} unsignaled process handles, {reported}/{total} process notifications"
                ));
            }
            if full_batch {
                tokio::task::yield_now().await;
            } else {
                tokio::time::sleep_until(deadline.min(Instant::now() + COMPLETION_INTERVAL)).await;
            }
        }
    }
}

/// Tokio's stable Child exposes a process handle, not the initial thread handle.
/// With CREATE_SUSPENDED no user code can spawn descendants before assignment.
/// Enumerate the documented Toolhelp thread snapshot before resuming any thread.
fn open_owned_thread(thread_id: u32, pid: u32) -> Result<OwnedHandle, String> {
    // SAFETY: only query/suspend/resume access is requested, without inheritance.
    let thread = unsafe {
        OpenThread(
            THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
            0,
            thread_id,
        )
    };
    if thread.is_null() {
        return Err(last_error("open suspended Windows child thread"));
    }
    // SAFETY: OpenThread returned one unique handle, including on query failure.
    let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
    // Thread IDs can be reused between the snapshot and OpenThread. Query the
    // acquired handle before resuming anything; its identity is now retained.
    // SAFETY: this live thread handle includes query-limited access.
    let owner = unsafe { GetProcessIdOfThread(thread.as_raw_handle()) };
    if owner == 0 {
        return Err(last_error("query suspended Windows child thread owner"));
    }
    if owner != pid {
        return Err(format!(
            "Windows child thread owner changed: expected {pid}, found {owner}"
        ));
    }
    Ok(thread)
}

fn resume_threads(pid: u32) -> Result<(), String> {
    // SAFETY: TH32CS_SNAPTHREAD needs no remote memory or process handle.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(last_error("snapshot suspended Windows child threads"));
    }
    // SAFETY: a successful snapshot returns one owned handle.
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
    let mut entry = THREADENTRY32 {
        dwSize: size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    // SAFETY: the snapshot is live and entry advertises its correct size.
    if unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } == 0 {
        return Err(last_error("enumerate suspended Windows child threads"));
    }
    let mut threads = Vec::new();
    loop {
        if entry.th32OwnerProcessID == pid {
            // Collect and verify every handle before allowing any execution.
            threads.push(open_owned_thread(entry.th32ThreadID, pid)?);
        }
        entry.dwSize = size_of::<THREADENTRY32>() as u32;
        // SAFETY: the snapshot and writable entry remain live.
        if unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                break;
            }
            return Err(format!(
                "Cannot enumerate suspended Windows child threads: {error}"
            ));
        }
    }
    if threads.is_empty() {
        return Err("No suspended Windows child thread was found".into());
    }
    let mut resumed = false;
    for thread in threads {
        // SAFETY: these thread handles belong to our retained, job-assigned root.
        let count = unsafe { ResumeThread(thread.as_raw_handle()) };
        match count {
            u32::MAX => return Err(last_error("resume Windows child thread")),
            0 => {}
            1 => resumed = true,
            _ => return Err("Windows child thread remained suspended after resume".into()),
        }
    }
    if !resumed {
        return Err("No Windows child thread resumed from CREATE_SUSPENDED".into());
    }
    Ok(())
}

pub(super) async fn spawn(
    command: &mut Command,
    description: &str,
) -> Result<(Child, Job), String> {
    // Configure the emergency guard before creating a child. The command
    // builders are internal and do not supply other Windows creation flags.
    let job = Job::new()?;
    command.creation_flags(CREATE_SUSPENDED).kill_on_drop(true);
    let child = command
        .spawn()
        .map_err(|error| format!("Cannot spawn {description}: {error}"))?;
    finish_spawn(child, job, |job, child, pid| {
        job.assign(child)?;
        resume_threads(pid)
    })
    .await
}

async fn finish_spawn(
    mut child: Child,
    job: Job,
    prepare: impl FnOnce(&Job, &Child, u32) -> Result<(), String>,
) -> Result<(Child, Job), String> {
    let pid = child.id().expect("a newly spawned child has a PID");
    if let Err(error) = prepare(&job, &child, pid) {
        // Assignment may have failed, or resume may have partly succeeded. Kill
        // both independently, await both proofs, and retain the original error.
        let termination = job.terminate();
        let _ = child.start_kill();
        let (reaped, empty) = tokio::join!(
            super::reap(&mut child, "Windows child after spawn failure"),
            job.wait_empty(CLEANUP_DEADLINE),
        );
        let mut failures = vec![error];
        failures.extend(
            [termination.err(), reaped.err(), empty.err()]
                .into_iter()
                .flatten(),
        );
        return Err(failures.join("; "));
    }
    Ok((child, job))
}

#[cfg(test)]
#[path = "windows_process_tests.rs"]
mod tests;
