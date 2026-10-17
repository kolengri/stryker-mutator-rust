use super::*;

fn campaign(scopes: Value) -> Campaign {
    Campaign::new(serde_json::from_value(json!({"scopes":scopes})).unwrap()).unwrap()
}
fn event(c: &mut Campaign, value: Value) {
    c.record(serde_json::from_value(value).unwrap()).unwrap();
}
fn plan(durations: &[Option<f64>], runners: usize) -> Value {
    json!({"runners":runners,"jobs":durations.iter().enumerate().map(|(id,cost)|json!({"id":id.to_string(),"baselineMs":cost,"timeoutMs":cost.map(|v|v*3.0)})).collect::<Vec<_>>()})
}
fn begin(c: &mut Campaign, p: Value) {
    event(c, json!({"type":"begin","scopeId":"s","atMs":0}));
    event(c, json!({"type":"plan","scopeId":"s","atMs":10,"plan":p}));
}
fn remaining(c: &Campaign, at: f64) -> f64 {
    c.estimate(at).unwrap()["remainingMs"].as_f64().unwrap()
}

#[test]
fn unequal_jobs_replay_the_actual_supplied_fifo_schedule() {
    // Two workers: [100,10] start together. The 10ms worker takes another
    // 10ms job then a 100ms job. Completion is 120ms, not total work / 2=110.
    let mut c = campaign(json!([{"id":"s"}]));
    begin(
        &mut c,
        plan(&[Some(100.0), Some(10.0), Some(10.0), Some(100.0)], 2),
    );
    assert_eq!(remaining(&c, 10.0), 120.0);
    event(
        &mut c,
        json!({"type":"start","scopeId":"s","jobId":"0","atMs":10}),
    );
    event(
        &mut c,
        json!({"type":"start","scopeId":"s","jobId":"1","atMs":10}),
    );
    event(
        &mut c,
        json!({"type":"finish","scopeId":"s","jobId":"1","atMs":20}),
    );
    event(
        &mut c,
        json!({"type":"start","scopeId":"s","jobId":"2","atMs":20}),
    );
    assert_eq!(remaining(&c, 20.0), 110.0);
    // Core 10's elapsed/completed-weight forecast at this exact trace point:
    let elapsed_tick_eta = 10.0 / 10.0 * (220.0 - 10.0);
    assert_eq!(elapsed_tick_eta, 210.0);
    event(
        &mut c,
        json!({"type":"finish","scopeId":"s","jobId":"2","atMs":30}),
    );
    event(
        &mut c,
        json!({"type":"start","scopeId":"s","jobId":"3","atMs":30}),
    );
    assert_eq!(remaining(&c, 30.0), 100.0);
    event(
        &mut c,
        json!({"type":"finish","scopeId":"s","jobId":"0","atMs":110}),
    );
    assert_eq!(remaining(&c, 110.0), 20.0);
    event(
        &mut c,
        json!({"type":"finish","scopeId":"s","jobId":"3","atMs":130}),
    );
    assert_eq!(remaining(&c, 130.0), 0.0);
    event(&mut c, json!({"type":"end","scopeId":"s","atMs":130}));
    assert_eq!(c.estimate(130.0).unwrap()["state"], "complete");
}

#[test]
fn unknown_scopes_and_partial_plans_never_masquerade_as_full_campaign_eta() {
    let mut c = campaign(json!([{"id":"s"},{"id":"unknown"}]));
    let mut p = plan(&[Some(100.0), None], 1);
    p["complete"] = false.into();
    begin(&mut c, p);
    let result = c.estimate(10.0).unwrap();
    assert_eq!(result["state"], "partial");
    assert!(result["remainingMs"].is_null());
    assert_eq!(result["knownRemainingMs"], 100.0);
    assert!(result["range"]["upperMs"].is_null());
    assert_eq!(result["scopes"][1]["plannedJobs"], Value::Null);
    assert_eq!(result["scopes"][0]["unknown"].as_array().unwrap().len(), 2);
}

#[test]
fn measured_preparation_is_added_once_for_sequential_future_scopes() {
    let mut future = plan(&[Some(80.0), Some(20.0)], 2);
    future["preparationMs"] = json!(50);
    let mut c = campaign(json!([{"id":"s"},{"id":"next","plan":future}]));
    begin(&mut c, plan(&[Some(100.0)], 1));
    assert_eq!(remaining(&c, 10.0), 230.0);
    event(
        &mut c,
        json!({"type":"finish","scopeId":"s","jobId":"0","atMs":110,"durationMs":100}),
    );
    event(&mut c, json!({"type":"end","scopeId":"s","atMs":110}));
    event(&mut c, json!({"type":"begin","scopeId":"next","atMs":110}));
    assert_eq!(remaining(&c, 130.0), 110.0);
    assert!(
        c.estimate(170.0).unwrap()["remainingMs"].is_null(),
        "overrunning preparation must be disclosed"
    );
}

