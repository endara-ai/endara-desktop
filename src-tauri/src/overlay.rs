//! Always-on-top overlay window scaffolding + SSE bridge from the relay
//! `GET /api/events/tool-calls` mgmt-socket endpoint to a Tauri renderer
//! event named `tool-call-event`.
//!
//! Phase 2 deliverable. The overlay UI itself lives in `src/routes/overlay`
//! and is filled out in Phase 4; Phase 5 owns the persistent settings /
//! migration that decides whether `overlay_enabled` is true on startup.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::async_runtime;
use tauri::webview::Color;
use tauri::{
    AppHandle, Emitter, Listener, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindow,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::api_proxy;
use crate::sse;

/// Current schema version for the `[meta]` block. Bumped only when an
/// incompatible config shape change ships; readers ignore unknown future
/// versions and fall back to defaults.
pub const CONFIG_SCHEMA_VERSION: i64 = 1;

/// Default auto-dismiss window applied to overlay groups after the last
/// in-flight request settles. Mirrors the toast store's `DEFAULT_OPTS`.
pub const DEFAULT_AUTO_DISMISS_MS: u32 = 2000;

/// Default maximum number of overlay cards rendered at once. Older groups
/// collapse into a "+N earlier" affordance.
pub const DEFAULT_MAX_VISIBLE: u8 = 4;

/// Inclusive bounds enforced when persisting/loading the auto-dismiss window.
pub const AUTO_DISMISS_MS_MIN: u32 = 1000;
pub const AUTO_DISMISS_MS_MAX: u32 = 10_000;

/// Inclusive bounds enforced when persisting/loading the max-visible count.
pub const MAX_VISIBLE_MIN: u8 = 1;
pub const MAX_VISIBLE_MAX: u8 = 8;

/// Stable label for the overlay `WebviewWindow`. Used by capability scoping
/// and by [`crate::lib::show_overlay`] / [`crate::lib::hide_overlay`].
pub const OVERLAY_WINDOW_LABEL: &str = "overlay";

/// Initial overlay width in physical pixels. The overlay stacks cards along
/// the right edge of the primary monitor.
const OVERLAY_WIDTH: f64 = 400.0;

/// Fraction of the primary monitor height the overlay occupies.
const OVERLAY_HEIGHT_FRACTION: f64 = 0.80;

/// Initial backoff for SSE reconnect attempts (sidecar restart, dropped pipe).
const SSE_BACKOFF_INITIAL: Duration = Duration::from_millis(500);

/// Hard cap for the exponential SSE reconnect backoff.
const SSE_BACKOFF_MAX: Duration = Duration::from_secs(30);

/// Runtime configuration for the overlay window. Persisted under
/// `[desktop.overlay]` in `config.toml`; the Phase 5 settings UI / tray
/// toggle round-trip through this struct via the
/// `get_overlay_settings` / `set_overlay_settings` Tauri commands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", default)]
pub struct OverlaySettings {
    pub enabled: bool,
    pub position: OverlayPosition,
    pub auto_dismiss_ms: u32,
    pub max_visible: u8,
    pub show_profile: bool,
}

impl Default for OverlaySettings {
    fn default() -> Self {
        Self {
            enabled: true,
            position: OverlayPosition::BottomRight,
            auto_dismiss_ms: DEFAULT_AUTO_DISMISS_MS,
            max_visible: DEFAULT_MAX_VISIBLE,
            show_profile: true,
        }
    }
}

impl OverlaySettings {
    /// Clamp out-of-range numeric fields to the documented bounds. Called by
    /// `set_overlay_settings` before persisting so a misbehaving renderer
    /// can't write `auto_dismiss_ms = 0` (which would render the dismiss
    /// timer immediately) or a `max_visible` value that the UI cannot
    /// represent meaningfully.
    pub fn sanitize(mut self) -> Self {
        self.auto_dismiss_ms = self
            .auto_dismiss_ms
            .clamp(AUTO_DISMISS_MS_MIN, AUTO_DISMISS_MS_MAX);
        self.max_visible = self.max_visible.clamp(MAX_VISIBLE_MIN, MAX_VISIBLE_MAX);
        self
    }
}

/// Four-corner positioning model for the overlay window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OverlayPosition {
    BottomRight,
    BottomLeft,
    TopRight,
    TopLeft,
}

