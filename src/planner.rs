//! Batch branch selection and run-option arithmetic; Node retains objects/effects.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::coverage::{finite, response};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    version: u32,
    has_coverage: bool,
    ignore_static: bool,
    time_spent_all_tests: f64,
    global_filter_present: bool,
    #[serde(rename = "timeoutMS")]
    timeout_ms: f64,
    timeout_factor: f64,
    #[serde(rename = "timeOverheadMS")]
    time_overhead_ms: f64,
    rows: Vec<Row>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Row {
    has_status: bool,
    is_static: bool,
    covered_times_ms: Vec<f64>,
    #[serde(deserialize_with = "serde::Deserialize::deserialize")]
    hit_count: Option<f64>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum Decision {
    Existing,
    IgnoreStatic,
    #[serde(rename_all = "camelCase")]
    Run {
        selection: &'static str,
        r#static: Option<bool>,
        net_time: f64,
        timeout: f64,
        hit_limit: Option<f64>,
        mutant_activation: &'static str,
        reload_environment: bool,
    },
}

pub(crate) fn planning_batch(input: &str) -> Value {
    response(plan(input))
}

fn plan(input: &str) -> Result<Vec<Decision>, String> {
    let input: Input = serde_json::from_str(input).map_err(|error| error.to_string())?;
    if input.version != 1 {
        return Err("Unsupported planning ABI version".into());
    }
    for number in [
        input.time_spent_all_tests,
        input.timeout_ms,
        input.timeout_factor,
        input.time_overhead_ms,
    ] {
        finite(number)?;
    }
    input
        .rows
        .iter()
        .map(|row| {
            for &time in &row.covered_times_ms {
                finite(time)?;
            }
            if let Some(hits) = row.hit_count {
                finite(hits)?;
            }
            if row.has_status {
                return Ok(Decision::Existing);
            }
            let covered = input.has_coverage
                && (!row.is_static || (input.ignore_static && !row.covered_times_ms.is_empty()));
            if input.has_coverage && row.is_static && input.ignore_static && !covered {
                return Ok(Decision::IgnoreStatic);
            }
            let net_time = if covered {
                row.covered_times_ms
                    .iter()
                    .try_fold(0.0, |sum, time| finite(sum + time))?
            } else {
                input.time_spent_all_tests
            };
            // Keep JavaScript's evaluation order, including intermediate overflow.
            let timeout = finite(
                input.timeout_factor * net_time + input.timeout_ms + input.time_overhead_ms,
            )?;
            let hit_limit = row.hit_count.map(|hits| finite(hits * 100.0)).transpose()?;
            let is_static = input.has_coverage.then_some(row.is_static);
            let filter_present = covered || input.global_filter_present;
            Ok(Decision::Run {
                selection: if covered { "covered" } else { "global" },
                r#static: is_static,
                net_time,
                timeout,
                hit_limit,
                mutant_activation: if filter_present { "runtime" } else { "static" },
                reload_environment: !(filter_present && is_static == Some(false)),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn input() -> Value {
        json!({"version":1,"hasCoverage":true,"ignoreStatic":true,"timeSpentAllTests":42,
        "globalFilterPresent":false,"timeoutMS":10,"timeoutFactor":1.5,"timeOverheadMS":2,
        "rows":[
            {"hasStatus":true,"isStatic":true,"coveredTimesMs":[],"hitCount":null},
            {"hasStatus":false,"isStatic":true,"coveredTimesMs":[],"hitCount":0},
            {"hasStatus":false,"isStatic":true,"coveredTimesMs":[20,2],"hitCount":-2},
            {"hasStatus":false,"isStatic":false,"coveredTimesMs":[],"hitCount":0}
        ]})
    }

    #[test]
    fn covers_existing_ignored_hybrid_and_empty_filter() {
        let result = planning_batch(&input().to_string());
        assert_eq!(result["result"][0], json!({"kind":"existing"}));
        assert_eq!(result["result"][1], json!({"kind":"ignore-static"}));
        assert_eq!(
            result["result"][2],
            json!({"kind":"run","selection":"covered","static":true,
            "netTime":22.0,"timeout":45.0,"hitLimit":-200.0,"mutantActivation":"runtime","reloadEnvironment":true})
        );
        assert_eq!(result["result"][3]["netTime"], 0.0);
        assert_eq!(result["result"][3]["reloadEnvironment"], false);
    }

    #[test]
    fn has_no_partial_decisions_on_overflow_or_bad_numbers() {
        for number in [json!(-0.0), json!(1e308)] {
            let mut input = input();
            input["rows"][3]["hitCount"] = number;
            let result = planning_batch(&input.to_string());
            assert_eq!(result["supported"], false);
            assert!(result.get("result").is_none());
        }
    }
}