#[test]
fn effective_capacity_and_occupied_long_running_workers_control_the_tail() {
    let mut c = campaign(json!([{"id":"s"}]));
    begin(&mut c, plan(&[Some(100.0); 5], 1));
    assert_eq!(remaining(&c, 10.0), 500.0);
    event(
        &mut c,
        json!({"type":"capacity","scopeId":"s","runners":2,"atMs":10}),
    );
    assert_eq!(remaining(&c, 10.0), 300.0);
    event(
        &mut c,
        json!({"type":"start","scopeId":"s","jobId":"0","atMs":10}),
    );
    event(
        &mut c,
        json!({"type":"start","scopeId":"s","jobId":"1","atMs":10}),
    );
    assert!(
        remaining(&c, 160.0) > 200.0,
        "two right-censored workers still occupy both slots"
    );
    let snapshot = c.estimate(160.0).unwrap();
    assert_eq!(snapshot["scopes"][0]["runningJobs"], 2);
    assert_eq!(snapshot["scopes"][0]["queuedJobs"], 3);
    event(
        &mut c,
        json!({"type":"capacity","scopeId":"s","runners":1,"atMs":160}),
    );
    assert_eq!(
        remaining(&c, 160.0),
        375.0,
        "draining workers must finish before new work uses reduced capacity"
    );
    event(
        &mut c,
        json!({"type":"capacity","scopeId":"s","runners":0,"atMs":160}),
    );
    assert!(c.estimate(160.0).unwrap()["remainingMs"].is_null());
}

#[test]
fn measured_timeouts_and_recovery_attempts_contribute_without_capping_at_deadline() {
    let mut c = campaign(json!([{"id":"s"}]));
    begin(&mut c, plan(&[Some(10.0); 4], 1));
    event(
        &mut c,
        json!({"type":"finish","scopeId":"s","jobId":"0","atMs":80,"durationMs":70,"attempts":2,"timedOut":true}),
    );
    assert_eq!(
        remaining(&c, 80.0),
        210.0,
        "recovery and timeout cost exceeds the 30ms per-attempt deadline"
    );
    let snapshot = c.estimate(80.0).unwrap();
    assert_eq!(snapshot["scopes"][0]["provenance"]["retryAttempts"], 1);
    assert_eq!(snapshot["scopes"][0]["provenance"]["timedOutSamples"], 1);
}

#[test]
fn rolling_observations_adapt_to_changed_pace_and_reload_cost_is_separate() {
    let mut c = campaign(json!([{"id":"s"}]));
    let mut p = plan(&vec![Some(10.0); 70], 1);
    p["jobs"][69]["reload"] = true.into();
    p["jobs"][69]["baselineMs"] = json!(100);
    begin(&mut c, p);
    for id in 0..32 {
        event(
            &mut c,
            json!({"type":"finish","scopeId":"s","jobId":id.to_string(),"atMs":10+id*100,"durationMs":100}),
        );
    }
    let slow = remaining(&c, 3110.0);
    for id in 32..64 {
        event(
            &mut c,
            json!({"type":"finish","scopeId":"s","jobId":id.to_string(),"atMs":3120+(id-32)*10,"durationMs":10}),
        );
    }
    assert!(slow > 3_000.0);
    assert_eq!(
        remaining(&c, 3430.0),
        150.0,
        "five warm jobs plus the unobserved 100ms reload job"
    );
}

