//! Single-use caller handshake. No JS import runs on a libuv worker.
use super::{NativeInput, config, submit};
use napi::{Env, bindgen_prelude::PromiseRaw};
use napi_derive::napi;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::watch;
#[cfg(windows)]
use windows_sys::Win32::{
    Globalization::{CSTR_EQUAL, CompareStringOrdinal},
    System::Environment::GetEnvironmentVariableW,
};

#[derive(Default)]
struct Registry {
    readers: usize,
    executable: bool,
    cancellations: HashMap<String, watch::Sender<bool>>,
    environments: Vec<(watch::Receiver<bool>, Arc<CallerEnvironment>)>,
}
static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
fn registry() -> &'static Mutex<Registry> {
    REGISTRY.get_or_init(Mutex::default)
}
fn failure(reason: impl Into<String>) -> napi::Error {
    napi::Error::from_reason(reason.into())
}

// A bounded per-run spawn context, keyed by the already-owned cancellation
// channel. Legacy direct-addon calls omit it and retain OS inheritance.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CallerEnvironment {
    pairs: Vec<(String, String)>,
    pub shell: Option<String>,
    pub has_worker: bool,
}
impl CallerEnvironment {
    pub fn apply(&self, command: &mut tokio::process::Command) {
        command
            .env_clear()
            .envs(self.pairs.iter().map(|(key, value)| (key, value)));
        #[cfg(windows)]
        for name in WINDOWS_REQUIRED_ENV {
            // libuv preserves supplied spelling and values, including empty.
            // Windows' ordinal case mapping also covers non-ASCII spellings;
            // ASCII-only matching would not reproduce libuv/std EnvKey.
            if !self
                .pairs
                .iter()
                .any(|(key, _)| windows_env_name_eq(key, name))
                && let Some(value) = windows_required_env_value(name)
            {
                command.env(name, value);
            }
        }
    }
}
// Node 22.18/24.11/26.10 libuv win/process.c required_vars. Command's
// Windows EnvKey uses the same CompareStringOrdinal ordering for the final block.
#[cfg(windows)]
const WINDOWS_REQUIRED_ENV: [&str; 11] = [
    "HOMEDRIVE",
    "HOMEPATH",
    "LOGONSERVER",
    "PATH",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "USERDOMAIN",
    "USERNAME",
    "USERPROFILE",
    "WINDIR",
];

#[cfg(windows)]
fn windows_env_name_eq(left: &str, right: &str) -> bool {
    let left: Vec<_> = left.encode_utf16().collect();
    let right: Vec<_> = right.encode_utf16().collect();
    // Environment names are bounded by Windows well below i32::MAX.
    let (Ok(left_len), Ok(right_len)) = (i32::try_from(left.len()), i32::try_from(right.len()))
    else {
        return false;
    };
    // SAFETY: both slices remain live with their exact UTF-16 lengths.
    unsafe {
        CompareStringOrdinal(left.as_ptr(), left_len, right.as_ptr(), right_len, 1) == CSTR_EQUAL
    }
}
#[cfg(windows)]
fn windows_required_env_value(name: &str) -> Option<std::ffi::OsString> {
    let wide: Vec<_> = name.encode_utf16().chain([0]).collect();
    // Match libuv's NULL-buffer size probe, including its empty/absent handling.
    // SAFETY: wide is NUL-terminated; NULL/0 requests only the required size.
    if unsafe { GetEnvironmentVariableW(wide.as_ptr(), std::ptr::null_mut(), 0) } == 0 {
        None
    } else {
        std::env::var_os(name)
    }
}

pub(super) fn caller_environment(
    channel: &watch::Receiver<bool>,
) -> Option<Arc<CallerEnvironment>> {
    registry()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .environments
        .iter()
        .find(|(candidate, _)| candidate.same_channel(channel))
        .map(|(_, context)| context.clone())
}

