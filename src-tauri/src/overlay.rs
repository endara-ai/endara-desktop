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

use arc_swap::ArcSwap;
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

// ---- Cursor poller + hit rects ---------------------------------------------
//
// Production builds keep the overlay window in `set_ignore_cursor_events(true)`
// so it never steals input. That makes renderer pointer handlers useless for
// re-enabling interactivity: a click-through window receives no pointer events
// from the OS, so `pointerenter` never fires — the classic deadlock. Instead,
// the renderer reports the visible card rects (`set_overlay_hit_rects`), and a
// Rust-side poller compares the global cursor position against them, flipping
// the ignore flag on inside/outside transitions. With no rects there is
// nothing to hover, so the poller is stopped entirely (zero idle cost).

/// Poll interval for the cursor poller while hit rects are present. Fast
/// enough that hover feels immediate, slow enough to be negligible CPU.
#[cfg(not(target_os = "macos"))]
const HIT_RECT_POLL_INTERVAL: Duration = Duration::from_millis(90);

/// Axis-aligned card hit rect in overlay-window viewport coordinates
/// (CSS / logical pixels), as reported by the renderer. Mirrors the
/// `HitRect` type in `src/lib/overlay/overlay-helpers.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct HitRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl HitRect {
    /// Half-open containment check (`[x, x+w) × [y, y+h)`).
    pub fn contains(&self, px: f64, py: f64) -> bool {
        px >= self.x && px < self.x + self.width && py >= self.y && py < self.y + self.height
    }
}

/// True when any rect contains the point.
pub fn any_rect_contains(rects: &[HitRect], x: f64, y: f64) -> bool {
    rects.iter().any(|r| r.contains(x, y))
}

/// Convert a global cursor position (physical pixels) into the overlay
/// window's viewport coordinate space (logical / CSS pixels) so it can be
/// compared against renderer-reported `getBoundingClientRect` values. The
/// overlay window is undecorated, so its outer position IS the viewport
/// origin. A non-positive scale factor (defensive; never expected from
/// Tauri) falls back to 1.0 rather than dividing by zero.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn cursor_to_viewport(
    cursor: PhysicalPosition<f64>,
    window_pos: PhysicalPosition<i32>,
    scale_factor: f64,
) -> (f64, f64) {
    let scale = if scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    (
        (cursor.x - window_pos.x as f64) / scale,
        (cursor.y - window_pos.y as f64) / scale,
    )
}

/// Tauri-managed shared state for overlay click routing. `rects` holds the
/// renderer-reported card rects (viewport / CSS px). On macOS the overlay's
/// `hitTest:` override reads them lock-free on the AppKit main thread; on
/// other platforms the cursor poller reads them and `poller` holds its task
/// handle so an empty report can abort it.
#[derive(Default)]
pub struct OverlayHitState {
    rects: Arc<ArcSwap<Vec<HitRect>>>,
    #[cfg(not(target_os = "macos"))]
    poller: std::sync::Mutex<Option<JoinHandle<()>>>,
}

/// Apply a renderer hit-rect report.
///
/// On macOS the overlay's `hitTest:` override (see [`macos_panel`]) reads the
/// rects directly on the AppKit main thread, so all this does is a single
/// lock-free store per renderer report — no poller, no `setIgnoresMouseEvents`
/// toggle. On other platforms it drives the cursor poller.
pub fn update_hit_rects(app: &AppHandle, state: &OverlayHitState, rects: Vec<HitRect>) {
    #[cfg(target_os = "macos")]
    {
        // The overlay content view's `hitTest:` override consults these rects
        // synchronously on every mouse event; storing them is the whole job.
        let _ = app;
        state.rects.store(Arc::new(rects));
    }
    #[cfg(not(target_os = "macos"))]
    {
        update_hit_rects_polled(app, state, rects);
    }
}

