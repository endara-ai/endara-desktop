use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, RunEvent, State,
};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
use tokio::sync::Mutex;

/// Check if a port is already in use by attempting a TCP connection.
/// Returns `true` if the port is occupied.
fn is_port_in_use(port: u16) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(500)).is_ok()
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

/// Holds the relay sidecar child process handle.
pub struct RelayState {
    child: Arc<Mutex<Option<tauri_plugin_shell::process::CommandChild>>>,
    running: Arc<Mutex<bool>>,
    auto_restart_enabled: Arc<Mutex<bool>>,
    port: Arc<Mutex<u16>>,
    restart_count: Arc<Mutex<u32>>,
    port_conflict: Arc<Mutex<bool>>,
}

#[derive(Serialize, Clone)]
pub struct RelayStatusInfo {
    pub running: bool,
}

#[derive(Serialize, Clone)]
pub struct SidecarStatusResponse {
    pub running: bool,
    pub port_conflict: bool,
    pub port: u16,
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

#[derive(Serialize, Clone)]
pub struct BuildInfo {
    pub version: String,
    pub monorepo_commit: String,
    pub relay_commit: String,
    pub desktop_commit: String,
    pub build_date: String,
}

#[tauri::command]
async fn get_build_info() -> Result<BuildInfo, String> {
    Ok(BuildInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        monorepo_commit: env!("MONOREPO_COMMIT").to_string(),
        relay_commit: env!("RELAY_COMMIT").to_string(),
        desktop_commit: env!("DESKTOP_COMMIT").to_string(),
        build_date: env!("BUILD_DATE").to_string(),
    })
}

