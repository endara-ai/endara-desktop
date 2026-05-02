use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, RunEvent, State,
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
fn build_sidecar_args<'a>(
    dev: bool,
    data_dir: &'a str,
    config: &'a str,
    port: &'a str,
) -> Vec<&'a str> {
    if dev {
        vec!["start", "--data-dir", data_dir, "--port", port]
    } else {
        vec!["start", "--config", config, "--port", port]
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
}

#[derive(Serialize, Clone)]
pub struct RelayStatusInfo {
    pub running: bool,
}

#[derive(Serialize, Clone)]
pub struct RelayLogPayload {
    pub level: String,
    pub message: String,
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

    // Spawn a background task to monitor stdout/stderr
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = strip_ansi(&String::from_utf8_lossy(&line));
                    // Detect successful startup from stdout
                    if text.contains("MCP server running") {
                        emit_sidecar_status(&app_handle, "running", None).await;
                    }
                    if let Some(state) = app_handle.try_state::<RelayState>() {
                        let mut buf = state.log_buffer.lock().await;
                        buf.push(RelayLogPayload {
                            level: "info".to_string(),
                            message: text.clone(),
                        });
                        let len = buf.len();
                        if len > 5000 {
                            buf.drain(..len - 5000);
                        }
                    }
                    let _ = app_handle.emit(
                        "relay-log",
                        RelayLogPayload {
                            level: "info".to_string(),
                            message: text,
                        },
                    );
                }
                CommandEvent::Stderr(line) => {
                    let text = strip_ansi(&String::from_utf8_lossy(&line));
                    let level = if text.contains("ERROR") || text.contains("error") {
                        "error"
                    } else if text.contains("WARN") || text.contains("warn") {
                        "warn"
                    } else {
                        "info"
                    };
                    // Detect successful startup from stderr (tracing outputs to stderr)
                    if text.contains("MCP server running") {
                        emit_sidecar_status(&app_handle, "running", None).await;
                    }
                    if let Some(state) = app_handle.try_state::<RelayState>() {
                        let mut buf = state.log_buffer.lock().await;
                        buf.push(RelayLogPayload {
                            level: level.to_string(),
                            message: text.clone(),
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
                    // Update running state
                    if let Some(state) = app_handle.try_state::<RelayState>() {
                        if let Ok(mut pid_guard) = state.pid.lock() {
                            pid_guard.take();
                        }
                        *state.running.lock().await = false;
                        *state.child.lock().await = None;
                    }
                    // Emit relay-health event for termination
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

                    // Emit sidecar lifecycle status based on exit code
                    let exited_cleanly = code == Some(0) || (code.is_none() && signal.is_some());
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
                CommandEvent::Error(err) => {
                    log::error!("[relay] command error error={err}");
                }
                _ => {}
            }
        }
    });

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
    if let Ok(mut pid_guard) = state.pid.lock() {
        pid_guard.take();
    }
    let mut child_guard = state.child.lock().await;
    if let Some(child) = child_guard.take() {
        child
            .kill()
            .map_err(|e| format!("Failed to kill relay: {e}"))?;
    }
    *state.running.lock().await = false;
    Ok(RelayStatusInfo { running: false })
}

#[tauri::command]
async fn restart_relay(
    app: AppHandle,
    state: State<'_, RelayState>,
) -> Result<RelayStatusInfo, String> {
    {
        if let Ok(mut pid_guard) = state.pid.lock() {
            pid_guard.take();
        }
        let mut child_guard = state.child.lock().await;
        if let Some(child) = child_guard.take() {
            let _ = child.kill();
        }
    }
    *state.running.lock().await = false;

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

#[tauri::command]
async fn set_js_execution_mode(enabled: bool) -> Result<(), String> {
    let mut table = read_config()?;

    // Set local_js_execution in the [relay] section
    if let Some(relay) = table.get_mut("relay").and_then(|v| v.as_table_mut()) {
        relay.insert(
            "local_js_execution".to_string(),
            toml::Value::Boolean(enabled),
        );
    } else {
        return Err("Missing [relay] section in config".to_string());
    }

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
#[tauri::command]
async fn check_for_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
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

#[derive(Deserialize)]
struct AddEndpointArgs {
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
    client_secret: Option<String>,
    scopes: Option<String>,
    token_endpoint: Option<String>,
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
    client_secret: Option<String>,
    scopes: Option<String>,
    token_endpoint: Option<String>,
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
                let client_secret = ep
                    .get("client_secret")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
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
                    client_secret,
                    scopes,
                    token_endpoint,
                });
            }
        }
    }

    Err(format!("Endpoint '{}' not found", name))
}

