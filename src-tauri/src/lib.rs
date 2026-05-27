mod api_proxy;
mod overlay;
mod sse;
mod tray;
mod webview_recovery;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, RunEvent, State, Window,
};
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;

// Update channel URLs
const STABLE_UPDATE_URL: &str =
    "https://github.com/endara-ai/endara-desktop/releases/latest/download/latest.json";
const BETA_UPDATE_URL: &str = "https://endara-ai.github.io/endara-desktop/latest.json";

/// Timeout for the pre-flight JSON manifest fetch performed before delegating
/// to `tauri-plugin-updater`. Chosen to be larger than typical CDN latency yet
/// short enough that a hung endpoint does not block the UI.
const UPDATER_FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Number of bytes of the response body we keep when logging a non-2xx
/// updater response. Newlines/control chars are stripped before logging.
const UPDATER_BODY_EXCERPT_BYTES: usize = 512;

/// Base backoff for the updater check after a single failure (1 minute).
const UPDATER_BACKOFF_BASE_SECS: u64 = 60;

/// Cap for the exponential updater backoff (30 minutes).
const UPDATER_BACKOFF_MAX_SECS: u64 = 30 * 60;

/// Initial grace period after a relay sidecar spawn before the first /healthz
/// probe, so the watchdog does not race the relay's HTTP server bind.
const RELAY_WATCHDOG_INITIAL_DELAY: std::time::Duration = std::time::Duration::from_secs(2);

/// Interval between successive /healthz probes once the watchdog is running.
const RELAY_WATCHDOG_PROBE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(10);

/// Per-probe HTTP timeout for /healthz so a stalled relay does not block the
/// watchdog loop or queue probes.
const RELAY_WATCHDOG_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Base backoff (seconds) for the first auto-restart attempt after an
/// unexpected relay sidecar termination.
const RELAY_RESTART_BASE_SECS: u64 = 1;

/// Cap (seconds) for the auto-restart exponential backoff schedule.
const RELAY_RESTART_MAX_SECS: u64 = 30;

/// Hard cap on consecutive auto-restart attempts before the supervisor
/// suspends auto-restart and emits a `"failed"` status.
const RELAY_RESTART_MAX_ATTEMPTS: u32 = 5;

/// Healthy-uptime threshold (seconds): if the relay was up for at least this
/// long before terminating, the supervisor resets its attempt counter.
const RELAY_RESTART_HEALTHY_RESET_SECS: u64 = 60;

/// User-facing message emitted when the supervisor exhausts its retry budget.
const RELAY_RESTART_SUSPENDED_MSG: &str =
    "Relay crashed repeatedly; auto-restart suspended. Click Restart to retry.";

/// Compute the auto-restart backoff window in seconds for a given attempt
/// number (1-indexed). Schedule: 1s, 2s, 4s, 8s, 16s, then capped at
/// [`RELAY_RESTART_MAX_SECS`]. Returns `0` for `attempt == 0`.
fn relay_restart_backoff_secs(attempt: u32) -> u64 {
    if attempt == 0 {
        return 0;
    }
    // Clamp the exponent so `1u64 << exp` never overflows.
    let exp = (attempt - 1).min(20);
    let secs = RELAY_RESTART_BASE_SECS.saturating_mul(1u64 << exp);
    secs.min(RELAY_RESTART_MAX_SECS)
}

/// Decision returned by [`RelayRestartPolicy::on_termination`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayRestartDecision {
    /// Termination was intentional (`stop_relay`, `restart_relay`, tray quit,
    /// app exit, or a prior cap exhaustion); the supervisor must not respawn.
    Suppress,
    /// Schedule an auto-restart after `delay_secs`. `attempt` is 1-indexed and
    /// `max` is the configured hard cap, both surfaced to the UI in the
    /// `"restarting"` event payload.
    Restart {
        attempt: u32,
        delay_secs: u64,
        max: u32,
    },
    /// The supervisor has exhausted its retry budget; emit `"failed"` and stop.
    GiveUp { max: u32 },
}

/// Pure state machine that drives the relay sidecar auto-restart supervisor.
/// Lives behind a `std::sync::Mutex` inside [`RelayState`] and is also unit
/// tested in isolation (no async, no `tauri` types).
#[derive(Default, Debug, Clone)]
pub struct RelayRestartPolicy {
    /// Number of consecutive failed auto-restart attempts in the current
    /// unhealthy window.
    attempts: u32,
}

impl RelayRestartPolicy {
    /// Apply the policy to a sidecar termination event.
    ///
    /// * `intentional_stop` — value of the `intentional_stop` flag *after* the
    ///   atomic read-and-reset in the `Terminated` arm; when `true` we
    ///   short-circuit to [`RelayRestartDecision::Suppress`] (and reset the
    ///   attempt counter, since the next failure starts a fresh unhealthy
    ///   window).
    /// * `uptime_secs` — wall-clock seconds the child was alive before
    ///   terminating; when it is `>= RELAY_RESTART_HEALTHY_RESET_SECS` the
    ///   attempt counter is reset before this attempt is counted.
    pub fn on_termination(
        &mut self,
        intentional_stop: bool,
        uptime_secs: u64,
    ) -> RelayRestartDecision {
        if intentional_stop {
            self.attempts = 0;
            return RelayRestartDecision::Suppress;
        }
        if uptime_secs >= RELAY_RESTART_HEALTHY_RESET_SECS {
            self.attempts = 0;
        }
        self.attempts = self.attempts.saturating_add(1);
        if self.attempts > RELAY_RESTART_MAX_ATTEMPTS {
            // Drop the counter so a subsequent user-initiated restart starts
            // from a clean slate; the caller is responsible for setting
            // `intentional_stop = true` to block further auto-restart events.
            self.attempts = 0;
            return RelayRestartDecision::GiveUp {
                max: RELAY_RESTART_MAX_ATTEMPTS,
            };
        }
        RelayRestartDecision::Restart {
            attempt: self.attempts,
            delay_secs: relay_restart_backoff_secs(self.attempts),
            max: RELAY_RESTART_MAX_ATTEMPTS,
        }
    }

    /// Reset the attempt counter. Called when the user manually starts,
    /// restarts, or stops the relay so a fresh unhealthy window begins.
    pub fn reset(&mut self) {
        self.attempts = 0;
    }
}

/// Workaround: In Tauri v2, `set_activation_policy` is only available on `App`,
/// not on `AppHandle`, so it cannot be called from event handlers.
/// See: https://github.com/tauri-apps/tauri/issues/9244
/// This uses objc2-app-kit to call NSApplication.setActivationPolicy directly.
/// TODO: Remove this workaround once Tauri exposes set_activation_policy on AppHandle.
#[cfg(target_os = "macos")]
fn set_macos_activation_policy(regular: bool) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
    let mtm = MainThreadMarker::new().expect("must be called on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    let policy = if regular {
        NSApplicationActivationPolicy::Regular
    } else {
        NSApplicationActivationPolicy::Accessory
    };
    app.setActivationPolicy(policy);
}

/// Dev-mode data directory name (relative to home).
const DEV_DATA_DIR_NAME: &str = ".endara-dev";

/// Default relay port for dev mode.
const DEV_RELAY_PORT: u16 = 9500;

/// Default relay port for production.
const DEFAULT_RELAY_PORT: u16 = 9400;

/// Returns `true` when running in dev mode.
///
/// Dev mode is detected via `cfg!(debug_assertions)` (true during `cargo tauri dev`,
/// false in release builds) **or** when the `ENDARA_DATA_DIR` env var is set.
fn is_dev_mode() -> bool {
    cfg!(debug_assertions) || std::env::var("ENDARA_DATA_DIR").is_ok()
}

/// Returns the base data directory: `~/.endara-dev` in dev mode, `~/.endara` in production.
fn data_dir() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
    if is_dev_mode() {
        Ok(home.join(DEV_DATA_DIR_NAME))
    } else {
        Ok(home.join(".endara"))
    }
}

/// Check if a port is already in use by attempting a TCP connection.
fn is_port_in_use(port: u16) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(500)).is_ok()
}

/// Read the relay port from config.toml [relay] section.
/// Uses the dev or production data directory based on `is_dev_mode()`.
/// Returns None if the file doesn't exist, can't be parsed, or has no port setting.
fn read_port_from_config() -> Option<u16> {
    let config_path = data_dir().ok()?.join("config.toml");
    let contents = std::fs::read_to_string(&config_path).ok()?;
    let parsed: toml::Table = contents.parse().ok()?;
    parsed
        .get("relay")?
        .as_table()?
        .get("port")?
        .as_integer()
        .and_then(|p| u16::try_from(p).ok())
}

/// Strip ANSI escape sequences from text.
fn strip_ansi(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // Skip ESC [ ... (letter) sequences
            if chars.peek() == Some(&'[') {
                chars.next(); // consume '['
                while let Some(&next) = chars.peek() {
                    chars.next();
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else {
            result.push(c);
        }
    }
    result
}

/// Extract the endpoint name from the relay's tracing span.
///
/// The relay sidecar is launched with `--log-format text` (see
/// [`build_sidecar_args`]) so tracing-subscriber emits its "Full" formatter
/// shape, with span fields inline:
///
/// ```text
/// 2026-05-22T15:10:43Z  INFO endpoint{endpoint="github" transport="stdio"}: <target>: <msg>
/// ```
///
/// Returns `Some("github")` when the `endpoint{...}` span is present and
/// `None` for relay-level events that have no span context (e.g. "Relay
/// listening on …"). A leading and trailing pair of double-quotes is stripped
/// from the captured token so callers get the bare endpoint name — the Full
/// formatter quotes string-typed field values, while older test fixtures and
/// the compact format used unquoted values, so the parser accepts both.
///
/// Lines emitted in the relay's `compact` format (`INFO endpoint: <target>:
/// <msg> endpoint="NAME" transport="…"`) do NOT match because the span fields
/// trail the message instead of appearing inline — this is why the sidecar
/// must run with `--log-format text`.
fn parse_endpoint_from_span(line: &str) -> Option<String> {
    use std::sync::OnceLock;
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r"endpoint\{endpoint=([^ }]+)")
            .expect("parse_endpoint_from_span regex is valid")
    });
    re.captures(line)
        .and_then(|c| c.get(1))
        .map(|m| strip_quote_pair(m.as_str()).to_string())
        .filter(|s| !s.is_empty())
}

/// Strip exactly one leading and one trailing `"` from `s` when both are
/// present. Returns the input unchanged if the value is not double-quoted on
/// both sides — this avoids over-eager trimming of values that legitimately
/// begin or end with a quote character.
fn strip_quote_pair(s: &str) -> &str {
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        &s[1..s.len() - 1]
    } else {
        s
    }
}

/// Extract the tracing level token from a relay compact-format log line.
///
/// The relay's stdout/stderr emits lines whose level token (`ERROR` / `WARN` /
/// `INFO` / `DEBUG` / `TRACE`) appears as a whole word right after the ISO
/// timestamp prefix, with one or two spaces of padding (compact format
/// right-aligns the level). The regex anchors near the start of the line so it
/// will not return `Some` just because the message body happens to contain the
/// English word "error".
///
/// Returns the lowercased static level string (`"error"` / `"warn"` / `"info"`
/// / `"debug"` / `"trace"`) when the token is present, or `None` for raw
/// stdout/stderr lines emitted by adapters without tracing context. Callers
/// (the stdout/stderr capture branches) supply their own fallback when the
/// helper returns `None`.
fn parse_level_from_line(line: &str) -> Option<&'static str> {
    use std::sync::OnceLock;
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        // Match a whole-word level token after the ISO timestamp prefix. The
        // compact format pads the level with one or two spaces, so we allow
        // any run of whitespace before and after the token.
        regex::Regex::new(r"^\S+\s+(ERROR|WARN|INFO|DEBUG|TRACE)(?:\s|$)")
            .expect("parse_level_from_line regex is valid")
    });
    re.captures(line)
        .and_then(|c| c.get(1))
        .map(|m| match m.as_str() {
            "ERROR" => "error",
            "WARN" => "warn",
            "INFO" => "info",
            "DEBUG" => "debug",
            "TRACE" => "trace",
            _ => unreachable!("regex alternation restricts matches to the five level tokens"),
        })
}

/// Return the path to config.toml in the appropriate data directory
/// (`~/.endara-dev/config.toml` in dev mode, `~/.endara/config.toml` in production).
fn config_path() -> Result<std::path::PathBuf, String> {
    data_dir().map(|d| d.join("config.toml"))
}

/// Build the argument vector passed to the `endara-relay` sidecar.
///
/// In dev mode we pass `--data-dir` (letting the relay derive its config path and
/// perform the first-run copy from production). In production we pass `--config`
/// directly. Extracted as a pure helper so it is trivially unit-testable.
///
/// We also force `--log-format text` (tracing-subscriber's "Full" formatter)
/// so span fields appear inline as `endpoint{endpoint="NAME" ...}:` instead of
/// the relay's CLI default `compact` shape, which trails the span fields at
/// the end of the line. Both [`parse_endpoint_from_span`] and the front-end
/// `SPAN_RE` parser are written against the inline shape — without this pin
/// every relay-log event would report a `null` endpoint and the Logs view's
/// "Endpoint" column would render `---` for every row.
fn build_sidecar_args<'a>(
    dev: bool,
    data_dir: &'a str,
    config: &'a str,
    port: &'a str,
) -> Vec<&'a str> {
    if dev {
        vec![
            "start",
            "--data-dir",
            data_dir,
            "--port",
            port,
            "--log-format",
            "text",
        ]
    } else {
        vec![
            "start",
            "--config",
            config,
            "--port",
            port,
            "--log-format",
            "text",
        ]
    }
}

/// Read and parse `~/.endara/config.toml`, returning `Err` if the file is missing or invalid.
fn read_config() -> Result<toml::Table, String> {
    let path = config_path()?;
    if !path.exists() {
        return Err("Config file not found".to_string());
    }
    let contents =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read config: {e}"))?;
    contents
        .parse()
        .map_err(|e| format!("Failed to parse config: {e}"))
}

/// Serialize and write a `toml::Table` back to `~/.endara/config.toml`.
/// Ensures the parent directory exists before writing so a missing `~/.endara/`
/// does not surface as an unhelpful "No such file or directory" error.
fn write_config(table: &toml::Table) -> Result<(), String> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            format!(
                "Failed to create config directory {}: {e}",
                parent.display()
            )
        })?;
    }
    let new_contents =
        toml::to_string_pretty(table).map_err(|e| format!("Failed to serialize config: {e}"))?;
    std::fs::write(&path, &new_contents).map_err(|e| format!("Failed to write config: {e}"))
}

