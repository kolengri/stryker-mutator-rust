//! Rust-owned command mutation coordinator. JavaScript only calls this async task.

use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
};

use napi::{Env, Task, bindgen_prelude::AsyncTask};
use serde_json::{Value, json};
use tokio::{sync::watch, task::JoinSet};

mod bridge;
#[cfg(all(test, unix))]
mod bridge_tests;
mod config;
mod mocha;
#[cfg(all(test, unix))]
mod mocha_tests;
mod process;
mod project;
mod report;
#[cfg(all(test, unix))]
mod tests;

type Registry = Mutex<HashMap<String, watch::Sender<bool>>>;
static CANCELLATIONS: OnceLock<Registry> = OnceLock::new();
static WORKER_IDS: AtomicU64 = AtomicU64::new(0);

fn worker_id() -> String {
    WORKER_IDS.fetch_add(1, Ordering::Relaxed).to_string()
}

pub struct NativeRunTask {
    input: String,
    cancellation: watch::Sender<bool>,
    cancellation_id: Option<String>,
}

pub(crate) fn task(
    input: String,
    cancellation_id: Option<String>,
) -> napi::Result<AsyncTask<NativeRunTask>> {
    let (cancellation, _) = watch::channel(false);
    if let Some(id) = &cancellation_id {
        if id.is_empty() || id.len() > 256 {
            return Err(napi::Error::from_reason("Invalid native cancellation ID"));
        }
        let mut registry = CANCELLATIONS
            .get_or_init(Registry::default)
            .lock()
            .map_err(|_| napi::Error::from_reason("Native cancellation registry poisoned"))?;
        if registry.contains_key(id) {
            return Err(napi::Error::from_reason(
                "Native cancellation ID is already active",
            ));
        }
        registry.insert(id.clone(), cancellation.clone());
    }
    // Do not attach napi's automatic AbortSignal: the Promise must remain pending
    // until Rust has killed/reaped every command and applied sandbox cleanup.
    Ok(AsyncTask::new(NativeRunTask {
        input,
        cancellation,
        cancellation_id,
    }))
}

pub(crate) fn cancel(id: &str) -> bool {
    let Some(registry) = CANCELLATIONS.get() else {
        return false;
    };
    let Ok(registry) = registry.lock() else {
        return false;
    };
    if let Some(cancellation) = registry.get(id) {
        cancellation.send_replace(true);
        true
    } else {
        false
    }
}

impl Drop for NativeRunTask {
    fn drop(&mut self) {
        if let Some(id) = &self.cancellation_id
            && let Some(registry) = CANCELLATIONS.get()
            && let Ok(mut registry) = registry.lock()
        {
            registry.remove(id);
        }
    }
}

impl Task for NativeRunTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> napi::Result<String> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        runtime
            .block_on(run(&self.input, self.cancellation.clone()))
            .map(|response| response.to_string())
            .map_err(|error| {
                if error == "Native mutation run cancelled" {
                    napi::Error::new(napi::Status::Cancelled, error)
                } else {
                    napi::Error::from_reason(error)
                }
            })
    }

    fn resolve(&mut self, _env: Env, output: String) -> napi::Result<String> {
        Ok(output)
    }
}

fn unsupported(reason: String) -> Value {
    json!({"version":1,"supported":false,"reason":reason})
}

