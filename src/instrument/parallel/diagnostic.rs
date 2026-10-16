//! Private, opt-in release-test stage diagnostic; absent from the addon.
use super::*;
use std::{sync::atomic::AtomicU64, time::Instant};

static ENABLED: AtomicBool = AtomicBool::new(false);
static NANOS: [AtomicU64; 6] = [const { AtomicU64::new(0) }; 6];
const STAGES: [&str; 6] = [
    "input_parse",
    "guards",
    "emitter",
    "output_parse",
    "slot_scan",
    "merge_relocation",
];

pub(crate) struct Timer(usize, Option<Instant>);
impl Timer {
    pub(crate) fn start(stage: usize) -> Self {
        Self(stage, ENABLED.load(Ordering::Relaxed).then(Instant::now))
    }
}
impl Drop for Timer {
    fn drop(&mut self) {
        if let Some(start) = self.1 {
            NANOS[self.0].fetch_add(start.elapsed().as_nanos() as u64, Ordering::Relaxed);
        }
    }
}

#[test]
#[ignore = "bounded diagnostic; run alone in release mode with --nocapture"]
fn release_stages() {
    // Stage durations sum worker elapsed times; they are not batch wall time.
    // This intentionally uses the real ABI response construction and serialization.
    let mut samples = vec![];
    for shape in ["balanced", "skewed"] {
        let files: Vec<_> = (0..8)
            .map(|index| File {
                name: format!("stage-{index}.js"),
                content: (0..if shape == "balanced" {
                    512
                } else if index == 0 {
                    4089
                } else {
                    1
                })
                    .map(|i| {
                        format!(
                            "function f{i}(a,b) {{ if (a > b) {{ return a + b; }} return a - b; }}"
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
                mutate: Selection::Boolean(true),
            })
            .collect();
        let mut reference = None;
        for round in 0..3 {
            for threads in if round % 2 == 0 { [1, 4] } else { [4, 1] } {
                let input = serde_json::to_string(&serde_json::json!({
                    "files": files, "options": {}, "execution": { "threads": threads }
                }))
                .unwrap();
                for nanos in &NANOS {
                    nanos.store(0, Ordering::Relaxed);
                }
                ENABLED.store(true, Ordering::Relaxed);
                let before = Instant::now();
                let response = instrument_batch(&input);
                let native_ms = before.elapsed().as_secs_f64() * 1000.0;
                ENABLED.store(false, Ordering::Relaxed);
                let serialization = Instant::now();
                let output = serde_json::to_string(&response).unwrap();
                let serialization_ms = serialization.elapsed().as_secs_f64() * 1000.0;
                assert!(response.supported, "{:?}", response.reason);
                let value = serde_json::to_value(response.result).unwrap();
                if let Some(reference) = &reference {
                    assert_eq!(&value, reference);
                } else {
                    reference = Some(value);
                }
                let stages: serde_json::Map<_, _> = STAGES
                    .iter()
                    .zip(&NANOS)
                    .map(|(name, nanos)| {
                        (
                            (*name).into(),
                            serde_json::json!(nanos.load(Ordering::Relaxed) as f64 / 1e6),
                        )
                    })
                    .collect();
                samples.push(serde_json::json!({ "shape": shape, "round": round, "threads": threads,
                    "batchWallMs": native_ms, "serializationMs": serialization_ms,
                    "outputBytes": output.len(), "workerStageSumMs": stages, "execution": response.execution }));
            }
        }
    }
    println!("STAGE_JSON={}", serde_json::to_string(&samples).unwrap());
}