/// Read the update channel from ~/.endara/config.toml [desktop] section.
/// Returns "stable" if not set or on any error.
fn read_update_channel() -> String {
    let Ok(parsed) = read_config() else {
        return "stable".to_string();
    };
    parsed
        .get("desktop")
        .and_then(|v| v.as_table())
        .and_then(|t| t.get("update_channel"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "stable".to_string())
}

/// Read `relay.local_js_execution` from `~/.endara/config.toml`.
/// Returns `false` on any error, missing section, or missing key, mirroring
/// `read_update_channel` so the UI gets a deterministic default during cold
/// start (when the config may not yet have a `[relay]` section).
fn read_js_execution_mode() -> bool {
    let Ok(parsed) = read_config() else {
        return false;
    };
    parsed
        .get("relay")
        .and_then(|v| v.as_table())
        .and_then(|t| t.get("local_js_execution"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Read `relay.toon_output` from `~/.endara/config.toml`.
/// Returns `true` on any error, missing section, or missing key — matches the
/// relay's own default so a cold-started UI doesn't flash "disabled" before
/// the on-disk value resolves.
fn read_toon_output() -> bool {
    let Ok(parsed) = read_config() else {
        return true;
    };
    parsed
        .get("relay")
        .and_then(|v| v.as_table())
        .and_then(|t| t.get("toon_output"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// Holds the relay sidecar child process handle.
pub struct RelayState {
    child: Arc<Mutex<Option<tauri_plugin_shell::process::CommandChild>>>,
    /// Raw PID stored behind a std::sync::Mutex so it can be read without an async runtime
    /// (e.g. in the synchronous `RunEvent::Exit` callback).
    pid: Arc<std::sync::Mutex<Option<u32>>>,
    running: Arc<Mutex<bool>>,
    port: Arc<Mutex<u16>>,
    last_sidecar_status: Arc<Mutex<String>>,
    last_sidecar_error: Arc<Mutex<Option<String>>>,
    log_buffer: Arc<Mutex<Vec<RelayLogPayload>>>,
    /// Handle for the post-spawn /healthz watchdog task. Stored behind a
    /// `std::sync::Mutex` so it can be aborted from synchronous contexts
    /// (`RunEvent::Exit`, tray quit). `None` when no relay is running.
    watchdog: Arc<std::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>,
    /// Set to `true` immediately before any intentional kill (user `stop_relay`
    /// / `restart_relay`, tray quit, app exit, exhausted supervisor budget).
    /// The `CommandEvent::Terminated` arm swaps this back to `false` and treats
    /// a previously-`true` value as suppression of auto-restart.
    intentional_stop: Arc<AtomicBool>,
    /// Handle for a scheduled auto-restart task awaiting its backoff sleep.
    /// Stored behind a `std::sync::Mutex` so it can be aborted from synchronous
    /// contexts (`RunEvent::Exit`, tray quit). `None` when no respawn is
    /// pending.
    restart_pending: Arc<std::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>>,
    /// Supervisor restart policy state: tracks the consecutive failed
    /// auto-restart attempts so the backoff schedule and hard cap can be
    /// evaluated deterministically.
    restart_policy: Arc<std::sync::Mutex<RelayRestartPolicy>>,
    /// Wall-clock instant at which the current (or most recent) child was
    /// spawned. The supervisor reads this on termination to compute uptime and
    /// decide whether to reset the attempt counter.
    last_spawn_at: Arc<std::sync::Mutex<Option<Instant>>>,
}

#[derive(Serialize, Clone)]
pub struct RelayStatusInfo {
    pub running: bool,
}

#[derive(Serialize, Clone)]
pub struct RelayLogPayload {
    pub level: String,
    pub message: String,
    /// Endpoint name extracted from the compact-format tracing span
    /// (`endpoint{endpoint=NAME ...}`), or `None` for relay-level events with
    /// no span context. Populated by [`parse_endpoint_from_span`] during
    /// stdout/stderr capture so downstream consumers (live `relay-log` events
    /// and the buffered-logs fetch) see the same authoritative value.
    /// Serialized as JSON `null` (not omitted) when absent so the desktop
    /// front-end can rely on the field being present on every event.
    pub endpoint: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct RelayHealthPayload {
    pub status: String,
    pub message: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct RelaySidecarStatusPayload {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Holds a pending update that has been checked but not yet installed.
pub struct PendingUpdate(std::sync::Mutex<Option<tauri_plugin_updater::Update>>);

/// Tauri-managed wrapper around [`UpdaterBackoff`].
#[derive(Default)]
pub struct UpdaterBackoffState(std::sync::Mutex<UpdaterBackoff>);

/// Pure state machine that tracks consecutive `check_for_update` failures and
/// returns a remaining backoff window when callers should skip a check.
#[derive(Default, Debug, Clone)]
pub struct UpdaterBackoff {
    consecutive_failures: u32,
    last_failure: Option<std::time::Instant>,
}

impl UpdaterBackoff {
    /// If a check should currently be skipped, returns `Some(retry_after_secs)`
    /// for the remaining backoff window. Returns `None` when the caller is
    /// free to attempt a check.
    fn next_retry_after_secs(&self, now: std::time::Instant) -> Option<u64> {
        let last = self.last_failure?;
        if self.consecutive_failures == 0 {
            return None;
        }
        let backoff_secs = backoff_window_secs(self.consecutive_failures);
        let elapsed = now.saturating_duration_since(last).as_secs();
        if elapsed >= backoff_secs {
            None
        } else {
            Some(backoff_secs - elapsed)
        }
    }

    fn record_failure(&mut self, now: std::time::Instant) {
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        self.last_failure = Some(now);
    }

    fn record_success(&mut self) {
        self.consecutive_failures = 0;
        self.last_failure = None;
    }
}

/// Compute the backoff window in seconds for a given count of consecutive
/// failures: `min(2^(n-1) * BASE, MAX)`. Returns `0` for `n == 0`.
fn backoff_window_secs(consecutive_failures: u32) -> u64 {
    if consecutive_failures == 0 {
        return 0;
    }
    // Clamp the exponent so `1u64 << exp` never overflows.
    let exp = (consecutive_failures - 1).min(20);
    let secs = UPDATER_BACKOFF_BASE_SECS.saturating_mul(1u64 << exp);
    secs.min(UPDATER_BACKOFF_MAX_SECS)
}

/// Truncate `body` to at most [`UPDATER_BODY_EXCERPT_BYTES`] bytes and replace
/// CR/LF/tab characters with spaces so the excerpt fits cleanly on a single
/// log line.
fn sanitize_body_excerpt(body: &str) -> String {
    let truncated = if body.len() > UPDATER_BODY_EXCERPT_BYTES {
        // Slice on a char boundary at-or-before the byte limit.
        let mut end = UPDATER_BODY_EXCERPT_BYTES;
        while end > 0 && !body.is_char_boundary(end) {
            end -= 1;
        }
        &body[..end]
    } else {
        body
    };
    truncated
        .chars()
        .map(|c| match c {
            '\n' | '\r' | '\t' => ' ',
            _ => c,
        })
        .collect()
}

/// Metadata about an available update.
#[derive(Serialize, Clone)]
pub struct UpdateMetadata {
    pub version: String,
    pub current_version: String,
    pub body: Option<String>,
    pub date: Option<String>,
}

/// Event payload emitted from `check_for_update` so the frontend can display
/// which channel was actually used for the check (and cannot visually drift
/// from the persisted value).
#[derive(Serialize, Clone)]
pub struct UpdateCheckedPayload {
    pub channel: String,
    pub url: String,
}

async fn emit_sidecar_status(app: &AppHandle, status: &str, error: Option<String>) {
    let payload = RelaySidecarStatusPayload {
        status: status.to_string(),
        error,
    };

    if let Some(state) = app.try_state::<RelayState>() {
        *state.last_sidecar_status.lock().await = payload.status.clone();
        *state.last_sidecar_error.lock().await = payload.error.clone();
    }

    let _ = app.emit("relay-sidecar-status", payload);
}

/// JSON shape returned by relay's `/healthz` endpoint (see endara-relay PR #36).
#[derive(Deserialize)]
struct HealthzResponse {
    status: String,
    #[allow(dead_code)]
    #[serde(default)]
    version: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    uptime_secs: Option<u64>,
}

/// Health snapshot derived from a single `/healthz` probe attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HealthState {
    /// No probe has produced a definitive result yet (initial state only).
    Unknown,
    /// `/healthz` returned 200 with a JSON body where `status == "ok"`.
    Healthy,
    /// Probe failed (transport error, non-2xx, parse error, or `status != "ok"`).
    Unhealthy { reason: String },
}

/// Event surfaced by the pure transition detector when health flips.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HealthTransition {
    BecameHealthy,
    BecameUnhealthy { reason: String },
}

/// Pure transition detector: emits `Some` only when the latest probe flips
/// the health state (including the first definitive observation from
/// `Unknown`). Subsequent probes that confirm the same state return `None`,
/// so callers do not spam events on every successful or failing probe.
pub fn detect_health_transition(
    prev: &HealthState,
    current: &HealthState,
) -> Option<HealthTransition> {
    match (prev, current) {
        // Same definitive state — silent.
        (HealthState::Healthy, HealthState::Healthy) => None,
        (HealthState::Unhealthy { .. }, HealthState::Unhealthy { .. }) => None,
        // Defensive: a fresh probe should never return Unknown, but if it
        // does we treat it as "no information" rather than a transition.
        (_, HealthState::Unknown) => None,
        // First definitive observation or a real flip.
        (_, HealthState::Healthy) => Some(HealthTransition::BecameHealthy),
        (_, HealthState::Unhealthy { reason }) => Some(HealthTransition::BecameUnhealthy {
            reason: reason.clone(),
        }),
    }
}

/// Issue a single `/healthz` probe against `127.0.0.1:port` and classify the
/// result. Logs the failure reason with a sanitized body excerpt (mirroring
/// the updater's pattern) so transient bad responses are debuggable. On a
/// successful probe the wall-clock round-trip is returned alongside the
/// `Healthy` state so the watchdog can surface it on the healthy transition.
async fn probe_healthz(client: &reqwest::Client, port: u16) -> (HealthState, Option<u64>) {
    let url = format!("http://127.0.0.1:{port}/healthz");
    let start = std::time::Instant::now();
    let response = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            return (
                HealthState::Unhealthy {
                    reason: format!("transport error: {e}"),
                },
                None,
            );
        }
    };

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let body_excerpt = sanitize_body_excerpt(&body);
        log::warn!(
            "[relay-watchdog] non-2xx probe port={} status={} body_excerpt={:?}",
            port,
            status.as_u16(),
            body_excerpt
        );
        return (
            HealthState::Unhealthy {
                reason: format!("non-2xx: {}", status.as_u16()),
            },
            None,
        );
    }

    let body = response.text().await.unwrap_or_default();
    match serde_json::from_str::<HealthzResponse>(&body) {
        Ok(h) if h.status == "ok" => {
            let latency_ms = start.elapsed().as_millis() as u64;
            (HealthState::Healthy, Some(latency_ms))
        }
        Ok(h) => {
            let body_excerpt = sanitize_body_excerpt(&body);
            log::warn!(
                "[relay-watchdog] unexpected status field port={} status={:?} body_excerpt={:?}",
                port,
                h.status,
                body_excerpt
            );
            (
                HealthState::Unhealthy {
                    reason: format!("status={}", h.status),
                },
                None,
            )
        }
        Err(e) => {
            let body_excerpt = sanitize_body_excerpt(&body);
            log::warn!(
                "[relay-watchdog] failed to parse JSON port={} error={} body_excerpt={:?}",
                port,
                e,
                body_excerpt
            );
            (
                HealthState::Unhealthy {
                    reason: format!("parse error: {e}"),
                },
                None,
            )
        }
    }
}

/// Watchdog loop: probe `/healthz` periodically and emit `relay-sidecar-status`
/// events on healthy↔unhealthy transitions. Runs until aborted via
/// [`stop_watchdog`].
async fn run_watchdog(app: AppHandle, port: u16) {
    let client = match reqwest::Client::builder()
        .timeout(RELAY_WATCHDOG_PROBE_TIMEOUT)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log::error!("[relay-watchdog] failed to build HTTP client error={e}");
            return;
        }
    };

    tokio::time::sleep(RELAY_WATCHDOG_INITIAL_DELAY).await;
    log::info!(
        "[relay-watchdog] starting probes port={} interval_secs={} timeout_secs={}",
        port,
        RELAY_WATCHDOG_PROBE_INTERVAL.as_secs(),
        RELAY_WATCHDOG_PROBE_TIMEOUT.as_secs()
    );

    let mut prev = HealthState::Unknown;
    loop {
        let (current, latency_ms) = probe_healthz(&client, port).await;
        if let Some(event) = detect_health_transition(&prev, &current) {
            match &event {
                HealthTransition::BecameHealthy => {
                    // DoD: literal "relay healthcheck ok" message with port +
                    // latency_ms fields, fired once per healthy transition
                    // (not per probe). Uses `target` so the watchdog tag is
                    // preserved without polluting the message text.
                    log::info!(
                        target: "relay-watchdog",
                        "relay healthcheck ok port={} latency_ms={}",
                        port,
                        latency_ms.unwrap_or(0)
                    );
                    emit_sidecar_status(&app, "running", None).await;
                }
                HealthTransition::BecameUnhealthy { reason } => {
                    log::warn!(
                        "[relay-watchdog] unhealthy transition port={} reason={}",
                        port,
                        reason
                    );
                    emit_sidecar_status(&app, "unhealthy", Some(reason.clone())).await;
                }
            }
        }
        prev = current;
        tokio::time::sleep(RELAY_WATCHDOG_PROBE_INTERVAL).await;
    }
}

/// Abort and clear any running relay watchdog task. Safe to call from sync
/// contexts (uses `std::sync::Mutex`, no await).
fn stop_watchdog(state: &RelayState) {
    if let Ok(mut guard) = state.watchdog.lock() {
        if let Some(handle) = guard.take() {
            handle.abort();
        }
    }
}

/// Abort and clear any pending auto-restart task. Safe to call from sync
/// contexts.
fn abort_pending_restart(state: &RelayState) {
    if let Ok(mut guard) = state.restart_pending.lock() {
        if let Some(handle) = guard.take() {
            handle.abort();
        }
    }
}

/// Schedule an auto-restart of the relay sidecar after `delay_secs`. The
/// returned task sleeps, re-checks the intentional-stop flag and the child
/// slot, then calls [`spawn_relay`] and updates the shared state — mirroring
/// the success path of [`start_relay`].
fn schedule_relay_restart(app: &AppHandle, delay_secs: u64, attempt: u32, max: u32) {
    let task_app = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let app = task_app;
        tokio::time::sleep(std::time::Duration::from_secs(delay_secs)).await;

        // Re-check state after the sleep so a user-initiated start / restart
        // or app exit during the backoff window short-circuits the respawn.
        let Some(state) = app.try_state::<RelayState>() else {
            return;
        };
        if state.intentional_stop.load(Ordering::Acquire) {
            log::info!(
                "[relay] auto-restart cancelled attempt={} reason=intentional_stop",
                attempt
            );
            return;
        }
        if state.child.lock().await.is_some() {
            log::info!(
                "[relay] auto-restart skipped attempt={} reason=child_already_running",
                attempt
            );
            return;
        }

        let port = *state.port.lock().await;
        log::info!(
            "[relay] auto-restart attempt={}/{} port={}",
            attempt,
            max,
            port
        );
        match spawn_relay(&app, port).await {
            Ok(child) => {
                if let Ok(mut pid_guard) = state.pid.lock() {
                    *pid_guard = Some(child.pid());
                }
                *state.child.lock().await = Some(child);
                *state.running.lock().await = true;
            }
            Err(e) => {
                log::error!(
                    "[relay] auto-restart attempt={} failed error={}",
                    attempt,
                    e
                );
                // `spawn_relay` already emitted a "failed" status on the
                // pre-flight path (the only failure mode that can be reached
                // here without producing a `Terminated` event). No further
                // action: the pre-flight path also sets `intentional_stop` so
                // the supervisor will not loop.
            }
        }
    });
    if let Some(state) = app.try_state::<RelayState>() {
        if let Ok(mut guard) = state.restart_pending.lock() {
            // Defensive: abort any prior pending restart (there should never
            // be one, but never leak a JoinHandle).
            if let Some(prior) = guard.take() {
                prior.abort();
            }
            *guard = Some(handle);
        }
    }
}

#[derive(Serialize, Clone)]
pub struct BuildInfo {
    pub version: String,
    pub desktop_commit: String,
    pub build_date: String,
}

#[tauri::command]
async fn get_build_info() -> Result<BuildInfo, String> {
    // Use BUILD_VERSION from CI if available (includes RC suffix), else fall back to Cargo.toml version
    let version = option_env!("BUILD_VERSION")
        .unwrap_or(env!("CARGO_PKG_VERSION"))
        .to_string();
    Ok(BuildInfo {
        version,
        desktop_commit: env!("DESKTOP_COMMIT").to_string(),
        build_date: env!("BUILD_DATE").to_string(),
    })
}

/// Spawn the relay sidecar and monitor its output.
/// Returns the child handle on success.
async fn spawn_relay(
    app: &AppHandle,
    port: u16,
) -> Result<tauri_plugin_shell::process::CommandChild, String> {
    let config_file = config_path()?;
    let base_dir = data_dir()?;

    // Ensure log directory exists for relay file logging
    let log_dir = base_dir.join("logs");
    let _ = std::fs::create_dir_all(&log_dir);

    let dev = is_dev_mode();
    log::info!(
        "[relay] attempting to spawn sidecar dev={} port={} config={:?}",
        dev,
        port,
        config_file
    );

    // Pre-flight port conflict check
    if is_port_in_use(port) {
        let err_msg = format!("Port {} is already in use by another process. Close the other process or change the relay port in Settings.", port);
        log::warn!(
            "[relay] pre-flight check failed port={} error={}",
            port,
            err_msg
        );
        // The spawn never started, so there is no `CommandEvent::Terminated`
        // to suppress. Setting the flag is belt-and-suspenders against any
        // orphan event that could otherwise trigger auto-restart.
        if let Some(state) = app.try_state::<RelayState>() {
            state.intentional_stop.store(true, Ordering::Release);
            abort_pending_restart(&state);
        }
        emit_sidecar_status(app, "failed", Some(err_msg.clone())).await;
        return Err(err_msg);
    }

    // Emit sidecar lifecycle: starting
    emit_sidecar_status(app, "starting", None).await;

    let port_str = port.to_string();
    let config_lossy = config_file.to_string_lossy().to_string();
    let data_dir_lossy = base_dir.to_string_lossy().to_string();

    // Build sidecar args — in dev mode use --data-dir (without --config) so
    // the relay derives its config path from data-dir and performs the
    // first-run config copy from production. In production mode pass
    // --config explicitly.
    let sidecar_args = build_sidecar_args(dev, &data_dir_lossy, &config_lossy, &port_str);

    let (mut rx, child) = app
        .shell()
        .sidecar("endara-relay")
        .map_err(|e| {
            log::error!("[relay] failed to create sidecar command error={e}");
            format!("Failed to create sidecar command: {e}")
        })?
        .args(&sidecar_args)
        .spawn()
        .map_err(|e| {
            log::error!("[relay] failed to spawn relay sidecar error={e}");
            format!("Failed to spawn relay sidecar: {e}")
        })?;

    log::info!("[relay] sidecar spawned pid={} port={}", child.pid(), port);

    // Record spawn timestamp so the supervisor can compute uptime when the
    // child terminates and decide whether to reset the attempt counter.
    if let Some(state) = app.try_state::<RelayState>() {
        if let Ok(mut guard) = state.last_spawn_at.lock() {
            *guard = Some(Instant::now());
        }
    }

    // Spawn a background task to monitor stdout/stderr
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = strip_ansi(&String::from_utf8_lossy(&line));
                    let endpoint = parse_endpoint_from_span(&text);
                    let level = parse_level_from_line(&text).unwrap_or("info");
                    // Detect successful startup from stdout
                    if text.contains("MCP server running") {
                        emit_sidecar_status(&app_handle, "running", None).await;
                    }
                    if let Some(state) = app_handle.try_state::<RelayState>() {
                        let mut buf = state.log_buffer.lock().await;
                        buf.push(RelayLogPayload {
                            level: level.to_string(),
                            message: text.clone(),
                            endpoint: endpoint.clone(),
                        });
                        let len = buf.len();
                        if len > 5000 {
                            buf.drain(..len - 5000);
                        }
                    }
                    let _ = app_handle.emit(
                        "relay-log",
                        RelayLogPayload {
                            level: level.to_string(),
                            message: text,
                            endpoint,
                        },
                    );
                }
                CommandEvent::Stderr(line) => {
                    let text = strip_ansi(&String::from_utf8_lossy(&line));
                    // Prefer the tracing level token at the start of the line;
                    // fall back to the legacy substring heuristic for raw
                    // stderr lines that have no tracing prefix.
                    let level = parse_level_from_line(&text).unwrap_or_else(|| {
                        if text.contains("ERROR") || text.contains("error") {
                            "error"
                        } else if text.contains("WARN") || text.contains("warn") {
                            "warn"
                        } else {
                            "info"
                        }
                    });
                    let endpoint = parse_endpoint_from_span(&text);
                    // Detect successful startup from stderr (tracing outputs to stderr)
                    if text.contains("MCP server running") {
                        emit_sidecar_status(&app_handle, "running", None).await;
                    }
                    if let Some(state) = app_handle.try_state::<RelayState>() {
                        let mut buf = state.log_buffer.lock().await;
                        buf.push(RelayLogPayload {
                            level: level.to_string(),
                            message: text.clone(),
                            endpoint: endpoint.clone(),
                        });
                        let len = buf.len();
                        if len > 5000 {
                            buf.drain(..len - 5000);
                        }
                    }
                    let _ = app_handle.emit(
                        "relay-log",
                        RelayLogPayload {
                            level: level.to_string(),
                            message: text.clone(),
                            endpoint,
                        },
                    );
                    // Emit relay-health event for ERROR lines
                    if level == "error" {
                        let _ = app_handle.emit(
                            "relay-health",
                            RelayHealthPayload {
                                status: "error".to_string(),
                                message: Some(text.clone()),
                            },
                        );
                        // Emit sidecar failed status for critical errors
                        if text.contains("Failed to start HTTP server")
                            || text.contains("Address already in use")
                        {
                            emit_sidecar_status(&app_handle, "failed", Some(text.clone())).await;
                        }
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let code = payload.code;
                    let signal = payload.signal;
                    log::warn!(
                        "[relay] process terminated code={:?} signal={:?}",
                        code,
                        signal
                    );

                    // Capture spawn timestamp before we clear it so the
                    // supervisor sees the uptime of *this* child, not the
                    // next one. `was_intentional` is the atomic read-and-reset
                    // of the intentional-stop flag, so a follow-up unexpected
                    // termination starts a fresh window.
                    let mut uptime_secs: u64 = 0;
                    let mut was_intentional = false;
                    if let Some(state) = app_handle.try_state::<RelayState>() {
                        if let Ok(mut guard) = state.last_spawn_at.lock() {
                            if let Some(spawned_at) = guard.take() {
                                uptime_secs = spawned_at.elapsed().as_secs();
                            }
                        }
                        was_intentional = state.intentional_stop.swap(false, Ordering::AcqRel);
                        if let Ok(mut pid_guard) = state.pid.lock() {
                            pid_guard.take();
                        }
                        *state.running.lock().await = false;
                        *state.child.lock().await = None;
                        stop_watchdog(&state);
                    }

                    // Emit relay-health event for termination (unchanged).
                    let _ = app_handle.emit(
                        "relay-health",
                        RelayHealthPayload {
                            status: "disconnected".to_string(),
                            message: Some(format!(
                                "Process terminated (code: {:?}, signal: {:?})",
                                code, signal
                            )),
                        },
                    );

                    let exited_cleanly = code == Some(0) || (code.is_none() && signal.is_some());

                    if was_intentional {
                        // Intentional shutdown path — preserve prior semantics
                        // and do not engage the supervisor.
                        if exited_cleanly {
                            emit_sidecar_status(&app_handle, "stopped", None).await;
                        } else {
                            emit_sidecar_status(
                                &app_handle,
                                "failed",
                                Some(format!(
                                    "Process exited with code: {:?}, signal: {:?}",
                                    code, signal
                                )),
                            )
                            .await;
                        }
                        break;
                    }

                    // Unexpected termination — consult the supervisor.
                    let decision = if let Some(state) = app_handle.try_state::<RelayState>() {
                        match state.restart_policy.lock() {
                            Ok(mut policy) => policy.on_termination(false, uptime_secs),
                            Err(_) => RelayRestartDecision::Suppress,
                        }
                    } else {
                        RelayRestartDecision::Suppress
                    };

                    match decision {
                        RelayRestartDecision::Restart {
                            attempt,
                            delay_secs,
                            max,
                        } => {
                            let reason = format!(
                                "signal={:?} code={:?}, attempt {}/{}",
                                signal, code, attempt, max
                            );
                            log::warn!(
                                "[relay] auto-restart scheduled attempt={} max={} delay_secs={} uptime_secs={} signal={:?} code={:?}",
                                attempt,
                                max,
                                delay_secs,
                                uptime_secs,
                                signal,
                                code
                            );
                            emit_sidecar_status(&app_handle, "restarting", Some(reason)).await;
                            schedule_relay_restart(&app_handle, delay_secs, attempt, max);
                        }
                        RelayRestartDecision::GiveUp { max } => {
                            log::error!(
                                "[relay] auto-restart suspended after {} consecutive failed attempts",
                                max
                            );
                            // Block any further auto-restart attempts until the
                            // user manually intervenes (start/restart resets
                            // both the flag and the policy).
                            if let Some(state) = app_handle.try_state::<RelayState>() {
                                state.intentional_stop.store(true, Ordering::Release);
                                abort_pending_restart(&state);
                            }
                            emit_sidecar_status(
                                &app_handle,
                                "failed",
                                Some(RELAY_RESTART_SUSPENDED_MSG.to_string()),
                            )
                            .await;
                        }
                        RelayRestartDecision::Suppress => {
                            // Reachable only when state is missing; preserve
                            // prior behavior.
                            if exited_cleanly {
                                emit_sidecar_status(&app_handle, "stopped", None).await;
                            } else {
                                emit_sidecar_status(
                                    &app_handle,
                                    "failed",
                                    Some(format!(
                                        "Process exited with code: {:?}, signal: {:?}",
                                        code, signal
                                    )),
                                )
                                .await;
                            }
                        }
                    }
                    break;
                }
                CommandEvent::Error(err) => {
                    log::error!("[relay] command error error={err}");
                }
                _ => {}
            }
        }
    });

    // Spawn the post-spawn /healthz watchdog. Abort any prior handle first
    // (defensive — there should not be one because spawn_relay is only called
    // when no relay is running, but we never want two probe loops racing).
    if let Some(state) = app.try_state::<RelayState>() {
        stop_watchdog(&state);
        let watchdog_app = app.clone();
        let handle = tauri::async_runtime::spawn(async move {
            run_watchdog(watchdog_app, port).await;
        });
        if let Ok(mut guard) = state.watchdog.lock() {
            *guard = Some(handle);
        }
    }

    Ok(child)
}