impl OverlayPosition {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "bottom-right" => Ok(Self::BottomRight),
            "bottom-left" => Ok(Self::BottomLeft),
            "top-right" => Ok(Self::TopRight),
            "top-left" => Ok(Self::TopLeft),
            other => Err(format!(
                "invalid overlay position {other:?} (expected one of bottom-right/bottom-left/top-right/top-left)"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::BottomRight => "bottom-right",
            Self::BottomLeft => "bottom-left",
            Self::TopRight => "top-right",
            Self::TopLeft => "top-left",
        }
    }
}

/// Tauri-managed handle to the running SSE bridge task. `subscribe_*` swaps
/// the inner `JoinHandle` in; `unsubscribe_*` (and app exit) abort it.
#[derive(Default)]
pub struct OverlaySubscriberState {
    pub task: Arc<Mutex<Option<JoinHandle<()>>>>,
}

/// Resolve the overlay's effective settings on startup, writing migration
/// state to disk on first run / first upgrade.
///
/// Three cases (matching the spec's migration table):
///
///   1. **Fresh install** (`!file_existed_before`): seed a brand-new
///      `config.toml` with `[desktop.overlay] enabled = true` plus a
///      `[meta]` block, and return defaults with `enabled: true`.
///   2. **Existing install upgrading** (file existed AND neither
///      `[desktop.overlay].enabled` nor `[meta]` are present): write the
///      `[desktop.overlay]` defaults with `enabled = false` (off-by-default
///      for existing users) plus a `[meta]` block so subsequent runs know
///      the migration ran. Return defaults with `enabled: false`.
///   3. **Explicit setting** (file existed AND `[desktop.overlay].enabled`
///      key is present): honour the persisted value verbatim — never
///      overwrite a user choice, never re-stamp `[meta]` if it already
///      exists.
///
/// `file_existed_before` MUST reflect the on-disk state captured BEFORE any
/// other code path (in particular the relay sidecar) has had a chance to
/// create or write `config.toml`. The desktop entry point in `lib.rs`
/// captures it at the very top of `setup()` and threads it here.
pub fn ensure_overlay_default(
    cfg_path: &Path,
    file_existed_before: bool,
) -> Result<OverlaySettings, String> {
    let mut table = if file_existed_before && cfg_path.exists() {
        let contents = std::fs::read_to_string(cfg_path)
            .map_err(|e| format!("read {}: {e}", cfg_path.display()))?;
        contents
            .parse::<toml::Table>()
            .map_err(|e| format!("parse {}: {e}", cfg_path.display()))?
    } else {
        toml::Table::new()
    };

    // Case 3: explicit setting already on disk. Honour it as-is, don't
    // re-stamp `[meta]`, don't rewrite the file.
    if file_existed_before {
        if let Some(existing) = read_overlay_section(&table) {
            return Ok(existing.sanitize());
        }
    }

    // Cases 1 & 2 both write the defaults block + `[meta]`. The only
    // difference is the `enabled` flag.
    let defaults = OverlaySettings {
        enabled: !file_existed_before,
        ..OverlaySettings::default()
    };
    write_overlay_section(&mut table, &defaults);
    ensure_meta_block(&mut table);

    if let Some(parent) = cfg_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create config directory {}: {e}", parent.display()))?;
    }
    let serialized =
        toml::to_string_pretty(&table).map_err(|e| format!("serialize config: {e}"))?;
    std::fs::write(cfg_path, serialized)
        .map_err(|e| format!("write {}: {e}", cfg_path.display()))?;

    Ok(defaults)
}

/// Extract `[desktop.overlay]` from the parsed config, returning `None` if
/// either the `[desktop]` table or the `[desktop.overlay]` sub-table is
/// missing or shaped wrong. A present table missing the `enabled` key is
/// still treated as "not set" — the migration helper relies on this so an
/// upgrading install with `[desktop]` (e.g. `update_channel = "stable"`) but
/// no `overlay` sub-table still falls into case 2.
fn read_overlay_section(table: &toml::Table) -> Option<OverlaySettings> {
    let overlay = table
        .get("desktop")
        .and_then(|v| v.as_table())
        .and_then(|t| t.get("overlay"))
        .and_then(|v| v.as_table())?;
    if !overlay.contains_key("enabled") {
        return None;
    }
    let value = toml::Value::Table(overlay.clone());
    value.try_into::<OverlaySettings>().ok()
}

/// Merge `settings` into the `[desktop.overlay]` sub-table, creating both
/// the `[desktop]` and `[desktop.overlay]` tables when missing. Preserves
/// any sibling keys already present under `[desktop]` (e.g.
/// `update_channel`).
fn write_overlay_section(table: &mut toml::Table, settings: &OverlaySettings) {
    let desktop = table
        .entry("desktop")
        .or_insert_with(|| toml::Value::Table(toml::Table::new()))
        .as_table_mut()
        .expect("desktop entry just inserted as Table");
    let overlay_value =
        toml::Value::try_from(settings).expect("OverlaySettings serializes to a TOML table");
    desktop.insert("overlay".to_string(), overlay_value);
}