/// Cursor-poller variant of [`update_hit_rects`] for platforms without the
/// macOS `hitTest:` override. Empty report → abort the poller and restore
/// click-through (covers "last card dismissed while hovered"). Non-empty →
/// ensure exactly one poller task is running.
///
/// Debug builds are a no-op: `build_overlay_window` never enables
/// click-through there (the window stays fully interactive for devtools), so
/// a poller toggling the ignore flag would only break that.
#[cfg(not(target_os = "macos"))]
fn update_hit_rects_polled(app: &AppHandle, state: &OverlayHitState, rects: Vec<HitRect>) {
    if cfg!(debug_assertions) {
        return;
    }
    let empty = rects.is_empty();
    state.rects.store(Arc::new(rects));

    let mut poller = state.poller.lock().expect("poller mutex poisoned");
    if empty {
        if let Some(task) = poller.take() {
            task.abort();
        }
        // The aborted poller may have left the window interactive (cursor
        // was inside a card when it disappeared) — restore click-through.
        if let Some(w) = app.get_webview_window(OVERLAY_WINDOW_LABEL) {
            if let Err(e) = w.set_ignore_cursor_events(true) {
                log::warn!("[overlay] set_ignore_cursor_events(true) on idle failed: {e}");
            }
        }
        return;
    }

    let running = poller.as_ref().map(|t| !t.is_finished()).unwrap_or(false);
    if running {
        return;
    }
    let app = app.clone();
    let rects = Arc::clone(&state.rects);
    *poller = Some(tokio::spawn(async move {
        cursor_poll_loop(app, rects).await;
    }));
}

/// Poll the global cursor position against the shared hit rects, toggling
/// the overlay window's ignore-cursor-events flag on inside/outside
/// transitions only (the underlying OS call is not free). Exits when the
/// overlay window is gone (overlay disabled); `update_hit_rects` aborts it
/// when the rect list empties.
#[cfg(not(target_os = "macos"))]
async fn cursor_poll_loop(app: AppHandle, rects: Arc<ArcSwap<Vec<HitRect>>>) {
    let mut hovering = false;
    loop {
        tokio::time::sleep(HIT_RECT_POLL_INTERVAL).await;
        let Some(window) = app.get_webview_window(OVERLAY_WINDOW_LABEL) else {
            return;
        };
        // `cursor_position()` is global/physical; combine with the window's
        // position + scale factor to land in the renderer's coordinate
        // space. Any error (e.g. cursor query unsupported mid-teardown)
        // counts as "outside" so the window fails safe into click-through.
        let inside = match (window.cursor_position(), window.outer_position()) {
            (Ok(cursor), Ok(pos)) => {
                let scale = window.scale_factor().unwrap_or(1.0);
                let (x, y) = cursor_to_viewport(cursor, pos, scale);
                let rects = rects.load();
                any_rect_contains(&rects, x, y)
            }
            _ => false,
        };
        if inside != hovering {
            if let Err(e) = window.set_ignore_cursor_events(!inside) {
                log::warn!(
                    "[overlay] set_ignore_cursor_events({}) failed: {e}",
                    !inside
                );
                continue;
            }
            hovering = inside;
        }
    }
}

/// macOS-native overlay click routing: a non-activating panel plus an
/// `NSView` `hitTest:` override that consults renderer-reported card rects so
/// clicks inside a card reach the WKWebView and clicks elsewhere pass through
/// to whatever window is underneath. Replaces the cursor poller +
/// `setIgnoresMouseEvents` toggle, which raced AppKit's event routing and let
/// clicks activate Endara instead of reaching the webview.
#[cfg(target_os = "macos")]
mod macos_panel {
    use std::sync::Arc;