#[tauri::command]
async fn start_relay(
    app: AppHandle,
    state: State<'_, RelayState>,
) -> Result<RelayStatusInfo, String> {
    if state.child.lock().await.is_some() {
        return Ok(RelayStatusInfo { running: true });
    }

    // A manual start always begins a fresh unhealthy window: clear any
    // pending auto-restart, reset the supervisor counter, and clear the
    // intentional-stop flag (which the supervisor may have left set after
    // exhausting its budget) before launching.
    abort_pending_restart(&state);
    if let Ok(mut policy) = state.restart_policy.lock() {
        policy.reset();
    }
    state.intentional_stop.store(false, Ordering::Release);

    let port = *state.port.lock().await;
    let child = spawn_relay(&app, port).await?;
    if let Ok(mut pid_guard) = state.pid.lock() {
        *pid_guard = Some(child.pid());
    }
    *state.child.lock().await = Some(child);
    *state.running.lock().await = true;
    Ok(RelayStatusInfo { running: true })
}

#[tauri::command]
async fn stop_relay(state: State<'_, RelayState>) -> Result<RelayStatusInfo, String> {
    // Cancel any pending auto-restart before we drop the watchdog / child so a
    // mid-sleep supervisor task cannot race us by spawning a fresh relay.
    abort_pending_restart(&state);
    stop_watchdog(&state);
    if let Ok(mut pid_guard) = state.pid.lock() {
        pid_guard.take();
    }
    let mut child_guard = state.child.lock().await;
    if let Some(child) = child_guard.take() {
        // Mark this kill as intentional *before* delivering the signal so the
        // `CommandEvent::Terminated` arm reads the flag set by us, not a stale
        // value from a prior unexpected death.
        state.intentional_stop.store(true, Ordering::Release);
        child
            .kill()
            .map_err(|e| format!("Failed to kill relay: {e}"))?;
    }
    *state.running.lock().await = false;
    if let Ok(mut policy) = state.restart_policy.lock() {
        policy.reset();
    }
    Ok(RelayStatusInfo { running: false })
}

#[tauri::command]
async fn restart_relay(
    app: AppHandle,
    state: State<'_, RelayState>,
) -> Result<RelayStatusInfo, String> {
    abort_pending_restart(&state);
    stop_watchdog(&state);
    // Clear any leftover intentional-stop flag (e.g. the supervisor set it
    // when it gave up after exhausting its restart budget) so the next
    // unexpected `Terminated` event is not silently routed to Suppress.
    state.intentional_stop.store(false, Ordering::Release);
    {
        if let Ok(mut pid_guard) = state.pid.lock() {
            pid_guard.take();
        }
        let mut child_guard = state.child.lock().await;
        if let Some(child) = child_guard.take() {
            // Arm the swap consumer in the `Terminated` arm so the kill we
            // are about to issue is recognised as intentional.
            state.intentional_stop.store(true, Ordering::Release);
            let _ = child.kill();
        }
    }
    *state.running.lock().await = false;
    if let Ok(mut policy) = state.restart_policy.lock() {
        policy.reset();
    }

    // Brief pause before restart
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let port = *state.port.lock().await;
    let child = spawn_relay(&app, port).await?;
    if let Ok(mut pid_guard) = state.pid.lock() {
        *pid_guard = Some(child.pid());
    }
    *state.child.lock().await = Some(child);
    *state.running.lock().await = true;
    Ok(RelayStatusInfo { running: true })
}

#[tauri::command]
async fn relay_status(state: State<'_, RelayState>) -> Result<RelayStatusInfo, String> {
    let running = *state.running.lock().await;
    Ok(RelayStatusInfo { running })
}

#[tauri::command]
async fn get_sidecar_status(
    state: State<'_, RelayState>,
) -> Result<RelaySidecarStatusPayload, String> {
    Ok(RelaySidecarStatusPayload {
        status: state.last_sidecar_status.lock().await.clone(),
        error: state.last_sidecar_error.lock().await.clone(),
    })
}