/// Stamp a `[meta]` block onto the config if one is not already present.
/// Idempotent: a config that already carries `[meta]` (from a prior
/// migration run) is left untouched.
fn ensure_meta_block(table: &mut toml::Table) {
    if table.contains_key("meta") {
        return;
    }
    let mut meta = toml::Table::new();
    meta.insert(
        "schema_version".to_string(),
        toml::Value::Integer(CONFIG_SCHEMA_VERSION),
    );
    meta.insert(
        "installed_at".to_string(),
        toml::Value::String(now_rfc3339()),
    );
    table.insert("meta".to_string(), toml::Value::Table(meta));
}

/// Format the current UTC time as an RFC 3339 string, e.g.
/// `"2026-05-27T07:21:03Z"`. Falls back to `"1970-01-01T00:00:00Z"` if the
/// system clock predates the UNIX epoch (effectively impossible on a
/// running desktop).
fn now_rfc3339() -> String {
    use time::format_description::well_known::Rfc3339;
    use time::OffsetDateTime;
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

/// Compute physical-pixel size + position for the overlay window on the
/// primary monitor. Returns `None` if no monitor is available — caller falls
/// back to builder defaults.
pub fn compute_overlay_geometry(
    monitor_size: PhysicalSize<u32>,
    monitor_position: PhysicalPosition<i32>,
    scale_factor: f64,
    position: OverlayPosition,
) -> (PhysicalSize<u32>, PhysicalPosition<i32>) {
    let width_phys = (OVERLAY_WIDTH * scale_factor) as u32;
    let height_phys = ((monitor_size.height as f64) * OVERLAY_HEIGHT_FRACTION) as u32;
    let size = PhysicalSize::new(width_phys.max(1), height_phys.max(1));

    let x = match position {
        OverlayPosition::BottomRight | OverlayPosition::TopRight => monitor_position
            .x
            .saturating_add(monitor_size.width as i32 - size.width as i32),
        OverlayPosition::BottomLeft | OverlayPosition::TopLeft => monitor_position.x,
    };
    let y = match position {
        OverlayPosition::BottomRight | OverlayPosition::BottomLeft => monitor_position
            .y
            .saturating_add(monitor_size.height as i32 - size.height as i32),
        OverlayPosition::TopRight | OverlayPosition::TopLeft => monitor_position.y,
    };

    (size, PhysicalPosition::new(x, y))
}

/// Exponential backoff iterator used by the SSE bridge reconnect loop.
/// Each call to `next` returns the next sleep duration, doubling each time
/// up to `SSE_BACKOFF_MAX`.
#[derive(Debug, Clone)]
pub struct ReconnectBackoff {
    current: Duration,
}

impl ReconnectBackoff {
    pub fn new() -> Self {
        Self {
            current: SSE_BACKOFF_INITIAL,
        }
    }

    pub fn next_delay(&mut self) -> Duration {
        let d = self.current;
        self.current = (self.current * 2).min(SSE_BACKOFF_MAX);
        d
    }

    pub fn reset(&mut self) {
        self.current = SSE_BACKOFF_INITIAL;
    }
}

impl Default for ReconnectBackoff {
    fn default() -> Self {
        Self::new()
    }
}

/// Build the overlay `WebviewWindow`. Caller must check `cfg.enabled` —
/// this function unconditionally builds; the call site decides whether to
/// invoke it.
pub fn build_overlay_window(
    app: &AppHandle,
    cfg: &OverlaySettings,
) -> tauri::Result<WebviewWindow> {
    // adapter-static prerenders the `/overlay` route to
    // `build/overlay/index.html` because the route exports
    // `trailingSlash = 'always'` (see `src/routes/overlay/+page.ts`).
    // `WebviewUrl::App("overlay/")` resolves uniformly in both modes:
    //   - dev:  `http://localhost:1420/overlay/` → SvelteKit/Vite serves the route
    //   - prod: Tauri's asset protocol maps the directory path to its `index.html`
    // Using `"overlay.html"` would 404 in dev (the dev server has no such file).
    let url = WebviewUrl::App(PathBuf::from("overlay/"));
    // Seed the webview's initial background with fully-transparent RGBA so the
    // first frame before our CSS loads is transparent rather than white
    // (covers Windows; macOS webview layer ignores this per Tauri docs, but
    // `transparent(true)` + the CSS handle that path).
    // Build hidden and reveal after the renderer signals it has actually
    // painted (`overlay-render-ready` event from `OverlayApp.svelte`'s
    // double-rAF). `on_page_load(Finished)` fires too early — the HTML is
    // parsed but the transparent CSS has not been composited yet, so the
    // user briefly sees the white default background. The renderer-invoke
    // variant (Phase 4 first attempt) also failed — likely an IPC/capability
    // issue. Tauri's event channel uses a separate transport that only needs
    // `core:event:default` (bundled into the overlay capability's
    // `core:default`), and the 500ms `async_runtime::spawn` safety net
    // below still covers renderer crash / event-system failure.
    let mut builder = tauri::WebviewWindowBuilder::new(app, OVERLAY_WINDOW_LABEL, url)
        .title("Endara Overlay")
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focusable(false)
        .shadow(false)
        .visible(false)
        .background_color(Color(0, 0, 0, 0))
        .accept_first_mouse(true);

    // `transparent` requires the `macos-private-api` Cargo feature on macOS
    // (we enable it in `Cargo.toml`) and `app.macOSPrivateApi = true` in
    // `tauri.conf.json`. On Windows / Linux it Just Works.
    builder = builder.transparent(true);

    #[cfg(target_os = "macos")]
    {
        builder = builder.visible_on_all_workspaces(true);
    }

    // Try to size + position relative to the primary monitor. Tauri's
    // monitor APIs can fail early in `setup` on some Linux compositors;
    // fall back to builder defaults if so.
    if let Some((size, pos)) = primary_monitor_geometry(app, cfg.position) {
        builder = builder.inner_size(size.width as f64, size.height as f64);
        builder = builder.position(pos.x as f64, pos.y as f64);
    }

    let window = builder.build()?;

    // Disable native window dragging on macOS. `NSWindow` defaults to
    // `isMovable = true`, which lets the user drag the entire overlay
    // window by clicking-and-holding anywhere on it (including
    // transparent regions) — wrong for an overlay that must stay
    // anchored to its computed corner. Tauri 2's `WebviewWindowBuilder`
    // does not expose this knob, so call `setMovable:` on the
    // underlying `NSWindow` directly. Dispatch onto the macOS main
    // thread because `build_overlay_window` can be invoked from a
    // Tauri command worker thread (`set_overlay_settings` → enable
    // overlay from Settings) where calling AppKit selectors directly
    // aborts the process. The window is built hidden (`visible(false)`
    // above) and only revealed via the `overlay-render-ready` event /
    // 500ms safety net below, both of which themselves go through the
    // main thread, so the `setMovable:` message lands before the
    // window can appear in a draggable state.
    #[cfg(target_os = "macos")]
    {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        match window.ns_window() {
            Ok(ptr) if !ptr.is_null() => {
                // Raw pointers are not `Send`; smuggle the `NSWindow`
                // address across the closure boundary as a `usize`.
                let ns_window_addr = ptr as usize;
                if let Err(e) = app.run_on_main_thread(move || {
                    let ns_window = ns_window_addr as *mut AnyObject;
                    // SAFETY: `ns_window()` returned the live
                    // `NSWindow` pointer owned by AppKit; we only
                    // borrow it for a single Obj-C message send,
                    // dispatched on the macOS main thread.
                    unsafe {
                        let _: () = msg_send![&*ns_window, setMovable: false];
                    }
                }) {
                    log::warn!(
                        target: "overlay",
                        "run_on_main_thread for setMovable failed: {e}; overlay window remains draggable"
                    );
                }
            }
            Ok(_) => log::warn!(
                target: "overlay",
                "ns_window() returned null; overlay window remains draggable"
            ),
            Err(e) => log::warn!(
                target: "overlay",
                "ns_window() failed: {e}; overlay window remains draggable"
            ),
        }
    }

    // Click-through by default — Phase 4 flips this per-card via the
    // `overlayPointerEnter`/`overlayPointerLeave` actions wired in
    // `OverlayApp.svelte`. In debug builds we skip the global
    // click-through so the overlay window is fully interactive and
    // right-click → Inspect works from devtools; production builds keep
    // the original click-through behaviour so the overlay never steals
    // input from the user's other windows.
    if cfg!(debug_assertions) {
        log::info!(
            target: "overlay",
            "debug build: overlay window is interactive (set_ignore_cursor_events skipped); right-click → Inspect to open devtools"
        );
    } else if let Err(e) = window.set_ignore_cursor_events(true) {
        log::warn!("[overlay] set_ignore_cursor_events failed: {e}");
    }

    // Primary reveal path: the renderer emits `overlay-render-ready` after a
    // double-rAF in `OverlayApp.svelte`'s `onMount`, which guarantees at
    // least one full composited paint cycle has shipped the transparent
    // canvas to the OS compositor before we ask the window manager to make
    // the window visible. `show()` is idempotent, so a second call from the
    // safety net below is a no-op.
    let ready_target = window.clone();
    window.once("overlay-render-ready", move |_event| {
        log::info!(target: "overlay", "render-ready event received — showing window");
        if let Err(e) = ready_target.show() {
            log::warn!("[overlay] show on render-ready failed: {e}");
        }
    });

    // Safety net: if the renderer never emits `overlay-render-ready`
    // (renderer crash, dev server stall, event-system regression, etc.),
    // reveal the window unconditionally after ~500ms so it never stays
    // hidden forever. `show()` is idempotent — calling it after the
    // render-ready handler has already shown the window is a no-op.
    // Use `tauri::async_runtime::spawn` rather than `tokio::spawn` here:
    // `build_overlay_window` runs from Tauri's `setup` hook on the macOS
    // main thread during `did_finish_launching`, where no tokio runtime is
    // active. `tokio::spawn` would panic; the panic cannot unwind across
    // the Objective-C delegate boundary, which aborts the process.
    // `tauri::async_runtime` is runtime-agnostic and always available at
    // setup time (it's tokio-backed, so `tokio::time::sleep` still works).
    let safety = window.clone();
    async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if let Err(e) = safety.show() {
            log::warn!("[overlay] safety-net show failed: {e}");
        }
    });

    Ok(window)
}