    use arc_swap::ArcSwap;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker};
    use objc2_app_kit::{NSAutoresizingMaskOptions, NSView, NSWindow, NSWindowStyleMask};
    use objc2_foundation::NSPoint;

    use super::{any_rect_contains, HitRect};

    /// Instance state for [`OverlayHitTestView`]: the shared, lock-free card
    /// rects refreshed by `set_overlay_hit_rects`.
    pub(super) struct OverlayHitTestIvars {
        rects: Arc<ArcSwap<Vec<HitRect>>>,
    }

    define_class!(
        /// Thin wrapper installed as the overlay window's content view.
        /// `hitTest:` consults the renderer-reported card rects so clicks
        /// inside a card reach the WKWebView while clicks elsewhere return
        /// `nil` and pass through to whatever window is underneath.
        #[unsafe(super(NSView))]
        #[ivars = OverlayHitTestIvars]
        pub(super) struct OverlayHitTestView;

        impl OverlayHitTestView {
            /// `point` arrives in the superview's coordinate system; convert it
            /// into our local (flipped, top-left) space so it lines up with the
            /// renderer's CSS-pixel rects, then route the click.
            #[unsafe(method(hitTest:))]
            fn hit_test(&self, point: NSPoint) -> *mut NSView {
                // SAFETY: `superview` returns a borrowed view we use only for
                // the immediately-following coordinate conversion.
                let superview = unsafe { self.superview() };
                let local = self.convertPoint_fromView(point, superview.as_deref());
                let guard = self.ivars().rects.load();
                let rects: &[HitRect] = &guard;
                if any_rect_contains(rects, local.x, local.y) {
                    // Inside a card → let NSView descend to the WKWebView.
                    unsafe { msg_send![super(self), hitTest: point] }
                } else {
                    // Outside every card → pass the click through.
                    std::ptr::null_mut()
                }
            }

            /// Top-left origin so local coordinates match the renderer's
            /// `getBoundingClientRect` values (CSS px, top-left) with no Y flip.
            #[unsafe(method(isFlipped))]
            fn is_flipped(&self) -> bool {
                true
            }

            /// Deliver the very first click immediately even when the panel was
            /// not previously key — no separate activation click.
            #[unsafe(method(acceptsFirstMouse:))]
            fn accepts_first_mouse(&self, _event: *mut AnyObject) -> bool {
                true
            }
        }
    );

    impl OverlayHitTestView {
        fn new(mtm: MainThreadMarker, rects: Arc<ArcSwap<Vec<HitRect>>>) -> Retained<Self> {
            let this = mtm
                .alloc::<OverlayHitTestView>()
                .set_ivars(OverlayHitTestIvars { rects });
            unsafe { msg_send![super(this), init] }
        }
    }

    /// Convert the overlay window into a non-activating panel and wrap its
    /// content view with [`OverlayHitTestView`]. Must run on the AppKit main
    /// thread. `ns_window_addr` is the live `NSWindow` pointer smuggled across
    /// the closure boundary as a `usize` (raw pointers are not `Send`).
    pub(super) fn configure(ns_window_addr: usize, rects: Arc<ArcSwap<Vec<HitRect>>>) {
        let Some(mtm) = MainThreadMarker::new() else {
            log::warn!(target: "overlay", "overlay panel setup skipped: not on the main thread");
            return;
        };
        // SAFETY: `ns_window_addr` is the live `NSWindow` returned by
        // `ns_window()`, only dereferenced here on the main thread.
        let ns_window: &NSWindow = unsafe { &*(ns_window_addr as *const NSWindow) };

        // Keep the overlay anchored to its computed corner (NSWindow defaults
        // to `isMovable = true`, which would let the user drag it anywhere by
        // clicking-and-holding any part of it, including transparent regions).
        ns_window.setMovable(false);

        // Non-activating panel: clicking the overlay must not activate Endara
        // or raise its main window. `NSWindowStyleMaskNonactivatingPanel`
        // (1 << 7) is the style every macOS HUD/overlay uses.
        let style = ns_window.styleMask();
        ns_window.setStyleMask(style | NSWindowStyleMask::NonactivatingPanel);

        let Some(content) = ns_window.contentView() else {
            log::warn!(target: "overlay", "overlay panel setup: window has no content view to wrap");
            return;
        };

        let wrapper = OverlayHitTestView::new(mtm, rects);
        wrapper.setFrame(content.frame());
        let resize = NSAutoresizingMaskOptions::ViewWidthSizable
            | NSAutoresizingMaskOptions::ViewHeightSizable;
        wrapper.setAutoresizingMask(resize);

        // `setContentView:` detaches `content` from the window; our retained
        // handle keeps it alive so we can re-parent it under the wrapper.
        let wrapper_view: &NSView = &wrapper;
        ns_window.setContentView(Some(wrapper_view));

        let content_view: &NSView = &content;
        content_view.setFrame(wrapper.bounds());
        content_view.setAutoresizingMask(resize);
        wrapper.addSubview(content_view);

        log::info!(
            target: "overlay",
            "overlay configured as non-activating panel with hitTest passthrough"
        );
    }
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

    // Case 1 only: scaffold a complete `[relay]` table so the generated
    // `config.toml` is self-documenting and the relay's `RelayConfig` (which
    // requires `machine_name`) can deserialize it on its first reload. On
    // upgrade (Case 2) we leave `[relay]` exactly as the existing install had
    // it; explicit settings (Case 3) already returned above.
    if !file_existed_before {
        ensure_relay_machine_name(&mut table);
    }

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