#[derive(Deserialize)]
struct UpdateEndpointArgs {
    original_name: String,
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
    client_secret: Option<String>,
    scopes: Option<String>,
    token_endpoint: Option<String>,
}

#[tauri::command]
async fn update_endpoint(args: UpdateEndpointArgs) -> Result<(), String> {
    let mut parsed = read_config()?;

    // If name changed, check for duplicates
    if args.name != args.original_name {
        if let Some(toml::Value::Array(endpoints)) = parsed.get("endpoints") {
            for ep in endpoints {
                if ep.get("name").and_then(|v| v.as_str()) == Some(&args.name) {
                    return Err(format!("An endpoint named '{}' already exists", args.name));
                }
            }
        }
    }

    let mut found = false;
    if let Some(toml::Value::Array(endpoints)) = parsed.get_mut("endpoints") {
        for ep in endpoints.iter_mut() {
            if ep.get("name").and_then(|v| v.as_str()) == Some(&args.original_name) {
                found = true;
                let table = ep.as_table_mut().ok_or("Endpoint is not a table")?;

                // Clear old fields and set new ones
                table.clear();
                table.insert("name".to_string(), toml::Value::String(args.name.clone()));
                table.insert(
                    "transport".to_string(),
                    toml::Value::String(args.transport.clone()),
                );
                if let Some(tool_prefix) = &args.tool_prefix {
                    table.insert(
                        "tool_prefix".to_string(),
                        toml::Value::String(tool_prefix.clone()),
                    );
                }

                if let Some(cmd) = &args.command {
                    table.insert("command".to_string(), toml::Value::String(cmd.clone()));
                }
                if let Some(cmd_args) = &args.args {
                    let arr: Vec<toml::Value> = cmd_args
                        .iter()
                        .map(|a| toml::Value::String(a.clone()))
                        .collect();
                    table.insert("args".to_string(), toml::Value::Array(arr));
                }
                if let Some(url) = &args.url {
                    table.insert("url".to_string(), toml::Value::String(url.clone()));
                }
                if let Some(description) = &args.description {
                    table.insert(
                        "description".to_string(),
                        toml::Value::String(description.clone()),
                    );
                }
                if let Some(env) = &args.env {
                    if !env.is_empty() {
                        let mut env_table = toml::map::Map::new();
                        for (k, v) in env {
                            env_table.insert(k.clone(), toml::Value::String(v.clone()));
                        }
                        table.insert("env".to_string(), toml::Value::Table(env_table));
                    }
                }
                if let Some(headers) = &args.headers {
                    if !headers.is_empty() {
                        let mut headers_table = toml::map::Map::new();
                        for (k, v) in headers {
                            headers_table.insert(k.clone(), toml::Value::String(v.clone()));
                        }
                        table.insert("headers".to_string(), toml::Value::Table(headers_table));
                    }
                }
                if let Some(oauth_server_url) = &args.oauth_server_url {
                    table.insert(
                        "oauth_server_url".to_string(),
                        toml::Value::String(oauth_server_url.clone()),
                    );
                }
                if let Some(client_id) = &args.client_id {
                    table.insert(
                        "client_id".to_string(),
                        toml::Value::String(client_id.clone()),
                    );
                }
                if let Some(client_secret) = &args.client_secret {
                    table.insert(
                        "client_secret".to_string(),
                        toml::Value::String(client_secret.clone()),
                    );
                }
                if let Some(scopes) = &args.scopes {
                    let arr: Vec<toml::Value> = scopes
                        .split_whitespace()
                        .map(|s| toml::Value::String(s.to_string()))
                        .collect();
                    if !arr.is_empty() {
                        table.insert("scopes".to_string(), toml::Value::Array(arr));
                    }
                }
                if let Some(token_endpoint) = &args.token_endpoint {
                    table.insert(
                        "token_endpoint".to_string(),
                        toml::Value::String(token_endpoint.clone()),
                    );
                }
                break;
            }
        }
    }

    if !found {
        return Err(format!("Endpoint '{}' not found", args.original_name));
    }

    write_config(&parsed)
}

