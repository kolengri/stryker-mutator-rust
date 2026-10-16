//! Bounded batch scheduling and byte-preserving relocation of generated ID slots.
//! Only owned strings/records leave a worker; its parser and arena stay local.

use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    thread,
};

use super::*;

// Provisional policy for auto mode. Explicit requests bypass this byte gate.
const AUTO_MIN_BYTES: usize = 32 * 1024;
static PARALLEL_BATCH: AtomicBool = AtomicBool::new(false);

#[derive(Default, Deserialize)]
#[serde(try_from = "Value")]
pub(super) struct Request {
    threads: Option<u64>,
}

impl TryFrom<Value> for Request {
    type Error = &'static str;

    fn try_from(value: Value) -> Result<Self, Self::Error> {
        let values = value.as_object().ok_or("execution must be an object")?;
        if values.keys().any(|name| name != "threads") {
            return Err("Unsupported native execution setting");
        }
        let threads = values
            .get("threads")
            .map(|value| {
                value
                    .as_u64()
                    .filter(|count| (1..=9_007_199_254_740_991).contains(count))
                    .ok_or("execution.threads must be a positive safe integer")
            })
            .transpose()?;
        Ok(Self { threads })
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(super) struct Execution {
    threads_used: usize,
    spawned_threads: usize,
    parallel_files: usize,
    serial_recoveries: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

struct Lease;

impl Lease {
    fn acquire() -> Option<Self> {
        PARALLEL_BATCH
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .ok()
            .map(|_| Self)
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        PARALLEL_BATCH.store(false, Ordering::Release);
    }
}

// Fault injection is confined to Rust unit tests, never the native ABI or env.
#[derive(Clone, Copy, Default)]
struct Faults {
    #[cfg(test)]
    spawn_after: Option<usize>,
    #[cfg(test)]
    panic_index: Option<usize>,
    #[cfg(test)]
    unproven_index: Option<usize>,
}

impl Faults {
    fn fail_spawn(self, _spawned: usize) -> bool {
        #[cfg(test)]
        return self.spawn_after == Some(_spawned);
        #[cfg(not(test))]
        false
    }

    fn before_file(self, _index: usize) {
        #[cfg(test)]
        assert_ne!(self.panic_index, Some(_index), "injected worker panic");
    }

    fn unproven(self, _index: usize) -> bool {
        #[cfg(test)]
        return self.unproven_index == Some(_index);
        #[cfg(not(test))]
        false
    }
}

pub(super) fn execute(
    files: Vec<File>,
    options: &Options,
    request: Request,
) -> Result<(InstrumentResult, Execution), String> {
    let available = if files.len() <= 1 || request.threads == Some(1) {
        1
    } else {
        thread::available_parallelism().map_or(1, usize::from)
    };
    execute_with(files, options, request, available, Faults::default())
}

fn execute_with(
    files: Vec<File>,
    options: &Options,
    request: Request,
    available: usize,
    faults: Faults,
) -> Result<(InstrumentResult, Execution), String> {
    let effective = request
        .threads
        .unwrap_or(available as u64)
        .min(available as u64)
        .min(files.len() as u64) as usize;
    let reason = if files.is_empty() {
        Some("empty-batch")
    } else if files.len() == 1 {
        Some("single-file")
    } else if effective <= 1 {
        Some("serial")
    } else if request.threads.is_none()
        && files.iter().map(|file| file.content.len()).sum::<usize>() < AUTO_MIN_BYTES
    {
        Some("small-batch")
    } else {
        None
    };
    if reason.is_some() {
        return serial(files, options, 0, false, reason);
    }
    let Some(_lease) = Lease::acquire() else {
        return serial(files, options, 0, false, Some("busy"));
    };

    // Every participant owns an initial index, so the caller always does work
    // and successfully spawned workers cannot be starved by a fast caller.
    // The cursor distributes the remaining files without a queue or a mutex.
    let cursor = AtomicUsize::new(effective);
    let (mut indexed, spawned, resource_failure, join_panic) = thread::scope(|scope| {
        let cursor = &cursor;
        let files = &files;
        let mut handles = Vec::with_capacity(effective - 1);
        let mut resource_failure = false;
        for initial in 1..effective {
            if faults.fail_spawn(handles.len()) {
                resource_failure = true;
                break;
            }
            match thread::Builder::new()
                .spawn_scoped(scope, move || work(initial, cursor, files, options, faults))
            {
                Ok(handle) => handles.push(handle),
                Err(_) => {
                    resource_failure = true;
                    break;
                }
            }
        }
        let spawned = handles.len();
        let mut indexed = work(0, cursor, files, options, faults);
        for initial in spawned + 1..effective {
            indexed.extend(work(initial, cursor, files, options, faults));
        }
        let mut join_panic = false;
        for handle in handles {
            match handle.join() {
                Ok(outcomes) => indexed.extend(outcomes),
                Err(_) => join_panic = true,
            }
        }
        (indexed, spawned, resource_failure, join_panic)
    });
    if join_panic {
        return Err(format!(
            "{}: Native instrumentation worker panicked",
            files[0].name
        ));
    }
    indexed.sort_unstable_by_key(|(index, _)| *index);
    // Panics are unsupported even if a resource/provenance retry was pending.
    // For ordinary batches all files were examined: choose the first failing
    // input, independent of completion order, exactly as the serial reference.
    if !resource_failure
        || indexed
            .iter()
            .any(|(_, outcome)| matches!(outcome, Err(Failure::Panic)))
    {
        for (index, outcome) in &indexed {
            if let Err(failure) = outcome {
                let reason = match failure {
                    Failure::Unsupported(reason) => reason.as_str(),
                    Failure::Panic => "Native instrumentation worker panicked",
                };
                return Err(format!("{}: {reason}", files[*index].name));
            }
        }
    }
    if resource_failure {
        drop(indexed);
        return serial(files, options, spawned, true, Some("resource-recovery"));
    }
    let mut outcomes = Vec::with_capacity(files.len());
    for (_, outcome) in indexed {
        match outcome {
            Ok(outcome) => outcomes.push(outcome),
            Err(_) => unreachable!("failures were handled above"),
        }
    }
    if outcomes.iter().any(|outcome| outcome.slots.is_none()) {
        drop(outcomes);
        return serial(files, options, spawned, true, Some("unproven-relocation"));
    }

    // Check the entire prefix sum before changing any record or output byte.
    let mut offsets = Vec::with_capacity(outcomes.len());
    let mut consumed = 0usize;
    for outcome in &outcomes {
        offsets.push(consumed);
        let Some(total) = consumed.checked_add(outcome.consumed_ids) else {
            drop(outcomes);
            return serial(files, options, spawned, true, Some("unproven-relocation"));
        };
        consumed = total;
    }
    let parallel_files = files.len();
    let mut result = InstrumentResult {
        files: Vec::with_capacity(files.len()),
        mutants: vec![],
    };
    for ((file, mut outcome), offset) in files.into_iter().zip(outcomes).zip(offsets) {
        if offset != 0 {
            for record in &mut outcome.records {
                // IDs and slots were validated against consumed_ids, whose
                // checked prefix sum bounds every addition here.
                record.id = (record.id.parse::<usize>().unwrap() + offset).to_string();
            }
            let mut relocated = String::with_capacity(outcome.content.len());
            let mut previous = 0;
            for slot in outcome.slots.unwrap() {
                relocated.push_str(&outcome.content[previous..slot.start]);
                relocated.push_str(&(slot.id + offset).to_string());
                previous = slot.end;
            }
            relocated.push_str(&outcome.content[previous..]);
            outcome.content = relocated;
        }
        result.files.push(File {
            content: outcome.content,
            ..file
        });
        result.mutants.extend(outcome.records);
    }
    Ok((
        result,
        Execution {
            threads_used: spawned + 1,
            spawned_threads: spawned,
            parallel_files,
            serial_recoveries: 0,
            reason: None,
        },
    ))
}

fn serial(
    files: Vec<File>,
    options: &Options,
    spawned_threads: usize,
    recovery: bool,
    reason: Option<&'static str>,
) -> Result<(InstrumentResult, Execution), String> {
    let threads_used = usize::from(!files.is_empty());
    let mut records = vec![];
    let mut next_id = 0;
    let mut output = Vec::with_capacity(files.len());
    for file in files {
        let content = catch_unwind(AssertUnwindSafe(|| {
            instrument_file(&file, options, &mut records, &mut next_id)
        }))
        .unwrap_or_else(|_| Err("Native instrumentation worker panicked".into()))
        .map_err(|reason| format!("{}: {reason}", file.name))?;
        output.push(File { content, ..file });
    }
    Ok((
        InstrumentResult {
            files: output,
            mutants: records,
        },
        Execution {
            threads_used,
            spawned_threads,
            parallel_files: 0,
            serial_recoveries: usize::from(recovery),
            reason,
        },
    ))
}

enum Failure {
    Unsupported(String),
    Panic,
}

struct FileOutput {
    content: String,
    records: Vec<ApiMutant>,
    consumed_ids: usize,
    slots: Option<Vec<Slot>>,
}

fn work(
    initial: usize,
    cursor: &AtomicUsize,
    files: &[File],
    options: &Options,
    faults: Faults,
) -> Vec<(usize, Result<FileOutput, Failure>)> {
    let mut output = vec![];
    let mut index = initial;
    while index < files.len() {
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            faults.before_file(index);
            let file = &files[index];
            let mut records = vec![];
            let mut consumed_ids = 0;
            let mut proven = false;
            let content = instrument_file_inner(
                file,
                options,
                &mut records,
                &mut consumed_ids,
                Some(&mut proven),
            )
            .map_err(Failure::Unsupported)?;
            let slots = if proven && !faults.unproven(index) {
                slots(&content, &file.name, &records, consumed_ids)
            } else {
                None
            };
            Ok(FileOutput {
                content,
                records,
                consumed_ids,
                slots,
            })
        }))
        .unwrap_or(Err(Failure::Panic));
        output.push((index, outcome));
        index = cursor.fetch_add(1, Ordering::Relaxed);
    }
    output
}