#[tauri::command]
async fn get_config_path_display() -> Result<String, String> {
    let path = config_path()?;
    if let Some(home) = dirs::home_dir() {
        let path_str = path.to_string_lossy();
        let home_str = home.to_string_lossy();
        if path_str.starts_with(home_str.as_ref()) {
            return Ok(format!("~{}", &path_str[home_str.len()..]));
        }
    }
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn get_buffered_relay_logs(
    state: State<'_, RelayState>,
) -> Result<Vec<RelayLogPayload>, String> {
    let mut buf = state.log_buffer.lock().await;
    let logs = buf.drain(..).collect();
    Ok(logs)
}

#[tauri::command]
async fn get_relay_port(state: State<'_, RelayState>) -> Result<u16, String> {
    Ok(*state.port.lock().await)
}

/// Proxy a management-API request from the WebView to the relay's local
/// Unix-domain socket / Windows named pipe. The relay no longer accepts
/// `/api/*` requests over TCP, so the SvelteKit UI must round-trip through the
/// Tauri backend (which can dial the socket and is bound to the same UID as
/// the listener).
#[tauri::command]
async fn mgmt_api_request(
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<api_proxy::ApiResponse, String> {
    let socket = api_proxy::resolve_api_socket_path(&data_dir()?);
    let body_bytes = match body {
        Some(v) => Some(serde_json::to_vec(&v).map_err(|e| format!("serialize body: {e}"))?),
        None => None,
    };
    api_proxy::send_request(&socket, &method, &path, body_bytes, &[]).await
}

/// Return the resolved management-API socket / pipe path for diagnostics. The
/// UI does not normally need this — it goes through `mgmt_api_request` — but
/// surfacing it helps with support / log redaction.
#[tauri::command]
async fn get_mgmt_api_socket_path() -> Result<String, String> {
    let socket = api_proxy::resolve_api_socket_path(&data_dir()?);
    Ok(socket.to_string_lossy().into_owned())
}

#[tauri::command]
async fn show_overlay(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(overlay::OVERLAY_WINDOW_LABEL) {
        w.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn hide_overlay(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(overlay::OVERLAY_WINDOW_LABEL) {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn set_overlay_ignore_cursor_events(app: AppHandle, ignore: bool) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(overlay::OVERLAY_WINDOW_LABEL) {
        w.set_ignore_cursor_events(ignore)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn reposition_overlay(app: AppHandle, position: String) -> Result<(), String> {
    let pos = overlay::OverlayPosition::parse(&position)?;
    overlay::reposition_overlay_window(&app, pos).map_err(|e| e.to_string())
}

#[tauri::command]
async fn subscribe_tool_call_events(
    window: Window,
    state: State<'_, overlay::OverlaySubscriberState>,
) -> Result<(), String> {
    let socket = api_proxy::resolve_api_socket_path(&data_dir()?);
    overlay::spawn_sse_bridge(&state, socket, window).await;
    Ok(())
}

#[tauri::command]
async fn unsubscribe_tool_call_events(
    state: State<'_, overlay::OverlaySubscriberState>,
) -> Result<(), String> {
    overlay::abort_sse_bridge(&state).await;
    Ok(())
}

/// Read `[desktop.overlay]` from `config.toml`, falling back to defaults if
/// the file is missing, malformed, or the section is absent. Used by the
/// Settings UI and the tray menu to display the current state without
/// triggering the migration helper (which only runs once at startup).
fn read_overlay_settings_from_config() -> overlay::OverlaySettings {
    let Ok(table) = read_config() else {
        return overlay::OverlaySettings::default();
    };
    let Some(overlay_table) = table
        .get("desktop")
        .and_then(|v| v.as_table())
        .and_then(|t| t.get("overlay"))
        .and_then(|v| v.as_table())
    else {
        return overlay::OverlaySettings::default();
    };
    toml::Value::Table(overlay_table.clone())
        .try_into::<overlay::OverlaySettings>()
        .unwrap_or_default()
        .sanitize()
}

/// Persist `settings` into `[desktop.overlay]`, creating the `[desktop]`
/// table if missing. Sibling keys under `[desktop]` (e.g. `update_channel`)
/// are preserved.
fn write_overlay_settings_to_config(settings: &overlay::OverlaySettings) -> Result<(), String> {
    let mut table = read_config().unwrap_or_else(|_| toml::Table::new());
    let desktop = table
        .entry("desktop")
        .or_insert_with(|| toml::Value::Table(toml::Table::new()))
        .as_table_mut()
        .ok_or("Invalid [desktop] section in config")?;
    let overlay_value =
        toml::Value::try_from(settings).map_err(|e| format!("serialize overlay settings: {e}"))?;
    desktop.insert("overlay".to_string(), overlay_value);
    write_config(&table)
}

#[tauri::command]
async fn get_overlay_settings() -> Result<overlay::OverlaySettings, String> {
    Ok(read_overlay_settings_from_config())
}

/// App-managed handle to the tray menu's "Show MCP activity overlay" check
/// item. Wrapping the `CheckMenuItem` in a newtype lets `apply_overlay_settings`
/// look it up via [`Manager::try_state`] and keep the checkbox in sync
/// without round-tripping through an event-bus listener. The clone stored
/// here is cheap — Tauri's `CheckMenuItem` is internally `Arc`-wrapped.
struct TrayOverlayToggle(CheckMenuItem<tauri::Wry>);

/// Desired checked state for the tray's "Show MCP activity overlay" menu
/// item given a set of `OverlaySettings`. Factored out so the contract
/// ("tray.checked mirrors `settings.enabled`") is unit-testable independently
/// of the Tauri runtime, and so the initial tray-menu construction and the
/// `apply_overlay_settings` sync path can share a single source of truth.
fn tray_overlay_checked_for(settings: &overlay::OverlaySettings) -> bool {
    settings.enabled
}

/// Persist `new_settings` and apply the runtime delta against `prev`:
///
///   * `enabled` toggled on  → build a fresh overlay window (its renderer
///     auto-subscribes to the SSE bridge on mount, so no manual subscribe).
///   * `enabled` toggled off → abort the SSE bridge AND destroy the overlay
///     window so its renderer unmounts cleanly.
///   * `position` changed (still enabled) → call `reposition_overlay_window`.
///   * Always `emit_to(OVERLAY_WINDOW_LABEL, "overlay:settings-changed", …)`
///     so the overlay renderer's `overlaySettingsStore` and toast store opts
///     (`auto_dismiss_ms`, `max_visible`, `show_profile`) stay in sync
///     without a window rebuild. Window-scoped so the main window is not
///     spuriously notified.
///   * Sync the tray menu's "Show MCP activity overlay" checkbox directly
///     via [`TrayOverlayToggle`] state (no event round-trip) so the tray
///     UI stays consistent when the Settings UI flips `enabled`.
///
/// Shared by the `set_overlay_settings` Tauri command and the tray-menu
/// "Show MCP activity overlay" toggle so both surfaces stay consistent.
async fn apply_overlay_settings(
    app: &AppHandle,
    state: &overlay::OverlaySubscriberState,
    prev: &overlay::OverlaySettings,
    new_settings: &overlay::OverlaySettings,
) -> Result<(), String> {
    write_overlay_settings_to_config(new_settings)?;

    let enabled_changed = prev.enabled != new_settings.enabled;
    let position_changed = prev.position != new_settings.position;

    if enabled_changed && !new_settings.enabled {
        // Disable: tear down SSE bridge first so the renderer is not racing
        // a final frame against window destruction, then destroy the
        // window. `destroy()` bypasses the `prevent_close` guard in the
        // app-level window event handler.
        overlay::abort_sse_bridge(state).await;
        if let Some(w) = app.get_webview_window(overlay::OVERLAY_WINDOW_LABEL) {
            if let Err(e) = w.destroy() {
                log::warn!("[overlay] destroy on disable failed: {e}");
            }
        }
        log::info!("[overlay] settings update enabled=false applied");
    } else if enabled_changed && new_settings.enabled {
        // Enable: rebuild the overlay window. The renderer auto-invokes
        // `subscribe_tool_call_events` on mount, which spawns a fresh SSE
        // bridge task.
        match overlay::build_overlay_window(app, new_settings) {
            Ok(_) => log::info!(
                "[overlay] settings update enabled=true position={} applied",
                new_settings.position.as_str()
            ),
            Err(e) => {
                log::warn!("[overlay] failed to build overlay window on enable error={e}");
                return Err(format!("failed to build overlay window: {e}"));
            }
        }
    } else if position_changed && new_settings.enabled {
        if let Err(e) = overlay::reposition_overlay_window(app, new_settings.position) {
            log::warn!("[overlay] reposition failed: {e}");
        }
    }

    // Notify the overlay renderer (if mounted) so its store + opts mirror
    // the new settings. Scoped to the overlay window via `emit_to` so the
    // main window is not spuriously notified. Safe to call even when the
    // overlay window is gone — Tauri swallows the emit for a missing
    // target label rather than erroring on it.
    if let Err(e) = app.emit_to(
        overlay::OVERLAY_WINDOW_LABEL,
        "overlay:settings-changed",
        new_settings,
    ) {
        log::warn!("[overlay] settings-changed emit_to failed: {e}");
    }

    // Keep the tray "Show MCP activity overlay" checkbox in sync. Both
    // callers (the `set_overlay_settings` Tauri command and the tray
    // toggle handler) flow through here, so this is the single place tray
    // state has to track. `try_state` is `None` during early init / tests
    // that don't register the toggle — silently skip in that case.
    if let Some(toggle) = app.try_state::<TrayOverlayToggle>() {
        if let Err(e) = toggle.0.set_checked(tray_overlay_checked_for(new_settings)) {
            log::warn!("[overlay] tray set_checked failed: {e}");
        }
    }

    Ok(())
}

#[tauri::command]
async fn set_overlay_settings(
    app: AppHandle,
    state: State<'_, overlay::OverlaySubscriberState>,
    settings: overlay::OverlaySettings,
) -> Result<(), String> {
    let new_settings = settings.sanitize();
    let prev = read_overlay_settings_from_config();
    apply_overlay_settings(&app, &state, &prev, &new_settings).await
}

/// Payload emitted to the main window so its RelayLogs view can scroll the
/// matching `request{id="..."}` row into view. Field name is camelCase to
/// match the renderer event handler — Tauri serializes Serde structs with
/// the default rename, and the front-end consumer expects `jsonrpcId`.
#[derive(Serialize, Clone)]
struct FocusLogPayload {
    #[serde(rename = "jsonrpcId")]
    jsonrpc_id: String,
}

/// Show + focus the main window and emit `overlay:focus-log` to it with the
/// JSON-RPC id of the request the user clicked on in the overlay. The Phase
/// 4 overlay card click handler is wired through here; Phase 3 ships the
/// plumbing only.
///
/// On macOS we also restore the regular activation policy so the app
/// reappears in the Dock + Cmd-Tab when the user clicks from an otherwise
/// hidden / accessory-mode session — mirroring the tray "Open Endara"
/// behaviour.
#[tauri::command]
async fn focus_main_window_on_log(app: AppHandle, jsonrpc_id: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    set_macos_activation_policy(true);
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        window
            .emit(
                "overlay:focus-log",
                FocusLogPayload {
                    jsonrpc_id: jsonrpc_id.clone(),
                },
            )
            .map_err(|e| e.to_string())?;
        log::info!(
            "[overlay] focus_main_window_on_log emitted jsonrpc_id={}",
            jsonrpc_id
        );
        Ok(())
    } else {
        Err("main window not available".to_string())
    }
}

#[tauri::command]
async fn set_relay_port(port: u16, state: State<'_, RelayState>) -> Result<(), String> {
    *state.port.lock().await = port;

    // Persist port to ~/.endara/config.toml
    let mut table = read_config()?;

    // Set port in the [relay] section
    if let Some(relay) = table.get_mut("relay").and_then(|v| v.as_table_mut()) {
        relay.insert("port".to_string(), toml::Value::Integer(port as i64));
    } else {
        return Err("Missing [relay] section in config".to_string());
    }

    write_config(&table)
}

/// Get whether local JS execution is enabled in the relay config.
/// Returns `false` if the config is missing, malformed, or has no `[relay]` section.
#[tauri::command]
async fn get_js_execution_mode() -> Result<bool, String> {
    Ok(read_js_execution_mode())
}

#[tauri::command]
async fn set_js_execution_mode(enabled: bool) -> Result<(), String> {
    let mut table = read_config().unwrap_or_else(|_| toml::Table::new());

    // Ensure [relay] section exists. The relay's `RelayConfig` requires
    // `machine_name`, so populate it from the system hostname when creating
    // the section from scratch — otherwise the relay's next config reload
    // would fail to deserialize.
    let relay = table
        .entry("relay")
        .or_insert_with(|| {
            let mut t = toml::Table::new();
            let machine_name = hostname::get()
                .ok()
                .and_then(|h| h.into_string().ok())
                .unwrap_or_else(|| "unknown".to_string());
            t.insert(
                "machine_name".to_string(),
                toml::Value::String(machine_name),
            );
            toml::Value::Table(t)
        })
        .as_table_mut()
        .ok_or("Invalid [relay] section in config")?;

    relay.insert(
        "local_js_execution".to_string(),
        toml::Value::Boolean(enabled),
    );

    write_config(&table)
}

/// Get whether TOON output is enabled in the relay config.
/// Returns `true` (the relay's own default) if the config is missing,
/// malformed, has no `[relay]` section, or has no `toon_output` field.
#[tauri::command]
async fn get_toon_output() -> Result<bool, String> {
    Ok(read_toon_output())
}

#[tauri::command]
async fn set_toon_output(enabled: bool) -> Result<(), String> {
    let mut table = read_config().unwrap_or_else(|_| toml::Table::new());

    // Ensure [relay] section exists. The relay's `RelayConfig` requires
    // `machine_name`, so populate it from the system hostname when creating
    // the section from scratch — otherwise the relay's next config reload
    // would fail to deserialize.
    let relay = table
        .entry("relay")
        .or_insert_with(|| {
            let mut t = toml::Table::new();
            let machine_name = hostname::get()
                .ok()
                .and_then(|h| h.into_string().ok())
                .unwrap_or_else(|| "unknown".to_string());
            t.insert(
                "machine_name".to_string(),
                toml::Value::String(machine_name),
            );
            toml::Value::Table(t)
        })
        .as_table_mut()
        .ok_or("Invalid [relay] section in config")?;

    relay.insert("toon_output".to_string(), toml::Value::Boolean(enabled));

    write_config(&table)
}

/// Get the current update channel ("stable" or "beta").
#[tauri::command]
async fn get_update_channel() -> Result<String, String> {
    Ok(read_update_channel())
}

/// Set the update channel and persist it to config.toml.
#[tauri::command]
async fn set_update_channel(channel: String) -> Result<(), String> {
    let mut table = read_config().unwrap_or_else(|_| toml::Table::new());

    // Ensure [desktop] section exists
    let desktop = table
        .entry("desktop")
        .or_insert_with(|| toml::Value::Table(toml::Table::new()))
        .as_table_mut()
        .ok_or("Invalid [desktop] section in config")?;

    desktop.insert("update_channel".to_string(), toml::Value::String(channel));

    write_config(&table)
}

/// Check for an available update using the channel-specific endpoint.
/// Stores the update in PendingUpdate state if found.
///
/// Performs a pre-flight `reqwest` GET on the manifest URL so a 4xx/5xx
/// response is logged with `url`, `status`, `body_excerpt`, and `channel`
/// before delegating to `tauri-plugin-updater` (which would otherwise
/// surface only an opaque "did not respond with a successful status code"
/// error). Consecutive failures trigger an exponential in-process backoff
/// to stop hammering a misconfigured endpoint.
#[tauri::command]
async fn check_for_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
    backoff: State<'_, UpdaterBackoffState>,
) -> Result<Option<UpdateMetadata>, String> {
    let channel = read_update_channel();
    let url = if channel == "beta" {
        BETA_UPDATE_URL
    } else {
        STABLE_UPDATE_URL
    };

    // Surface the effective channel so the UI can display which feed was checked
    // and stay in sync with the persisted backend value on every check.
    let _ = app.emit(
        "update://checked",
        UpdateCheckedPayload {
            channel: channel.clone(),
            url: url.to_string(),
        },
    );

    // Backoff gate: skip the check entirely if a recent failure put us in the
    // backoff window.
    {
        let guard = backoff
            .0
            .lock()
            .map_err(|e| format!("Failed to lock updater backoff state: {e}"))?;
        if let Some(retry_after_secs) = guard.next_retry_after_secs(std::time::Instant::now()) {
            log::info!(
                "updater check skipped: in backoff window channel={} retry_after_secs={}",
                channel,
                retry_after_secs
            );
            return Err(format!(
                "updater check skipped: in backoff window (retry_after_secs={})",
                retry_after_secs
            ));
        }
    }

    // Pre-flight fetch so we own the error path and can log url + status + body
    // excerpt before handing the URL to the plugin.
    let client = reqwest::Client::builder()
        .timeout(UPDATER_FETCH_TIMEOUT)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let response = match client.get(url).send().await {
        Ok(resp) => resp,
        Err(e) => {
            log::error!(
                "updater check transport error channel={} url={} error={}",
                channel,
                url,
                e
            );
            let mut guard = backoff
                .0
                .lock()
                .map_err(|e| format!("Failed to lock updater backoff state: {e}"))?;
            guard.record_failure(std::time::Instant::now());
            return Err(format!("Failed to fetch update manifest: {e}"));
        }
    };

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let body_excerpt = sanitize_body_excerpt(&body);
        log::warn!(
            "updater check non-2xx channel={} url={} status={} body_excerpt={:?}",
            channel,
            url,
            status.as_u16(),
            body_excerpt
        );
        let mut guard = backoff
            .0
            .lock()
            .map_err(|e| format!("Failed to lock updater backoff state: {e}"))?;
        guard.record_failure(std::time::Instant::now());
        return Err(format!(
            "Update endpoint returned status {} for {} channel",
            status.as_u16(),
            channel
        ));
    }

    // 2xx: reset backoff. The plugin will refetch + parse + verify the
    // manifest below; that is the install path of record.
    {
        let mut guard = backoff
            .0
            .lock()
            .map_err(|e| format!("Failed to lock updater backoff state: {e}"))?;
        guard.record_success();
    }
    drop(response);

    let update = app
        .updater_builder()
        .endpoints(vec![url
            .parse()
            .map_err(|e| format!("Invalid URL: {e}"))?])
        .map_err(|e| format!("Failed to configure updater: {e}"))?
        .build()
        .map_err(|e| format!("Failed to build updater: {e}"))?
        .check()
        .await
        .map_err(|e| format!("Failed to check for update: {e}"))?;

    match update {
        Some(upd) => {
            let metadata = UpdateMetadata {
                version: upd.version.clone(),
                current_version: upd.current_version.clone(),
                body: upd.body.clone(),
                date: upd.date.as_ref().map(|d| d.to_string()),
            };
            // Store the update for later installation
            if let Ok(mut guard) = pending.0.lock() {
                *guard = Some(upd);
            }
            Ok(Some(metadata))
        }
        None => Ok(None),
    }
}

/// Download and install the pending update.
#[tauri::command]
async fn download_and_install_update(pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = {
        let mut guard = pending
            .0
            .lock()
            .map_err(|e| format!("Failed to lock pending update: {e}"))?;
        guard.take()
    };

    match update {
        Some(upd) => {
            upd.download_and_install(|_, _| {}, || {})
                .await
                .map_err(|e| format!("Failed to download and install update: {e}"))?;
            Ok(())
        }
        None => Err("No pending update to install".to_string()),
    }
}

/// Show a system notification that an update is ready to install.
#[tauri::command]
async fn show_update_notification(app: AppHandle, version: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title("Endara Desktop Update Ready")
        .body(format!(
            "Version {} is ready to install. Open Endara to restart.",
            version
        ))
        .show()
        .map_err(|e| format!("Failed to show notification: {e}"))
}

#[derive(Serialize)]
struct EndpointConfig {
    name: String,
    transport: String,
    tool_prefix: Option<String>,
    command: Option<String>,
    args: Option<Vec<String>>,
    url: Option<String>,
    description: Option<String>,
    env: Option<HashMap<String, String>>,
    headers: Option<HashMap<String, String>>,
    oauth_server_url: Option<String>,
    client_id: Option<String>,
    /// True iff a client secret is stored for this endpoint (in the DCR file
    /// or — for legacy entries — in `config.toml`). The secret value itself is
    /// never returned to the UI; the field is masked write-only.
    client_secret_set: bool,
    scopes: Option<String>,
    token_endpoint: Option<String>,
    /// Mirrors `server_type_override` from `config.toml`; absent when no
    /// override is configured for this endpoint.
    server_type_override: Option<String>,
}

/// Path to the DCR credentials file for an endpoint, e.g.
/// `~/.endara/tokens/{name}.dcr.json`. Mirrors the relay's `TokenManager`
/// layout so we can answer "is a client secret stored?" without a relay
/// round-trip.
fn dcr_file_path(name: &str) -> Result<std::path::PathBuf, String> {
    Ok(data_dir()?.join("tokens").join(format!("{name}.dcr.json")))
}

#[tauri::command]
async fn get_endpoint_config(name: String) -> Result<EndpointConfig, String> {
    let parsed = read_config()?;

    if let Some(toml::Value::Array(endpoints)) = parsed.get("endpoints") {
        for ep in endpoints {
            if ep.get("name").and_then(|v| v.as_str()) == Some(&name) {
                let transport = ep
                    .get("transport")
                    .and_then(|v| v.as_str())
                    .unwrap_or("stdio")
                    .to_string();
                let command = ep
                    .get("command")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let args = ep.get("args").and_then(|v| v.as_array()).map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                });
                let url = ep
                    .get("url")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let tool_prefix = ep
                    .get("tool_prefix")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let description = ep
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let env = ep.get("env").and_then(|v| v.as_table()).map(|t| {
                    t.iter()
                        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
                        .collect()
                });
                let headers = ep.get("headers").and_then(|v| v.as_table()).map(|t| {
                    t.iter()
                        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
                        .collect()
                });
                let oauth_server_url = ep
                    .get("oauth_server_url")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let client_id = ep
                    .get("client_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                // The secret value is never returned to the UI. We only
                // expose whether one is stored — true if a DCR file exists
                // for this endpoint or, for legacy entries, if `config.toml`
                // still has a `client_secret` field.
                let legacy_toml_secret = ep
                    .get("client_secret")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .filter(|s| !s.is_empty());
                let dcr_exists = dcr_file_path(&name).map(|p| p.exists()).unwrap_or(false);
                let client_secret_set = dcr_exists || legacy_toml_secret.is_some();
                let scopes = ep.get("scopes").and_then(|v| v.as_array()).map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str())
                        .collect::<Vec<_>>()
                        .join(" ")
                });
                let token_endpoint = ep
                    .get("token_endpoint")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let server_type_override = ep
                    .get("server_type_override")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .filter(|s| !s.is_empty());

                return Ok(EndpointConfig {
                    name: name.clone(),
                    transport,
                    tool_prefix,
                    command,
                    args,
                    url,
                    description,
                    env,
                    headers,
                    oauth_server_url,
                    client_id,
                    client_secret_set,
                    scopes,
                    token_endpoint,
                    server_type_override,
                });
            }
        }
    }

    Err(format!("Endpoint '{}' not found", name))
}