/// Spawn the relay sidecar and monitor its output.
/// Returns the child handle on success.
fn spawn_relay(
    app: &AppHandle,
    port: u16,
) -> Result<tauri_plugin_shell::process::CommandChild, String> {
    let config_path = dirs::home_dir()
        .map(|h| h.join(".endara").join("config.toml"))
        .unwrap_or_default();

    // Ensure log directory exists for relay file logging
    if let Some(home) = dirs::home_dir() {
        let log_dir = home.join(".endara").join("logs");
        let _ = std::fs::create_dir_all(&log_dir);
    }

    eprintln!("[relay] attempting to spawn sidecar with config: {:?}, port: {}", config_path, port);

    // Emit sidecar lifecycle: starting
    let _ = app.emit("relay-sidecar-status", RelaySidecarStatusPayload {
        status: "starting".to_string(),
        error: None,
    });

    let port_str = port.to_string();
    let (mut rx, child) = app
        .shell()
        .sidecar("endara-relay")
        .map_err(|e| {
            eprintln!("[relay] FAILED to create sidecar command: {e}");
            format!("Failed to create sidecar command: {e}")
        })?
        .args(["start", "--config", &config_path.to_string_lossy(), "--port", &port_str])
        .spawn()
        .map_err(|e| {
            eprintln!("[relay] FAILED to spawn relay sidecar: {e}");
            format!("Failed to spawn relay sidecar: {e}")
        })?;

    eprintln!("[relay] sidecar process spawned successfully");

    // Spawn a background task to monitor stdout/stderr
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = strip_ansi(&String::from_utf8_lossy(&line));
                    // Detect successful startup from stdout
                    if text.contains("MCP server running") {
                        let _ = app_handle.emit("relay-sidecar-status", RelaySidecarStatusPayload {
                            status: "running".to_string(),
                            error: None,
                        });
                        // Reset restart count and clear port conflict on successful start
                        if let Some(state) = app_handle.try_state::<RelayState>() {
                            *state.restart_count.lock().await = 0;
                            *state.port_conflict.lock().await = false;
                        }
                    }
                    let _ = app_handle.emit("relay-log", RelayLogPayload {
                        level: "info".to_string(),
                        message: text,
                    });
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
                        let _ = app_handle.emit("relay-sidecar-status", RelaySidecarStatusPayload {
                            status: "running".to_string(),
                            error: None,
                        });
                        // Reset restart count and clear port conflict on successful start
                        if let Some(state) = app_handle.try_state::<RelayState>() {
                            *state.restart_count.lock().await = 0;
                            *state.port_conflict.lock().await = false;
                        }
                    }
                    let _ = app_handle.emit("relay-log", RelayLogPayload {
                        level: level.to_string(),
                        message: text.clone(),
                    });
                    // Emit relay-health event for ERROR lines
                    if level == "error" {
                        let _ = app_handle.emit("relay-health", RelayHealthPayload {
                            status: "error".to_string(),
                            message: Some(text.clone()),
                        });
                        // Emit sidecar failed status for critical errors
                        if text.contains("Failed to start HTTP server") || text.contains("Address already in use") {
                            let _ = app_handle.emit("relay-sidecar-status", RelaySidecarStatusPayload {
                                status: "failed".to_string(),
                                error: Some(text),
                            });
                        }
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let code = payload.code;
                    let signal = payload.signal;
                    eprintln!("[relay] process terminated, code: {code:?}, signal: {signal:?}");
                    // Update running state
                    if let Some(state) = app_handle.try_state::<RelayState>() {
                        *state.running.lock().await = false;
                        *state.child.lock().await = None;
                    }
                    // Emit relay-health event for termination
                    let _ = app_handle.emit("relay-health", RelayHealthPayload {
                        status: "disconnected".to_string(),
                        message: Some(format!("Process terminated (code: {:?}, signal: {:?})", code, signal)),
                    });

                    // Emit sidecar lifecycle status based on exit code
                    let exited_cleanly = code == Some(0) || (code.is_none() && signal.is_some());
                    if exited_cleanly {
                        let _ = app_handle.emit("relay-sidecar-status", RelaySidecarStatusPayload {
                            status: "stopped".to_string(),
                            error: None,
                        });
                    } else {
                        let _ = app_handle.emit("relay-sidecar-status", RelaySidecarStatusPayload {
                            status: "failed".to_string(),
                            error: Some(format!("Process exited with code: {:?}, signal: {:?}", code, signal)),
                        });
                    }

                    // Check if auto-restart is enabled (disabled by intentional stop)
                    let should_restart = if let Some(state) = app_handle.try_state::<RelayState>() {
                        *state.auto_restart_enabled.lock().await
                    } else {
                        false
                    };

                    if !should_restart {
                        eprintln!("[relay] auto-restart disabled, not restarting");
                        break;
                    }

                    // Check restart count and apply backoff
                    let current_restart_count = if let Some(state) = app_handle.try_state::<RelayState>() {
                        let mut count = state.restart_count.lock().await;
                        *count += 1;
                        *count
                    } else {
                        break;
                    };

                    if current_restart_count > 5 {
                        eprintln!("[relay] auto-restart stopped after 5 consecutive failures");
                        let _ = app_handle.emit("relay-sidecar-status", RelaySidecarStatusPayload {
                            status: "failed".to_string(),
                            error: Some("Auto-restart stopped after 5 consecutive failures".to_string()),
                        });
                        let _ = app_handle.emit("relay-health", RelayHealthPayload {
                            status: "error".to_string(),
                            message: Some("Auto-restart stopped after 5 consecutive failures".to_string()),
                        });
                        break;
                    }

                    // Exponential backoff: 2s, 4s, 8s, 16s, 30s
                    let delay_secs = std::cmp::min(2u64.pow(current_restart_count), 30);
                    eprintln!("[relay] attempting auto-restart {current_restart_count}/5 after {delay_secs}s...");
                    tokio::time::sleep(std::time::Duration::from_secs(delay_secs)).await;

                    if let Some(state) = app_handle.try_state::<RelayState>() {
                        let port = *state.port.lock().await;
                        match spawn_relay(&app_handle, port) {
                            Ok(new_child) => {
                                *state.child.lock().await = Some(new_child);
                                *state.running.lock().await = true;
                                eprintln!("[relay] auto-restart successful");
                                let _ = app_handle.emit("relay-health", RelayHealthPayload {
                                    status: "connected".to_string(),
                                    message: None,
                                });
                            }
                            Err(e) => {
                                eprintln!("[relay] auto-restart FAILED: {e}");
                                let _ = app_handle.emit("relay-health", RelayHealthPayload {
                                    status: "error".to_string(),
                                    message: Some(format!("Auto-restart failed: {e}")),
                                });
                            }
                        }
                    }
                    break;
                }
                CommandEvent::Error(err) => {
                    eprintln!("[relay] command error: {err}");
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
    let mut child_guard = state.child.lock().await;
    if child_guard.is_some() {
        return Ok(RelayStatusInfo { running: true });
    }
    *state.auto_restart_enabled.lock().await = true;
    *state.restart_count.lock().await = 0;
    *state.port_conflict.lock().await = false;
    let port = *state.port.lock().await;
    if is_port_in_use(port) {
        *state.port_conflict.lock().await = true;
        let _ = app.emit("relay-sidecar-status", RelaySidecarStatusPayload {
            status: "failed".to_string(),
            error: Some(format!("Port {} is already in use by another process. Close the other process or change the relay port in Settings.", port)),
        });
        return Err(format!("Port {} is already in use", port));
    }
    let child = spawn_relay(&app, port)?;
    *child_guard = Some(child);
    *state.running.lock().await = true;
    Ok(RelayStatusInfo { running: true })
}