pub(super) struct Ownership {
    executable: bool,
    active: AtomicBool,
    id: Option<String>,
    pub cancellation: watch::Sender<bool>,
}
impl Ownership {
    pub fn acquire(executable: bool, id: Option<String>) -> napi::Result<Arc<Self>> {
        let mut registry = registry()
            .lock()
            .map_err(|_| failure("Native run registry poisoned"))?;
        if registry.executable || (executable && registry.readers != 0) {
            return Err(failure(
                "Executable configuration requires exclusive native run ownership; another preparation or run is active",
            ));
        }
        if let Some(id) = &id {
            if id.is_empty() || id.len() > 256 {
                return Err(failure("Invalid native cancellation ID"));
            }
            if registry.cancellations.contains_key(id) {
                return Err(failure("Native cancellation ID is already active"));
            }
        }
        let (cancellation, _) = watch::channel(false);
        if let Some(id) = &id {
            registry
                .cancellations
                .insert(id.clone(), cancellation.clone());
        }
        if executable {
            registry.executable = true;
        } else {
            registry.readers += 1;
        }
        Ok(Arc::new(Self {
            executable,
            active: AtomicBool::new(true),
            id,
            cancellation,
        }))
    }
    // Idempotent so submission failure can release even if napi's queue failure
    // path leaked its internal Task box (locked napi 3.14.2 async_work.rs).
    pub fn release(&self) {
        if self.active.swap(false, Ordering::AcqRel) {
            let mut registry = registry().lock().unwrap_or_else(|error| error.into_inner());
            if let Some(id) = &self.id {
                registry.cancellations.remove(id);
            }
            registry
                .environments
                .retain(|(channel, _)| !channel.same_channel(&self.cancellation.subscribe()));
            if self.executable {
                registry.executable = false;
            } else {
                registry.readers -= 1;
            }
        }
    }
}
impl Drop for Ownership {
    fn drop(&mut self) {
        self.release();
    }
}
pub(super) fn cancel(id: &str) -> bool {
    let registry = registry().lock().unwrap_or_else(|error| error.into_inner());
    if let Some(sender) = registry.cancellations.get(id) {
        sender.send_replace(true);
        true
    } else {
        false
    }
}

