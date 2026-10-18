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
        325.0,
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

#[test]
fn configured_timeout_changes_uncertainty_not_the_expected_overrun_duration() {
    for observed in [false, true] {
        let mut predictions = vec![];
        for timeout in [None, Some(300.0), Some(1_200_000.0)] {
            let mut c = campaign(json!([{"id":"s"}]));
            let mut p = plan(&[Some(100.0); 2], 1);
            for job in p["jobs"].as_array_mut().unwrap() {
                job["timeoutMs"] = json!(timeout);
            }
            begin(&mut c, p);
            if observed {
                event(
                    &mut c,
                    json!({"type":"finish","scopeId":"s","jobId":"0","atMs":10,"durationMs":100}),
                );
            }
            event(
                &mut c,
                json!({"type":"start","scopeId":"s","jobId":"1","atMs":10}),
            );
            let snapshot = c.estimate(210.0).unwrap();
            let central = remaining(&c, 210.0);
            assert!(
                central > 0.0,
                "unfinished jobs retain positive residual work"
            );
            assert!(snapshot["range"]["upperMs"].as_f64().unwrap() >= central);
            predictions.push(central);
        }
        assert_eq!(predictions[0], predictions[1]);
        assert_eq!(
            predictions[0], predictions[2],
            "a configured limit is not a duration observation"
        );
    }
}

#[test]
fn empirical_running_tail_conditions_on_only_longer_observations() {
    let mut c = campaign(json!([{"id":"s"}]));
    begin(&mut c, plan(&[Some(100.0); 4], 1));
    for (id, wall) in [(0, 40), (1, 100), (2, 300)] {
        event(
            &mut c,
            json!({"type":"finish","scopeId":"s","jobId":id.to_string(),"atMs":10,"durationMs":wall}),
        );
    }
    event(
        &mut c,
        json!({"type":"start","scopeId":"s","jobId":"3","atMs":10}),
    );
    assert_eq!(
        remaining(&c, 160.0),
        150.0,
        "E[T-age | T>age], not unconditional mean minus age"
    );
    assert!(
        remaining(&c, 1_000.0) > 0.0,
        "the observed maximum is not a deadline"
    );
}

#[test]
fn shared_forecasts_keep_baseline_normalization_reload_groups_and_timeouts_separate() {
    let mut c = campaign(json!([{"id":"s"}]));
    let mut p = plan(
        &[
            Some(100.0),
            Some(100.0),
            Some(100.0),
            Some(200.0),
            Some(100.0),
            Some(200.0),
        ],
        2,
    );
    for id in [1, 4, 5] {
        p["jobs"][id]["reload"] = json!(true);
    }
    p["jobs"][2]["timeoutMs"] = json!(1_200_000.0);
    begin(&mut c, p);
    event(
        &mut c,
        json!({"type":"finish","scopeId":"s","jobId":"0","atMs":10,"durationMs":50}),
    );
    event(
        &mut c,
        json!({"type":"finish","scopeId":"s","jobId":"1","atMs":10,"durationMs":300}),
    );
    // Remaining FIFO costs are [50,100,300,600]. Two workers finish at 350,700.
    assert_eq!(remaining(&c, 10.0), 700.0);
    for id in [2, 3] {
        event(
            &mut c,
            json!({"type":"start","scopeId":"s","jobId":id.to_string(),"atMs":10}),
        );
    }
    assert_eq!(remaining(&c, 30.0), 680.0);
}

