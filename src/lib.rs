use napi_derive::napi;

mod coverage;
mod eta;
mod execution_coverage;
mod instrument;
mod mutations;
mod planner;
mod runtime;

/// Own a complete supported mutation run on a background libuv task.
#[napi(js_name = "runNativeMutationTest", strict)]
pub fn run_native_mutation_test(
    env: napi::Env,
    input_json: String,
    cancellation_id: Option<String>,
) -> napi::Result<napi::bindgen_prelude::PromiseRaw<'static, String>> {
    runtime::start(env, input_json, cancellation_id)
}

/// Discover configuration in Rust before asking the original caller to import.
#[napi(js_name = "prepareNativeMutationTest", strict)]
pub fn prepare_native_mutation_test(
    input_json: String,
    cancellation_id: Option<String>,
) -> napi::Result<runtime::NativePreparation> {
    runtime::NativePreparation::begin(input_json, cancellation_id)
}

/// Signal cancellation; the run Promise settles only after Rust cleanup.
#[napi(js_name = "cancelNativeRun", strict)]
pub fn cancel_native_run(cancellation_id: String) -> bool {
    runtime::cancel(&cancellation_id)
}

/// Hash UTF-8 input with BLAKE3, returning lowercase hexadecimal.
#[napi(js_name = "cacheKey", strict)]
pub fn cache_key(input: String) -> String {
    blake3::hash(input.as_bytes()).to_hex().to_string()
}

/// Return an experimental AST mutation preview as JSON.
///
/// Candidate ranges are zero-based, end-exclusive JavaScript UTF-16 offsets.
/// `supported` is deliberately false until upstream Stryker filtering, preprocessing,
/// and all mutators have parity. Parse failures return no candidates and a reason.
#[napi(js_name = "analyze", strict)]
pub fn analyze(source: String, file_name: String) -> String {
    serde_json::to_string(&mutations::analyze_source(&source, &file_name))
        .expect("mutation preview contains only JSON-serializable values")
}

/// Instrument a conservative JavaScript grammar entirely in Rust.
/// Unsupported batches have no partial result and must be delegated to StrykerJS.
#[napi(js_name = "instrumentBatch", strict)]
pub fn instrument_batch(input_json: String) -> String {
    serde_json::to_string(&instrument::instrument_batch(&input_json))
        .expect("instrumentation result contains only JSON-serializable values")
}

/// Index a complete ordered coverage batch without serializing test objects.
#[napi(js_name = "coverageBatch", strict)]
pub fn coverage_batch(input_json: String) -> String {
    coverage::coverage_batch(&input_json).to_string()
}

/// Calculate a complete batch of pinned core planning decisions.
#[napi(js_name = "planningBatch", strict)]
pub fn planning_batch(input_json: String) -> String {
    planner::planning_batch(&input_json).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_keys_match_blake3_reference_vectors() {
        assert_eq!(
            cache_key(String::new()),
            "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"
        );
        assert_eq!(
            cache_key("abc".into()),
            "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85"
        );
        assert_ne!(cache_key("é".into()), cache_key("e\u{301}".into()));
    }
}