/// Opaque authoritative preparation. Paths and parsed CLI options cannot be
/// rewritten by the caller. `run` consumes it once; `close` abandons it.
#[napi]
pub struct NativePreparation {
    pending: Option<Result<config::Discovered, String>>,
    ready: Option<Result<config::Config, String>>,
    ownership: Option<Arc<Ownership>>,
    executable: bool,
    plugins_complete: bool,
}
impl NativePreparation {
    pub(crate) fn begin(input: String, id: Option<String>) -> napi::Result<Self> {
        let discovered = serde_json::from_str::<config::Request>(&input)
            .map_err(|error| error.to_string())
            .and_then(config::discover);
        let executable = discovered
            .as_ref()
            .is_ok_and(|value| value.executable.is_some());
        let discovered = discovered.and_then(|value| {
            if executable && actual_cwd()? != value.cwd {
                Err("Executable configuration requires request cwd to equal the caller's actual canonical cwd".into())
            } else { Ok(value) }
        });
        let ownership = if discovered.is_ok() {
            Some(Ownership::acquire(executable, id)?)
        } else {
            None
        };
        Ok(Self {
            pending: Some(discovered),
            ready: None,
            ownership,
            executable,
            plugins_complete: false,
        })
    }
    fn store(&mut self, config: Result<config::Config, String>) {
        if config.is_err() {
            self.ownership.take();
        }
        self.ready = Some(config);
    }
}
fn actual_cwd() -> Result<std::path::PathBuf, String> {
    config::canonicalize(&std::env::current_dir().map_err(|error| error.to_string())?)
}
// Schema property order controls default insertion order. Value::eq ignores
// object key order even with preserve_order, so compare descriptors in order.
fn ordered_equal(left: &serde_json::Value, right: &serde_json::Value) -> bool {
    match (left, right) {
        (serde_json::Value::Object(left), serde_json::Value::Object(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|((lk, lv), (rk, rv))| lk == rk && ordered_equal(lv, rv))
        }
        (serde_json::Value::Array(left), serde_json::Value::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| ordered_equal(left, right))
        }
        _ => left == right,
    }
}
fn pinned_core(schema: &serde_json::Value) -> Result<(), String> {
    let pinned: serde_json::Value =
        serde_json::from_str(include_str!("schema.json")).expect("pinned schema");
    if !ordered_equal(schema, &pinned) {
        return Err("Unsupported executable configuration capability: caller SDK core schema differs from pinned 10.0.0".into());
    }
    Ok(())
}
#[napi]
impl NativePreparation {
    #[napi(getter)]
    pub fn config_path(&self) -> Option<String> {
        self.pending
            .as_ref()?
            .as_ref()
            .ok()?
            .executable
            .as_ref()
            .map(|(_, path)| path.to_string_lossy().into_owned())
    }
    #[napi(getter)]
    pub fn config_name(&self) -> Option<String> {
        self.pending
            .as_ref()?
            .as_ref()
            .ok()?
            .executable
            .as_ref()
            .map(|(name, _)| name.clone())
    }
    #[napi(getter)]
    pub fn unsupported_reason(&self) -> Option<String> {
        self.pending
            .as_ref()
            .and_then(|value| value.as_ref().err())
            .or_else(|| self.ready.as_ref().and_then(|value| value.as_ref().err()))
            .cloned()
    }
    #[napi(getter)]
    pub fn plugin_modules(&self) -> Vec<String> {
        // Only modules selected by Rust after core validation are imported for
        // caller metadata; plugin execution remains the existing SDK boundary.
        self.ready
            .as_ref()
            .and_then(|value| value.as_ref().ok())
            .map(|config| config.modules.clone())
            .unwrap_or_default()
    }
    #[napi]
    pub fn close(&mut self) {
        self.pending.take();
        self.ready.take();
        self.ownership.take();
    }
    /// Complete core merge/validation before asking for plugin schema metadata.
    #[napi]
    pub fn complete(
        &mut self,
        imported_json: String,
        caller_schema: String,
        null_prototypes: Option<String>,
    ) -> napi::Result<String> {
        let discovered = self
            .pending
            .take()
            .ok_or_else(|| failure("Native preparation has already been consumed or closed"))?;
        let mut effects = match effect_transport(null_prototypes) {
            Ok(effects) => effects,
            Err(error) => {
                self.ownership.take();
                return Err(error);
            }
        };
        let result = discovered.and_then(|discovered| {
            if discovered.executable.is_none() { return Err("JSON preparation does not accept imported configuration".into()); }
            if actual_cwd()? != discovered.cwd { return Err("Unsupported executable configuration capability: process.chdir during import (cwd effects are not restored)".into()); }
            let schema = serde_json::from_str(&caller_schema).map_err(|error| format!("Unsupported caller schema transport: {error}"))?;
            pinned_core(&schema)?;
            let imported = serde_json::from_str(&imported_json).map_err(|error| format!("Unsupported configuration transport: {error}"))?;
            config::finish_effects(discovered, Some(imported), &mut effects)
        });
        self.store(result);
        Ok(effects.response())
    }
    /// Apply plugin validation synchronously, preserving effects on error before
    /// native scheduling/project preparation is possible.
    #[napi]
    pub fn complete_plugins(
        &mut self,
        imported_json: String,
        caller_metadata: String,
        null_prototypes: Option<String>,
    ) -> napi::Result<String> {
        let ready = self
            .ready
            .take()
            .ok_or_else(|| failure("Core preparation is required first"))?;
        let mut effects = match effect_transport(null_prototypes) {
            Ok(effects) => effects,
            Err(error) => {
                self.ownership.take();
                return Err(error);
            }
        };
        let result = ready.and_then(|mut config| {
            if !self.executable || self.plugins_complete { return Err("Plugin preparation has already been consumed or is not executable".into()); }
            if actual_cwd()? != config.cwd { return Err("Unsupported executable configuration capability: process.chdir during caller metadata import".into()); }
            let metadata: serde_json::Value = serde_json::from_str(&caller_metadata).map_err(|error| error.to_string())?;
            pinned_core(&metadata["core"])?;
            let expected = if config.runner == config::Runner::Mocha { vec![serde_json::from_str::<serde_json::Value>(include_str!("mocha-schema.json")).expect("pinned Mocha schema")] } else { vec![] };
            if !ordered_equal(&metadata["plugins"], &serde_json::json!(expected)) { return Err("Unsupported executable configuration capability: caller plugin schema differs from pinned 10.0.0".into()); }
            config.options = serde_json::from_str(&imported_json).map_err(|error| format!("Unsupported configuration transport: {error}"))?;
            if !config.options.is_object() { return Err("Configuration must be a JSON object".into()); }
            config::normalize_plugin_effects(&mut config, &metadata["core"], metadata["plugins"].as_array().expect("checked plugins"), &mut effects)?;
            config::refresh(config)
        });
        self.plugins_complete = true;
        self.store(result);
        Ok(effects.response())
    }
    #[napi]
    pub fn run(
        &mut self,
        env: Env,
        caller_metadata: Option<String>,
        caller_environment_json: Option<String>,
    ) -> napi::Result<PromiseRaw<'static, String>> {
        let config = if let Some(ready) = self.ready.take() {
            ready
        } else {
            self.pending
                .take()
                .ok_or_else(|| failure("Native preparation has already been consumed or closed"))?
                .and_then(|discovered| {
                    if discovered.executable.is_some() {
                        return Err(
                            "Executable configuration must be completed in its caller first".into(),
                        );
                    }
                    config::finish(discovered, None)
                })
        };
        let config = config.and_then(|config| {
            if self.executable && !self.plugins_complete {
                return Err("Executable plugin preparation must complete before run".into());
            }
            if caller_metadata.is_some() {
                return Err("Caller metadata must be supplied during plugin preparation".into());
            }
            if let Some(input) = caller_environment_json {
                let context: CallerEnvironment = serde_json::from_str(&input)
                    .map_err(|error| format!("Invalid caller environment transport: {error}"))?;
                if context.pairs.iter().any(|(key, value)| {
                    key.contains('\0') || key.contains('=') || value.contains('\0')
                }) || context
                    .shell
                    .as_ref()
                    .is_some_and(|value| value.contains('\0'))
                {
                    return Err("Invalid caller environment entry".into());
                }
                if let Some(owner) = &self.ownership {
                    registry()
                        .lock()
                        .map_err(|_| "Native run registry poisoned")?
                        .environments
                        .push((owner.cancellation.subscribe(), Arc::new(context)));
                }
            }
            Ok(config)
        });
        if config.is_err() {
            self.ownership.take();
        }
        submit(
            env,
            NativeInput::Prepared(config.map(Box::new)),
            self.ownership.take(),
        )
    }
}