/// Resolve primary-monitor geometry into physical pixels for the requested
/// corner. Returns `None` if Tauri cannot enumerate a monitor.
fn primary_monitor_geometry(
    app: &AppHandle,
    position: OverlayPosition,
) -> Option<(PhysicalSize<u32>, PhysicalPosition<i32>)> {
    let monitor = app.primary_monitor().ok().flatten().or_else(|| {
        app.available_monitors()
            .ok()
            .and_then(|m| m.into_iter().next())
    })?;
    Some(compute_overlay_geometry(
        *monitor.size(),
        *monitor.position(),
        monitor.scale_factor(),
        position,
    ))
}

/// Reposition the overlay window to one of the four corners. Idempotent and
/// safe to call while the window is hidden.
pub fn reposition_overlay_window(app: &AppHandle, position: OverlayPosition) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window(OVERLAY_WINDOW_LABEL) else {
        return Ok(());
    };
    if let Some((size, pos)) = primary_monitor_geometry(app, position) {
        window.set_size(size)?;
        window.set_position(pos)?;
    }
    Ok(())
}

/// Spawn the SSE bridge task. Stores the `JoinHandle` in `state.task` so
/// `unsubscribe_tool_call_events` can abort it. If a task is already
/// running, it is aborted first.
pub async fn spawn_sse_bridge(
    state: &OverlaySubscriberState,
    socket_path: std::path::PathBuf,
    window: tauri::Window,
) {
    let mut guard = state.task.lock().await;
    if let Some(prev) = guard.take() {
        prev.abort();
    }
    let handle = tokio::spawn(async move {
        sse_bridge_loop(socket_path, window).await;
    });
    *guard = Some(handle);
}