#[tauri::command]
async fn stop_relay(state: State<'_, RelayState>) -> Result<RelayStatusInfo, String> {
    *state.auto_restart_enabled.lock().await = false;
    let mut child_guard = state.child.lock().await;
    if let Some(child) = child_guard.take() {
        child.kill().map_err(|e| format!("Failed to kill relay: {e}"))?;
    }
    *state.running.lock().await = false;
    Ok(RelayStatusInfo { running: false })
}

#[tauri::command]
async fn restart_relay(
    app: AppHandle,
    state: State<'_, RelayState>,
) -> Result<RelayStatusInfo, String> {
    // Stop existing — disable auto-restart so the Terminated handler doesn't race
    *state.auto_restart_enabled.lock().await = false;
    {
        let mut child_guard = state.child.lock().await;
        if let Some(child) = child_guard.take() {
            let _ = child.kill();
        }
    }
    *state.running.lock().await = false;

    // Brief pause before restart
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Start new — re-enable auto-restart
    *state.auto_restart_enabled.lock().await = true;
    *state.restart_count.lock().await = 0;
    *state.port_conflict.lock().await = false;
    let port = *state.port.lock().await;
    if is_port_in_use(port) {
        *state.port_conflict.lock().await = true;
        let _ = app.emit("relay-sidecar-status", RelaySidecarStatusPayload {
            status: "failed".to_string(),
            error: Some(format!("Port {} is already in use by another process. Close the other process or change the relay port in Settings.", port)),
        });
        return Err(format!("Port {} is already in use", port));
    }
    let child = spawn_relay(&app, port)?;
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
async fn get_sidecar_status(state: State<'_, RelayState>) -> Result<SidecarStatusResponse, String> {
    let running = *state.running.lock().await;
    let port_conflict = *state.port_conflict.lock().await;
    let port = *state.port.lock().await;
    Ok(SidecarStatusResponse { running, port_conflict, port })
}

#[tauri::command]
async fn set_relay_port(port: u16, state: State<'_, RelayState>) -> Result<(), String> {
    *state.port.lock().await = port;
    Ok(())
}

#[tauri::command]
async fn set_js_execution_mode(enabled: bool) -> Result<(), String> {
    let config_path = dirs::home_dir()
        .map(|h| h.join(".endara").join("config.toml"))
        .ok_or_else(|| "Could not determine home directory".to_string())?;

    let contents = if config_path.exists() {
        std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read config: {e}"))?
    } else {
        return Err("Config file does not exist".to_string());
    };

    let mut table: toml::Table = contents
        .parse()
        .map_err(|e| format!("Failed to parse config: {e}"))?;

    // Set local_js_execution in the [relay] section
    if let Some(relay) = table.get_mut("relay").and_then(|v| v.as_table_mut()) {
        relay.insert(
            "local_js_execution".to_string(),
            toml::Value::Boolean(enabled),
        );
    } else {
        return Err("Missing [relay] section in config".to_string());
    }

    let new_contents = toml::to_string_pretty(&table)
        .map_err(|e| format!("Failed to serialize config: {e}"))?;

    std::fs::write(&config_path, &new_contents)
        .map_err(|e| format!("Failed to write config: {e}"))?;

    Ok(())
}

#[derive(Deserialize)]
struct AddEndpointArgs {
    name: String,
    transport: String,
    command: Option<String>,
    args: Option<Vec<String>>,
    url: Option<String>,
    description: Option<String>,
    env: Option<HashMap<String, String>>,
    headers: Option<HashMap<String, String>>,
    #[serde(rename = "toolPrefix")]
    tool_prefix: Option<String>,
}

#[derive(Serialize)]
struct EndpointConfig {
    name: String,
    transport: String,
    command: Option<String>,
    args: Option<Vec<String>>,
    url: Option<String>,
    description: Option<String>,
    env: Option<HashMap<String, String>>,
    headers: Option<HashMap<String, String>>,
    #[serde(rename = "toolPrefix", skip_serializing_if = "Option::is_none")]
    tool_prefix: Option<String>,
}

#[tauri::command]
async fn get_endpoint_config(name: String) -> Result<EndpointConfig, String> {
    let config_path = dirs::home_dir()
        .map(|h| h.join(".endara").join("config.toml"))
        .ok_or_else(|| "Could not determine home directory".to_string())?;

    if !config_path.exists() {
        return Err("Config file not found".to_string());
    }

    let contents = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {e}"))?;

    let parsed: toml::Table = contents
        .parse()
        .map_err(|e| format!("Failed to parse config: {e}"))?;

    if let Some(toml::Value::Array(endpoints)) = parsed.get("endpoints") {
        for ep in endpoints {
            if ep.get("name").and_then(|v| v.as_str()) == Some(&name) {
                let transport = ep.get("transport").and_then(|v| v.as_str()).unwrap_or("stdio").to_string();
                let command = ep.get("command").and_then(|v| v.as_str()).map(|s| s.to_string());
                let args = ep.get("args").and_then(|v| v.as_array()).map(|arr| {
                    arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()
                });
                let url = ep.get("url").and_then(|v| v.as_str()).map(|s| s.to_string());
                let description = ep.get("description").and_then(|v| v.as_str()).map(|s| s.to_string());
                let env = ep.get("env").and_then(|v| v.as_table()).map(|t| {
                    t.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect()
                });
                let headers = ep.get("headers").and_then(|v| v.as_table()).map(|t| {
                    t.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect()
                });
                let tool_prefix = ep.get("tool_prefix").and_then(|v| v.as_str()).map(|s| s.to_string());

                return Ok(EndpointConfig {
                    name: name.clone(),
                    transport,
                    command,
                    args,
                    url,
                    description,
                    env,
                    headers,
                    tool_prefix,
                });
            }
        }
    }

    Err(format!("Endpoint '{}' not found", name))
}

#[derive(Deserialize)]
struct UpdateEndpointArgs {
    #[serde(rename = "originalName")]
    original_name: String,
    name: String,
    transport: String,
    command: Option<String>,
    args: Option<Vec<String>>,
    url: Option<String>,
    description: Option<String>,
    env: Option<HashMap<String, String>>,
    headers: Option<HashMap<String, String>>,
    #[serde(rename = "toolPrefix")]
    tool_prefix: Option<String>,
}

#[tauri::command]
async fn update_endpoint(args: UpdateEndpointArgs) -> Result<(), String> {
    let config_path = dirs::home_dir()
        .map(|h| h.join(".endara").join("config.toml"))
        .ok_or_else(|| "Could not determine home directory".to_string())?;

    if !config_path.exists() {
        return Err("Config file not found".to_string());
    }

    let contents = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {e}"))?;

    let mut parsed: toml::Table = contents
        .parse()
        .map_err(|e| format!("Failed to parse config: {e}"))?;

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
                table.insert("transport".to_string(), toml::Value::String(args.transport.clone()));

                if let Some(cmd) = &args.command {
                    table.insert("command".to_string(), toml::Value::String(cmd.clone()));
                }
                if let Some(cmd_args) = &args.args {
                    let arr: Vec<toml::Value> = cmd_args.iter().map(|a| toml::Value::String(a.clone())).collect();
                    table.insert("args".to_string(), toml::Value::Array(arr));
                }
                if let Some(url) = &args.url {
                    table.insert("url".to_string(), toml::Value::String(url.clone()));
                }
                if let Some(description) = &args.description {
                    table.insert("description".to_string(), toml::Value::String(description.clone()));
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
                if let Some(tool_prefix) = &args.tool_prefix {
                    table.insert("tool_prefix".to_string(), toml::Value::String(tool_prefix.clone()));
                }
                break;
            }
        }
    }

    if !found {
        return Err(format!("Endpoint '{}' not found", args.original_name));
    }

    let new_contents = toml::to_string_pretty(&parsed)
        .map_err(|e| format!("Failed to serialize config: {e}"))?;

    std::fs::write(&config_path, &new_contents)
        .map_err(|e| format!("Failed to write config: {e}"))?;

    Ok(())
}