fn effect_transport(paths: Option<String>) -> napi::Result<config::Effects> {
    let paths = paths
        .map(|paths| serde_json::from_str(&paths))
        .transpose()
        .map_err(|error| {
            failure(format!(
                "Invalid configuration descriptor transport: {error}"
            ))
        })?
        .unwrap_or_default();
    Ok(config::Effects::capture(paths))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn required_fallbacks_preserve_supplied_spelling_empty_and_custom_deletion() {
        let context = CallerEnvironment {
            pairs: vec![
                ("sYsTeMrOoT".into(), "".into()),
                ("UserProfile".into(), "caller-profile".into()),
            ],
            shell: None,
            has_worker: false,
        };
        let mut command = tokio::process::Command::new("unused.exe");
        context.apply(&mut command);
        let entries: Vec<_> = command
            .as_std()
            .get_envs()
            .map(|(key, value)| (key.to_owned(), value.unwrap().to_owned()))
            .collect();
        for (key, value) in &context.pairs {
            assert!(
                entries
                    .iter()
                    .any(|(actual_key, actual_value)| actual_key == key.as_str()
                        && actual_value == value.as_str())
            );
        }
        assert!(!entries.iter().any(|(key, _)| key == "CUSTOM_DELETED"));
        for name in WINDOWS_REQUIRED_ENV {
            if !context
                .pairs
                .iter()
                .any(|(key, _)| windows_env_name_eq(key, name))
            {
                assert_eq!(
                    entries
                        .iter()
                        .find(|(key, _)| key == name)
                        .map(|(_, value)| value.clone()),
                    windows_required_env_value(name)
                );
            }
        }
    }

    #[test]
    fn spawn_context_is_channel_scoped_and_released_with_owner() {
        let owner = Ownership::acquire(false, None).unwrap();
        let channel = owner.cancellation.subscribe();
        let unrelated = watch::channel(false).1;
        let context = Arc::new(CallerEnvironment {
            pairs: vec![("CALLER".into(), "private".into())],
            shell: None,
            has_worker: false,
        });
        registry()
            .lock()
            .unwrap()
            .environments
            .push((channel.clone(), context));
        assert_eq!(caller_environment(&channel).unwrap().pairs[0].1, "private");
        assert!(caller_environment(&unrelated).is_none());
        owner.release();
        assert!(caller_environment(&channel).is_none());
    }
}