/// Abort the running SSE bridge task, if any.
pub async fn abort_sse_bridge(state: &OverlaySubscriberState) {
    let mut guard = state.task.lock().await;
    if let Some(task) = guard.take() {
        task.abort();
    }
}

/// Main reconnect loop. Each iteration: dial the socket, send the HTTP
/// request, consume the response body as SSE frames, and emit each frame's
/// JSON payload as a `tool-call-event` window event. On disconnect, sleep
/// for an exponentially-growing backoff (capped at 30s) and retry.
async fn sse_bridge_loop(socket_path: std::path::PathBuf, window: tauri::Window) {
    let mut backoff = ReconnectBackoff::new();
    loop {
        match run_sse_connection(&socket_path, &window).await {
            Ok(()) => {
                // Server closed the stream cleanly — reconnect with the
                // initial backoff so a transient relay restart recovers in
                // <1s.
                log::info!("[overlay] SSE stream closed cleanly; reconnecting");
                backoff.reset();
            }
            Err(e) => {
                let delay = backoff.next_delay();
                log::info!(
                    "[overlay] SSE bridge error: {e}; reconnecting in {:?}",
                    delay
                );
                tokio::time::sleep(delay).await;
            }
        }
    }
}

/// Run a single SSE connection. Returns `Ok(())` if the server closed the
/// stream cleanly (EOF), or `Err(message)` on any I/O / protocol failure
/// (the caller backs off + retries).
async fn run_sse_connection(
    socket_path: &std::path::Path,
    window: &tauri::Window,
) -> Result<(), String> {
    let mut stream = api_proxy::connect_stream(socket_path).await?;

    // Minimal raw HTTP/1.1 GET. The mgmt server is single-purpose and lives
    // on the same socket as the rest of the management API; we don't need
    // hyper for a single one-shot request whose body we will read for the
    // lifetime of the subscription.
    let req = b"GET /api/events/tool-calls HTTP/1.1\r\n\
host: relay.local\r\n\
accept: text/event-stream\r\n\
cache-control: no-cache\r\n\
connection: keep-alive\r\n\
\r\n";
    stream
        .write_all(req)
        .await
        .map_err(|e| format!("write SSE request: {e}"))?;
    stream
        .flush()
        .await
        .map_err(|e| format!("flush SSE request: {e}"))?;

    let mut reader = BufReader::new(stream);
    let status = read_status_line(&mut reader).await?;
    if status != 200 {
        return Err(format!("SSE endpoint returned HTTP {status}"));
    }
    skip_response_headers(&mut reader).await?;

    log::info!("[overlay] SSE stream connected");
    loop {
        match sse::read_frame(&mut reader).await {
            Ok(Some(frame)) => {
                if frame.event == "lagged" {
                    log::warn!(
                        "[overlay] relay reported lagged subscriber; events may have been dropped"
                    );
                    continue;
                }
                match serde_json::from_str::<serde_json::Value>(&frame.data) {
                    Ok(json) => {
                        if let Err(e) = window.emit("tool-call-event", json) {
                            log::warn!("[overlay] emit tool-call-event failed: {e}");
                        }
                    }
                    Err(e) => {
                        log::warn!(
                            "[overlay] dropping non-JSON SSE frame error={e} data={:?}",
                            truncate_for_log(&frame.data, 200)
                        );
                    }
                }
            }
            Ok(None) => return Ok(()),
            Err(e) => return Err(format!("read SSE frame: {e}")),
        }
    }
}