fn is_helper(name: &str) -> bool {
    matches!(name, "stryNS_9fa48" | "stryCov_9fa48" | "stryMutAct_9fa48")
}

#[derive(Default)]
struct HelperIdentifiers(bool);

// Full default walk, including all TS/declare/type subtrees. Identifier names
// (including properties and labels) are conservatively treated as references.
impl<'a> Visit<'a> for HelperIdentifiers {
    fn visit_identifier_name(&mut self, node: &IdentifierName<'a>) {
        self.0 |= is_helper(node.name.as_str());
    }
    fn visit_binding_identifier(&mut self, node: &BindingIdentifier<'a>) {
        self.0 |= is_helper(node.name.as_str());
    }
    fn visit_identifier_reference(&mut self, node: &IdentifierReference<'a>) {
        self.0 |= is_helper(node.name.as_str());
    }
    fn visit_label_identifier(&mut self, node: &LabelIdentifier<'a>) {
        self.0 |= is_helper(node.name.as_str());
    }
}

pub(super) fn has_helper_identifiers(program: &Program<'_>) -> bool {
    let mut scan = HelperIdentifiers::default();
    scan.visit_program(program);
    scan.0
}

struct Slot {
    start: usize,
    end: usize,
    id: usize,
}

struct Slots<'s> {
    content: &'s str,
    consumed_ids: usize,
    active: HashMap<usize, (usize, usize)>,
    slots: Vec<Slot>,
    valid: bool,
}

