//! Always-on-top overlay window scaffolding + SSE bridge from the relay
//! `GET /api/events/tool-calls` mgmt-socket endpoint to a Tauri renderer
//! event named `tool-call-event`.
//!
//! Phase 2 deliverable. The overlay UI itself lives in `src/routes/overlay`
//! and is filled out in Phase 4; Phase 5 owns the persistent settings /
//! migration that decides whether `overlay_enabled` is true on startup.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::api_proxy;
use crate::sse;

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

/// Compile-time configuration for the overlay window builder. Phase 5 will
/// populate this from `config.toml`; Phase 2 hardcodes the default.
#[derive(Debug, Clone)]
pub struct OverlaySettings {
    pub enabled: bool,
    pub position: OverlayPosition,
}

impl Default for OverlaySettings {
    fn default() -> Self {
        Self {
            enabled: true,
            position: OverlayPosition::BottomRight,
        }
    }
}

/// Four-corner positioning model for the overlay window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
    // adapter-static prerenders the `/overlay` route to `build/overlay.html`
    // (see `src/routes/overlay/+page.ts`); load it explicitly so we don't
    // depend on Tauri's optional `.html` auto-suffix.
    let url = WebviewUrl::App(PathBuf::from("overlay.html"));
    let mut builder = tauri::WebviewWindowBuilder::new(app, OVERLAY_WINDOW_LABEL, url)
        .title("Endara Overlay")
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focusable(false)
        .shadow(false)
        .visible(true)
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
    // Click-through by default — Phase 4 will flip this per-card.
    if let Err(e) = window.set_ignore_cursor_events(true) {
        log::warn!("[overlay] set_ignore_cursor_events failed: {e}");
    }
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
}
