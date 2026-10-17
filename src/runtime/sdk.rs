//! Rust schedules SDK calls; the Node process owns only the explicitly selected SDK plugin instance.

use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use serde_json::{Value, json};
use tokio::{
    sync::{Mutex, Semaphore, watch},
    task::JoinSet,
    time::Instant,
};

use super::{
    bridge::{BridgeError, BridgeSession, BridgeSpec},
    config::{self, Config},
    project::{Project, Sandbox},
    report,
};

const LIFECYCLE: Duration = Duration::from_secs(60);
const DISPOSE: Duration = Duration::from_secs(10);
const CANCELLED: &str = "Native mutation run cancelled";

fn forward_logs(session: &mut BridgeSession) {
    for event in session.take_events() {
        eprintln!("[stryker-rust:compat] {event}");
    }
}

fn error_string(error: BridgeError) -> String {
    match error {
        BridgeError::Cancelled => CANCELLED.into(),
        BridgeError::Remote(error) => {
            let message = format!("{}: {}", error.name, error.message);
            error
                .stack
                .map_or_else(|| message.clone(), |stack| format!("{message}\n{stack}"))
        }
        error => error.to_string(),
    }
}

fn spec(config: &Config, cwd: PathBuf) -> BridgeSpec {
    BridgeSpec {
        node_executable: config
            .node_executable
            .clone()
            .expect("validated Node executable"),
        bridge_module: config
            .bridge_module
            .clone()
            .expect("validated bridge module"),
        cwd,
        trace_output: config.options["logLevel"] == "trace",
    }
}

/// Discover schemas without constructing a plugin or writing a sandbox/report.
pub(super) async fn prepare(
    config: &mut Config,
    cancellation: watch::Receiver<bool>,
) -> Result<Result<(), String>, String> {
    let mut session =
        BridgeSession::start(spec(config, config.cwd.clone()), LIFECYCLE, cancellation)
            .await
            .map_err(error_string)?;
    let metadata = session
        .call(
            "prepare",
            json!({"cwd":config.cwd,"modules":config.modules}),
            LIFECYCLE,
        )
        .await;
    let cleanup = session.dispose(DISPOSE).await;
    forward_logs(&mut session);
    if let Err(error) = cleanup {
        return Err(error_string(error));
    }
    let metadata = metadata.map_err(error_string)?;
    if metadata["sdkVersion"] != "10.0.0" {
        return Ok(Err(
            "Native SDK runner requires the pinned Stryker SDK 10.0.0".into(),
        ));
    }
    let contributions = metadata["schemaContributions"]
        .as_array()
        .ok_or("Compatibility metadata omitted schema contributions")?;
    if let Err(error) =
        config::normalize_plugin_options(config, &metadata["coreSchema"], contributions)
    {
        return Ok(Err(error));
    }
    config.modules = metadata["loadedModules"]
        .as_array()
        .ok_or("Compatibility metadata omitted modules")?
        .iter()
        .map(|module| {
            module["moduleName"]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| "Compatibility metadata omitted a module URL".to_owned())
        })
        .collect::<Result<_, _>>()?;
    Ok(Ok(()))
}