pub(super) async fn run(input: &str, cancellation: watch::Sender<bool>) -> Result<Value, String> {
    if *cancellation.borrow() {
        return Err("Native mutation run cancelled".into());
    }
    let mut config = match serde_json::from_str::<config::Request>(input)
        .map_err(|error| error.to_string())
        .and_then(config::prepare)
    {
        Ok(config) => config,
        Err(reason) => return Ok(unsupported(reason)),
    };
    if config.runner == config::Runner::Mocha
        && let Err(error) = mocha::prepare(&mut config, cancellation.subscribe()).await?
    {
        return Ok(unsupported(error));
    }
    let project = match project::prepare(&config) {
        Ok(project) => project,
        Err(reason) => return Ok(unsupported(reason)),
    };
    if config.runner == config::Runner::Mocha {
        return mocha::run(config, project, cancellation).await;
    }
    // The complete input/source eligibility decision precedes sandbox or report
    // writes. Cancellation queued before compute also has no run effects.
    if *cancellation.borrow() {
        return Err("Native mutation run cancelled".into());
    }
    let mut sandboxes = Vec::new();
    let mut worker_ids = Vec::new();
    let result = async {
    sandboxes.push(project::Sandbox::create(&config, &project)?);
    worker_ids.push(worker_id());
    let baseline = process::run(&config.command, &sandboxes[0].path, None, &worker_ids[0], config.options["dryRunTimeoutMinutes"].as_f64().expect("validated deadline") * 60_000.0, cancellation.subscribe()).await?;
    if baseline.timed_out { return Err("Baseline command timed out".into()); }
    if !baseline.status.is_some_and(|status| status.success()) {
        return Err(format!("Baseline command failed. stdout:\n{}\nstderr:\n{}", baseline.stdout, baseline.stderr));
    }
    let mut truncations = usize::from(baseline.truncated);
    let plan = crate::planner::planning_batch(&json!({"version":1,"hasCoverage":false,"ignoreStatic":config.options["ignoreStatic"],
        "timeSpentAllTests":baseline.duration_ms,"globalFilterPresent":false,"timeoutMS":config.options["timeoutMS"],
        "timeoutFactor":config.options["timeoutFactor"],"timeOverheadMS":0,
        "rows": project.mutants.iter().map(|mutant| json!({"hasStatus":mutant.get("status").is_some(),"isStatic":false,"coveredTimesMs":[],"hitCount":null})).collect::<Vec<_>>()}).to_string());
    if plan["supported"] != true { return Err(format!("Native planning failed: {}", plan["reason"])); }
    let decisions = plan["result"].as_array().ok_or("Native planner omitted decisions")?;
    let worker_count = config.concurrency.min(decisions.iter().filter(|decision| decision["kind"] != "existing").count().max(1));
    for _ in 1..worker_count {
        if *cancellation.borrow() { return Err("Native mutation run cancelled".into()); }
        sandboxes.push(project::Sandbox::create(&config, &project)?);
        worker_ids.push(worker_id());
    }
    let mut available: VecDeque<_> = (0..worker_count).collect();
    let mut tasks = JoinSet::new();
    let mut completed = Vec::with_capacity(project.mutants.len());
    let mut command_starts = 1;
    let mut maximum_concurrency = 1;
    let mut timeouts = 0;
    let mut errors = Vec::new();
    let mut index = 0;
    loop {
        while errors.is_empty() && !*cancellation.borrow() && tasks.len() < worker_count && index < project.mutants.len() {
            let mut mutant = project.mutants[index].clone();
            let decision = &decisions[index]; index += 1;
            if decision["kind"] == "existing" { mutant["static"] = false.into(); completed.push(report::complete(mutant, None, &config.cwd)); continue; }
            let timeout = decision["timeout"].as_f64().ok_or("Native planner omitted deadline")?;
            let command = config.command.clone();
            let worker = available.pop_front().expect("bounded scheduler has an available sandbox");
            let directory = sandboxes[worker].path.clone();
            let cwd = config.cwd.clone();
            let receiver = cancellation.subscribe();
            let worker_id = worker_ids[worker].clone();
            tasks.spawn(async move {
                let id = mutant["id"].as_str().ok_or("Native mutant has no ID")?;
                let outcome = process::run(&command, &directory, Some(id), &worker_id, timeout, receiver).await?;
                let timed_out = outcome.timed_out;
                let truncated = outcome.truncated;
                Ok::<_, String>((worker, report::complete(mutant, Some(outcome), &cwd), timed_out, truncated))
            });
            command_starts += 1;
            maximum_concurrency = maximum_concurrency.max(tasks.len());
        }
        if tasks.is_empty() { break; }
        match tasks.join_next().await.expect("nonempty command set") {
            Ok(Ok((worker, mutant, timed_out, truncated))) => { available.push_back(worker); completed.push(mutant); timeouts += usize::from(timed_out); truncations += usize::from(truncated); }
            result => {
                errors.push(match result { Ok(Err(error)) => error, Err(error) => format!("Native command task failed: {error}"), _ => unreachable!() });
                cancellation.send_replace(true);
            }
        }
    }
    // All started tasks were joined, so an error/cancellation cannot settle the
    // public Promise while sibling commands still own running children.
    if !errors.is_empty() {
        return Err(if errors.iter().all(|error| error == "Native mutation run cancelled") {
            "Native mutation run cancelled".into()
        } else {
            errors.join("; ")
        });
    }
    if *cancellation.borrow() { return Err("Native mutation run cancelled".into()); }
    completed.sort_by_key(|mutant| mutant["id"].as_str().and_then(|id| id.parse::<u64>().ok()).unwrap_or(0));
    let report = report::assemble(&config, &project, &completed);
    report::write(&config, &report)?;
    let exit_code = report::exit_code(&config, &completed);
    for sandbox in &mut sandboxes { sandbox.finish(&config); }
    Ok::<_, String>(json!({"version":1,"supported":true,"exitCode":exit_code,"mutants":completed,"report":report,
        "stats":{"coordinator":"rust","nativeInstrumentationBatches":usize::from(!project.instrumented.is_empty()),
            "nativePlanningBatches":1,"nativePlannedMutants":project.mutants.len(),
            "commandStarts":command_starts,"maximumConcurrency":maximum_concurrency,"sandboxes":sandboxes.len(),"timeouts":timeouts,
            "outputTruncations":truncations,"compatibilityCalls":0,"cache":"disabled"}}))
    }.await;
    let failures = sandboxes
        .iter_mut()
        .filter_map(|sandbox| sandbox.cleanup().err())
        .collect::<Vec<_>>();
    if failures.is_empty() {
        result
    } else {
        Err(format!(
            "{}{}",
            result
                .err()
                .map_or(String::new(), |error| format!("{error}; ")),
            failures.join("; ")
        ))
    }
}