#[tauri::command]
async fn remove_endpoint(name: String) -> Result<(), String> {
    let mut parsed = read_config()?;

    if let Some(toml::Value::Array(endpoints)) = parsed.get_mut("endpoints") {
        let original_len = endpoints.len();
        endpoints.retain(|ep| {
            ep.get("name")
                .and_then(|v| v.as_str())
                .map(|n| n != name)
                .unwrap_or(true)
        });
        if endpoints.len() == original_len {
            return Err(format!("Endpoint '{}' not found", name));
        }
    } else {
        return Err(format!("Endpoint '{}' not found", name));
    }

    write_config(&parsed)
}

/// Check if autostart is enabled.
#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch()
        .is_enabled()
        .map_err(|e| format!("Failed to check autostart: {e}"))
}

/// Enable or disable autostart.
#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        manager
            .enable()
            .map_err(|e| format!("Failed to enable autostart: {e}"))
    } else {
        manager
            .disable()
            .map_err(|e| format!("Failed to disable autostart: {e}"))
    }
}

/// Check if app was started with the autostart flag.
fn is_autostarted() -> bool {
    std::env::args().any(|arg| arg == "--autostarted")
}

/// Tauri-managed wrapper around the tray menu's first item ("status"). The
/// inner `MenuItem` already handles main-thread dispatch internally and is
/// `Send + Sync` (it's an `Arc<Inner>`), so no extra mutex is needed.
/// Hardcoded to `tauri::Wry` because the default runtime is the only one in
/// use for this app.
pub struct TrayStatusItem(pub tauri::menu::MenuItem<tauri::Wry>);

/// Compose the tray menu label for a given health `state` and optional
/// frontend-provided `detail`. When `detail` is present it is rendered as
/// `"Endara — {detail}"`; otherwise we fall back to the per-state defaults.
fn compose_tray_menu_label(state: &str, detail: Option<&str>) -> String {
    if let Some(d) = detail.map(str::trim).filter(|s| !s.is_empty()) {
        return format!("Endara — {d}");
    }
    match state {
        "healthy" => "Endara — Running".to_string(),
        "degraded" => "Endara — Issue detected".to_string(),
        "down" => "Endara — Relay not running".to_string(),
        _ => "Endara".to_string(),
    }
}

/// Compose the tray tooltip for a given health `state` and optional
/// frontend-provided `detail`. When `detail` is present it is rendered as
/// `"Endara Relay — {detail}"`; otherwise we fall back to the per-state
/// defaults from spec §5.
fn compose_tray_tooltip(state: &str, detail: Option<&str>) -> String {
    if let Some(d) = detail.map(str::trim).filter(|s| !s.is_empty()) {
        return format!("Endara Relay — {d}");
    }
    match state {
        "healthy" => "Endara Relay — all systems healthy".to_string(),
        "degraded" => "Endara Relay — some endpoints need attention".to_string(),
        "down" => "Endara Relay — relay is not running".to_string(),
        _ => "Endara Relay".to_string(),
    }
}