#[test]
fn matching_history_is_bounded_metrics_only_and_rejects_changed_inputs_and_bad_data() {
    let identity = "a".repeat(64);
    let mut original = campaign(json!([{"id":"s","identity":identity}]));
    begin(&mut original, plan(&[Some(100.0)], 1));
    event(
        &mut original,
        json!({"type":"finish","scopeId":"s","jobId":"0","atMs":60,"durationMs":50}),
    );
    let history = serde_json::to_value(original.history(1000.0)).unwrap();
    assert!(!history.to_string().contains("jobs"));
    let mut good = Campaign::new(
        serde_json::from_value(
            json!({"scopes":[{"id":"s","identity":identity}],"history":history,"nowUnixMs":1001}),
        )
        .unwrap(),
    )
    .unwrap();
    begin(&mut good, plan(&[Some(100.0); 2], 1));
    assert_eq!(remaining(&good, 10.0), 100.0);
    for bad in [
        json!({}),
        json!({"version":2}),
        {
            let mut v = history.clone();
            v["generatedAtUnixMs"] = json!(1002);
            v
        },
        {
            let mut v = history.clone();
            v["generatedAtUnixMs"] = json!(0);
            v
        },
        {
            let mut v = history.clone();
            v["scopes"][0]["samples"][0]["durationMs"] = json!(-1);
            v
        },
    ] {
        let now = if bad["generatedAtUnixMs"] == 0 {
            HISTORY_AGE_MS + 1.0
        } else {
            1001.0
        };
        let mut stale = Campaign::new(
            serde_json::from_value(
                json!({"scopes":[{"id":"s","identity":identity}],"history":bad,"nowUnixMs":now}),
            )
            .unwrap(),
        )
        .unwrap();
        begin(&mut stale, plan(&[Some(100.0)], 1));
        assert_eq!(remaining(&stale, 10.0), 100.0);
        assert!(stale.history_notes[0].starts_with("ignored"));
    }
    let mut changed=Campaign::new(serde_json::from_value(json!({"scopes":[{"id":"s","identity":"b".repeat(64)}],"history":history,"nowUnixMs":1001})).unwrap()).unwrap();
    begin(&mut changed, plan(&[Some(100.0)], 1));
    assert_eq!(remaining(&changed, 10.0), 100.0);
}

#[test]
fn empty_zero_missing_and_invalid_inputs_have_explicit_outcomes() {
    assert_eq!(
        campaign(json!([])).estimate(0.0).unwrap()["state"],
        "complete"
    );
    let mut c = campaign(json!([{"id":"s"}]));
    begin(&mut c, plan(&[], 1));
    assert_eq!(remaining(&c, 10.0), 0.0);
    let mut c = campaign(json!([{"id":"s"}]));
    begin(&mut c, plan(&[Some(0.0)], 1));
    assert!(c.estimate(10.0).unwrap()["remainingMs"].is_null());
    assert!(c.estimate(f64::NAN).is_err());
    assert!(c.estimate(f64::INFINITY).is_err());
    assert!(
        c.record(
            serde_json::from_value(
                json!({"type":"start","scopeId":"s","jobId":"missing","atMs":10})
            )
            .unwrap()
        )
        .is_err()
    );
    assert!(
        c.record(
            serde_json::from_value(json!({"type":"capacity","scopeId":"s","runners":1,"atMs":9}))
                .unwrap()
        )
        .is_err()
    );
    assert!(
        Campaign::new(serde_json::from_value(json!({"scopes":[{"id":"s"},{"id":"s"}]})).unwrap())
            .is_err()
    );
    assert!(identity(json!({"sources":"s","tests":"t","configuration":"c","lockfile":"l","runtime":"r","engine":"e"}).to_string()).is_ok());
    assert!(identity(json!({"sources":"s"}).to_string()).is_err());
}

#[test]
fn reexporting_an_unobserved_history_scope_does_not_renew_its_measurement_age() {
    let identity = "a".repeat(64);
    let mut original = campaign(json!([{"id":"s","identity":identity}]));
    begin(&mut original, plan(&[Some(100.0)], 1));
    event(
        &mut original,
        json!({"type":"finish","scopeId":"s","jobId":"0","atMs":60,"durationMs":50}),
    );
    let history = serde_json::to_value(original.history(1000.0)).unwrap();
    let untouched = Campaign::new(
        serde_json::from_value(
            json!({"scopes":[{"id":"s","identity":identity}],"history":history,"nowUnixMs":2000}),
        )
        .unwrap(),
    )
    .unwrap();
    let saved = serde_json::to_value(untouched.history(HISTORY_AGE_MS)).unwrap();
    assert_eq!(saved["scopes"][0]["measuredAtUnixMs"], 1000.0);
    let expired = Campaign::new(serde_json::from_value(json!({"scopes":[{"id":"s","identity":identity}],"history":saved,"nowUnixMs":HISTORY_AGE_MS+1001.0})).unwrap()).unwrap();
    assert!(expired.scopes[0].history_samples.is_empty());
}

#[test]
fn extreme_normalization_is_unknown_instead_of_nonfinite_json() {
    let mut c = campaign(json!([{"id":"s"}]));
    begin(&mut c, plan(&[Some(1e-300), Some(1e10)], 1));
    event(
        &mut c,
        json!({"type":"finish","scopeId":"s","jobId":"0","atMs":11,"durationMs":1e10}),
    );
    let value = c.estimate(11.0).unwrap();
    assert!(value["remainingMs"].is_null());
    assert_eq!(value["state"], "partial");
    assert_eq!(value["knownRemainingMs"], 0.0);
}
