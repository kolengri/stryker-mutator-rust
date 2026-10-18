//! Advisory, sequential-campaign ETA. Never participates in execution decisions.
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const MODEL: &str = "plan-replay-v1";
const WINDOW: usize = 32;
const MAX_JOBS: usize = 1_000_000;
const MAX_MS: f64 = 31_536_000_000.0;
const HISTORY_AGE_MS: f64 = 30.0 * 86_400_000.0;

fn fail(reason: impl Into<String>) -> napi::Error {
    napi::Error::from_reason(reason.into())
}
fn unix_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.0
}
fn duration(value: f64) -> bool {
    value.is_finite() && (0.0..=MAX_MS).contains(&value)
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}
fn label(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    sources: String,
    tests: String,
    configuration: String,
    lockfile: String,
    runtime: String,
    engine: String,
}

/// Hash complete caller-supplied input digests, never read project files here.
#[napi(js_name = "etaIdentity", strict)]
pub fn identity(input: String) -> napi::Result<String> {
    let value: Identity =
        serde_json::from_str(&input).map_err(|e| fail(format!("Invalid ETA identity: {e}")))?;
    let parts = [
        value.sources,
        value.tests,
        value.configuration,
        value.lockfile,
        value.runtime,
        value.engine,
    ];
    if parts.iter().any(|part| part.is_empty()) {
        return Err(fail("All six ETA identity components are required"));
    }
    Ok(blake3::hash(
        serde_json::to_string(&(MODEL, parts))
            .expect("identity JSON")
            .as_bytes(),
    )
    .to_hex()
    .to_string())
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Job {
    pub id: String,
    /// Measured inactive cost for this plan, including applicable reload overhead.
    pub baseline_ms: Option<f64>,
    pub timeout_ms: Option<f64>,
    #[serde(default)]
    pub reload: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plan {
    jobs: Vec<Job>,
    runners: usize,
    /// Measured matching preparation cost, needed for a scope not yet begun.
    preparation_ms: Option<f64>,
    baseline_ms: Option<f64>,
    #[serde(default = "yes")]
    complete: bool,
    #[serde(default)]
    notes: Vec<String>,
    #[serde(default)]
    unmeasured_work: Vec<String>,
}
fn yes() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScopeInput {
    id: String,
    identity: Option<String>,
    plan: Option<Plan>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    scopes: Vec<ScopeInput>,
    history: Option<Value>,
    now_unix_ms: Option<f64>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Sample {
    baseline_ms: Option<f64>,
    duration_ms: f64,
    reload: bool,
    attempts: u32,
    timed_out: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HistoryScope {
    id: String,
    identity: String,
    measured_at_unix_ms: f64,
    preparation_ms: Option<f64>,
    baseline_ms: Option<f64>,
    samples: VecDeque<Sample>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct History {
    version: u32,
    model: String,
    generated_at_unix_ms: f64,
    scopes: Vec<HistoryScope>,
}

#[derive(Clone, Copy)]
enum Status {
    Queued,
    Running(f64),
    Done,
}
struct Scope {
    id: String,
    identity: Option<String>,
    plan: Option<Plan>,
    statuses: Vec<Status>,
    indexes: HashMap<String, usize>,
    begun: Option<f64>,
    planned_at: Option<f64>,
    ended: bool,
    samples: VecDeque<Sample>,
    history_samples: VecDeque<Sample>,
    history_measured_at: Option<f64>,
    preparation_ms: Option<f64>,
    baseline_ms: Option<f64>,
    completed: usize,
}
struct Forecast {
    costs: [f64; 3],
    durations: Vec<f64>,
    from_baseline: bool,
}
impl Forecast {
    fn remaining(&self, age: Option<f64>, timeout: Option<f64>) -> [f64; 3] {
        let mut costs = self.costs;
        if self.from_baseline {
            costs[2] = costs[2].max(timeout.unwrap_or(costs[2]));
        }
        residual(costs, age, &self.durations, timeout)
    }
}
pub(crate) struct Campaign {
    scopes: Vec<Scope>,
    clock: Instant,
    last_at: f64,
    history_notes: Vec<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Event {
    Begin {
        scope_id: String,
        at_ms: Option<f64>,
    },
    Plan {
        scope_id: String,
        at_ms: Option<f64>,
        plan: Plan,
    },
    Capacity {
        scope_id: String,
        at_ms: Option<f64>,
        runners: usize,
        unmeasured_work: Option<Vec<String>>,
    },
    Degrade {
        scope_id: String,
        at_ms: Option<f64>,
        reason: String,
    },
    Start {
        scope_id: String,
        at_ms: Option<f64>,
        job_id: String,
    },
    Finish {
        scope_id: String,
        at_ms: Option<f64>,
        job_id: String,
        duration_ms: Option<f64>,
        attempts: Option<u32>,
        #[serde(default)]
        timed_out: bool,
        #[serde(default = "yes")]
        sample: bool,
    },
    End {
        scope_id: String,
        at_ms: Option<f64>,
    },
}
impl Event {
    fn set_time(&mut self, at: f64) {
        match self {
            Self::Begin { at_ms, .. }
            | Self::Plan { at_ms, .. }
            | Self::Capacity { at_ms, .. }
            | Self::Degrade { at_ms, .. }
            | Self::Start { at_ms, .. }
            | Self::Finish { at_ms, .. }
            | Self::End { at_ms, .. } => *at_ms = Some(at),
        }
    }
    fn target(&self) -> (&str, Option<f64>) {
        match self {
            Self::Begin { scope_id, at_ms }
            | Self::Plan {
                scope_id, at_ms, ..
            }
            | Self::Capacity {
                scope_id, at_ms, ..
            }
            | Self::Degrade {
                scope_id, at_ms, ..
            }
            | Self::Start {
                scope_id, at_ms, ..
            }
            | Self::Finish {
                scope_id, at_ms, ..
            }
            | Self::End { scope_id, at_ms } => (scope_id, *at_ms),
        }
    }
}

impl Campaign {
    fn new(input: Input) -> Result<Self, String> {
        if input.scopes.len() > 10_000 {
            return Err("Too many ETA scopes".into());
        }
        let mut ids = HashSet::new();
        let mut scopes = Vec::new();
        for scope in input.scopes {
            if !label(&scope.id) || !ids.insert(scope.id.clone()) {
                return Err("ETA scope IDs must be nonempty and unique".into());
            }
            if scope.identity.as_ref().is_some_and(|value| !digest(value)) {
                return Err("ETA identity must be a lowercase 64-character digest".into());
            }
            let mut value = Scope {
                id: scope.id,
                identity: scope.identity,
                plan: None,
                statuses: vec![],
                indexes: HashMap::new(),
                begun: None,
                planned_at: None,
                ended: false,
                samples: VecDeque::new(),
                history_samples: VecDeque::new(),
                history_measured_at: None,
                preparation_ms: None,
                baseline_ms: None,
                completed: 0,
            };
            if let Some(plan) = scope.plan {
                value.set_plan(plan)?;
            }
            scopes.push(value);
        }
        let mut campaign = Self {
            scopes,
            clock: Instant::now(),
            last_at: 0.0,
            history_notes: vec![],
        };
        if let Some(history) = input.history {
            campaign.load_history(history, input.now_unix_ms.unwrap_or_else(unix_ms));
        }
        Ok(campaign)
    }
    fn load_history(&mut self, value: Value, now: f64) {
        let history = serde_json::from_value::<History>(value);
        let Ok(history) = history else {
            self.history_notes.push("ignored: malformed history".into());
            return;
        };
        if history.version != 1
            || history.model != MODEL
            || !now.is_finite()
            || !history.generated_at_unix_ms.is_finite()
            || history.generated_at_unix_ms > now
            || now - history.generated_at_unix_ms > HISTORY_AGE_MS
            || history.scopes.len() > 10_000
        {
            self.history_notes
                .push("ignored: incompatible, stale or future history".into());
            return;
        }
        let mut seen = HashSet::new();
        for past in history.scopes {
            if !seen.insert(past.id.clone()) {
                self.history_notes
                    .push(format!("ignored duplicate history scope: {}", past.id));
                continue;
            }
            let Some(scope) = self.scopes.iter_mut().find(|scope| scope.id == past.id) else {
                continue;
            };
            if scope.identity.as_ref() != Some(&past.identity) || !digest(&past.identity) {
                self.history_notes
                    .push(format!("ignored identity mismatch: {}", past.id));
                continue;
            }
            if past.samples.len() > WINDOW
                || !past.measured_at_unix_ms.is_finite()
                || past.measured_at_unix_ms < 0.0
                || past.measured_at_unix_ms > now
                || now - past.measured_at_unix_ms > HISTORY_AGE_MS
                || past.samples.iter().any(|s| {
                    !duration(s.duration_ms)
                        || s.baseline_ms.is_some_and(|v| !duration(v))
                        || s.attempts == 0
                        || s.attempts > 1000
                })
                || past.preparation_ms.is_some_and(|v| !duration(v))
                || past.baseline_ms.is_some_and(|v| !duration(v))
            {
                self.history_notes
                    .push(format!("ignored invalid metrics: {}", past.id));
                continue;
            }
            scope.history_samples = past.samples;
            scope.history_measured_at = Some(past.measured_at_unix_ms);
            scope.preparation_ms = scope.preparation_ms.or(past.preparation_ms);
            scope.baseline_ms = scope.baseline_ms.or(past.baseline_ms);
            self.history_notes.push(format!("matched: {}", past.id));
        }
    }
    pub(crate) fn elapsed(&self) -> f64 {
        self.clock.elapsed().as_secs_f64() * 1000.0
    }
    fn record(&mut self, event: Event) -> Result<Event, String> {
        let (id, at) = event.target();
        let at =
            at.unwrap_or_else(|| self.elapsed())
                .max(if at.is_none() { self.last_at } else { 0.0 });
        if !duration(at) || at < self.last_at {
            return Err("ETA event time must be finite and monotonic".into());
        }
        let index = self
            .scopes
            .iter()
            .position(|scope| scope.id == id)
            .ok_or("Unknown ETA scope")?;
        if matches!(event, Event::Begin { .. })
            && self.scopes[..index].iter().any(|scope| !scope.ended)
        {
            return Err("ETA scopes execute sequentially; preceding scopes must end first".into());
        }
        let scope = &mut self.scopes[index];
        if scope.ended {
            return Err("ETA scope already ended".into());
        }
        let mut recorded = event.clone();
        recorded.set_time(at);
        match event {
            Event::Begin { .. } => {
                if scope.begun.is_some() {
                    return Err("ETA scope already begun".into());
                }
                scope.begun = Some(at);
            }
            Event::Plan { plan, .. } => {
                if scope
                    .statuses
                    .iter()
                    .any(|status| !matches!(status, Status::Queued))
                {
                    return Err("Cannot replace an executing ETA plan".into());
                }
                scope.set_plan(plan)?;
                if let Some(begun) = scope.begun {
                    scope.preparation_ms = Some(at - begun);
                    scope.planned_at = Some(at);
                }
            }
            Event::Capacity {
                runners,
                unmeasured_work,
                ..
            } => {
                if runners > 4096 {
                    return Err("ETA runner count must be from 0 through 4096".into());
                }
                let plan = scope.plan.as_mut().ok_or("ETA capacity requires a plan")?;
                plan.runners = runners;
                if let Some(work) = unmeasured_work {
                    plan.unmeasured_work = work;
                }
            }
            Event::Degrade { reason, .. } => {
                if let Some(plan) = &mut scope.plan {
                    plan.complete = false;
                    plan.notes.push(reason);
                }
            }
            Event::Start { job_id, .. } => {
                if scope.begun.is_none() {
                    return Err("Begin ETA scope before starting jobs".into());
                }
                let job = *scope.indexes.get(&job_id).ok_or("Unknown ETA job")?;
                if !matches!(scope.statuses[job], Status::Queued) {
                    return Err("ETA job already started or completed".into());
                }
                scope.statuses[job] = Status::Running(at);
            }
            Event::Finish {
                job_id,
                duration_ms,
                attempts,
                timed_out,
                sample,
                ..
            } => {
                if scope.begun.is_none() {
                    return Err("Begin ETA scope before finishing jobs".into());
                }
                let job = *scope.indexes.get(&job_id).ok_or("Unknown ETA job")?;
                if matches!(scope.statuses[job], Status::Done) {
                    return Err("ETA job already completed".into());
                }
                let measured = duration_ms.or_else(|| {
                    if let Status::Running(start) = scope.statuses[job] {
                        Some(at - start)
                    } else {
                        None
                    }
                });
                let attempts_measured = attempts.is_some() || (sample && measured.is_some());
                let attempts = attempts.unwrap_or(1);
                if measured.is_some_and(|v| !duration(v)) || attempts == 0 || attempts > 1000 {
                    return Err("Invalid ETA execution metrics".into());
                }
                if let Event::Finish {
                    duration_ms,
                    attempts: recorded_attempts,
                    ..
                } = &mut recorded
                {
                    *duration_ms = measured;
                    *recorded_attempts = attempts_measured.then_some(attempts);
                }
                if sample && let Some(wall) = measured {
                    let plan = scope.plan.as_ref().expect("indexed plan");
                    scope.samples.push_back(Sample {
                        baseline_ms: plan.jobs[job].baseline_ms,
                        duration_ms: wall,
                        reload: plan.jobs[job].reload,
                        attempts,
                        timed_out,
                    });
                    if scope.samples.len() > WINDOW {
                        scope.samples.pop_front();
                    }
                }
                scope.statuses[job] = Status::Done;
                scope.completed += 1;
            }
            Event::End { .. } => {
                if scope
                    .statuses
                    .iter()
                    .any(|status| !matches!(status, Status::Done))
                {
                    return Err("Cannot end ETA scope with unfinished jobs".into());
                }
                scope.ended = true;
            }
        }
        self.last_at = at;
        Ok(recorded)
    }
    fn estimate(&self, at: f64) -> Result<Value, String> {
        if !duration(at) || at < self.last_at {
            return Err("ETA snapshot time precedes its observations".into());
        }
        let scopes = self
            .scopes
            .iter()
            .map(|scope| scope.estimate(at))
            .collect::<Vec<_>>();
        let known: f64 = scopes
            .iter()
            .map(|s| s["knownRemainingMs"].as_f64().unwrap_or(0.0))
            .sum();
        let low: f64 = scopes
            .iter()
            .map(|s| s["range"]["lowerMs"].as_f64().unwrap_or(0.0))
            .sum();
        let high: f64 = scopes
            .iter()
            .map(|s| s["range"]["upperMs"].as_f64().unwrap_or(0.0))
            .sum();
        let full = scopes.iter().all(|scope| !scope["remainingMs"].is_null());
        let complete = self.scopes.iter().all(|s| s.ended);
        let some_known = scopes.iter().any(|s| s["plannedJobs"].is_number());
        Ok(
            json!({"version":1,"observedAtMs":at,"state":if complete {"complete"} else if full {"estimated"} else if some_known {"partial"} else {"unknown"},
            "remainingMs":if full {Some(known)} else {None},"knownRemainingMs":known,"range":{"lowerMs":low,"upperMs":if full {Some(high)} else {None}},"scopes":scopes,
            "provenance":{"model":MODEL,"history":self.history_notes,"rangeKind":"heuristic, not a confidence interval or deadline guarantee","scopeScheduling":"sequential","excludes":["final reporting and teardown","undisclosed scopes or external contention"],"accuracy":"not calibrated on real-project held-out runs"}}),
        )
    }
    fn history(&self, now: f64) -> History {
        History {
            version: 1,
            model: MODEL.into(),
            generated_at_unix_ms: now,
            scopes: self
                .scopes
                .iter()
                .filter_map(|s| {
                    let identity = s.identity.clone()?;
                    // Do not rejuvenate untouched old samples when persisting
                    // an interrupted campaign. New samples replace the old window.
                    let (samples, measured_at_unix_ms) = if !s.samples.is_empty() {
                        (s.samples.clone(), now)
                    } else if let Some(at) = s.history_measured_at {
                        (s.history_samples.clone(), at)
                    } else if s.planned_at.is_some() {
                        (VecDeque::new(), now)
                    } else {
                        return None;
                    };
                    Some(HistoryScope {
                        id: s.id.clone(),
                        identity,
                        measured_at_unix_ms,
                        preparation_ms: s.preparation_ms,
                        baseline_ms: s.baseline_ms,
                        samples,
                    })
                })
                .collect(),
        }
    }
}

impl Scope {
    fn set_plan(&mut self, plan: Plan) -> Result<(), String> {
        if plan.runners > 4096
            || plan.jobs.len() > MAX_JOBS
            || plan.preparation_ms.is_some_and(|v| !duration(v))
            || plan.baseline_ms.is_some_and(|v| !duration(v))
        {
            return Err("Invalid ETA plan size, runners or timing".into());
        }
        let mut indexes = HashMap::new();
        for (index, job) in plan.jobs.iter().enumerate() {
            if !label(&job.id)
                || indexes.insert(job.id.clone(), index).is_some()
                || job.baseline_ms.is_some_and(|v| !duration(v))
                || job.timeout_ms.is_some_and(|v| !duration(v))
            {
                return Err("Invalid or duplicate ETA job".into());
            }
        }
        self.preparation_ms = plan.preparation_ms.or(self.preparation_ms);
        self.baseline_ms = plan.baseline_ms.or(self.baseline_ms);
        self.statuses = vec![Status::Queued; plan.jobs.len()];
        self.indexes = indexes;
        self.plan = Some(plan);
        Ok(())
    }
    fn forecast(&self, job: &Job) -> Option<Forecast> {
        // A rolling window adapts to pace changes. Current observations replace,
        // rather than indefinitely blending with, source-matching older runs.
        let samples = if self.samples.iter().any(|s| s.reload == job.reload) {
            &self.samples
        } else {
            &self.history_samples
        };
        let mut durations = samples
            .iter()
            .filter(|s| s.reload == job.reload)
            .map(|s| match (job.baseline_ms, s.baseline_ms) {
                (Some(base), Some(observed)) if base > 0.0 && observed > 0.0 => {
                    s.duration_ms * base / observed
                }
                _ => s.duration_ms,
            })
            .collect::<Vec<_>>();
        if durations.iter().any(|v| !duration(*v)) {
            return None;
        }
        if durations.is_empty() {
            let base = job.baseline_ms.filter(|v| *v > 0.0)?;
            // The inactive run is evidence for a scale, not an accuracy claim.
            durations.push(base);
            return Some(Forecast {
                costs: [base * 0.25, base, base * 2.0],
                durations,
                from_baseline: true,
            });
        }
        durations.sort_by(f64::total_cmp);
        let mean = durations.iter().sum::<f64>() / durations.len() as f64;
        let low = durations[durations.len() / 10].min(mean * 0.75);
        let high = durations[(durations.len() * 9 / 10).min(durations.len() - 1)].max(mean * 1.25);
        Some(Forecast {
            costs: [low, mean, high],
            durations,
            from_baseline: false,
        })
    }
    fn estimate(&self, at: f64) -> Value {
        if self.ended {
            return json!({"id":self.id,"state":"complete","plannedJobs":self.plan.as_ref().map(|p|p.jobs.len()),"completedJobs":self.completed,"runningJobs":0,"queuedJobs":0,"remainingMs":0,"knownRemainingMs":0,"range":{"lowerMs":0,"upperMs":0},"unknown":[]});
        }
        let Some(plan) = &self.plan else {
            return json!({"id":self.id,"state":"unknown","plannedJobs":null,"remainingMs":null,"knownRemainingMs":0,"range":{"lowerMs":0,"upperMs":null},"unknown":["runnable plan unavailable"]});
        };
        let mut unknown = plan.unmeasured_work.clone();
        if !plan.complete {
            unknown.push("plan is partial; additional jobs unknown".into());
        }
        let mut preparation = 0.0;
        if self.planned_at.is_none() {
            if let Some(cost) = self.preparation_ms {
                preparation = (cost - self.begun.map_or(0.0, |start| at - start)).max(0.0);
            } else {
                unknown.push("remaining preparation/baseline cost unmeasured".into());
            }
            if self.begun.is_some() && preparation == 0.0 {
                unknown.push("preparation still running beyond its measured cost".into());
            }
        }
        let running = self
            .statuses
            .iter()
            .filter(|s| matches!(s, Status::Running(_)))
            .count();
        let queued = self
            .statuses
            .iter()
            .filter(|s| matches!(s, Status::Queued))
            .count();
        if plan.runners == 0 && running + queued > 0 {
            unknown.push("no available runners; resumption unknown".into());
        }
        let mut timelines = [
            vec![0.0; plan.runners.max(running).max(1)],
            vec![0.0; plan.runners.max(running).max(1)],
            vec![0.0; plan.runners.max(running).max(1)],
        ];
        let mut slot = 0;
        let mut missing = 0;
        // Jobs commonly share the same inactive scale. Normalize and sort each
        // reload/scale distribution once per snapshot, not once per mutant.
        // Age and timeout remain job-specific and never enter calibration.
        let mut forecasts = HashMap::new();
        let mut forecast = |job: &Job, age| {
            forecasts
                .entry((job.reload, job.baseline_ms.map(f64::to_bits)))
                .or_insert_with(|| self.forecast(job))
                .as_ref()
                .map(|forecast| forecast.remaining(age, job.timeout_ms))
        };
        for (job, status) in plan.jobs.iter().zip(&self.statuses) {
            if let Status::Running(start) = status {
                if let Some(cost) = forecast(job, Some(at - start)) {
                    for i in 0..3 {
                        timelines[i][slot] = cost[i];
                    }
                } else {
                    missing += 1;
                }
                slot += 1;
            }
        }
        if running > plan.runners && plan.runners > 0 {
            // When capacity shrinks, draining jobs still occupy resources. New
            // jobs cannot start until in-flight occupancy falls below the limit.
            for timeline in &mut timelines {
                timeline.sort_by(|a, b| b.total_cmp(a));
                timeline.truncate(plan.runners);
            }
        }
        for (job, status) in plan.jobs.iter().zip(&self.statuses) {
            if matches!(status, Status::Queued) && plan.runners > 0 {
                if let Some(cost) = forecast(job, None) {
                    for i in 0..3 {
                        // Honor the supplied order and actual occupied workers.
                        let next = timelines[i]
                            .iter()
                            .enumerate()
                            .min_by(|(_, a), (_, b)| a.total_cmp(b))
                            .expect("runner slot")
                            .0;
                        timelines[i][next] += cost[i];
                    }
                } else {
                    missing += 1;
                }
            }
        }
        if missing > 0 {
            unknown.push(format!("{missing} jobs have no measured duration scale"));
        }
        let costs = timelines.map(|slots| slots.into_iter().fold(0.0, f64::max));
        let full = unknown.is_empty();
        json!({"id":self.id,"state":if full {"estimated"}else{"partial"},"plannedJobs":plan.jobs.len(),"completedJobs":self.completed,"runningJobs":running,"queuedJobs":queued,"effectiveRunners":plan.runners,
            "remainingMs":if full {Some(preparation+costs[1])}else{None},"knownRemainingMs":preparation+costs[1],"range":{"lowerMs":preparation+costs[0],"upperMs":if full {Some(preparation+costs[2])}else{None}},"unknown":unknown,
            "provenance":{"baselineMs":self.baseline_ms,"preparationMs":self.preparation_ms,"plannedAtMs":self.planned_at,"currentSamples":self.samples.len(),"matchingHistorySamples":self.history_samples.len(),"window":WINDOW,"notes":plan.notes,"timedOutSamples":self.samples.iter().filter(|s|s.timed_out).count(),"retryAttempts":self.samples.iter().map(|s|s.attempts.saturating_sub(1) as usize).sum::<usize>()}})
    }
}

fn residual(cost: [f64; 3], age: Option<f64>, samples: &[f64], timeout: Option<f64>) -> [f64; 3] {
    let Some(age) = age else {
        return cost;
    };
    let (sum, count) = samples
        .iter()
        .copied()
        .filter(|v| *v > age)
        .fold((0.0, 0), |(sum, count), value| (sum + value, count + 1));
    if count > 0 {
        let mean = sum / count as f64 - age;
        return [0.0, mean, (cost[2] - age).max(mean * 1.25)];
    }
    // Right-censored running jobs must not disappear at their old prediction.
    // Beyond the observed tail, retain the positive, scale-based heuristic.
    // A configured timeout supplies no probability of using that budget: Core
    // computes it from timeoutFactor * netTime + timeoutMS + overhead. It is an
    // uncertainty scenario only, not half a timeout of expected remaining work.
    // Recovery/retries may also exceed it, so it is never a hard cap.
    let horizon = timeout.unwrap_or(cost[2]);
    let remaining = (cost[1] * 0.25).max(1.0);
    [
        0.0,
        remaining,
        (cost[2] - age).max(horizon - age).max(remaining * 2.0),
    ]
}

/// Shared with a native coordinator; snapshots remain callable on the JS thread.
#[napi]
pub struct EtaEngine {
    pub(crate) inner: Arc<Mutex<Campaign>>,
}
#[napi]
impl EtaEngine {
    #[napi(constructor)]
    pub fn new(input: String) -> napi::Result<Self> {
        let input: Input =
            serde_json::from_str(&input).map_err(|e| fail(format!("Invalid ETA campaign: {e}")))?;
        Ok(Self {
            inner: Arc::new(Mutex::new(Campaign::new(input).map_err(fail)?)),
        })
    }
    #[napi]
    pub fn record(&self, input: String) -> napi::Result<String> {
        let event: Event =
            serde_json::from_str(&input).map_err(|e| fail(format!("Invalid ETA event: {e}")))?;
        self.inner
            .lock()
            .map_err(|_| fail("ETA state poisoned"))?
            .record(event)
            .map(|event| serde_json::to_string(&event).expect("numeric ETA event"))
            .map_err(fail)
    }
    #[napi]
    pub fn snapshot(&self, at_ms: Option<f64>) -> napi::Result<String> {
        let state = self.inner.lock().map_err(|_| fail("ETA state poisoned"))?;
        state
            .estimate(at_ms.unwrap_or_else(|| state.elapsed().max(state.last_at)))
            .map(|v| v.to_string())
            .map_err(fail)
    }
    #[napi]
    pub fn history(&self, now_unix_ms: Option<f64>) -> napi::Result<String> {
        let now = now_unix_ms.unwrap_or_else(unix_ms);
        if !now.is_finite() || now < 0.0 {
            return Err(fail("Invalid ETA history timestamp"));
        }
        let state = self.inner.lock().map_err(|_| fail("ETA state poisoned"))?;
        serde_json::to_string(&state.history(now)).map_err(|e| fail(e.to_string()))
    }
}

#[derive(Clone)]
pub(crate) struct Observer {
    inner: Arc<Mutex<Campaign>>,
    scope: String,
}
impl Observer {
    pub(crate) fn new(engine: &EtaEngine, scope: String) -> napi::Result<Self> {
        if !engine
            .inner
            .lock()
            .map_err(|_| fail("ETA state poisoned"))?
            .scopes
            .iter()
            .any(|s| s.id == scope)
        {
            return Err(fail("Unknown ETA scope"));
        }
        Ok(Self {
            inner: engine.inner.clone(),
            scope,
        })
    }
    fn send(&self, event: Event) {
        // Advisory telemetry never changes a test result or aborts a run.
        if let Ok(mut state) = self.inner.lock()
            && let Err(error) = state.record(event)
        {
            state
                .history_notes
                .push(format!("native observation rejected: {error}"));
            if let Some(scope) = state.scopes.iter_mut().find(|scope| scope.id == self.scope)
                && let Some(plan) = &mut scope.plan
            {
                plan.complete = false;
            }
        }
    }
    pub(crate) fn plan(&self, jobs: Vec<Job>, runners: usize, baseline: f64, notes: Vec<String>) {
        self.send(Event::Plan {
            scope_id: self.scope.clone(),
            at_ms: None,
            plan: Plan {
                jobs,
                runners,
                preparation_ms: None,
                baseline_ms: Some(baseline),
                complete: true,
                notes,
                unmeasured_work: vec![],
            },
        });
    }
    pub(crate) fn capacity(&self, runners: usize, unmeasured_work: Vec<String>) {
        self.send(Event::Capacity {
            scope_id: self.scope.clone(),
            at_ms: None,
            runners,
            unmeasured_work: Some(unmeasured_work),
        });
    }
    pub(crate) fn start(&self, id: &str) {
        self.send(Event::Start {
            scope_id: self.scope.clone(),
            at_ms: None,
            job_id: id.into(),
        });
    }
    pub(crate) fn finish(&self, id: &str, duration: f64, attempts: u32, timed_out: bool) {
        self.send(Event::Finish {
            scope_id: self.scope.clone(),
            at_ms: None,
            job_id: id.into(),
            duration_ms: Some(duration),
            attempts: Some(attempts),
            timed_out,
            sample: true,
        });
    }
    pub(crate) fn end(&self) {
        self.send(Event::End {
            scope_id: self.scope.clone(),
            at_ms: None,
        });
    }
}

#[cfg(test)]
#[path = "eta_tests.rs"]
mod tests;