#[test]
fn dealyv_semantic_replay_keeps_baselines_inside_first_outer_mutant_runs() {
    // Recorded SDK epochs relative to 1792299953847.148. First calls include
    // each worker's inactive baseline; later calls use their active-run start.
    // This replays semantic shape, not exact IPC timestamps (not captured).
    // (id, outer start, outer finish): creation order differs from completion.
    let calls: [(usize, f64, f64); 13] = [
        (0, 0.004, 38_274.567),
        (1, 0.0, 27_314.626),
        (2, 0.163, 27_476.427),
        (3, 391.803, 28_519.394),
        (4, 0.015, 38_323.384),
        (5, 854.264, 38_738.560),
        (6, 407.570, 27_724.050),
        (7, 920.497, 28_677.277),
        (8, 27_320.386, 30_532.459),
        (9, 27_480.140, 31_173.717),
        (10, 27_727.155, 30_928.824),
        (11, 28_532.582, 31_588.849),
        (12, 28_680.854, 31_502.229),
    ];
    let mut c = campaign(json!([{"id":"s"}]));
    event(&mut c, json!({"type":"begin","scopeId":"s","atMs":0}));
    let mut p = plan(&[Some(9_025.0); 13], 4);
    for job in p["jobs"].as_array_mut().unwrap() {
        job["timeoutMs"] = json!(1_211_904.5);
        job["reload"] = json!(true);
    }
    p["unmeasuredWork"] = json!(["checker processing time unmeasured"]);
    event(
        &mut c,
        json!({"type":"plan","scopeId":"s","atMs":0,"plan":p}),
    );
    assert_eq!(c.estimate(0.0).unwrap()["state"], "partial");
    event(
        &mut c,
        json!({"type":"capacity","scopeId":"s","atMs":0,"runners":8,"unmeasuredWork":[]}),
    );
    let mut events = calls
        .iter()
        .flat_map(|&(id, start, finish)| {
            [
                (
                    start,
                    json!({"type":"start","scopeId":"s","jobId":id.to_string(),"atMs":start}),
                ),
                (
                    finish,
                    json!({"type":"finish","scopeId":"s","jobId":id.to_string(),"atMs":finish}),
                ),
            ]
        })
        .collect::<Vec<_>>();
    events.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut events = events.into_iter().peekable();
    for at in [9_152.852, 19_152.852, 29_152.852] {
        while events.peek().is_some_and(|(time, _)| *time <= at) {
            event(&mut c, events.next().unwrap().1);
        }
        let snapshot = c.estimate(at).unwrap();
        let scope = &snapshot["scopes"][0];
        assert_eq!(scope["plannedJobs"], 13);
        assert_eq!(
            scope["completedJobs"].as_u64().unwrap()
                + scope["runningJobs"].as_u64().unwrap()
                + scope["queuedJobs"].as_u64().unwrap(),
            13
        );
        println!(
            "dealyv replay at={at:.3} remaining={:.3} actual={:.3} completed={} running={} queued={}",
            remaining(&c, at),
            38_738.560 - at,
            scope["completedJobs"],
            scope["runningJobs"],
            scope["queuedJobs"]
        );
        assert!(
            remaining(&c, at) < 60_000.0,
            "20-minute configuration must not create a ten-minute central forecast"
        );
    }
    for (_, value) in events {
        event(&mut c, value);
    }
    assert_eq!(c.scopes[0].completed, 13);
    assert_eq!(c.scopes[0].samples.len(), 13);
    assert_eq!(remaining(&c, 38_738.560), 0.0);
    event(
        &mut c,
        json!({"type":"end","scopeId":"s","atMs":38_738.560}),
    );
    assert_eq!(c.estimate(38_738.560).unwrap()["state"], "complete");
}

#[test]
fn dropped_and_late_events_do_not_fabricate_samples_or_completion() {
    let mut c = campaign(json!([{"id":"s"},{"id":"undiscovered"}]));
    begin(&mut c, plan(&[Some(100.0); 3], 2));
    // A terminal checker result, and a dropped start with a measured IPC finish.
    event(
        &mut c,
        json!({"type":"finish","scopeId":"s","jobId":"0","atMs":20,"sample":false}),
    );
    event(
        &mut c,
        json!({"type":"finish","scopeId":"s","jobId":"1","atMs":30,"durationMs":50,"attempts":1,"timedOut":true}),
    );
    event(
        &mut c,
        json!({"type":"start","scopeId":"s","jobId":"2","atMs":30}),
    );
    let last_at = c.last_at;
    for invalid in [
        json!({"type":"end","scopeId":"s","atMs":40}),
        json!({"type":"finish","scopeId":"s","jobId":"1","atMs":40,"durationMs":1}),
        json!({"type":"finish","scopeId":"s","jobId":"2","atMs":29}),
    ] {
        assert!(c.record(serde_json::from_value(invalid).unwrap()).is_err());
        assert_eq!(c.last_at, last_at);
    }
    // Cancellation without a final finish/end cannot become a successful end.
    let snapshot = c.estimate(10_000.0).unwrap();
    assert_eq!(snapshot["state"], "partial");
    assert!(snapshot["remainingMs"].is_null());
    assert!(snapshot["range"]["upperMs"].is_null());
    assert!(snapshot["knownRemainingMs"].as_f64().unwrap() > 0.0);
    assert_eq!(snapshot["scopes"][0]["completedJobs"], 2);
    assert_eq!(snapshot["scopes"][0]["runningJobs"], 1);
    assert_eq!(snapshot["scopes"][0]["provenance"]["currentSamples"], 1);
}

#[test]
fn timeout_budget_and_unmeasured_finish_do_not_invent_a_duration_scale() {
    for timeout in [None, Some(1_200_000.0)] {
        let mut c = campaign(json!([{"id":"s"}]));
        let mut p = plan(&[None; 2], 1);
        for job in p["jobs"].as_array_mut().unwrap() {
            job["timeoutMs"] = json!(timeout);
        }
        begin(&mut c, p);
        // A dropped start without an explicit duration retires the result only.
        event(
            &mut c,
            json!({"type":"finish","scopeId":"s","jobId":"0","atMs":20}),
        );
        let snapshot = c.estimate(20.0).unwrap();
        assert_eq!(snapshot["state"], "partial");
        assert!(snapshot["remainingMs"].is_null());
        assert_eq!(snapshot["knownRemainingMs"], 0.0);
        assert_eq!(snapshot["scopes"][0]["completedJobs"], 1);
        assert_eq!(snapshot["scopes"][0]["provenance"]["currentSamples"], 0);
    }
}