/// Update the tray icon, tooltip, and status menu item to reflect the latest
/// aggregated health state computed on the frontend. Unknown `state` values
/// fall back to the monochrome template icon so the menu bar stays in a
/// sensible default. `detail` is an optional short description (≤ ~50 chars)
/// supplied by the frontend so the menu line and tooltip surface the specific
/// problem instead of a generic per-state label.
#[tauri::command]
fn set_tray_health(app: AppHandle, state: &str, detail: Option<String>) {
    let Some(icons) = app.try_state::<tray::TrayIcons>() else {
        log::warn!("[tray] set_tray_health called before TrayIcons state is managed");
        return;
    };
    let (icon_data, is_template) = match state {
        "healthy" => (&icons.healthy, false),
        "degraded" => (&icons.degraded, false),
        "down" => (&icons.down, false),
        _ => (&icons.base, true),
    };
    let detail_ref = detail.as_deref();
    let tooltip = compose_tray_tooltip(state, detail_ref);
    let menu_label = compose_tray_menu_label(state, detail_ref);
    let Some(tray_icon) = app.tray_by_id("main") else {
        log::warn!("[tray] set_tray_health: main tray icon not found");
        return;
    };
    match tauri::image::Image::from_bytes(icon_data) {
        Ok(image) => {
            if let Err(e) = tray_icon.set_icon(Some(image)) {
                log::warn!("[tray] failed to set tray icon state={state} error={e}");
            }
        }
        Err(e) => {
            log::warn!("[tray] failed to decode tray icon state={state} error={e}");
        }
    }
    if let Err(e) = tray_icon.set_icon_as_template(is_template) {
        log::warn!("[tray] failed to set icon_as_template state={state} error={e}");
    }
    if let Err(e) = tray_icon.set_tooltip(Some(&tooltip)) {
        log::warn!("[tray] failed to set tooltip state={state} error={e}");
    }
    if let Some(status_item) = app.try_state::<TrayStatusItem>() {
        if let Err(e) = status_item.0.set_text(&menu_label) {
            log::warn!("[tray] failed to set status menu label state={state} error={e}");
        }
    } else {
        log::warn!("[tray] set_tray_health called before TrayStatusItem state is managed");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Capture `config.toml` existence BEFORE any code path (read_config,
    // read_port_from_config, the relay sidecar spawn) has had a chance to
    // touch the file. The overlay migration helper in Phase 5 uses this to
    // distinguish a fresh install (file did not exist → overlay defaults to
    // enabled) from an upgrading install (file existed → overlay defaults to
    // disabled). Falls back to `false` (fresh-install semantics) when
    // `config_path()` cannot be resolved.
    let overlay_file_existed_before = config_path().map(|p| p.exists()).unwrap_or(false);

    let default_port = if is_dev_mode() {
        DEV_RELAY_PORT
    } else {
        DEFAULT_RELAY_PORT
    };
    let relay_state = RelayState {
        child: Arc::new(Mutex::new(None)),
        pid: Arc::new(std::sync::Mutex::new(None)),
        running: Arc::new(Mutex::new(false)),
        port: Arc::new(Mutex::new(read_port_from_config().unwrap_or(default_port))),
        last_sidecar_status: Arc::new(Mutex::new("unknown".to_string())),
        last_sidecar_error: Arc::new(Mutex::new(None)),
        log_buffer: Arc::new(Mutex::new(Vec::new())),
        watchdog: Arc::new(std::sync::Mutex::new(None)),
        intentional_stop: Arc::new(AtomicBool::new(false)),
        restart_pending: Arc::new(std::sync::Mutex::new(None)),
        restart_policy: Arc::new(std::sync::Mutex::new(RelayRestartPolicy::default())),
        last_spawn_at: Arc::new(std::sync::Mutex::new(None)),
    };

    let child_handle = relay_state.child.clone();
    let pid_handle = relay_state.pid.clone();
    let watchdog_handle = relay_state.watchdog.clone();
    let intentional_stop_handle = relay_state.intentional_stop.clone();
    let restart_pending_handle = relay_state.restart_pending.clone();

    let pending_update = PendingUpdate(std::sync::Mutex::new(None));

    let version = option_env!("BUILD_VERSION")
        .unwrap_or(env!("CARGO_PKG_VERSION"))
        .to_string();
    let commit = env!("DESKTOP_COMMIT").to_string();
    let channel = read_update_channel();
    let autostarted = is_autostarted();
    let dev = is_dev_mode();

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([
                    Target::new(TargetKind::LogDir { file_name: None }),
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::Webview),
                ])
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .max_file_size(5 * 1024 * 1024)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin({
            let builder = tauri_plugin_autostart::Builder::new().args(["--autostarted"]);
            #[cfg(target_os = "macos")]
            let builder =
                builder.macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent);
            builder.build()
        })
        .plugin(tauri_plugin_notification::init())
        .manage(relay_state)
        .manage(pending_update)
        .manage(UpdaterBackoffState::default())
        .manage(overlay::OverlaySubscriberState::default())
        .invoke_handler(tauri::generate_handler![
            start_relay,
            stop_relay,
            restart_relay,
            relay_status,
            get_sidecar_status,
            get_build_info,
            remove_endpoint,
            get_endpoint_config,
            get_relay_port,
            set_relay_port,
            mgmt_api_request,
            get_mgmt_api_socket_path,
            get_js_execution_mode,
            set_js_execution_mode,
            get_toon_output,
            set_toon_output,
            get_config_path_display,
            get_buffered_relay_logs,
            get_update_channel,
            set_update_channel,
            check_for_update,
            download_and_install_update,
            show_update_notification,
            get_autostart,
            set_autostart,
            set_tray_health,
            show_overlay,
            hide_overlay,
            set_overlay_ignore_cursor_events,
            reposition_overlay,
            subscribe_tool_call_events,
            unsubscribe_tool_call_events,
            get_overlay_settings,
            set_overlay_settings,
            focus_main_window_on_log,
        ])
        .setup(move |app| {
            log::info!(
                "desktop starting version={} commit={} channel={} autostarted={} is_dev={}",
                version,
                commit,
                channel,
                autostarted,
                dev
            );

            // Resolve the overlay's persisted settings BEFORE building the
            // tray menu so the "Show MCP activity overlay" checkbox starts
            // in the right state. `overlay_file_existed_before` was
            // captured at the very top of `run()` before any other code
            // path could touch `config.toml`.
            let overlay_cfg = match config_path() {
                Ok(cfg_path) => overlay::ensure_overlay_default(
                    &cfg_path,
                    overlay_file_existed_before,
                )
                .unwrap_or_else(|e| {
                    log::warn!("[overlay] migration helper failed error={e}; using defaults");
                    overlay::OverlaySettings::default()
                }),
                Err(e) => {
                    log::warn!("[overlay] config_path unresolved error={e}; using defaults");
                    overlay::OverlaySettings::default()
                }
            };
            log::info!(
                "[overlay] resolved settings enabled={} position={} auto_dismiss_ms={} max_visible={} show_profile={}",
                overlay_cfg.enabled,
                overlay_cfg.position.as_str(),
                overlay_cfg.auto_dismiss_ms,
                overlay_cfg.max_visible,
                overlay_cfg.show_profile,
            );

            // Build tray menu
            let status_item =
                MenuItem::with_id(app, "status", "Endara — Running", false, None::<&str>)?;
            let open_item = MenuItem::with_id(app, "open", "Open Endara", true, None::<&str>)?;
            let overlay_toggle_item = CheckMenuItem::with_id(
                app,
                "toggle_overlay",
                "Show MCP activity overlay",
                true,
                tray_overlay_checked_for(&overlay_cfg),
                None::<&str>,
            )?;
            let update_item =
                MenuItem::with_id(app, "check_update", "Check for Updates", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            let menu = Menu::with_items(
                app,
                &[
                    &status_item,
                    &open_item,
                    &overlay_toggle_item,
                    &update_item,
                    &quit_item,
                ],
            )?;

            // Register the tray toggle as managed state so
            // `apply_overlay_settings` can update its checked state directly
            // without an event-bus round-trip. Both the Settings UI command
            // path and the tray-click path call `apply_overlay_settings`,
            // so this single registration keeps both surfaces in sync.
            app.manage(TrayOverlayToggle(overlay_toggle_item.clone()));

            // Stash the status menu item as managed state so `set_tray_health`
            // can update its label when the frontend reports a new health
            // detail (e.g. "Endara — Sign in required for github-mcp").
            app.manage(TrayStatusItem(status_item.clone()));

            // Pre-build the colored tray-icon variants from the base template
            // and stash them as managed state so `set_tray_health` can swap
            // them on demand without redoing the PNG decode/encode work.
            const TRAY_ICON_TEMPLATE: &[u8] = include_bytes!("../icons/tray-icon-template.png");
            app.manage(tray::build_tray_icons(TRAY_ICON_TEMPLATE));

            let _tray = TrayIconBuilder::with_id("main")
                .icon(tauri::image::Image::from_bytes(TRAY_ICON_TEMPLATE)?)
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        log::info!("tray menu action=open");
                        // Show in Cmd-Tab and Dock
                        #[cfg(target_os = "macos")]
                        set_macos_activation_policy(true);
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "toggle_overlay" => {
                        // Flip `enabled` against the current persisted value
                        // and route through `apply_overlay_settings` so the
                        // tray and Settings UI take the same code path.
                        let prev = read_overlay_settings_from_config();
                        let next = overlay::OverlaySettings {
                            enabled: !prev.enabled,
                            ..prev.clone()
                        };
                        log::info!(
                            "tray menu action=toggle_overlay from={} to={}",
                            prev.enabled,
                            next.enabled
                        );
                        let app_handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let state =
                                app_handle.state::<overlay::OverlaySubscriberState>();
                            if let Err(e) =
                                apply_overlay_settings(&app_handle, &state, &prev, &next).await
                            {
                                log::warn!(
                                    "[overlay] tray toggle apply failed error={}",
                                    e
                                );
                            }
                        });
                    }
                    "check_update" => {
                        log::info!("tray menu action=check_update");
                        let _ = app.emit("check-for-update", ());
                        // Show in Cmd-Tab and Dock
                        #[cfg(target_os = "macos")]
                        set_macos_activation_policy(true);
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        log::info!("tray menu action=quit");
                        // Kill relay sidecar before exiting
                        if let Some(state) = app.try_state::<RelayState>() {
                            // Mark the impending kill as intentional and cancel
                            // any pending auto-restart so the supervisor does
                            // not respawn the sidecar mid-shutdown.
                            state.intentional_stop.store(true, Ordering::Release);
                            abort_pending_restart(&state);
                            // Stop the watchdog so it does not race shutdown.
                            stop_watchdog(&state);
                            // Kill by PID first (synchronous, reliable)
                            if let Ok(mut pid_guard) = state.pid.lock() {
                                if let Some(pid) = pid_guard.take() {
                                    log::info!(
                                        "[relay] killing sidecar pid={} reason=tray_quit",
                                        pid
                                    );
                                    #[cfg(unix)]
                                    unsafe {
                                        libc::kill(pid as i32, libc::SIGTERM);
                                    }
                                }
                            }
                            // Also kill via child handle as fallback
                            let child_handle = state.child.clone();
                            tauri::async_runtime::block_on(async {
                                let mut guard = child_handle.lock().await;
                                if let Some(child) = guard.take() {
                                    let _ = child.kill();
                                }
                            });
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // Spawn the relay sidecar on startup
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let port = if let Some(state) = app_handle.try_state::<RelayState>() {
                    *state.port.lock().await
                } else if is_dev_mode() {
                    DEV_RELAY_PORT
                } else {
                    DEFAULT_RELAY_PORT
                };
                match spawn_relay(&app_handle, port).await {
                    Ok(child) => {
                        let pid = child.pid();
                        if let Some(state) = app_handle.try_state::<RelayState>() {
                            if let Ok(mut pid_guard) = state.pid.lock() {
                                *pid_guard = Some(pid);
                            }
                            *state.child.lock().await = Some(child);
                            *state.running.lock().await = true;
                        }
                        log::info!("[relay] sidecar started pid={} port={}", pid, port);
                    }
                    Err(e) => {
                        log::error!("[relay] failed to start sidecar on launch error={e}");
                    }
                }
            });

            // Install the WKWebView crash-recovery hook on the main window so
            // a killed web-content process triggers an automatic reload
            // instead of leaving the window blank. No-op on non-macOS.
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = webview_recovery::install(&window, app.handle().clone()) {
                    log::warn!(
                        "[webview] failed to install crash-recovery hook error={}",
                        e
                    );
                }
            } else {
                log::warn!("[webview] main window missing at setup; crash-recovery not installed");
            }

            if overlay_cfg.enabled {
                match overlay::build_overlay_window(app.handle(), &overlay_cfg) {
                    Ok(_) => log::info!(
                        "[overlay] window built label=overlay position={}",
                        overlay_cfg.position.as_str()
                    ),
                    Err(e) => log::warn!("[overlay] failed to build overlay window error={e}"),
                }
            }

            // Handle autostarted launch: hide window and set accessory mode
            if is_autostarted() {
                log::info!("autostart hide window=main accessory_mode=true");
                // Hide the window when auto-launched
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
                // Set accessory mode (no Dock icon, no Cmd-Tab)
                #[cfg(target_os = "macos")]
                set_macos_activation_policy(false);
            } else {
                // Normal launch: ensure app appears in Cmd-Tab on startup
                #[cfg(target_os = "macos")]
                set_macos_activation_policy(true);
            }

            log::info!("setup complete");

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // The overlay window is owned by the app lifecycle (toggled
                // via the Settings tray); close-requested on it (e.g. via
                // dev-tools) is a no-op rather than the "hide main + drop
                // activation policy" path the main window uses.
                if window.label() == overlay::OVERLAY_WINDOW_LABEL {
                    log::info!(
                        "window close requested label={} action=prevented",
                        window.label()
                    );
                    api.prevent_close();
                    return;
                }
                log::info!(
                    "window close requested label={} action=prevented_and_hidden",
                    window.label()
                );
                // Prevent the window from being destroyed — hide it instead
                api.prevent_close();
                let _ = window.hide();
                // Hide from Cmd-Tab and Dock, keep in menu bar tray
                #[cfg(target_os = "macos")]
                set_macos_activation_policy(false);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app, event| {
            if let RunEvent::Exit = event {
                log::info!("app exit");
                // Suppress any in-flight supervisor logic so the upcoming SIGTERM
                // is treated as an intentional shutdown, then abort a pending
                // auto-restart task if one is sleeping out its backoff window.
                intentional_stop_handle.store(true, Ordering::Release);
                if let Ok(mut guard) = restart_pending_handle.lock() {
                    if let Some(handle) = guard.take() {
                        handle.abort();
                    }
                }
                // Abort the watchdog before tearing down the relay so it does
                // not log spurious "unhealthy" transitions while we shut down.
                if let Ok(mut guard) = watchdog_handle.lock() {
                    if let Some(handle) = guard.take() {
                        handle.abort();
                    }
                }
                // Kill relay by PID — no async runtime needed, avoids block_on deadlock
                if let Ok(mut guard) = pid_handle.try_lock() {
                    if let Some(pid) = guard.take() {
                        log::info!("[relay] killing sidecar pid={} reason=app_exit", pid);
                        #[cfg(unix)]
                        unsafe {
                            libc::kill(pid as i32, libc::SIGTERM);
                        }
                    }
                }
                // Also try the async child.kill() as fallback, in a separate thread
                // to avoid deadlocking on the tokio runtime during shutdown.
                let child_handle = child_handle.clone();
                let _ = std::thread::spawn(move || {
                    if let Ok(rt) = tokio::runtime::Runtime::new() {
                        rt.block_on(async {
                            let mut guard = child_handle.lock().await;
                            if let Some(child) = guard.take() {
                                let _ = child.kill();
                            }
                        });
                    }
                })
                .join();
            }
        });
}

#[cfg(test)]
mod relay_restart_policy_tests {
    use super::*;

    #[test]
    fn backoff_schedule_doubles_then_caps() {
        assert_eq!(relay_restart_backoff_secs(0), 0);
        assert_eq!(relay_restart_backoff_secs(1), 1);
        assert_eq!(relay_restart_backoff_secs(2), 2);
        assert_eq!(relay_restart_backoff_secs(3), 4);
        assert_eq!(relay_restart_backoff_secs(4), 8);
        assert_eq!(relay_restart_backoff_secs(5), 16);
        // Once 2^(n-1) exceeds RELAY_RESTART_MAX_SECS the value clamps.
        assert_eq!(relay_restart_backoff_secs(6), RELAY_RESTART_MAX_SECS);
        assert_eq!(relay_restart_backoff_secs(20), RELAY_RESTART_MAX_SECS);
        // Large exponents must not overflow the saturating shift.
        assert_eq!(relay_restart_backoff_secs(1000), RELAY_RESTART_MAX_SECS);
    }

    #[test]
    fn intentional_stop_suppresses_and_resets_counter() {
        let mut policy = RelayRestartPolicy::default();
        // Burn one failed attempt to verify suppression also clears state.
        let _ = policy.on_termination(false, 0);
        let decision = policy.on_termination(true, 0);
        assert_eq!(decision, RelayRestartDecision::Suppress);
        // The next unexpected termination must start from attempt=1 again.
        let next = policy.on_termination(false, 0);
        assert!(matches!(
            next,
            RelayRestartDecision::Restart { attempt: 1, .. }
        ));
    }

    #[test]
    fn healthy_uptime_resets_attempt_counter() {
        let mut policy = RelayRestartPolicy::default();
        // Three rapid failures bring the counter to 3.
        for expected in 1..=3 {
            match policy.on_termination(false, 0) {
                RelayRestartDecision::Restart { attempt, .. } => assert_eq!(attempt, expected),
                other => panic!("expected Restart, got {:?}", other),
            }
        }
        // A failure after >= RELAY_RESTART_HEALTHY_RESET_SECS uptime resets first,
        // so this counts as attempt=1.
        match policy.on_termination(false, RELAY_RESTART_HEALTHY_RESET_SECS) {
            RelayRestartDecision::Restart {
                attempt,
                delay_secs,
                max,
            } => {
                assert_eq!(attempt, 1);
                assert_eq!(delay_secs, 1);
                assert_eq!(max, RELAY_RESTART_MAX_ATTEMPTS);
            }
            other => panic!("expected Restart, got {:?}", other),
        }
    }

    #[test]
    fn give_up_after_max_attempts_then_reset_allows_fresh_window() {
        let mut policy = RelayRestartPolicy::default();
        for expected in 1..=RELAY_RESTART_MAX_ATTEMPTS {
            match policy.on_termination(false, 0) {
                RelayRestartDecision::Restart { attempt, max, .. } => {
                    assert_eq!(attempt, expected);
                    assert_eq!(max, RELAY_RESTART_MAX_ATTEMPTS);
                }
                other => panic!("expected Restart at attempt {}, got {:?}", expected, other),
            }
        }
        // One more crash inside the unhealthy window must trip the cap.
        assert_eq!(
            policy.on_termination(false, 0),
            RelayRestartDecision::GiveUp {
                max: RELAY_RESTART_MAX_ATTEMPTS,
            }
        );
        // After GiveUp the counter is cleared so a manual restart (which calls
        // reset()) followed by a fresh crash starts at attempt=1.
        policy.reset();
        match policy.on_termination(false, 0) {
            RelayRestartDecision::Restart { attempt, .. } => assert_eq!(attempt, 1),
            other => panic!("expected Restart, got {:?}", other),
        }
    }

    #[test]
    fn give_up_then_reset_arms_fresh_restart_window() {
        let mut policy = RelayRestartPolicy::default();
        // Burn through the full restart budget; the (max+1)-th failure must
        // trip the cap and return GiveUp.
        for _ in 0..RELAY_RESTART_MAX_ATTEMPTS {
            match policy.on_termination(false, 0) {
                RelayRestartDecision::Restart { .. } => {}
                other => panic!("expected Restart, got {:?}", other),
            }
        }
        assert_eq!(
            policy.on_termination(false, 0),
            RelayRestartDecision::GiveUp {
                max: RELAY_RESTART_MAX_ATTEMPTS,
            }
        );
        // Simulate the user clicking "Retry" — `restart_relay` resets the
        // policy before re-spawning. The next unintentional termination must
        // open a fresh restart window starting at attempt=1 with the base
        // backoff and the canonical max attempts.
        policy.reset();
        assert_eq!(
            policy.on_termination(false, 0),
            RelayRestartDecision::Restart {
                attempt: 1,
                delay_secs: 1,
                max: RELAY_RESTART_MAX_ATTEMPTS,
            }
        );
    }

    #[test]
    fn delay_secs_matches_backoff_schedule() {
        let mut policy = RelayRestartPolicy::default();
        let expected_delays = [1u64, 2, 4, 8, 16];
        for expected in expected_delays {
            match policy.on_termination(false, 0) {
                RelayRestartDecision::Restart { delay_secs, .. } => {
                    assert_eq!(delay_secs, expected);
                }
                other => panic!("expected Restart, got {:?}", other),
            }
        }
    }
}

#[cfg(test)]
mod dev_mode_tests {
    use super::*;
    use serial_test::serial;

    /// RAII guard that snapshots and unsets `ENDARA_DATA_DIR` on construction
    /// and restores the prior value on drop, so tests cannot leak env state
    /// into each other even on panic. Tests using this guard must also carry
    /// `#[serial_test::serial]` to prevent cross-thread interference.
    struct EnvGuard {
        prior: Option<String>,
    }

    impl EnvGuard {
        fn new() -> Self {
            let prior = std::env::var("ENDARA_DATA_DIR").ok();
            std::env::remove_var("ENDARA_DATA_DIR");
            Self { prior }
        }

        fn set(&self, value: &str) {
            std::env::set_var("ENDARA_DATA_DIR", value);
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.prior {
                Some(v) => std::env::set_var("ENDARA_DATA_DIR", v),
                None => std::env::remove_var("ENDARA_DATA_DIR"),
            }
        }
    }

    #[test]
    #[serial]
    fn is_dev_mode_respects_env_var() {
        let guard = EnvGuard::new();
        guard.set("/tmp/foo");
        assert!(is_dev_mode(), "ENDARA_DATA_DIR set => dev mode");

        // After unsetting, `is_dev_mode` still reports true under `cargo test`
        // because `cfg!(debug_assertions)` is on in test builds. The env-var
        // branch is therefore the only one we can flip deterministically.
        std::env::remove_var("ENDARA_DATA_DIR");
        assert!(is_dev_mode(), "debug_assertions keeps dev mode on in tests");
    }

    #[test]
    #[serial]
    fn data_dir_dev_vs_prod() {
        let guard = EnvGuard::new();
        guard.set("/tmp/foo");
        let dir = data_dir().expect("data_dir should succeed with HOME set");
        assert!(
            dir.ends_with(DEV_DATA_DIR_NAME),
            "dev data_dir should end with {DEV_DATA_DIR_NAME}, got {dir:?}"
        );
        // Prod-mode branch can't be covered here because `cfg!(debug_assertions)`
        // forces `is_dev_mode()` to return true under `cargo test`.
    }

