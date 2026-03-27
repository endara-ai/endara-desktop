use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, RunEvent, State,
};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
use tokio::sync::Mutex;

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
                        // Reset restart count on successful start
                        if let Some(state) = app_handle.try_state::<RelayState>() {
                            *state.restart_count.lock().await = 0;
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
                        // Reset restart count on successful start
                        if let Some(state) = app_handle.try_state::<RelayState>() {
                            *state.restart_count.lock().await = 0;
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
    let port = *state.port.lock().await;
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
    let port = *state.port.lock().await;
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
    };

    let child_handle = relay_state.child.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new()
            .level(log::LevelFilter::Info)
            .build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .manage(relay_state)
        .invoke_handler(tauri::generate_handler![
            start_relay,
            stop_relay,
            restart_relay,
            relay_status,
            get_build_info,
            add_endpoint,
            remove_endpoint,
            set_relay_port,
            set_js_execution_mode,
        ])
        .setup(|app| {
            // Build tray menu
            let status_item =
                MenuItem::with_id(app, "status", "Endara — Running", false, None::<&str>)?;
            let open_item = MenuItem::with_id(app, "open", "Open Endara", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            let menu = Menu::with_items(app, &[&status_item, &open_item, &quit_item])?;

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