async fn read_status_line<R: AsyncBufReadExt + Unpin>(reader: &mut R) -> Result<u16, String> {
    let mut line = String::new();
    let n = reader
        .read_line(&mut line)
        .await
        .map_err(|e| format!("read status line: {e}"))?;
    if n == 0 {
        return Err("connection closed before status line".to_string());
    }
    // Expected: "HTTP/1.1 200 OK\r\n" (per RFC 9112 §4 — status-line is
    // version SP status-code SP reason-phrase).
    let trimmed = line.trim_end_matches(['\r', '\n']);
    let mut parts = trimmed.splitn(3, ' ');
    let _version = parts.next().ok_or("malformed HTTP status line")?;
    let code = parts.next().ok_or("missing status code")?;
    code.parse::<u16>()
        .map_err(|e| format!("invalid status code {code:?}: {e}"))
}

async fn skip_response_headers<R: AsyncBufReadExt + Unpin>(reader: &mut R) -> Result<(), String> {
    let mut buf = String::new();
    loop {
        buf.clear();
        let n = reader
            .read_line(&mut buf)
            .await
            .map_err(|e| format!("read response header: {e}"))?;
        if n == 0 {
            return Err("connection closed in headers".to_string());
        }
        let trimmed = buf.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            return Ok(());
        }
    }
}

