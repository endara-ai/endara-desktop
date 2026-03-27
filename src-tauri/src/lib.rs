use std::sync::Arc;

use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, RunEvent, State,
};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
use tokio::sync::Mutex;

/// Holds the relay sidecar child process handle.
pub struct RelayState {
    child: Arc<Mutex<Option<tauri_plugin_shell::process::CommandChild>>>,
    running: Arc<Mutex<bool>>,
    auto_restart_enabled: Arc<Mutex<bool>>,
}

#[derive(Serialize, Clone)]
pub struct RelayStatusInfo {
    pub running: bool,
}

/// Spawn the relay sidecar and monitor its output.
/// Returns the child handle on success.
fn spawn_relay(
    app: &AppHandle,
) -> Result<tauri_plugin_shell::process::CommandChild, String> {
    let config_path = dirs::home_dir()
        .map(|h| h.join(".endara").join("config.toml"))
        .unwrap_or_default();

    let (mut rx, child) = app
        .shell()
        .sidecar("binaries/endara-relay")
        .map_err(|e| format!("Failed to create sidecar command: {e}"))?
        .args(["--config", &config_path.to_string_lossy()])
        .spawn()
        .map_err(|e| format!("Failed to spawn relay sidecar: {e}"))?;

    // Spawn a background task to monitor stdout/stderr
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    log::info!("[relay stdout] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    log::warn!("[relay stderr] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(payload) => {
                    log::warn!(
                        "[relay] process terminated with code: {:?}, signal: {:?}",
                        payload.code,
                        payload.signal
                    );
                    // Update running state
                    if let Some(state) = app_handle.try_state::<RelayState>() {
                        *state.running.lock().await = false;
                        *state.child.lock().await = None;
                    }

                    // Check if auto-restart is enabled (disabled by intentional stop)
                    let should_restart = if let Some(state) = app_handle.try_state::<RelayState>() {
                        *state.auto_restart_enabled.lock().await
                    } else {
                        false
                    };

                    if !should_restart {
                        log::info!("[relay] auto-restart disabled, not restarting");
                        break;
                    }

                    // Auto-restart after a brief delay
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    log::info!("[relay] attempting auto-restart...");
                    if let Some(state) = app_handle.try_state::<RelayState>() {
                        match spawn_relay(&app_handle) {
                            Ok(new_child) => {
                                *state.child.lock().await = Some(new_child);
                                *state.running.lock().await = true;
                                log::info!("[relay] auto-restart successful");
                            }
                            Err(e) => {
                                log::error!("[relay] auto-restart failed: {e}");
                            }
                        }
                    }
                    break;
                }
                CommandEvent::Error(err) => {
                    log::error!("[relay] error: {err}");
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
    let child = spawn_relay(&app)?;
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
    let child = spawn_relay(&app)?;
    *state.child.lock().await = Some(child);
    *state.running.lock().await = true;
    Ok(RelayStatusInfo { running: true })
}

#[tauri::command]
async fn relay_status(state: State<'_, RelayState>) -> Result<RelayStatusInfo, String> {
    let running = *state.running.lock().await;
    Ok(RelayStatusInfo { running })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let relay_state = RelayState {
        child: Arc::new(Mutex::new(None)),
        running: Arc::new(Mutex::new(false)),
        auto_restart_enabled: Arc::new(Mutex::new(true)),
    };

    let child_handle = relay_state.child.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .manage(relay_state)
        .invoke_handler(tauri::generate_handler![
            start_relay,
            stop_relay,
            restart_relay,
            relay_status,
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
                match spawn_relay(&app_handle) {
                    Ok(child) => {
                        if let Some(state) = app_handle.try_state::<RelayState>() {
                            *state.child.lock().await = Some(child);
                            *state.running.lock().await = true;
                        }
                        log::info!("[relay] sidecar started successfully");
                    }
                    Err(e) => {
                        log::error!("[relay] failed to start sidecar on launch: {e}");
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