impl<'a> Visit<'a> for Slots<'_> {
    fn visit_call_expression(&mut self, node: &CallExpression<'a>) {
        if let Expression::Identifier(callee) = &node.callee {
            let activation = callee.name == "stryMutAct_9fa48";
            if activation || callee.name == "stryCov_9fa48" {
                self.valid &= !node.optional
                    && node.type_arguments.is_none()
                    && if activation {
                        node.arguments.len() == 1
                    } else {
                        !node.arguments.is_empty()
                    };
                for argument in &node.arguments {
                    let Argument::StringLiteral(literal) = argument else {
                        self.valid = false;
                        continue;
                    };
                    let Some(id) = canonical_id(literal.value.as_str(), self.consumed_ids) else {
                        self.valid = false;
                        continue;
                    };
                    let Some(counts) = self.active.get_mut(&id) else {
                        self.valid = false;
                        continue;
                    };
                    if activation {
                        counts.0 += 1;
                    } else {
                        counts.1 += 1;
                    }
                    let start = literal.span.start as usize;
                    let end = literal.span.end as usize;
                    // Only the emitter's canonical quoted decimal arguments
                    // qualify, not escapes or another original string value.
                    if self.content.get(start..end) != Some(format!("\"{id}\"").as_str()) {
                        self.valid = false;
                    } else {
                        self.slots.push(Slot {
                            start: start + 1,
                            end: end - 1,
                            id,
                        });
                    }
                }
            }
        }
        walk::walk_call_expression(self, node);
    }
}