fn truncate_for_log(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max).collect();
        out.push('…');
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    #[test]
    fn overlay_position_round_trips() {
        for p in [
            OverlayPosition::BottomRight,
            OverlayPosition::BottomLeft,
            OverlayPosition::TopRight,
            OverlayPosition::TopLeft,
        ] {
            assert_eq!(OverlayPosition::parse(p.as_str()).unwrap(), p);
        }
    }

    #[test]
    fn overlay_position_rejects_invalid() {
        assert!(OverlayPosition::parse("middle").is_err());
        assert!(OverlayPosition::parse("").is_err());
    }

    #[test]
    fn default_settings_enabled_bottom_right() {
        let s = OverlaySettings::default();
        assert!(s.enabled);
        assert_eq!(s.position, OverlayPosition::BottomRight);
    }

    #[test]
    fn geometry_anchors_bottom_right_corner() {
        let monitor_size = PhysicalSize::new(1920u32, 1080u32);
        let monitor_pos = PhysicalPosition::new(0i32, 0i32);
        let (size, pos) =
            compute_overlay_geometry(monitor_size, monitor_pos, 1.0, OverlayPosition::BottomRight);
        // 400 logical px @ scale 1.0
        assert_eq!(size.width, 400);
        // 80% of 1080
        assert_eq!(size.height, 864);
        // Anchored right edge: 1920 - 400 = 1520
        assert_eq!(pos.x, 1520);
        // Anchored bottom: 1080 - 864 = 216
        assert_eq!(pos.y, 216);
    }

    #[test]
    fn geometry_anchors_top_left_corner() {
        let (size, pos) = compute_overlay_geometry(
            PhysicalSize::new(1920u32, 1080u32),
            PhysicalPosition::new(0i32, 0i32),
            1.0,
            OverlayPosition::TopLeft,
        );
        assert_eq!(pos.x, 0);
        assert_eq!(pos.y, 0);
        assert_eq!(size.width, 400);
    }

    #[test]
    fn geometry_honors_monitor_offset() {
        // Secondary monitor positioned at x=1920.
        let (_size, pos) = compute_overlay_geometry(
            PhysicalSize::new(2560u32, 1440u32),
            PhysicalPosition::new(1920i32, 0i32),
            2.0,
            OverlayPosition::BottomRight,
        );
        // Width at scale 2.0 = 800 px. Right edge of secondary = 1920+2560 = 4480.
        assert_eq!(pos.x, 4480 - 800);
    }

    #[test]
    fn backoff_doubles_then_caps() {
        let mut b = ReconnectBackoff::new();
        let d1 = b.next_delay();
        let d2 = b.next_delay();
        let d3 = b.next_delay();
        assert_eq!(d1, SSE_BACKOFF_INITIAL);
        assert_eq!(d2, SSE_BACKOFF_INITIAL * 2);
        assert_eq!(d3, SSE_BACKOFF_INITIAL * 4);
        // Hammer it past the cap and confirm it saturates.
        for _ in 0..20 {
            let _ = b.next_delay();
        }
        assert_eq!(b.next_delay(), SSE_BACKOFF_MAX);
    }

    #[test]
    fn backoff_reset_returns_to_initial() {
        let mut b = ReconnectBackoff::new();
        for _ in 0..10 {
            let _ = b.next_delay();
        }
        b.reset();
        assert_eq!(b.next_delay(), SSE_BACKOFF_INITIAL);
    }

    #[tokio::test]
    async fn read_status_line_parses_ok_200() {
        let mut r = BufReader::new(&b"HTTP/1.1 200 OK\r\n"[..]);
        let s = read_status_line(&mut r).await.unwrap();
        assert_eq!(s, 200);
    }

    #[tokio::test]
    async fn read_status_line_parses_non_200() {
        let mut r = BufReader::new(&b"HTTP/1.1 500 Internal Server Error\r\n"[..]);
        let s = read_status_line(&mut r).await.unwrap();
        assert_eq!(s, 500);
    }

    #[tokio::test]
    async fn skip_response_headers_consumes_until_blank_line() {
        let bytes =
            b"content-type: text/event-stream\r\ncache-control: no-cache\r\n\r\nbody starts here";
        let mut r = BufReader::new(&bytes[..]);
        skip_response_headers(&mut r).await.unwrap();
        let mut rest = String::new();
        r.read_line(&mut rest).await.unwrap();
        assert_eq!(rest, "body starts here");
    }

    // ---- Phase 5: migration helper tests --------------------------------

    fn read_table(path: &Path) -> toml::Table {
        let txt = std::fs::read_to_string(path).unwrap();
        txt.parse::<toml::Table>().unwrap()
    }

    #[test]
    fn ensure_overlay_default_fresh_install_enables_overlay() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("config.toml");
        // `file_existed_before` is false: the entry point captured the
        // absence of `config.toml` before any other code ran.
        let settings = ensure_overlay_default(&cfg, false).unwrap();
        assert!(settings.enabled, "fresh install must enable overlay");
        assert_eq!(settings.position, OverlayPosition::BottomRight);
        assert_eq!(settings.auto_dismiss_ms, DEFAULT_AUTO_DISMISS_MS);
        assert_eq!(settings.max_visible, DEFAULT_MAX_VISIBLE);
        assert!(settings.show_profile);

        let table = read_table(&cfg);
        let overlay = table["desktop"]["overlay"].as_table().unwrap();
        assert_eq!(overlay["enabled"].as_bool(), Some(true));
        assert_eq!(overlay["position"].as_str(), Some("bottom-right"));
        let meta = table["meta"].as_table().unwrap();
        assert_eq!(
            meta["schema_version"].as_integer(),
            Some(CONFIG_SCHEMA_VERSION)
        );
        assert!(meta.contains_key("installed_at"));
    }

    #[test]
    fn ensure_overlay_default_existing_install_disables_overlay() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("config.toml");
        // Pre-existing config that the relay (or a prior desktop version)
        // wrote. No `[meta]`, no `[desktop.overlay]` — classic upgrade.
        std::fs::write(
            &cfg,
            "[relay]\nport = 7777\n\n[desktop]\nupdate_channel = \"stable\"\n",
        )
        .unwrap();

        let settings = ensure_overlay_default(&cfg, true).unwrap();
        assert!(
            !settings.enabled,
            "upgrading install must default to disabled"
        );
        assert_eq!(settings.position, OverlayPosition::BottomRight);

        let table = read_table(&cfg);
        let overlay = table["desktop"]["overlay"].as_table().unwrap();
        assert_eq!(overlay["enabled"].as_bool(), Some(false));
        // Sibling `[desktop]` key must be preserved verbatim.
        assert_eq!(table["desktop"]["update_channel"].as_str(), Some("stable"));
        // Unrelated tables are untouched.
        assert_eq!(table["relay"]["port"].as_integer(), Some(7777));
        let meta = table["meta"].as_table().unwrap();
        assert_eq!(
            meta["schema_version"].as_integer(),
            Some(CONFIG_SCHEMA_VERSION)
        );
    }

    #[test]
    fn ensure_overlay_default_existing_install_no_desktop_block_disables_overlay() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("config.toml");
        // Pre-existing config that contains ONLY a `[relay]` block — no
        // `[desktop]` table at all. The migration must still treat this as
        // an upgrade (disable overlay by default) and stamp `[meta]`.
        std::fs::write(&cfg, "[relay]\nport = 7777\n").unwrap();

        let settings = ensure_overlay_default(&cfg, true).unwrap();
        assert!(
            !settings.enabled,
            "upgrading install must default to disabled"
        );

        let table = read_table(&cfg);
        let overlay = table["desktop"]["overlay"].as_table().unwrap();
        assert_eq!(overlay["enabled"].as_bool(), Some(false));
        // Unrelated `[relay]` table is untouched.
        assert_eq!(table["relay"]["port"].as_integer(), Some(7777));
        let meta = table["meta"].as_table().unwrap();
        assert_eq!(
            meta["schema_version"].as_integer(),
            Some(CONFIG_SCHEMA_VERSION)
        );
        assert!(meta.contains_key("installed_at"));
    }

    #[test]
    fn ensure_overlay_default_honours_explicit_setting() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("config.toml");
        // User had previously toggled the overlay on with a non-default
        // position. `[meta]` already stamped from the prior migration.
        std::fs::write(
            &cfg,
            r#"
[meta]
schema_version = 1
installed_at = "2025-12-01T00:00:00Z"

[desktop.overlay]
enabled = true
position = "top-left"
auto_dismiss_ms = 3500
max_visible = 6
show_profile = false
"#,
        )
        .unwrap();
        let before = std::fs::read_to_string(&cfg).unwrap();

        let settings = ensure_overlay_default(&cfg, true).unwrap();
        assert!(settings.enabled);
        assert_eq!(settings.position, OverlayPosition::TopLeft);
        assert_eq!(settings.auto_dismiss_ms, 3500);
        assert_eq!(settings.max_visible, 6);
        assert!(!settings.show_profile);

        // File on disk must be byte-identical: we promise not to rewrite a
        // user's explicit choice and not to re-stamp `installed_at`.
        let after = std::fs::read_to_string(&cfg).unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn ensure_overlay_default_clamps_out_of_range_values() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("config.toml");
        std::fs::write(
            &cfg,
            r#"
[desktop.overlay]
enabled = true
position = "bottom-right"
auto_dismiss_ms = 99999
max_visible = 99
show_profile = true
"#,
        )
        .unwrap();
        let s = ensure_overlay_default(&cfg, true).unwrap();
        assert_eq!(s.auto_dismiss_ms, AUTO_DISMISS_MS_MAX);
        assert_eq!(s.max_visible, MAX_VISIBLE_MAX);
    }

    #[test]
    fn ensure_overlay_default_creates_parent_directory() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("nested/sub/config.toml");
        let s = ensure_overlay_default(&cfg, false).unwrap();
        assert!(s.enabled);
        assert!(cfg.exists());
    }
}