    #[test]
    #[serial]
    fn config_path_joins_data_dir() {
        let _guard = EnvGuard::new();
        let cfg = config_path().expect("config_path should succeed");
        let base = data_dir().expect("data_dir should succeed");
        assert_eq!(cfg, base.join("config.toml"));
    }

    #[test]
    fn build_sidecar_args_dev_vs_prod() {
        // Both branches must end with `--log-format text` so the relay's
        // tracing layer emits the inline span shape the desktop parsers
        // (`parse_endpoint_from_span` + the front-end `SPAN_RE`) expect.
        // Without it the relay's compact-format default would hide span
        // fields at the end of the line and the Logs view's Endpoint
        // column would render `---` for every row.
        let dev = build_sidecar_args(true, "/tmp/dev", "/tmp/dev/config.toml", "9500");
        assert_eq!(
            dev,
            vec![
                "start",
                "--data-dir",
                "/tmp/dev",
                "--port",
                "9500",
                "--log-format",
                "text",
            ]
        );

        let prod = build_sidecar_args(false, "/tmp/dev", "/tmp/prod/config.toml", "9400");
        assert_eq!(
            prod,
            vec![
                "start",
                "--config",
                "/tmp/prod/config.toml",
                "--port",
                "9400",
                "--log-format",
                "text",
            ]
        );
    }
}

#[cfg(test)]
mod updater_backoff_tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn updater_backoff_window_grows_then_caps() {
        // Exponential schedule: 1m, 2m, 4m, 8m, 16m, then capped at 30m.
        assert_eq!(backoff_window_secs(0), 0);
        assert_eq!(backoff_window_secs(1), 60);
        assert_eq!(backoff_window_secs(2), 120);
        assert_eq!(backoff_window_secs(3), 240);
        assert_eq!(backoff_window_secs(4), 480);
        assert_eq!(backoff_window_secs(5), 960);
        assert_eq!(backoff_window_secs(6), UPDATER_BACKOFF_MAX_SECS);
        // Saturates rather than overflowing for absurdly large counts.
        assert_eq!(backoff_window_secs(100), UPDATER_BACKOFF_MAX_SECS);
        assert_eq!(backoff_window_secs(u32::MAX), UPDATER_BACKOFF_MAX_SECS);
    }

    #[test]
    fn updater_backoff_no_failures_allows_check() {
        let b = UpdaterBackoff::default();
        assert!(b.next_retry_after_secs(Instant::now()).is_none());
    }

    #[test]
    fn updater_backoff_record_failure_advances_retry() {
        let mut b = UpdaterBackoff::default();
        let now = Instant::now();

        b.record_failure(now);
        let first = b
            .next_retry_after_secs(now)
            .expect("first failure should produce a backoff window");
        assert!(first > 0 && first <= 60, "first window should be <= 60s");

        // A second failure should produce a strictly larger window than the first.
        b.record_failure(now);
        let second = b
            .next_retry_after_secs(now)
            .expect("second failure should still be in backoff");
        assert!(
            second > first,
            "second window ({second}s) must exceed first ({first}s)"
        );
    }

    #[test]
    fn updater_backoff_clears_after_window_passes() {
        let mut b = UpdaterBackoff::default();
        let now = Instant::now();
        b.record_failure(now);

        // Once the configured window elapses, the gate opens again.
        let later = now + Duration::from_secs(UPDATER_BACKOFF_BASE_SECS + 1);
        assert!(b.next_retry_after_secs(later).is_none());
    }

    #[test]
    fn updater_backoff_record_success_resets() {
        let mut b = UpdaterBackoff::default();
        let now = Instant::now();
        b.record_failure(now);
        b.record_failure(now);
        assert!(b.next_retry_after_secs(now).is_some());

        b.record_success();
        assert_eq!(b.consecutive_failures, 0);
        assert!(b.last_failure.is_none());
        assert!(b.next_retry_after_secs(now).is_none());
    }

    #[test]
    fn updater_backoff_sanitize_strips_newlines_and_truncates() {
        let body = "line1\nline2\r\nline3\twith\ttabs";
        let cleaned = sanitize_body_excerpt(body);
        assert!(!cleaned.contains('\n'));
        assert!(!cleaned.contains('\r'));
        assert!(!cleaned.contains('\t'));
        assert_eq!(cleaned, "line1 line2  line3 with tabs");

        let long = "x".repeat(UPDATER_BODY_EXCERPT_BYTES + 100);
        let cleaned_long = sanitize_body_excerpt(&long);
        assert_eq!(cleaned_long.len(), UPDATER_BODY_EXCERPT_BYTES);
    }
}

#[cfg(test)]
mod reqwest_tls_provider_tests {
    /// Regression: the desktop's `reqwest` dependency must be configured with a
    /// rustls feature that installs a default crypto provider. A previous attempt
    /// used `rustls-no-provider`, which caused a panic at
    /// `reqwest::async_impl::client::default_rustls_crypto_provider` ("No provider
    /// set") the first time `reqwest::Client::builder().build()` was called —
    /// triggered transitively by `tauri-plugin-updater` during macOS
    /// `did_finish_launching`, before any window painted.
    ///
    /// Building a default client exercises the same TLS connector setup path
    /// that panicked. With a provider installed (e.g. `rustls` or
    /// `rustls-tls` feature) this completes without panic; with
    /// `rustls-no-provider` and no caller-installed provider it would panic
    /// inside `Client::builder().build()`.
    #[test]
    fn reqwest_client_has_tls_provider_installed() {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(50))
            .build()
            .expect("reqwest client builds without panicking on TLS provider setup");
        // Touch the client so the optimizer cannot drop the build call.
        let _ = format!("{client:?}");
    }
}

#[cfg(test)]
mod relay_watchdog_tests {
    use super::*;

    fn unhealthy(reason: &str) -> HealthState {
        HealthState::Unhealthy {
            reason: reason.to_string(),
        }
    }

    #[test]
    fn first_healthy_observation_emits_became_healthy() {
        let event = detect_health_transition(&HealthState::Unknown, &HealthState::Healthy);
        assert_eq!(event, Some(HealthTransition::BecameHealthy));
    }

    #[test]
    fn first_unhealthy_observation_emits_became_unhealthy_with_reason() {
        let event =
            detect_health_transition(&HealthState::Unknown, &unhealthy("transport error: x"));
        assert_eq!(
            event,
            Some(HealthTransition::BecameUnhealthy {
                reason: "transport error: x".to_string(),
            })
        );
    }

    #[test]
    fn healthy_to_healthy_is_silent() {
        // The whole point: every successful probe must NOT spam events.
        let event = detect_health_transition(&HealthState::Healthy, &HealthState::Healthy);
        assert!(event.is_none());
    }

    #[test]
    fn unhealthy_to_unhealthy_is_silent_even_with_changed_reason() {
        // Stay-unhealthy is silent so a flapping reason string does not generate noise.
        let event = detect_health_transition(&unhealthy("non-2xx: 503"), &unhealthy("parse error"));
        assert!(event.is_none());
    }

    #[test]
    fn healthy_to_unhealthy_emits_with_reason() {
        let event = detect_health_transition(&HealthState::Healthy, &unhealthy("non-2xx: 500"));
        assert_eq!(
            event,
            Some(HealthTransition::BecameUnhealthy {
                reason: "non-2xx: 500".to_string(),
            })
        );
    }

    #[test]
    fn unhealthy_to_healthy_emits_recovered() {
        let event =
            detect_health_transition(&unhealthy("transport error: x"), &HealthState::Healthy);
        assert_eq!(event, Some(HealthTransition::BecameHealthy));
    }

    #[test]
    fn current_unknown_never_emits() {
        // Defensive: a probe should never return Unknown, but if it did we
        // must not invent a transition for it in either direction.
        assert!(detect_health_transition(&HealthState::Unknown, &HealthState::Unknown).is_none());
        assert!(detect_health_transition(&HealthState::Healthy, &HealthState::Unknown).is_none());
        assert!(detect_health_transition(&unhealthy("x"), &HealthState::Unknown).is_none());
    }
}

#[cfg(test)]
mod js_execution_mode_tests {
    //! Round-trip coverage for `read_js_execution_mode` and
    //! `set_js_execution_mode`. Each test pins `$HOME` to a fresh
    //! `tempfile::TempDir` so the Tauri commands write into an isolated
    //! `~/.endara-dev/config.toml`. Tests are `serial` because env-var
    //! manipulation is process-global.
    use super::*;
    use serial_test::serial;
    use tempfile::TempDir;

    /// Snapshots `$HOME` on construction and restores it on drop so tests
    /// cannot leak the override into each other even on panic.
    struct HomeGuard {
        prior: Option<String>,
        _tmp: TempDir,
    }

    impl HomeGuard {
        fn new() -> Self {
            let prior = std::env::var("HOME").ok();
            let tmp = tempfile::tempdir().expect("create tempdir");
            std::env::set_var("HOME", tmp.path());
            Self { prior, _tmp: tmp }
        }
    }

    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match &self.prior {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
        }
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build tokio runtime")
    }

    fn write_config_str(contents: &str) {
        let path = config_path().expect("config_path");
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent dir");
        }
        std::fs::write(&path, contents).expect("write config.toml");
    }

    fn read_config_str() -> String {
        let path = config_path().expect("config_path");
        std::fs::read_to_string(&path).expect("read config.toml")
    }

    #[test]
    #[serial]
    fn get_js_execution_mode_returns_true_when_set() {
        let _home = HomeGuard::new();
        write_config_str("[relay]\nlocal_js_execution = true\nmachine_name = \"x\"\n");
        assert!(read_js_execution_mode());
    }

    #[test]
    #[serial]
    fn get_js_execution_mode_returns_false_when_unset() {
        let _home = HomeGuard::new();
        write_config_str("[relay]\nmachine_name = \"x\"\n");
        assert!(!read_js_execution_mode());
    }

    #[test]
    #[serial]
    fn get_js_execution_mode_returns_false_when_no_relay_section() {
        let _home = HomeGuard::new();
        write_config_str("[desktop]\nupdate_channel = \"stable\"\n");
        assert!(!read_js_execution_mode());
    }

    #[test]
    #[serial]
    fn get_js_execution_mode_returns_false_when_file_missing() {
        let _home = HomeGuard::new();
        // No config.toml written.
        assert!(!read_js_execution_mode());
    }

    #[test]
    #[serial]
    fn get_js_execution_mode_returns_false_when_file_malformed() {
        let _home = HomeGuard::new();
        write_config_str("not valid toml ====\n");
        assert!(!read_js_execution_mode());
    }

    #[test]
    #[serial]
    fn set_js_execution_mode_roundtrips() {
        let _home = HomeGuard::new();
        let rt = rt();
        write_config_str("[relay]\nmachine_name = \"x\"\n");

        rt.block_on(set_js_execution_mode(true)).expect("set true");
        assert!(read_js_execution_mode());

        rt.block_on(set_js_execution_mode(false))
            .expect("set false");
        assert!(!read_js_execution_mode());
    }

    #[test]
    #[serial]
    fn set_js_execution_mode_creates_missing_relay_section() {
        let _home = HomeGuard::new();
        let rt = rt();
        write_config_str("[desktop]\nupdate_channel = \"stable\"\n");

        rt.block_on(set_js_execution_mode(true))
            .expect("set_js_execution_mode should succeed");

        let toml_str = read_config_str();
        let parsed: toml::Table =
            toml::from_str(&toml_str).expect("re-parse config.toml as toml::Table");

        let relay = parsed
            .get("relay")
            .and_then(|v| v.as_table())
            .expect("[relay] section should exist");
        assert_eq!(
            relay.get("local_js_execution").and_then(|v| v.as_bool()),
            Some(true),
            "local_js_execution should be true"
        );
        let machine_name = relay
            .get("machine_name")
            .and_then(|v| v.as_str())
            .expect("machine_name should be set");
        assert!(
            !machine_name.is_empty(),
            "machine_name should be non-empty, got {machine_name:?}"
        );
    }

    #[test]
    #[serial]
    fn set_js_execution_mode_preserves_other_fields() {
        let _home = HomeGuard::new();
        let rt = rt();
        write_config_str(
            "[desktop]\n\
             update_channel = \"beta\"\n\
             \n\
             [relay]\n\
             machine_name = \"host\"\n\
             token_dir = \"/tmp/x\"\n\
             \n\
             [[endpoints]]\n\
             name = \"gmail-acct\"\n\
             transport = \"stdio\"\n\
             tool_prefix = \"gmail\"\n\
             command = \"echo\"\n\
             args = [\"hi\"]\n",
        );

        rt.block_on(set_js_execution_mode(true))
            .expect("set_js_execution_mode should succeed");

        let toml_str = read_config_str();
        let parsed: toml::Table =
            toml::from_str(&toml_str).expect("re-parse config.toml as toml::Table");

        let desktop = parsed
            .get("desktop")
            .and_then(|v| v.as_table())
            .expect("[desktop] preserved");
        assert_eq!(
            desktop.get("update_channel").and_then(|v| v.as_str()),
            Some("beta"),
            "update_channel should be preserved"
        );

        let relay = parsed
            .get("relay")
            .and_then(|v| v.as_table())
            .expect("[relay] preserved");
        assert_eq!(
            relay.get("machine_name").and_then(|v| v.as_str()),
            Some("host"),
            "machine_name should be preserved"
        );
        assert_eq!(
            relay.get("token_dir").and_then(|v| v.as_str()),
            Some("/tmp/x"),
            "token_dir should be preserved"
        );
        assert_eq!(
            relay.get("local_js_execution").and_then(|v| v.as_bool()),
            Some(true),
            "local_js_execution should be set to true"
        );

        let endpoints = parsed
            .get("endpoints")
            .and_then(|v| v.as_array())
            .expect("[[endpoints]] preserved");
        assert_eq!(endpoints.len(), 1, "endpoint count should be unchanged");
        let ep = endpoints[0].as_table().expect("endpoint is a table");
        assert_eq!(ep.get("name").and_then(|v| v.as_str()), Some("gmail-acct"));
        assert_eq!(ep.get("transport").and_then(|v| v.as_str()), Some("stdio"));
        assert_eq!(
            ep.get("tool_prefix").and_then(|v| v.as_str()),
            Some("gmail")
        );
        assert_eq!(ep.get("command").and_then(|v| v.as_str()), Some("echo"));
        let args = ep
            .get("args")
            .and_then(|v| v.as_array())
            .expect("args preserved");
        assert_eq!(args.len(), 1);
        assert_eq!(args[0].as_str(), Some("hi"));
    }
}

#[cfg(test)]
mod toon_output_tests {
    //! Round-trip coverage for `read_toon_output` and `set_toon_output`.
    //! Mirrors `js_execution_mode_tests` but pins the default to `true` to
    //! match the relay's own default — a missing field, missing section,
    //! missing file, or malformed file all resolve to `true`.
    use super::*;
    use serial_test::serial;
    use tempfile::TempDir;

    struct HomeGuard {
        prior: Option<String>,
        _tmp: TempDir,
    }