fn canonical_id(value: &str, consumed: usize) -> Option<usize> {
    let id = value.parse::<usize>().ok()?;
    (id < consumed && id.to_string() == value).then_some(id)
}

fn slots(content: &str, name: &str, records: &[ApiMutant], consumed: usize) -> Option<Vec<Slot>> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(name).ok()?.with_module(true);
    let source_type = source_type.with_typescript(source_type.is_typescript());
    let parsed = Parser::new(&allocator, content, source_type)
        .with_options(ParseOptions {
            preserve_parens: false,
            parse_regular_expression: true,
            ..ParseOptions::default()
        })
        .parse();
    if parsed.fatal_error || !parsed.diagnostics.is_empty() {
        return None;
    }
    let mut scan = Slots {
        content,
        consumed_ids: consumed,
        active: HashMap::new(),
        slots: vec![],
        valid: true,
    };
    let mut previous = None;
    for record in records {
        let id = canonical_id(&record.id, consumed)?;
        if previous.is_some_and(|previous| previous >= id)
            || record.status_reason.as_deref() == Some("")
        {
            return None;
        }
        previous = Some(id);
        if record.status.is_none() {
            scan.active.insert(id, (0, 0));
        }
    }
    scan.visit_program(&parsed.program);
    if !scan.valid
        || scan
            .active
            .values()
            .any(|&(activation, coverage)| activation == 0 || coverage == 0)
    {
        return None;
    }
    scan.slots.sort_unstable_by_key(|slot| slot.start);
    if scan
        .slots
        .windows(2)
        .any(|pair| pair[0].end > pair[1].start)
    {
        return None;
    }
    Some(scan.slots)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn files() -> Vec<File> {
        (0..6)
            .map(|index| File {
                name: format!("{index}.js"),
                content: "consume(true + 2); const a = false;".into(),
                mutate: Selection::Boolean(true),
            })
            .collect()
    }

    fn reference() -> Value {
        serde_json::to_value(
            serial(files(), &Options::default(), 0, false, None)
                .unwrap()
                .0,
        )
        .unwrap()
    }

    #[test]
    fn caps_workers_and_counts_the_caller_as_an_actual_participant() {
        let _guard = TEST_LOCK.lock().unwrap();
        let (result, execution) = execute_with(
            files(),
            &Options::default(),
            Request {
                threads: Some(1000),
            },
            3,
            Faults::default(),
        )
        .unwrap();
        assert_eq!(execution.threads_used, 3);
        assert_eq!(execution.spawned_threads, 2);
        assert_eq!(execution.parallel_files, 6);
        assert_eq!(execution.serial_recoveries, 0);
        assert_eq!(serde_json::to_value(result).unwrap(), reference());
    }

    #[test]
    fn resource_and_provenance_failures_retry_the_entire_native_batch() {
        let _guard = TEST_LOCK.lock().unwrap();
        for (faults, spawned, reason) in [
            (
                Faults {
                    spawn_after: Some(0),
                    ..Faults::default()
                },
                0,
                "resource-recovery",
            ),
            (
                Faults {
                    spawn_after: Some(1),
                    ..Faults::default()
                },
                1,
                "resource-recovery",
            ),
            (
                Faults {
                    unproven_index: Some(3),
                    ..Faults::default()
                },
                3,
                "unproven-relocation",
            ),
        ] {
            let (result, execution) = execute_with(
                files(),
                &Options::default(),
                Request { threads: Some(4) },
                8,
                faults,
            )
            .unwrap();
            assert_eq!(serde_json::to_value(result).unwrap(), reference());
            assert_eq!(execution.threads_used, 1);
            assert_eq!(execution.spawned_threads, spawned);
            assert_eq!(execution.parallel_files, 0);
            assert_eq!(execution.serial_recoveries, 1);
            assert_eq!(execution.reason, Some(reason));
            assert!(Lease::acquire().is_some(), "recovery releases the lease");
        }
    }

    #[test]
    fn panic_is_unsupported_and_never_silently_recovered() {
        let _guard = TEST_LOCK.lock().unwrap();
        for spawn_after in [None, Some(0), Some(1)] {
            let failure = execute_with(
                files(),
                &Options::default(),
                Request { threads: Some(4) },
                8,
                Faults {
                    panic_index: Some(2),
                    spawn_after,
                    ..Faults::default()
                },
            )
            .err()
            .unwrap();
            assert_eq!(failure, "2.js: Native instrumentation worker panicked");
            assert!(Lease::acquire().is_some(), "panic releases the lease");
        }
        let mut input = files();
        input[0].content = "const = ;".into();
        let failure = execute_with(
            input,
            &Options::default(),
            Request { threads: Some(4) },
            8,
            Faults {
                panic_index: Some(2),
                ..Faults::default()
            },
        )
        .err()
        .unwrap();
        assert!(failure.starts_with("0.js: Syntax error:"));
        assert!(Lease::acquire().is_some());
    }

    #[test]
    fn contended_and_fast_paths_do_not_spawn_or_claim_recovery() {
        let _guard = TEST_LOCK.lock().unwrap();
        let _lease = Lease::acquire().unwrap();
        for (input, request, available, used, reason) in [
            (vec![], Some(4), 8, 0, "empty-batch"),
            (
                files().into_iter().take(1).collect(),
                Some(4),
                8,
                1,
                "single-file",
            ),
            (files(), Some(1), 8, 1, "serial"),
            (files(), Some(4), 1, 1, "serial"),
            (files(), None, 8, 1, "small-batch"),
            (files(), Some(4), 8, 1, "busy"),
        ] {
            let (_, execution) = execute_with(
                input,
                &Options::default(),
                Request { threads: request },
                available,
                Faults::default(),
            )
            .unwrap();
            assert_eq!(execution.threads_used, used);
            assert_eq!(execution.spawned_threads, 0);
            assert_eq!(execution.parallel_files, 0);
            assert_eq!(execution.serial_recoveries, 0);
            assert_eq!(execution.reason, Some(reason));
        }
    }

    #[test]
    fn relocation_rejects_unproven_calls_and_empty_reason_quirks() {
        let input = files().remove(0);
        let mut records = vec![];
        let mut consumed = 0;
        let content =
            instrument_file(&input, &Options::default(), &mut records, &mut consumed).unwrap();
        assert!(slots(&content, &input.name, &records, consumed).is_some());
        for corrupted in [
            content.replace("stryMutAct_9fa48(\"1\")", "stryMutAct_9fa48(\"01\")"),
            content.replace("stryMutAct_9fa48(\"1\")", "stryMutAct_9fa48(\"999\")"),
            content.replace("stryMutAct_9fa48(\"1\")", "stryMutAct_9fa48(1)"),
            content.replace("stryMutAct_9fa48(\"1\")", "stryMutAct_9fa48(\"1\", \"1\")"),
            content.replace("stryMutAct_9fa48(\"1\")", "stryMutAct_9fa48?.(\"1\")"),
            content.replace("stryMutAct_9fa48(\"1\")", "stryMutAct_9fa48(\"\\x31\")"),
            "invalid {".into(),
        ] {
            assert_ne!(corrupted, content);
            assert!(slots(&corrupted, &input.name, &records, consumed).is_none());
        }
        records[0].status_reason = Some(String::new());
        assert!(slots(&content, &input.name, &records, consumed).is_none());
    }
}