#[tauri::command]
async fn add_endpoint(args: AddEndpointArgs) -> Result<(), String> {
    let config_path = dirs::home_dir()
        .map(|h| h.join(".endara").join("config.toml"))
        .ok_or_else(|| "Could not determine home directory".to_string())?;

    // Read existing config or create default
    let mut contents = if config_path.exists() {
        std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read config: {e}"))?
    } else {
        // Create parent directory if needed
        if let Some(parent) = config_path.parent() {
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

    // Check for duplicate endpoint name
    if let Ok(parsed) = contents.parse::<toml::Table>() {
        if let Some(toml::Value::Array(endpoints)) = parsed.get("endpoints") {
            for ep in endpoints {
                if let Some(toml::Value::String(name)) = ep.get("name") {
                    if name == &args.name {
                        return Err(format!("An endpoint named '{}' already exists", args.name));
                    }
                }
            }
        }
    }

    // Build the TOML block for the new endpoint
    contents.push_str("\n[[endpoints]]\n");
    contents.push_str(&format!("name = {}\n", toml::Value::String(args.name).to_string()));
    contents.push_str(&format!("transport = {}\n", toml::Value::String(args.transport).to_string()));
    if let Some(cmd) = args.command {
        contents.push_str(&format!("command = {}\n", toml::Value::String(cmd).to_string()));
    }
    if let Some(cmd_args) = args.args {
        let arr: Vec<String> = cmd_args.iter().map(|a| toml::Value::String(a.clone()).to_string()).collect();
        contents.push_str(&format!("args = [{}]\n", arr.join(", ")));
    }
    if let Some(url) = args.url {
        contents.push_str(&format!("url = {}\n", toml::Value::String(url).to_string()));
    }
    if let Some(description) = args.description {
        contents.push_str(&format!("description = {}\n", toml::Value::String(description).to_string()));
    }
    if let Some(env) = args.env {
        if !env.is_empty() {
            let pairs: Vec<String> = env.iter().map(|(k, v)| {
                format!("{} = {}", k, toml::Value::String(v.clone()).to_string())
            }).collect();
            contents.push_str(&format!("env = {{ {} }}\n", pairs.join(", ")));
        }
    }
    if let Some(headers) = args.headers {
        if !headers.is_empty() {
            let pairs: Vec<String> = headers.iter().map(|(k, v)| {
                format!("{} = {}", k, toml::Value::String(v.clone()).to_string())
            }).collect();
            contents.push_str(&format!("headers = {{ {} }}\n", pairs.join(", ")));
        }
    }
    if let Some(tool_prefix) = args.tool_prefix {
        contents.push_str(&format!("tool_prefix = {}\n", toml::Value::String(tool_prefix).to_string()));
    }

    std::fs::write(&config_path, &contents)
        .map_err(|e| format!("Failed to write config: {e}"))?;

    Ok(())
}

#[tauri::command]
async fn remove_endpoint(name: String) -> Result<(), String> {
    let config_path = dirs::home_dir()
        .map(|h| h.join(".endara").join("config.toml"))
        .ok_or_else(|| "Could not determine home directory".to_string())?;

    if !config_path.exists() {
        return Err("Config file not found".to_string());
    }

    let contents = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {e}"))?;

    let mut parsed: toml::Table = contents
        .parse()
        .map_err(|e| format!("Failed to parse config: {e}"))?;

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

    let new_contents = toml::to_string_pretty(&parsed)
        .map_err(|e| format!("Failed to serialize config: {e}"))?;

    std::fs::write(&config_path, &new_contents)
        .map_err(|e| format!("Failed to write config: {e}"))?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let relay_state = RelayState {
        child: Arc::new(Mutex::new(None)),
        running: Arc::new(Mutex::new(false)),
        auto_restart_enabled: Arc::new(Mutex::new(true)),
        port: Arc::new(Mutex::new(9400)),
        restart_count: Arc::new(Mutex::new(0)),
        port_conflict: Arc::new(Mutex::new(false)),
    };

    let child_handle = relay_state.child.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new()
            .level(log::LevelFilter::Info)
            .build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .manage(relay_state)
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
            set_relay_port,
            set_js_execution_mode,
        ])
        .setup(|app| {
            // Build tray menu
            let status_item =
                MenuItem::with_id(app, "status", "Endara — Running", false, None::<&str>)?;
            let open_item = MenuItem::with_id(app, "open", "Open Endara", true, None::<&str>)?;
            let update_item = MenuItem::with_id(app, "check_update", "Check for Updates", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            let menu = Menu::with_items(app, &[&status_item, &open_item, &update_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "check_update" => {
                        let _ = app.emit("check-for-update", ());
                        // Also show the window so user can see the update UI
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
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
                } else {
                    9400
                };
                if is_port_in_use(port) {
                    eprintln!("[relay] port {} is already in use, not spawning relay", port);
                    if let Some(state) = app_handle.try_state::<RelayState>() {
                        *state.port_conflict.lock().await = true;
                    }
                    let _ = app_handle.emit("relay-sidecar-status", RelaySidecarStatusPayload {
                        status: "failed".to_string(),
                        error: Some(format!("Port {} is already in use by another process. Close the other process or change the relay port in Settings.", port)),
                    });
                    return;
                }
                match spawn_relay(&app_handle, port) {
                    Ok(child) => {
                        if let Some(state) = app_handle.try_state::<RelayState>() {
                            *state.child.lock().await = Some(child);
                            *state.running.lock().await = true;
                        }
                        eprintln!("[relay] sidecar started successfully");
                    }
                    Err(e) => {
                        eprintln!("[relay] FAILED to start sidecar on launch: {e}");
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                // Kill relay sidecar on app exit
                let child_handle = child_handle.clone();
                tauri::async_runtime::block_on(async {
                    let mut guard = child_handle.lock().await;
                    if let Some(child) = guard.take() {
                        log::info!("[relay] killing sidecar on app exit");
                        let _ = child.kill();
                    }
                });
            }
        });
}
