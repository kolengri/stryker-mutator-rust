//! File-level selection from settled, owned process receipts. Missing evidence
//! never means NoCoverage. This index is independent of private Core admission.
use std::collections::{BTreeSet, HashMap, HashSet};

use napi_derive::napi;
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    version: u32,
    qualified: bool,
    files: Vec<String>,
    runs: Vec<Run>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Run {
    file: String,
    session: String,
    baseline: String,
    receipts: Vec<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Event {
    Start {
        version: u32,
        session: String,
        file: String,
        id: String,
        parent: Option<String>,
    },
    Hit {
        mutant: String,
        phase: String,
    },
    Open {
        child: String,
    },
    #[serde(rename_all = "camelCase")]
    Settled {
        child: String,
        exit_code: i32,
        signal: Option<String>,
    },
    Issue {
        reason: String,
    },
    OpenTask {
        task: String,
    },
    SettledTask {
        task: String,
    },
    CancelTask {
        task: String,
    },
}

struct Receipt {
    version: u32,
    session: String,
    file: String,
    id: String,
    parent: Option<String>,
    children: Vec<String>,
    hits: Vec<(String, bool)>,
}

// Every hit is synchronously appended before execution continues. Root completion
// is established by the consumer's exhaustive process result/EOF; each child's
// completion is established by its parent's settled event after spawnSync EOF.
fn receipt(raw: &str) -> Result<Receipt, String> {
    if !raw.ends_with('\n') {
        return Err("Truncated coverage journal".into());
    }
    let mut events = raw.lines();
    let first: Event = serde_json::from_str(events.next().ok_or("Empty coverage journal")?)
        .map_err(|e| e.to_string())?;
    let Event::Start {
        version,
        session,
        file,
        id,
        parent,
    } = first
    else {
        return Err("Missing participant start".into());
    };
    let mut result = Receipt {
        version,
        session,
        file,
        id,
        parent,
        children: Vec::new(),
        hits: Vec::new(),
    };
    let mut pending = HashSet::new();
    let mut tasks = HashSet::new();
    let mut task_ids = HashSet::new();
    for line in events {
        let event: Event = serde_json::from_str(line).map_err(|e| e.to_string())?;
        match event {
            Event::Hit { mutant, phase }
                if !mutant.is_empty() && (phase == "static" || phase == "test") =>
            {
                result.hits.push((mutant, phase == "static"))
            }
            Event::Open { child } if !child.is_empty() && !result.children.contains(&child) => {
                pending.insert(child.clone());
                result.children.push(child);
            }
            Event::Settled {
                child,
                exit_code,
                signal,
            } if exit_code == 0 && signal.is_none() && pending.remove(&child) => {}
            Event::Issue { reason } => return Err(format!("Incomplete coverage: {reason}")),
            Event::OpenTask { task } if !task.is_empty() && task_ids.insert(task.clone()) => {
                tasks.insert(task);
            }
            Event::SettledTask { task } | Event::CancelTask { task } if tasks.remove(&task) => {}
            _ => return Err("Unknown, duplicate or unsuccessful coverage event".into()),
        }
    }
    if !pending.is_empty() {
        return Err("Missing child EOF".into());
    }
    if !tasks.is_empty() {
        return Err("Unsettled asynchronous coverage work".into());
    }
    Ok(result)
}

#[derive(Default)]
struct Index {
    files: Vec<String>,
    by_mutant: HashMap<String, BTreeSet<usize>>,
    static_mutants: HashSet<String>,
    participants: usize,
}

fn index(input: &str) -> Result<Index, String> {
    if input.len() > 16 * 1024 * 1024 {
        return Err("Coverage evidence exceeds 16 MiB".into());
    }
    let input: Input = serde_json::from_str(input).map_err(|e| e.to_string())?;
    if input.version != 1 || !input.qualified || input.files.is_empty() {
        return Err("Unqualified file isolation or coverage ABI".into());
    }
    let files: HashSet<_> = input.files.iter().collect();
    if files.len() != input.files.len() || input.runs.len() != files.len() {
        return Err("Incomplete or duplicate file set".into());
    }
    let mut result = Index {
        files: input.files.clone(),
        ..Index::default()
    };
    let mut seen_files = HashSet::new();
    let mut sessions = HashSet::new();
    for run in input.runs {
        if !files.contains(&run.file)
            || !seen_files.insert(run.file.clone())
            || run.baseline != "survived"
            || run.session.is_empty()
            || !sessions.insert(run.session.clone())
        {
            return Err("Failed baseline or mismatched file/session".into());
        }
        let slot = result.files.iter().position(|f| f == &run.file).unwrap();
        let mut participants = HashMap::new();
        for raw in run.receipts {
            let receipt = receipt(&raw)?;
            if receipt.version != 1
                || receipt.session != run.session
                || receipt.file != run.file
                || receipt.id.is_empty()
                || participants.contains_key(&receipt.id)
            {
                return Err("Incomplete, corrupt or unsuccessful participant receipt".into());
            }
            participants.insert(receipt.id.clone(), receipt);
        }
        let roots: Vec<_> = participants
            .values()
            .filter(|p| p.parent.is_none())
            .collect();
        if roots.len() != 1 || roots[0].id != "root" {
            return Err("Missing or ambiguous root completion".into());
        }
        let mut visited = HashSet::new();
        let mut pending = vec!["root".to_owned()];
        while let Some(id) = pending.pop() {
            if !visited.insert(id.clone()) {
                return Err("Duplicate or cyclic child ownership".into());
            }
            let participant = participants.get(&id).ok_or("Missing child completion")?;
            for child in &participant.children {
                let receipt = participants.get(child).ok_or("Missing child completion")?;
                if receipt.parent.as_ref() != Some(&id) {
                    return Err("Mismatched child ownership".into());
                }
                pending.push(child.clone());
            }
            for (mutant, is_static) in &participant.hits {
                if *is_static {
                    result.static_mutants.insert(mutant.clone());
                }
                result
                    .by_mutant
                    .entry(mutant.clone())
                    .or_default()
                    .insert(slot);
            }
        }
        if visited.len() != participants.len() {
            return Err("Unowned or late participant".into());
        }
        result.participants += participants.len();
    }
    Ok(result)
}

/// A fail-closed native index. The caller owns I/O and must invalidate on source,
/// runtime, configuration or dependency changes. No result authorizes NoCoverage.
#[napi]
pub struct ExecutionCoverage {
    index: Option<Index>,
    reason: String,
}

#[napi]
impl ExecutionCoverage {
    #[napi(constructor)]
    pub fn new(input_json: String) -> Self {
        match index(&input_json) {
            Ok(index) => Self {
                index: Some(index),
                reason: "Complete owned receipts".into(),
            },
            Err(reason) => Self {
                index: None,
                reason,
            },
        }
    }

    #[napi]
    pub fn summary(&self) -> String {
        json!({"complete": self.index.is_some(), "reason": self.reason,
            "files": self.index.as_ref().map_or(0, |i| i.files.len()),
            "participants": self.index.as_ref().map_or(0, |i| i.participants)})
        .to_string()
    }

    #[napi]
    pub fn select(&self, mutant_id: String, static_mutation: bool) -> String {
        let full = |reason: &str| json!({"files": null, "reason": reason}).to_string();
        let Some(index) = &self.index else {
            return full(&self.reason);
        };
        if static_mutation || index.static_mutants.contains(&mutant_id) {
            return full("Static mutation");
        }
        let Some(slots) = index.by_mutant.get(&mutant_id) else {
            return full("No positive coverage evidence");
        };
        if slots.len() == index.files.len() {
            return full("Every file covers this mutant");
        }
        let files: Vec<_> = slots.iter().map(|slot| &index.files[*slot]).collect();
        json!({"files": files, "reason": "Complete positive file coverage"}).to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn journal(file: &str, id: &str, parent: Value, events: &[Value]) -> String {
        let start =
            json!({"type":"start","version":1,"session":file,"file":file,"id":id,"parent":parent});
        std::iter::once(start)
            .chain(events.iter().cloned())
            .map(|e| format!("{e}\n"))
            .collect()
    }
    fn input() -> Value {
        let a = journal(
            "a",
            "root",
            Value::Null,
            &[
                json!({"type":"open","child":"child"}),
                json!({"type":"settled","child":"child","exitCode":0,"signal":null}),
                json!({"type":"hit","mutant":"s","phase":"static"}),
                json!({"type":"hit","mutant":"m","phase":"test"}),
            ],
        );
        let c = journal(
            "a",
            "child",
            json!("root"),
            &[json!({"type":"hit","mutant":"c","phase":"static"})],
        );
        let b = journal("b", "root", Value::Null, &[]);
        json!({"version":1,"qualified":true,"files":["a","b"],"runs":[
            {"file":"a","session":"a","baseline":"survived","receipts":[a,c]},
            {"file":"b","session":"b","baseline":"survived","receipts":[b]}]})
    }
    #[test]
    fn execution_coverage_positive_selection_and_safe_fallbacks() {
        let index = ExecutionCoverage::new(input().to_string());
        assert_eq!(
            serde_json::from_str::<Value>(&index.summary()).unwrap()["participants"],
            3
        );
        let selection: Value = serde_json::from_str(&index.select("m".into(), false)).unwrap();
        assert_eq!(selection["files"], json!(["a"]));
        for (id, is_static) in [("m", true), ("s", false), ("c", false), ("absent", false)] {
            assert!(serde_json::from_str::<Value>(&index.select(id.into(),is_static)).unwrap()["files"].is_null());
        }
    }
    #[test]
    fn execution_coverage_rejects_missing_corrupt_late_and_failed_evidence() {
        for case in 0..15 {
            let mut value = input();
            match case {
                0 => value["qualified"] = json!(false),
                1 => {
                    value["runs"].as_array_mut().unwrap().pop();
                }
                2 => value["runs"][0]["baseline"] = json!("Timeout"),
                3 => {
                    value["runs"][0]["receipts"].as_array_mut().unwrap().pop();
                }
                n => {
                    let raw = value["runs"][0]["receipts"][0].as_str().unwrap();
                    let corrupt = match n {
                        4 => "{\n".to_owned(),
                        5 => raw.replace("\"session\":\"a\"", "\"session\":\"stale\""),
                        6 => raw.trim_end().to_owned(),
                        7 => raw.replace("\"exitCode\":0", "\"exitCode\":1"),
                        8 => format!("{raw}{}\n", json!({"type":"issue","reason":"Worker"})),
                        9 => raw.replace("\"child\":\"child\"", "\"child\":\"unknown\""),
                        10 => raw.replace("\"phase\":\"test\"", "\"phase\":\"unknown\""),
                        11 => format!(
                            "{raw}{}\n",
                            json!({"type":"settled","child":"child","exitCode":0,"signal":null})
                        ),
                        12 => raw
                            .lines()
                            .filter(|l| !l.contains("settled"))
                            .map(|l| format!("{l}\n"))
                            .collect(),
                        13 => raw.replace("\"signal\":null", "\"signal\":\"SIGKILL\""),
                        _ => format!("{raw}{}\n", json!({"type":"open","child":"root"})),
                    };
                    value["runs"][0]["receipts"][0] = json!(corrupt);
                }
            }
            let index = ExecutionCoverage::new(value.to_string());
            assert!(index.index.is_none(), "case {case}");
            assert!(
                serde_json::from_str::<Value>(&index.select("m".into(), false)).unwrap()["files"]
                    .is_null()
            );
        }
    }
}