#[tauri::command]
async fn add_endpoint(args: AddEndpointArgs) -> Result<(), String> {
    let path = config_path()?;

    // Read existing config or create default
    let contents = if path.exists() {
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read config: {e}"))?
    } else {
        // Create parent directory if needed
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create config directory: {e}"))?;
        }
        // Create a default config with machine name
        let machine_name = hostname::get()
            .ok()
            .and_then(|h| h.into_string().ok())
            .unwrap_or_else(|| "unknown".to_string());
        format!("[relay]\nmachine_name = \"{machine_name}\"\n")
    };

    let mut parsed: toml::Table = contents
        .parse()
        .map_err(|e| format!("Failed to parse config: {e}"))?;

    // Check for duplicate endpoint name
    if let Some(toml::Value::Array(endpoints)) = parsed.get("endpoints") {
        for ep in endpoints {
            if let Some(toml::Value::String(name)) = ep.get("name") {
                if name == &args.name {
                    return Err(format!("An endpoint named '{}' already exists", args.name));
                }
            }
        }
    }

    let mut endpoint = toml::map::Map::new();
    endpoint.insert("name".to_string(), toml::Value::String(args.name));
    endpoint.insert("transport".to_string(), toml::Value::String(args.transport));
    if let Some(tool_prefix) = args.tool_prefix {
        endpoint.insert("tool_prefix".to_string(), toml::Value::String(tool_prefix));
    }

    if let Some(cmd) = args.command {
        endpoint.insert("command".to_string(), toml::Value::String(cmd));
    }
    if let Some(cmd_args) = args.args {
        let arr = cmd_args.into_iter().map(toml::Value::String).collect();
        endpoint.insert("args".to_string(), toml::Value::Array(arr));
    }
    if let Some(url) = args.url {
        endpoint.insert("url".to_string(), toml::Value::String(url));
    }
    if let Some(description) = args.description {
        endpoint.insert("description".to_string(), toml::Value::String(description));
    }
    if let Some(env) = args.env {
        if !env.is_empty() {
            let mut env_table = toml::map::Map::new();
            for (k, v) in env {
                env_table.insert(k, toml::Value::String(v));
            }
            endpoint.insert("env".to_string(), toml::Value::Table(env_table));
        }
    }
    if let Some(headers) = args.headers {
        if !headers.is_empty() {
            let mut headers_table = toml::map::Map::new();
            for (k, v) in headers {
                headers_table.insert(k, toml::Value::String(v));
            }
            endpoint.insert("headers".to_string(), toml::Value::Table(headers_table));
        }
    }
    if let Some(oauth_server_url) = args.oauth_server_url {
        endpoint.insert(
            "oauth_server_url".to_string(),
            toml::Value::String(oauth_server_url),
        );
    }
    if let Some(client_id) = args.client_id {
        endpoint.insert("client_id".to_string(), toml::Value::String(client_id));
    }
    if let Some(client_secret) = args.client_secret {
        endpoint.insert(
            "client_secret".to_string(),
            toml::Value::String(client_secret),
        );
    }
    if let Some(scopes) = args.scopes {
        let arr: Vec<toml::Value> = scopes
            .split_whitespace()
            .map(|s| toml::Value::String(s.to_string()))
            .collect();
        if !arr.is_empty() {
            endpoint.insert("scopes".to_string(), toml::Value::Array(arr));
        }
    }
    if let Some(token_endpoint) = args.token_endpoint {
        endpoint.insert(
            "token_endpoint".to_string(),
            toml::Value::String(token_endpoint),
        );
    }

    let endpoints = parsed
        .entry("endpoints")
        .or_insert_with(|| toml::Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| "Invalid endpoints section in config".to_string())?;
    endpoints.push(toml::Value::Table(endpoint));

    write_config(&parsed)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
    };

    let child_handle = relay_state.child.clone();
    let pid_handle = relay_state.pid.clone();

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
        .invoke_handler(tauri::generate_handler![
            start_relay,
            stop_relay,
            restart_relay,
            relay_status,
            get_sidecar_status,
            get_build_info,
            add_endpoint,
            remove_endpoint,
            get_endpoint_config,
            update_endpoint,
            get_relay_port,
            set_relay_port,
            set_js_execution_mode,
            get_config_path_display,
            get_buffered_relay_logs,
            get_update_channel,
            set_update_channel,
            check_for_update,
            download_and_install_update,
            show_update_notification,
            get_autostart,
            set_autostart,
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

            // Build tray menu
            let status_item =
                MenuItem::with_id(app, "status", "Endara — Running", false, None::<&str>)?;
            let open_item = MenuItem::with_id(app, "open", "Open Endara", true, None::<&str>)?;
            let update_item =
                MenuItem::with_id(app, "check_update", "Check for Updates", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            let menu =
                Menu::with_items(app, &[&status_item, &open_item, &update_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
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
        let dev = build_sidecar_args(true, "/tmp/dev", "/tmp/dev/config.toml", "9500");
        assert_eq!(
            dev,
            vec!["start", "--data-dir", "/tmp/dev", "--port", "9500"]
        );

        let prod = build_sidecar_args(false, "/tmp/dev", "/tmp/prod/config.toml", "9400");
        assert_eq!(
            prod,
            vec![
                "start",
                "--config",
                "/tmp/prod/config.toml",
                "--port",
                "9400"
            ]
        );
    }
}
