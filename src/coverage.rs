//! Ordered coverage indexing for the pinned StrykerJS 10.0.0 core.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    version: u32,
    test_ids: Vec<String>,
    #[serde(deserialize_with = "serde::Deserialize::deserialize")]
    coverage: Option<Coverage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Coverage {
    r#static: Vec<(String, f64)>,
    per_test: Vec<(String, Vec<(String, f64)>)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Index {
    tests_by_id: Vec<(String, usize)>,
    tests_by_mutant_id: Vec<(String, Vec<usize>)>,
    hits_by_mutant_id: Vec<(String, f64)>,
    unknown_test_ids: Vec<String>,
}

pub(crate) fn finite(value: f64) -> Result<f64, String> {
    if value.is_finite() && !(value == 0.0 && value.is_sign_negative()) {
        Ok(value)
    } else {
        Err("Nonfinite or negative-zero core number".into())
    }
}

pub(crate) fn response<T: Serialize>(result: Result<T, String>) -> Value {
    match result {
        Ok(result) => json!({ "supported": true, "result": result }),
        Err(reason) => json!({ "supported": false, "reason": reason }),
    }
}

pub(crate) fn coverage_batch(input: &str) -> Value {
    response(index(input))
}

fn index(input: &str) -> Result<Index, String> {
    let input: Input = serde_json::from_str(input).map_err(|error| error.to_string())?;
    if input.version != 1 {
        return Err("Unsupported coverage ABI version".into());
    }
    let mut result = Index {
        tests_by_id: Vec::new(),
        tests_by_mutant_id: Vec::new(),
        hits_by_mutant_id: Vec::new(),
        unknown_test_ids: Vec::new(),
    };
    let mut test_slots = HashMap::new();
    for (index, id) in input.test_ids.into_iter().enumerate() {
        let next = result.tests_by_id.len();
        let slot = *test_slots.entry(id.clone()).or_insert(next);
        if slot == next {
            result.tests_by_id.push((id, index));
        } else {
            result.tests_by_id[slot].1 = index;
        }
    }
    if let Some(coverage) = input.coverage {
        let mut mutant_slots = HashMap::new();
        let mut associated = HashSet::new();
        for (test_id, counts) in &coverage.per_test {
            if let Some(&slot) = test_slots.get(test_id) {
                let test_index = result.tests_by_id[slot].1;
                for (id, count) in counts {
                    finite(*count)?;
                    if *count > 0.0 && associated.insert((id.clone(), test_index)) {
                        let next = result.tests_by_mutant_id.len();
                        let slot = *mutant_slots.entry(id.clone()).or_insert(next);
                        if slot == next {
                            result.tests_by_mutant_id.push((id.clone(), Vec::new()));
                        }
                        result.tests_by_mutant_id[slot].1.push(test_index);
                    }
                }
            } else {
                result.unknown_test_ids.push(test_id.clone());
            }
        }
        let mut hit_slots = HashMap::new();
        for counts in std::iter::once(&coverage.r#static)
            .chain(coverage.per_test.iter().map(|(_, counts)| counts))
        {
            for (id, count) in counts {
                finite(*count)?;
                let next = result.hits_by_mutant_id.len();
                let slot = *hit_slots.entry(id.clone()).or_insert(next);
                if slot == next {
                    result.hits_by_mutant_id.push((id.clone(), 0.0));
                }
                let hits = &mut result.hits_by_mutant_id[slot].1;
                *hits = finite(*hits + count)?;
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_duplicate_slots_last_test_and_unknown_hits() {
        let result = coverage_batch(
            r#"{"version":1,"testIds":["a","b","a"],"coverage":{"static":[["x",-2]],"perTest":[["a",[["x",3],["z",0]]],["missing",[["x",4]]],["b",[["x",1]]]]}}"#,
        );
        assert_eq!(result["result"]["testsById"], json!([["a", 2], ["b", 1]]));
        assert_eq!(result["result"]["testsByMutantId"], json!([["x", [2, 1]]]));
        assert_eq!(
            result["result"]["hitsByMutantId"],
            json!([["x", 6.0], ["z", 0.0]])
        );
        assert_eq!(result["result"]["unknownTestIds"], json!(["missing"]));
    }

    #[test]
    fn rejects_entire_invalid_or_overflowing_batches() {
        for input in [
            "{}",
            r#"{"version":2,"testIds":[],"coverage":null}"#,
            r#"{"version":1,"testIds":[],"coverage":{"static":[["x",-0.0]],"perTest":[]}}"#,
            r#"{"version":1,"testIds":[],"coverage":{"static":[["x",1e308]],"perTest":[["unknown",[["x",1e308]]]]}}"#,
        ] {
            let result = coverage_batch(input);
            assert_eq!(result["supported"], false);
            assert!(result.get("result").is_none());
        }
    }

    #[test]
    fn json_input_preserves_binary64_rounding() {
        let result = coverage_batch(
            r#"{"version":1,"testIds":[],"coverage":{"static":[["x",136306105880066.75]],"perTest":[]}}"#,
        );
        assert_eq!(
            result["result"]["hitsByMutantId"][0][1],
            json!(136306105880066.75)
        );
    }
}