/// Scaffold a `[relay]` table carrying `machine_name` so a freshly-seeded
/// `config.toml` is complete and the relay can deserialize it on its first
/// reload. `machine_name` is derived from the system hostname (fallback
/// `"unknown"`), mirroring the pattern used by the `set_*` config commands in
/// `lib.rs`. Idempotent: never overwrites an existing `[relay]` table or an
/// existing `machine_name`.
fn ensure_relay_machine_name(table: &mut toml::Table) {
    let relay = table
        .entry("relay")
        .or_insert_with(|| toml::Value::Table(toml::Table::new()));
    let Some(relay) = relay.as_table_mut() else {
        return;
    };
    if relay.contains_key("machine_name") {
        return;
    }
    let machine_name = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "unknown".to_string());
    relay.insert(
        "machine_name".to_string(),
        toml::Value::String(machine_name),
    );
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

    // On macOS, convert the overlay into a non-activating panel and wrap its
    // content view with an `NSView` `hitTest:` override (see `macos_panel`):
    // clicks inside a renderer-reported card rect reach the WKWebView, clicks
    // elsewhere pass through to the window underneath, and the overlay never
    // activates Endara. This also pins the window in place (`setMovable:
    // false`) so it can't be dragged off its computed corner. Dispatch onto
    // the macOS main thread because `build_overlay_window` can be invoked from
    // a Tauri command worker thread (`set_overlay_settings` → enable overlay
    // from Settings) where calling AppKit selectors directly aborts the
    // process. The window is built hidden (`visible(false)` above) and only
    // revealed via the `overlay-render-ready` event / 500ms safety net below,
    // both of which themselves go through the main thread, so this lands before
    // the window can appear.
    #[cfg(target_os = "macos")]
    {
        let rects = Arc::clone(&app.state::<OverlayHitState>().rects);
        match window.ns_window() {
            Ok(ptr) if !ptr.is_null() => {
                // Raw pointers are not `Send`; smuggle the `NSWindow`
                // address across the closure boundary as a `usize`.
                let ns_window_addr = ptr as usize;
                if let Err(e) = app.run_on_main_thread(move || {
                    macos_panel::configure(ns_window_addr, rects);
                }) {
                    log::warn!(
                        target: "overlay",
                        "run_on_main_thread for overlay panel setup failed: {e}; overlay stays a plain activating window"
                    );
                }
            }
            Ok(_) => log::warn!(
                target: "overlay",
                "ns_window() returned null; overlay panel setup skipped"
            ),
            Err(e) => log::warn!(
                target: "overlay",
                "ns_window() failed: {e}; overlay panel setup skipped"
            ),
        }
    }

    // Non-macOS: click-through by default — the Rust-side cursor poller (see
    // `update_hit_rects` / `cursor_poll_loop` above) flips this while the
    // global cursor is over a renderer-reported card rect. In debug builds we
    // skip the global click-through so the overlay window is fully interactive
    // and right-click → Inspect works from devtools; production builds keep the
    // click-through behaviour so the overlay never steals input from the user's
    // other windows. macOS routes clicks via the panel + `hitTest:` override
    // installed above and never toggles `set_ignore_cursor_events`.
    #[cfg(not(target_os = "macos"))]
    {
        if cfg!(debug_assertions) {
            log::info!(
                target: "overlay",
                "debug build: overlay window is interactive (set_ignore_cursor_events skipped); right-click → Inspect to open devtools"
            );
        } else if let Err(e) = window.set_ignore_cursor_events(true) {
            log::warn!("[overlay] set_ignore_cursor_events failed: {e}");
        }
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
    fn hit_rect_contains_inside_and_edges() {
        let r = HitRect {
            x: 20.0,
            y: 100.0,
            width: 340.0,
            height: 72.0,
        };
        assert!(r.contains(20.0, 100.0), "top-left corner is inclusive");
        assert!(r.contains(189.0, 135.0), "interior point");
        assert!(!r.contains(360.0, 135.0), "right edge is exclusive");
        assert!(!r.contains(189.0, 172.0), "bottom edge is exclusive");
        assert!(!r.contains(19.9, 135.0), "left of rect");
        assert!(!r.contains(189.0, 99.9), "above rect");
    }

    #[test]
    fn any_rect_contains_checks_all_rects() {
        let rects = [
            HitRect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
            HitRect {
                x: 100.0,
                y: 100.0,
                width: 10.0,
                height: 10.0,
            },
        ];
        assert!(any_rect_contains(&rects, 5.0, 5.0));
        assert!(any_rect_contains(&rects, 105.0, 105.0));
        assert!(!any_rect_contains(&rects, 50.0, 50.0));
        assert!(!any_rect_contains(&[], 5.0, 5.0));
    }

    #[test]
    fn hit_test_passthrough_matches_card_rects_in_local_coords() {
        // Decision logic of the macOS `hitTest:` override: the wrapper view is
        // flipped (top-left origin), so renderer rects compare directly against
        // the view-local point with no Y inversion. Inside a card → capture
        // (return super.hitTest); outside every card → pass through (return
        // nil). Coordinates mirror a real diagnostic-log report.
        let cards = [
            HitRect {
                x: 40.0,
                y: 1032.0,
                width: 340.0,
                height: 100.0,
            },
            HitRect {
                x: 40.0,
                y: 900.0,
                width: 340.0,
                height: 100.0,
            },
        ];
        // Point inside the first card → captured.
        assert!(any_rect_contains(&cards, 47.3, 1060.6));
        // Gap between the two cards → passed through.
        assert!(!any_rect_contains(&cards, 200.0, 1010.0));
        // Transparent strip left of the cards → passed through.
        assert!(!any_rect_contains(&cards, 10.0, 1060.0));
        // No cards at all → everything passes through.
        assert!(!any_rect_contains(&[], 47.3, 1060.6));
    }

    #[test]
    fn cursor_to_viewport_translates_and_scales() {
        // Window at physical (1520, 216) on a 2x display; cursor at
        // physical (1560, 416) → viewport logical (20, 100).
        let (x, y) = cursor_to_viewport(
            PhysicalPosition::new(1560.0f64, 416.0f64),
            PhysicalPosition::new(1520i32, 216i32),
            2.0,
        );
        assert_eq!(x, 20.0);
        assert_eq!(y, 100.0);
    }

    #[test]
    fn cursor_to_viewport_identity_at_scale_one() {
        let (x, y) = cursor_to_viewport(
            PhysicalPosition::new(100.0f64, 50.0f64),
            PhysicalPosition::new(0i32, 0i32),
            1.0,
        );
        assert_eq!((x, y), (100.0, 50.0));
    }

    #[test]
    fn cursor_to_viewport_guards_non_positive_scale() {
        let (x, y) = cursor_to_viewport(
            PhysicalPosition::new(10.0f64, 10.0f64),
            PhysicalPosition::new(0i32, 0i32),
            0.0,
        );
        assert_eq!((x, y), (10.0, 10.0));
    }

    #[test]
    fn hit_rect_deserializes_from_renderer_shape() {
        let json = r#"{"x":20.5,"y":100.0,"width":340.0,"height":72.25}"#;
        let r: HitRect = serde_json::from_str(json).unwrap();
        assert_eq!(
            r,
            HitRect {
                x: 20.5,
                y: 100.0,
                width: 340.0,
                height: 72.25,
            }
        );
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
        // Fresh install scaffolds a complete `[relay]` table with a
        // non-empty `machine_name` so the relay can deserialize the config.
        let relay = table["relay"].as_table().unwrap();
        let machine_name = relay["machine_name"].as_str().unwrap();
        assert!(
            !machine_name.is_empty(),
            "fresh install must seed a non-empty relay.machine_name"
        );
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
        // Upgrade must NOT inject a `machine_name` into the existing
        // `[relay]` table.
        assert!(
            !table["relay"]
                .as_table()
                .unwrap()
                .contains_key("machine_name"),
            "upgrade must not add relay.machine_name"
        );
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
        // Upgrade must NOT inject a `machine_name` into the existing
        // `[relay]` table.
        assert!(
            !table["relay"]
                .as_table()
                .unwrap()
                .contains_key("machine_name"),
            "upgrade must not add relay.machine_name"
        );
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