#[derive(Default)]
struct Stats {
    calls: usize,
    starts: usize,
    restarts: usize,
    timeouts: usize,
    truncations: usize,
    dropped_events: usize,
    captured_output_bytes: usize,
    pids: Vec<u32>,
}
impl Stats {
    fn add(&mut self, mut other: Self) {
        self.calls += other.calls;
        self.starts += other.starts;
        self.restarts += other.restarts;
        self.timeouts += other.timeouts;
        self.truncations += other.truncations;
        self.dropped_events += other.dropped_events;
        self.captured_output_bytes += other.captured_output_bytes;
        self.pids.append(&mut other.pids);
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Environment {
    Pristine,
    Loaded,
    Static,
}

struct Worker {
    last_attempts: u32,
    config: Arc<Config>,
    directory: PathBuf,
    descriptions: Arc<Value>,
    test_files: Arc<Vec<PathBuf>>,
    cancellation: watch::Sender<bool>,
    session: Option<BridgeSession>,
    environment: Environment,
    can_reload: Option<bool>,
    runs: u64,
    stats: Stats,
}

impl Worker {
    fn new(
        config: Arc<Config>,
        directory: PathBuf,
        descriptions: Arc<Value>,
        test_files: Arc<Vec<PathBuf>>,
        cancellation: watch::Sender<bool>,
    ) -> Self {
        Self {
            last_attempts: 0,
            config,
            directory,
            descriptions,
            test_files,
            cancellation,
            session: None,
            environment: Environment::Pristine,
            can_reload: None,
            runs: 0,
            stats: Stats::default(),
        }
    }

    async fn call(
        &mut self,
        method: &str,
        params: Value,
        deadline: Duration,
    ) -> Result<Value, BridgeError> {
        self.stats.calls += 1;
        let session = self
            .session
            .as_mut()
            .expect("initialized compatibility session");
        let result = session.call(method, params, deadline).await;
        forward_logs(session);
        result
    }

    async fn start(&mut self) -> Result<(), String> {
        if *self.cancellation.borrow() {
            return Err(CANCELLED.into());
        }
        let session = BridgeSession::start(
            spec(&self.config, self.directory.clone()),
            LIFECYCLE,
            self.cancellation.subscribe(),
        )
        .await
        .map_err(error_string)?;
        self.stats.starts += 1;
        self.stats.pids.push(session.pid());
        self.environment = Environment::Pristine;
        self.session = Some(session);
        let mut options = self.config.options.clone();
        // Mocha's SDK selects files during init. Test filenames are not test
        // titles, so they must never become mutantRun's title filter.
        if !self.test_files.is_empty() {
            options["testFiles"] = self
                .test_files
                .iter()
                .map(|file| json!(self.directory.join(file)))
                .collect();
        }
        let initialized = async {
            self.call("initialize", json!({"cwd":self.directory,"options":options,"fileDescriptions":*self.descriptions,"modules":self.config.modules,"plugin":{"kind":"TestRunner","name":self.config.runner.sdk().expect("SDK runner").name()}}), LIFECYCLE).await?;
            self.call("runner.init", Value::Null, LIFECYCLE).await?;
            Ok::<_, BridgeError>(())
        }.await;
        if let Err(error) = initialized {
            let error = error_string(error);
            return match self.dispose().await {
                Ok(()) => Err(error),
                Err(cleanup) => Err(format!("{error}; {cleanup}")),
            };
        }
        Ok(())
    }

    async fn dispose(&mut self) -> Result<(), String> {
        if let Some(mut session) = self.session.take() {
            self.stats.calls += 1;
            let result = session.dispose(DISPOSE).await;
            forward_logs(&mut session);
            let diagnostics = session.diagnostics();
            self.stats.truncations += usize::from(diagnostics.output_truncated);
            self.stats.dropped_events += diagnostics.dropped_events;
            self.stats.captured_output_bytes += diagnostics.stdout.len() + diagnostics.stderr.len();
            // Cancellation is reported only after transport termination/reaping;
            // transport cleanup failures retain their own operational error.
            match result {
                Ok(()) => {}
                Err(BridgeError::Cancelled) if *self.cancellation.borrow() => {}
                Err(error) => return Err(error_string(error)),
            }
        }
        Ok(())
    }

    async fn restart(&mut self, reset_layers: bool) -> Result<(), String> {
        self.dispose().await?;
        if reset_layers {
            self.environment = Environment::Pristine;
            self.can_reload = None;
            self.runs = 0;
        }
        self.stats.restarts += 1;
        self.start().await
    }

    async fn capabilities(&mut self) -> Result<bool, BridgeError> {
        if let Some(capable) = self.can_reload {
            return Ok(capable);
        }
        let value = self
            .call("runner.capabilities", Value::Null, LIFECYCLE)
            .await?;
        let capable = value["reloadEnvironment"].as_bool().ok_or_else(|| {
            BridgeError::Protocol("SDK runner capabilities omitted reloadEnvironment".into())
        })?;
        self.can_reload = Some(capable);
        Ok(capable)
    }

    async fn run_once(&mut self, method: &str, mut options: Value) -> Result<Value, BridgeError> {
        let next_environment;
        if method == "runner.mutantRun" {
            let reload_requested = options["reloadEnvironment"] == true;
            next_environment = if reload_requested {
                Environment::Static
            } else {
                Environment::Loaded
            };
            let needs_reload = if reload_requested {
                self.environment != Environment::Pristine
            } else {
                self.environment == Environment::Static
            };
            let can_reload = if needs_reload {
                self.capabilities().await?
            } else {
                false
            };
            if needs_reload && !can_reload {
                self.restart(false).await.map_err(BridgeError::Cleanup)?;
                self.runs = 0;
            }
            options["reloadEnvironment"] = (needs_reload && can_reload).into();
            self.runs += 1;
            let limit = self.config.options["maxTestRunnerReuse"]
                .as_u64()
                .expect("validated reuse");
            if limit > 0 && self.runs > limit {
                self.restart(false).await.map_err(BridgeError::Cleanup)?;
                self.runs = 1;
            }
        } else {
            next_environment = Environment::Loaded;
        }
        let deadline = Duration::from_secs_f64(
            options["timeout"].as_f64().expect("native finite timeout") / 1000.0,
        );
        let result = self.call(method, options, deadline).await;
        if matches!(result, Err(BridgeError::Timeout { .. })) {
            self.stats.timeouts += 1;
            self.restart(false).await.map_err(BridgeError::Cleanup)?;
            return Ok(json!({"status":"timeout"}));
        }
        if result.is_ok() {
            self.environment = next_environment;
        }
        result
    }

    async fn run(&mut self, method: &str, options: Value) -> Result<Value, String> {
        let mut last_error = String::new();
        self.last_attempts = 0;
        for _ in 0..2 {
            self.last_attempts += 1;
            match self.run_once(method, options.clone()).await {
                Ok(result) => return Ok(result),
                Err(BridgeError::Cancelled) => return Err(CANCELLED.into()),
                Err(error @ (BridgeError::Remote(_) | BridgeError::Process(_))) => {
                    last_error = error_string(error);
                    self.restart(true).await?;
                }
                Err(error) => return Err(error_string(error)),
            }
        }
        // Match the pinned retry decorator's final recovery, including its
        // initialization errors, instead of silently retaining a crashed worker.
        self.restart(true).await?;
        Ok(
            json!({"status":"error","errorMessage":format!("Test runner crashed. Tried twice to restart it without any luck. Last time the error message was: {last_error}")}),
        )
    }
}

fn pairs(value: &Value) -> Result<Value, String> {
    Ok(value
        .as_object()
        .ok_or("Invalid SDK coverage object")?
        .iter()
        .map(|(key, count)| json!([key, count]))
        .collect())
}

struct Plan {
    mutant: Value,
    options: Value,
    net_ms: f64,
}

struct Plans {
    early: Vec<Value>,
    runnable: VecDeque<Plan>,
    test_slots: Vec<usize>,
}

fn plans(
    config: &Config,
    project: &Project,
    baseline: &Value,
    overhead: f64,
) -> Result<Plans, String> {
    let tests = baseline["tests"]
        .as_array()
        .ok_or("Baseline omitted tests")?;
    let coverage = baseline.get("mutantCoverage");
    let has_coverage = coverage.is_some_and(|value| value["static"].is_object());
    let coverage_input = if let Some(coverage) = coverage.filter(|_| has_coverage) {
        let per_test = match coverage.get("perTest") {
            Some(value) => value
                .as_object()
                .ok_or("Invalid SDK per-test coverage")?
                .iter()
                .map(|(id, counts)| Ok(json!([id, pairs(counts)?])))
                .collect::<Result<Vec<_>, String>>()?,
            None => vec![],
        };
        json!({"static":pairs(&coverage["static"])? ,"perTest":per_test})
    } else {
        Value::Null
    };
    let indexed = crate::coverage::coverage_batch(&json!({"version":1,"testIds":tests.iter().map(|test| &test["id"]).collect::<Vec<_>>(),"coverage":coverage_input}).to_string());
    if indexed["supported"] != true {
        return Err(format!("Native coverage failed: {}", indexed["reason"]));
    }
    let index = &indexed["result"];
    let unique_tests = index["testsById"]
        .as_array()
        .ok_or("Native coverage omitted test index")?
        .iter()
        .map(|row| {
            row[1]
                .as_u64()
                .map(|value| value as usize)
                .ok_or_else(|| "Invalid native test index".into())
        })
        .collect::<Result<Vec<_>, String>>()?;
    let associations: HashMap<&str, &Value> = index["testsByMutantId"]
        .as_array()
        .ok_or("Native coverage omitted associations")?
        .iter()
        .map(|row| {
            Ok((
                row[0].as_str().ok_or("Invalid coverage mutant ID")?,
                &row[1],
            ))
        })
        .collect::<Result<_, String>>()?;
    let hits: HashMap<&str, &Value> = index["hitsByMutantId"]
        .as_array()
        .ok_or("Native coverage omitted counts")?
        .iter()
        .map(|row| Ok((row[0].as_str().ok_or("Invalid hit mutant ID")?, &row[1])))
        .collect::<Result<_, String>>()?;
    let net: f64 = tests
        .iter()
        .map(|test| test["timeSpentMs"].as_f64().unwrap_or(0.0))
        .sum();
    let rows = project.mutants.iter().map(|mutant| {
        let id = mutant["id"].as_str().expect("native mutant ID");
        let covered = associations.get(id).and_then(|rows| rows.as_array()).map(Vec::as_slice).unwrap_or_default();
        json!({"hasStatus":mutant.get("status").is_some(),"isStatic":coverage.is_some_and(|coverage| coverage["static"][id].as_f64().is_some_and(|count| count > 0.0)),"coveredTimesMs":covered.iter().map(|index| &tests[index.as_u64().expect("coverage test index") as usize]["timeSpentMs"]).collect::<Vec<_>>(),"hitCount":hits.get(id)})
    }).collect::<Vec<_>>();
    let planned = crate::planner::planning_batch(&json!({"version":1,"hasCoverage":has_coverage,"ignoreStatic":config.options["ignoreStatic"],"timeSpentAllTests":net,"globalFilterPresent":false,"timeoutMS":config.options["timeoutMS"],"timeoutFactor":config.options["timeoutFactor"],"timeOverheadMS":overhead,"rows":rows}).to_string());
    if planned["supported"] != true {
        return Err(format!("Native planning failed: {}", planned["reason"]));
    }
    let mut early = Vec::new();
    let mut runnable = Vec::new();
    for (mut mutant, decision) in project.mutants.iter().cloned().zip(
        planned["result"]
            .as_array()
            .ok_or("Missing native decisions")?,
    ) {
        let id = mutant["id"].as_str().expect("native mutant ID");
        let covered = associations
            .get(id)
            .and_then(|rows| rows.as_array())
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .map(|index| tests[index.as_u64().expect("coverage test index") as usize]["id"].clone())
            .collect::<Vec<_>>();
        let is_static = coverage.is_some_and(|coverage| {
            coverage["static"][id]
                .as_f64()
                .is_some_and(|count| count > 0.0)
        });
        if decision["kind"] == "existing" {
            mutant["static"] = is_static.into();
            early.push(mutant);
            continue;
        }
        if has_coverage {
            mutant["static"] = is_static.into();
            mutant["coveredBy"] = covered.clone().into();
        }
        if decision["kind"] == "ignore-static" {
            mutant["status"] = "Ignored".into();
            mutant["statusReason"] = "Static mutant (and \"ignoreStatic\" was enabled)".into();
            early.push(mutant);
            continue;
        }
        let covered_filter = decision["selection"] == "covered";
        if covered_filter && covered.is_empty() {
            mutant["status"] = "NoCoverage".into();
            early.push(mutant);
            continue;
        }
        let mut options = json!({"activeMutant":{"id":mutant["id"],"fileName":config.cwd.join(mutant["fileName"].as_str().expect("native file")),"location":mutant["location"],"mutatorName":mutant["mutatorName"],"replacement":mutant["replacement"]},"mutantActivation":decision["mutantActivation"],"timeout":decision["timeout"],"disableBail":config.options["disableBail"],"reloadEnvironment":decision["reloadEnvironment"]});
        if covered_filter {
            options["testFilter"] = covered.into();
        } else if config.runner.sdk() == Some(config::SdkRunner::Vitest)
            && !project.test_files.is_empty()
        {
            // Vitest consumes explicit files only in dryRun. Bound its subsequent
            // all-selected runs to baseline IDs, without changing the planner's
            // static activation/reload decision merely because a filter is sent.
            options["testFilter"] = unique_tests
                .iter()
                .map(|&index| tests[index]["id"].clone())
                .collect();
        }
        if !decision["hitLimit"].is_null() {
            options["hitLimit"] = decision["hitLimit"].clone();
        }
        runnable.push(Plan {
            mutant,
            options,
            net_ms: decision["netTime"].as_f64().expect("planned net time"),
        });
    }
    runnable.sort_by_key(|plan| plan.options["reloadEnvironment"] == true);
    Ok(Plans {
        early,
        runnable: runnable.into(),
        test_slots: unique_tests,
    })
}

fn completed(mut mutant: Value, result: Value) -> Result<Value, String> {
    let status = match result["status"].as_str() {
        Some("killed") => "Killed",
        Some("survived") => "Survived",
        Some("timeout") => "Timeout",
        Some("error") => "RuntimeError",
        _ => return Err(format!("Invalid SDK mutant result: {result}")),
    };
    mutant["status"] = status.into();
    for (source, target) in [
        ("nrOfTests", "testsCompleted"),
        ("failureMessage", "statusReason"),
        ("errorMessage", "statusReason"),
        ("reason", "statusReason"),
        ("killedBy", "killedBy"),
    ] {
        if let Some(value) = result.get(source) {
            mutant[target] = value.clone();
        }
    }
    Ok(mutant)
}

pub(super) async fn run(
    config: Config,
    project: Project,
    cancellation: watch::Sender<bool>,
) -> Result<Value, String> {
    let config = Arc::new(config);
    let descriptions = Arc::new(project.descriptions.clone());
    let test_files = Arc::new(project.test_files.clone());
    let mut sandboxes = Vec::new();
    let mut workers = Vec::new();
    let result = async {
        if *cancellation.borrow() { return Err(CANCELLED.into()); }
        sandboxes.push(Sandbox::create(&config, &project)?);
        let mut first = Worker::new(config.clone(), sandboxes[0].path.clone(), descriptions.clone(), test_files.clone(), cancellation.clone());
        // Retain ownership before the first fallible async operation.
        first.start().await?;
        workers.push(first);
        let timeout = config.options["dryRunTimeoutMinutes"].as_f64().expect("validated dry run timeout") * 60_000.0;
        let mut baseline_options = json!({"timeout":timeout,"coverageAnalysis":config.options["coverageAnalysis"],"disableBail":config.options["disableBail"],"files":project.originals.keys().map(|file| sandboxes[0].path.join(file)).collect::<Vec<_>>()});
        // Core 10 passes only filesToMutate, and omits testFiles when empty.
        // Vitest uses these separate inputs for related-file selection.
        if !test_files.is_empty() {
            baseline_options["testFiles"] = test_files.iter().map(|file| json!(sandboxes[0].path.join(file))).collect();
        }
        let started = Instant::now();
        let mut baseline = workers[0].run("runner.dryRun", baseline_options).await?;
        let gross = started.elapsed().as_secs_f64() * 1000.0;
        workers[0].capabilities().await.map_err(error_string)?;
        if baseline["status"] != "complete" { return Err(format!("Initial SDK run failed: {baseline}")); }
        let tests = baseline["tests"].as_array_mut().ok_or("Initial SDK run omitted tests")?;
        if tests.iter().any(|test| test["status"] == 1) { return Err(format!("One or more tests failed in the initial test run: {}", Value::Array(tests.clone()))); }
        if tests.is_empty() {
            if config.options["allowEmpty"] != true { return Err("No tests were executed in the initial test run; set allowEmpty to continue".into()); }
            // The pinned executor returns [] before planning/reportAll/wrapUp.
            // Preserve existing report files, including when a JSON reporter is
            // configured, and settle only after disposing the baseline worker.
            workers[0].dispose().await?;
            if *cancellation.borrow() { return Err(CANCELLED.into()); }
            let stats = &workers[0].stats;
            for sandbox in &mut sandboxes { sandbox.finish(&config); }
            if let Some(eta) = &config.eta { eta.plan(vec![], 0, gross, vec!["no tests; allowEmpty".into()]); eta.end(); }
            return Ok(json!({"version":1,"supported":true,"exitCode":0,"mutants":[],"stats":{"coordinator":"rust","nativeInstrumentationBatches":usize::from(!project.instrumented.is_empty()),"nativeCoverageBatches":0,"nativePlanningBatches":0,"nativePlannedMutants":0,"compatibilityCalls":stats.calls+2,"metadataWorkerStarts":1,"workerStarts":stats.starts,"workerPids":stats.pids,"workerRestarts":stats.restarts,"maximumConcurrency":0,"sandboxes":sandboxes.len(),"timeouts":stats.timeouts,"outputTruncations":stats.truncations,"capturedOutputBytes":stats.captured_output_bytes,"droppedLogEvents":stats.dropped_events,"cache":"disabled"}}));
        }
        for test in tests.iter_mut() {
            if let Some(file) = test["fileName"].as_str() {
                let path = PathBuf::from(file);
                if let Ok(relative) = path.strip_prefix(&sandboxes[0].path) { test["fileName"] = json!(config.cwd.join(relative)); }
            }
        }
        let net: f64 = tests.iter().map(|test| test["timeSpentMs"].as_f64().unwrap_or(0.0)).sum();
        let Plans { early:mut results, runnable:queue, test_slots } = plans(&config, &project, &baseline, (gross - net).max(0.0))?;
        let count = queue.len();
        let worker_count = config.concurrency.min(count.max(1));
        for _ in 1..worker_count {
            if *cancellation.borrow() { return Err(CANCELLED.into()); }
            sandboxes.push(Sandbox::create(&config, &project)?);
            workers.push(Worker::new(config.clone(), sandboxes.last().expect("new sandbox").path.clone(), descriptions.clone(), test_files.clone(), cancellation.clone()));
        }
        if let Some(eta) = &config.eta {
            eta.plan(queue.iter().map(|plan| crate::eta::Job { id: plan.mutant["id"].as_str().expect("native mutant ID").into(),
                baseline_ms: Some(plan.net_ms + (gross-net).max(0.0)), timeout_ms: plan.options["timeout"].as_f64(), reload: plan.options["reloadEnvironment"] == true }).collect(),
                1, gross, vec!["actual native SDK plan; measured wall time includes timeout, reload and recovery".into(),"cold runners enter effective capacity only after initialization".into()]);
            if worker_count > 1 { eta.capacity(1, vec!["cold worker initialization unmeasured".into()]); }
        }
        let ready = Arc::new(AtomicUsize::new(0));
        let queue = Arc::new(Mutex::new(queue));
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        // Match the pinned pool's bound without blocking a ready worker on
        // unrelated cold initialization. Restarts retain their own lifecycle.
        let initializations = Arc::new(Semaphore::new(2));
        let mut tasks = JoinSet::new();
        for mut worker in workers.drain(..) {
            let queue = queue.clone(); let cancellation = cancellation.clone();
            let active = active.clone(); let maximum = maximum.clone();
            let initializations = initializations.clone();
            let ready = ready.clone();
            tasks.spawn(async move {
                let outcome = async {
                    if worker.session.is_none() {
                        let _permit = initializations.acquire().await.map_err(|error| error.to_string())?;
                        worker.start().await?;
                    }
                    let runners = ready.fetch_add(1, Ordering::Relaxed) + 1;
                    if let Some(eta) = &worker.config.eta { eta.capacity(runners, if runners == worker_count {vec![]} else {vec!["cold worker initialization unmeasured".into()]}); }
                    let mut results = Vec::new();
                    loop {
                        if *cancellation.borrow() { return Err(CANCELLED.to_owned()); }
                        let Some(mut plan) = queue.lock().await.pop_front() else { break; };
                        plan.options["sandboxFileName"] = json!(worker.directory.join(plan.mutant["fileName"].as_str().expect("native mutant file")));
                        let concurrent = active.fetch_add(1, Ordering::Relaxed) + 1;
                        maximum.fetch_max(concurrent, Ordering::Relaxed);
                        let eta = worker.config.eta.clone();
                        let job_id = plan.mutant["id"].as_str().expect("native mutant ID");
                        let started = Instant::now();
                        if let Some(eta) = &eta { eta.start(job_id); }
                        let result = worker.run("runner.mutantRun", plan.options).await;
                        active.fetch_sub(1, Ordering::Relaxed);
                        let result = result?;
                        if let Some(eta) = &eta { eta.finish(job_id, started.elapsed().as_secs_f64()*1000.0, worker.last_attempts, result["status"] == "timeout"); }
                        results.push(completed(plan.mutant, result)?);
                    }
                    Ok::<_, String>(results)
                }.await;
                if outcome.is_err() { cancellation.send_replace(true); }
                let cleanup = worker.dispose().await;
                (outcome, cleanup, worker.stats)
            });
        }
        let mut errors = Vec::new(); let mut stats = Stats { calls:2, ..Stats::default() };
        while let Some(result) = tasks.join_next().await {
            match result {
                Ok((outcome, cleanup, worker_stats)) => {
                    stats.add(worker_stats);
                    match outcome { Ok(mut mutants) => results.append(&mut mutants), Err(error) => errors.push(error) }
                    if let Err(error) = cleanup { errors.push(error); }
                }
                Err(error) => { cancellation.send_replace(true); errors.push(format!("Native SDK runner task failed: {error}")); }
            }
        }
        if !errors.is_empty() {
            errors.dedup();
            return Err(if errors.iter().all(|error| error == CANCELLED) { CANCELLED.into() } else { errors.join("; ") });
        }
        if *cancellation.borrow() { return Err(CANCELLED.into()); }
        if let Some(eta) = &config.eta { eta.end(); }
        results.sort_by_key(|mutant| mutant["id"].as_str().and_then(|id| id.parse::<u64>().ok()).unwrap_or(0));
        let completed = results.into_iter().map(|mutant| report::complete(mutant, None, &config.cwd)).collect::<Vec<_>>();
        let tests = baseline["tests"].as_array().expect("validated tests");
        let report = report::assemble_sdk(&config, &project, &completed, tests, &test_slots)?;
        report::write(&config, &report)?;
        let exit_code = report::exit_code(&config, &completed);
        for sandbox in &mut sandboxes { sandbox.finish(&config); }
        Ok(json!({"version":1,"supported":true,"exitCode":exit_code,"mutants":completed,"report":report,"stats":{"coordinator":"rust","nativeInstrumentationBatches":usize::from(!project.instrumented.is_empty()),"nativeCoverageBatches":1,"nativePlanningBatches":1,"nativePlannedMutants":project.mutants.len(),"compatibilityCalls":stats.calls,"metadataWorkerStarts":1,"workerStarts":stats.starts,"workerPids":stats.pids,"workerRestarts":stats.restarts,"maximumConcurrency":maximum.load(Ordering::Relaxed),"sandboxes":sandboxes.len(),"timeouts":stats.timeouts,"outputTruncations":stats.truncations,"capturedOutputBytes":stats.captured_output_bytes,"droppedLogEvents":stats.dropped_events,"cache":"disabled"}}))
    }.await;
    let mut failures = Vec::new();
    for worker in &mut workers {
        if let Err(error) = worker.dispose().await {
            failures.push(error);
        }
    }
    for sandbox in &mut sandboxes {
        if let Err(error) = sandbox.cleanup() {
            failures.push(error);
        }
    }
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