    impl HomeGuard {
        fn new() -> Self {
            let prior = std::env::var("HOME").ok();
            let tmp = tempfile::tempdir().expect("create tempdir");
            std::env::set_var("HOME", tmp.path());
            Self { prior, _tmp: tmp }
        }
    }

    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match &self.prior {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
        }
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build tokio runtime")
    }

    fn write_config_str(contents: &str) {
        let path = config_path().expect("config_path");
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent dir");
        }
        std::fs::write(&path, contents).expect("write config.toml");
    }

    fn read_config_str() -> String {
        let path = config_path().expect("config_path");
        std::fs::read_to_string(&path).expect("read config.toml")
    }

    #[test]
    #[serial]
    fn get_toon_output_returns_true_when_set() {
        let _home = HomeGuard::new();
        write_config_str("[relay]\ntoon_output = true\nmachine_name = \"x\"\n");
        assert!(read_toon_output());
    }

    #[test]
    #[serial]
    fn get_toon_output_returns_false_when_unset_explicitly() {
        let _home = HomeGuard::new();
        write_config_str("[relay]\ntoon_output = false\nmachine_name = \"x\"\n");
        assert!(!read_toon_output());
    }

    #[test]
    #[serial]
    fn get_toon_output_returns_true_when_field_missing() {
        let _home = HomeGuard::new();
        write_config_str("[relay]\nmachine_name = \"x\"\n");
        assert!(read_toon_output());
    }

    #[test]
    #[serial]
    fn get_toon_output_returns_true_when_no_relay_section() {
        let _home = HomeGuard::new();
        write_config_str("[desktop]\nupdate_channel = \"stable\"\n");
        assert!(read_toon_output());
    }

    #[test]
    #[serial]
    fn get_toon_output_returns_true_when_file_missing() {
        let _home = HomeGuard::new();
        // No config.toml written.
        assert!(read_toon_output());
    }

    #[test]
    #[serial]
    fn get_toon_output_returns_true_when_file_malformed() {
        let _home = HomeGuard::new();
        write_config_str("not valid toml ====\n");
        assert!(read_toon_output());
    }

    #[test]
    #[serial]
    fn set_toon_output_roundtrips() {
        let _home = HomeGuard::new();
        let rt = rt();
        write_config_str("[relay]\nmachine_name = \"x\"\n");

        rt.block_on(set_toon_output(false)).expect("set false");
        assert!(!read_toon_output());

        rt.block_on(set_toon_output(true)).expect("set true");
        assert!(read_toon_output());
    }

    #[test]
    #[serial]
    fn set_toon_output_creates_missing_relay_section() {
        let _home = HomeGuard::new();
        let rt = rt();
        write_config_str("[desktop]\nupdate_channel = \"stable\"\n");

        rt.block_on(set_toon_output(false))
            .expect("set_toon_output should succeed");

        let toml_str = read_config_str();
        let parsed: toml::Table =
            toml::from_str(&toml_str).expect("re-parse config.toml as toml::Table");

        let relay = parsed
            .get("relay")
            .and_then(|v| v.as_table())
            .expect("[relay] section should exist");
        assert_eq!(
            relay.get("toon_output").and_then(|v| v.as_bool()),
            Some(false),
            "toon_output should be false"
        );
        let machine_name = relay
            .get("machine_name")
            .and_then(|v| v.as_str())
            .expect("machine_name should be set");
        assert!(
            !machine_name.is_empty(),
            "machine_name should be non-empty, got {machine_name:?}"
        );
    }

    #[test]
    #[serial]
    fn set_toon_output_preserves_other_fields() {
        let _home = HomeGuard::new();
        let rt = rt();
        write_config_str(
            "[desktop]\n\
             update_channel = \"beta\"\n\
             \n\
             [relay]\n\
             machine_name = \"host\"\n\
             token_dir = \"/tmp/x\"\n\
             local_js_execution = true\n\
             \n\
             [[endpoints]]\n\
             name = \"gmail-acct\"\n\
             transport = \"stdio\"\n\
             tool_prefix = \"gmail\"\n\
             command = \"echo\"\n\
             args = [\"hi\"]\n",
        );

        rt.block_on(set_toon_output(false))
            .expect("set_toon_output should succeed");

        let toml_str = read_config_str();
        let parsed: toml::Table =
            toml::from_str(&toml_str).expect("re-parse config.toml as toml::Table");

        let desktop = parsed
            .get("desktop")
            .and_then(|v| v.as_table())
            .expect("[desktop] preserved");
        assert_eq!(
            desktop.get("update_channel").and_then(|v| v.as_str()),
            Some("beta"),
            "update_channel should be preserved"
        );

        let relay = parsed
            .get("relay")
            .and_then(|v| v.as_table())
            .expect("[relay] preserved");
        assert_eq!(
            relay.get("machine_name").and_then(|v| v.as_str()),
            Some("host"),
            "machine_name should be preserved"
        );
        assert_eq!(
            relay.get("token_dir").and_then(|v| v.as_str()),
            Some("/tmp/x"),
            "token_dir should be preserved"
        );
        assert_eq!(
            relay.get("local_js_execution").and_then(|v| v.as_bool()),
            Some(true),
            "local_js_execution should be preserved"
        );
        assert_eq!(
            relay.get("toon_output").and_then(|v| v.as_bool()),
            Some(false),
            "toon_output should be set to false"
        );

        let endpoints = parsed
            .get("endpoints")
            .and_then(|v| v.as_array())
            .expect("[[endpoints]] preserved");
        assert_eq!(endpoints.len(), 1, "endpoint count should be unchanged");
        let ep = endpoints[0].as_table().expect("endpoint is a table");
        assert_eq!(ep.get("name").and_then(|v| v.as_str()), Some("gmail-acct"));
        assert_eq!(ep.get("transport").and_then(|v| v.as_str()), Some("stdio"));
        assert_eq!(
            ep.get("tool_prefix").and_then(|v| v.as_str()),
            Some("gmail")
        );
        assert_eq!(ep.get("command").and_then(|v| v.as_str()), Some("echo"));
        let args = ep
            .get("args")
            .and_then(|v| v.as_array())
            .expect("args preserved");
        assert_eq!(args.len(), 1);
        assert_eq!(args[0].as_str(), Some("hi"));
    }
}

#[cfg(test)]
mod parse_endpoint_from_span_tests {
    //! Coverage for [`parse_endpoint_from_span`] — the helper that lifts the
    //! endpoint name out of the relay's Full-format tracing span so each
    //! `relay-log` Tauri event carries an authoritative `endpoint` field.
    //!
    //! The sidecar is pinned to `--log-format text` ([`build_sidecar_args`]),
    //! which produces tracing-subscriber's Full-formatter shape with QUOTED
    //! span field values: `endpoint{endpoint="github" transport="stdio"}`.
    //! Fixtures here use that real wire shape so a future regression in the
    //! quote-stripping path would fail loudly. One backward-compatible
    //! unquoted fixture is retained, and a negative compact-format fixture
    //! documents why the sidecar must run with `--log-format text`.

    use super::*;

    #[test]
    fn endpoint_present_in_span_returns_some() {
        // Real Full-format wire shape — tracing-subscriber quotes the field.
        let line = "2026-05-20T10:00:00.000Z  INFO endpoint{endpoint=\"github\" transport=\"stdio\"}: Tool call completed";
        assert_eq!(
            parse_endpoint_from_span(line),
            Some("github".to_string()),
            "endpoint name should be extracted from endpoint{{endpoint=\"NAME\" ...}} span"
        );
    }

    #[test]
    fn no_span_returns_none() {
        // Relay-level event with no endpoint span.
        let line = "2026-05-20T10:00:00.000Z  INFO Relay listening on 127.0.0.1:47107";
        assert_eq!(
            parse_endpoint_from_span(line),
            None,
            "lines without an endpoint{{...}} span must yield None"
        );
    }

    #[test]
    fn nested_request_and_endpoint_spans_still_extract_endpoint() {
        // Full format with multiple span scopes (request{...} endpoint{...}).
        let line = "2026-05-20T10:00:00.000Z  INFO request{method=\"tools/call\" id=42} endpoint{endpoint=\"gmail\" transport=\"stdio\"}: handled";
        assert_eq!(parse_endpoint_from_span(line), Some("gmail".to_string()),);
    }

    #[test]
    fn quoted_endpoint_name_is_unquoted() {
        // A name with a hyphen — the surrounding pair of double-quotes from
        // the Full formatter must be stripped to yield the bare key.
        let line = "endpoint{endpoint=\"slack-prod\" transport=\"http\"}: connected";
        assert_eq!(
            parse_endpoint_from_span(line),
            Some("slack-prod".to_string()),
        );
    }

    #[test]
    fn unquoted_endpoint_name_still_parses_for_backward_compat() {
        // Older relay builds (and the spec §5 fixtures predating PR #67's
        // log-format flag) emitted bare unquoted values. Keep parsing them so
        // a stale buffered log line from a previous run still surfaces an
        // endpoint name.
        let line = "endpoint{endpoint=postgres transport=stdio}: ready";
        assert_eq!(parse_endpoint_from_span(line), Some("postgres".to_string()),);
    }

    #[test]
    fn empty_endpoint_field_returns_none() {
        // Defensive: a malformed `endpoint{endpoint=}` should not produce an
        // empty-string endpoint that the front-end might display as a row.
        let line = "endpoint{endpoint= transport=\"stdio\"}: weird";
        assert_eq!(parse_endpoint_from_span(line), None);
    }

    #[test]
    fn empty_quoted_endpoint_field_returns_none() {
        // Same defense for the quoted shape — `endpoint=""` strips to "" and
        // must be filtered out so the front-end never renders a blank row.
        let line = "endpoint{endpoint=\"\" transport=\"stdio\"}: weird";
        assert_eq!(parse_endpoint_from_span(line), None);
    }

    #[test]
    fn endpoint_at_end_of_span_closing_brace() {
        // Quoted endpoint field with no trailing space — terminator is `}`.
        let line = "endpoint{endpoint=\"postgres\"}: ready";
        assert_eq!(parse_endpoint_from_span(line), Some("postgres".to_string()),);
    }

    #[test]
    fn compact_format_line_returns_none() {
        // Documents why the sidecar must run with `--log-format text`: the
        // relay's CLI default (`compact`) emits span fields at the END of
        // the line, not inline. The parser intentionally returns `None` for
        // this shape so future maintainers see the dependency.
        let line = "2026-05-22T15:10:11Z  INFO endpoint: endara_relay::adapter::http: MCP server reported serverInfo.name endpoint=\"github\" transport=\"stdio\"";
        assert_eq!(
            parse_endpoint_from_span(line),
            None,
            "compact-format lines have trailing span fields and must not match"
        );
    }
}

#[cfg(test)]
mod parse_level_from_line_tests {
    //! Coverage for [`parse_level_from_line`] — the helper that lifts the
    //! tracing level token (ERROR/WARN/INFO/DEBUG/TRACE) out of the relay's
    //! compact-format log line. Drives the level pill in both the top-level
    //! Logs view and the per-endpoint LogsTab so DEBUG / WARN / TRACE lines
    //! no longer fall through to the hardcoded `"info"` default.

    use super::*;

    #[test]
    fn debug_line_returns_debug() {
        let line = "2026-05-20T17:54:47.123Z DEBUG endara_relay::registry: Registering adapter";
        assert_eq!(parse_level_from_line(line), Some("debug"));
    }

    #[test]
    fn info_line_with_two_space_padding_returns_info() {
        // Compact format right-aligns the level — INFO and WARN get an extra
        // leading space so columns line up with ERROR / DEBUG / TRACE.
        let line = "2026-05-20T17:54:47.123Z  INFO endpoint{endpoint=foo}: connected";
        assert_eq!(parse_level_from_line(line), Some("info"));
    }

    #[test]
    fn warn_line_returns_warn() {
        let line = "2026-05-20T17:54:47.123Z  WARN endpoint{endpoint=slack}: reconnecting";
        assert_eq!(parse_level_from_line(line), Some("warn"));
    }

    #[test]
    fn error_line_returns_error() {
        let line = "2026-05-20T17:54:47.123Z ERROR endpoint{endpoint=postgres}: server exited";
        assert_eq!(parse_level_from_line(line), Some("error"));
    }

    #[test]
    fn trace_line_returns_trace() {
        let line = "2026-05-20T17:54:47.123Z TRACE endara_relay::core: very noisy";
        assert_eq!(parse_level_from_line(line), Some("trace"));
    }

    #[test]
    fn raw_line_with_no_level_token_returns_none() {
        let line = "raw stdout from an adapter without tracing context";
        assert_eq!(parse_level_from_line(line), None);
    }

    #[test]
    fn message_body_word_error_does_not_match() {
        // The helper anchors near the start of the line, so a lowercase
        // English word "error" inside the message body must not be promoted
        // to a tracing level. The stderr fallback substring matcher still
        // handles this case, but the helper itself stays strict.
        let line = "2026-05-20T17:54:47.123Z something happened: an error occurred mid-body";
        assert_eq!(parse_level_from_line(line), None);
    }
}

#[cfg(test)]
mod tray_label_tests {
    use super::*;

    #[test]
    fn menu_label_falls_back_to_per_state_default_when_no_detail() {
        assert_eq!(compose_tray_menu_label("healthy", None), "Endara — Running");
        assert_eq!(
            compose_tray_menu_label("degraded", None),
            "Endara — Issue detected"
        );
        assert_eq!(
            compose_tray_menu_label("down", None),
            "Endara — Relay not running"
        );
    }

    #[test]
    fn menu_label_uses_detail_when_present() {
        assert_eq!(
            compose_tray_menu_label("degraded", Some("Sign in required for github-mcp")),
            "Endara — Sign in required for github-mcp"
        );
        assert_eq!(
            compose_tray_menu_label("down", Some("Relay stopped")),
            "Endara — Relay stopped"
        );
    }

    #[test]
    fn menu_label_treats_empty_or_whitespace_detail_as_no_detail() {
        assert_eq!(
            compose_tray_menu_label("healthy", Some("")),
            "Endara — Running"
        );
        assert_eq!(
            compose_tray_menu_label("healthy", Some("   ")),
            "Endara — Running"
        );
    }

    #[test]
    fn tooltip_falls_back_to_spec_5_defaults_when_no_detail() {
        assert_eq!(
            compose_tray_tooltip("healthy", None),
            "Endara Relay — all systems healthy"
        );
        assert_eq!(
            compose_tray_tooltip("degraded", None),
            "Endara Relay — some endpoints need attention"
        );
        assert_eq!(
            compose_tray_tooltip("down", None),
            "Endara Relay — relay is not running"
        );
    }

    #[test]
    fn tooltip_uses_detail_when_present() {
        assert_eq!(
            compose_tray_tooltip("degraded", Some("2 endpoints unhealthy")),
            "Endara Relay — 2 endpoints unhealthy"
        );
    }
}

#[cfg(test)]
mod tray_overlay_toggle_tests {
    //! Locks in the contract that the tray "Show MCP activity overlay"
    //! checkbox tracks [`overlay::OverlaySettings::enabled`] across both
    //! the Settings UI invoke path (`set_overlay_settings` → `apply_overlay_settings`)
    //! and the tray-click path (the "toggle_overlay" handler in `setup` →
    //! `apply_overlay_settings`). Both call sites use
    //! [`tray_overlay_checked_for`] to derive the checked state, so testing
    //! the helper covers both paths.

    use super::*;

    #[test]
    fn tray_checked_when_settings_enabled() {
        let s = overlay::OverlaySettings {
            enabled: true,
            ..Default::default()
        };
        assert!(tray_overlay_checked_for(&s));
    }

    #[test]
    fn tray_unchecked_when_settings_disabled() {
        let s = overlay::OverlaySettings {
            enabled: false,
            ..Default::default()
        };
        assert!(!tray_overlay_checked_for(&s));
    }

    #[test]
    fn tray_checked_ignores_non_enabled_fields() {
        // Non-enabled settings fields (position, dismiss window, max visible,
        // show_profile) must not influence the tray check state.
        let base = overlay::OverlaySettings {
            enabled: true,
            ..Default::default()
        };
        let position_variant = overlay::OverlaySettings {
            position: overlay::OverlayPosition::TopLeft,
            ..base.clone()
        };
        let dismiss_variant = overlay::OverlaySettings {
            auto_dismiss_ms: overlay::AUTO_DISMISS_MS_MAX,
            ..base.clone()
        };
        let show_profile_variant = overlay::OverlaySettings {
            show_profile: false,
            ..base.clone()
        };
        assert!(tray_overlay_checked_for(&position_variant));
        assert!(tray_overlay_checked_for(&dismiss_variant));
        assert!(tray_overlay_checked_for(&show_profile_variant));
    }
}
