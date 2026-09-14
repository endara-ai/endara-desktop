//! UI heartbeat watchdog.
//!
//! The Rust side emits a `ui-heartbeat` event to the `main` webview every
//! [`HEARTBEAT_INTERVAL`]; the frontend answers with the `ui_heartbeat_ack`
//! command. [`UiWatchdogPolicy`] is a pure state machine (no tauri types) that
//! turns the send/ack stream plus a [`WindowSnapshot`] into transitions
//! (`Stalled` / `Recovered`) and a [`ReloadDecision`]. The tauri glue at the
//! bottom of this file owns the timer, the window queries, and the logging.
//!
//! Recovery rules:
//! - `stalled` after [`STALL_THRESHOLD`] consecutive missed acks (~90 s).
//! - A visible stalled window is reloaded at most once per
//!   [`RELOAD_COOLDOWN`], and at most [`RELOAD_MAX_CONSECUTIVE`] times in a
//!   row without an ack in between; after that the watchdog logs one ERROR
//!   and stops reloading until the page acks or the user reloads manually.
//! - A hidden window is never auto-reloaded (macOS may legitimately throttle
//!   a hidden WKWebView). The reload happens on the next show, but only after
//!   a heartbeat that was *sent while visible* also goes unanswered — so a
//!   merely-throttled page gets a chance to ack before being reloaded.
//! - An outstanding heartbeat younger than [`PROBE_MIN_AGE`] is never counted
//!   as missed, so a focus-triggered probe racing another focus event or the
//!   periodic tick cannot reload a page that had no time to answer.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, Webview};

pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
pub const STALL_THRESHOLD: u32 = 3;
pub const RELOAD_COOLDOWN: Duration = Duration::from_secs(10 * 60);
pub const RELOAD_MAX_CONSECUTIVE: u32 = 3;
pub const PROBE_MIN_AGE: Duration = Duration::from_secs(10);
pub const UI_LOG_MAX_BYTES: usize = 2048;

const MAIN_WINDOW_LABEL: &str = "main";

// ---- Pure policy ------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WindowSnapshot {
    pub visible: bool,
    pub focused: bool,
    pub minimized: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Outstanding {
    seq: u64,
    sent_at: Instant,
    sent_visible: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LastAck {
    seq: u64,
    at: Instant,
    latency: Option<Duration>,
}

/// Context captured at the moment the page is declared stalled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StallReport {
    pub missed: u32,
    pub last_ack_seq: Option<u64>,
    pub last_ack_age: Option<Duration>,
    pub last_ack_latency: Option<Duration>,
    pub window: WindowSnapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeferReason {
    Hidden,
    AwaitingVisibleProbe,
    RateLimited {
        retry_in: Duration,
    },
    /// [`RELOAD_MAX_CONSECUTIVE`] reloads happened without an ack in between.
    GaveUp {
        reloads: u32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReloadDecision {
    None,
    Reload,
    /// Reload is warranted but withheld; `Some` only when the reason differs
    /// from the previously reported one so callers can log it once.
    Deferred(Option<DeferReason>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transition {
    Stalled(StallReport),
    Recovered { stalled_for: Duration, missed: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TickOutcome {
    /// The heartbeat outstanding after this tick.
    pub seq: u64,
    /// `false` when the previous heartbeat was younger than [`PROBE_MIN_AGE`]
    /// and is kept in flight instead of a new one being issued.
    pub emit: bool,
    pub transition: Option<Transition>,
    pub reload: ReloadDecision,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AckOutcome {
    pub latency: Option<Duration>,
    pub transition: Option<Transition>,
}

#[derive(Debug)]
pub struct UiWatchdogPolicy {
    next_seq: u64,
    outstanding: Option<Outstanding>,
    missed: u32,
    last_ack: Option<LastAck>,
    stalled_since: Option<Instant>,
    last_reload_at: Option<Instant>,
    consecutive_reloads: u32,
    last_defer_reported: Option<DeferReason>,
}

impl Default for UiWatchdogPolicy {
    fn default() -> Self {
        Self::new()
    }
}

impl UiWatchdogPolicy {
    pub fn new() -> Self {
        Self {
            next_seq: 1,
            outstanding: None,
            missed: 0,
            last_ack: None,
            stalled_since: None,
            last_reload_at: None,
            consecutive_reloads: 0,
            last_defer_reported: None,
        }
    }

    pub fn is_stalled(&self) -> bool {
        self.stalled_since.is_some()
    }

    #[cfg(test)]
    pub fn missed(&self) -> u32 {
        self.missed
    }

    /// One heartbeat tick: settle the previous heartbeat (a still-outstanding
    /// one counts as a miss), evaluate the stall / reload decision, then hand
    /// out the next sequence number to send. A heartbeat younger than
    /// [`PROBE_MIN_AGE`] is left in flight untouched (`emit: false`).
    pub fn tick(&mut self, now: Instant, window: WindowSnapshot) -> TickOutcome {
        let mut transition = None;
        let mut visible_probe_missed = false;

        if let Some(prev) = self.outstanding {
            if now.saturating_duration_since(prev.sent_at) < PROBE_MIN_AGE {
                return TickOutcome {
                    seq: prev.seq,
                    emit: false,
                    transition: None,
                    reload: ReloadDecision::None,
                };
            }
        }

        if let Some(prev) = self.outstanding.take() {
            self.missed = self.missed.saturating_add(1);
            visible_probe_missed = prev.sent_visible;
            if self.missed == STALL_THRESHOLD && self.stalled_since.is_none() {
                self.stalled_since = Some(now);
                self.last_defer_reported = None;
                transition = Some(Transition::Stalled(self.stall_report(now, window)));
            }
        }

        let reload = if self.stalled_since.is_some() {
            self.decide_reload(now, window, visible_probe_missed)
        } else {
            ReloadDecision::None
        };

        let seq = self.next_seq;
        self.next_seq += 1;
        self.outstanding = Some(Outstanding {
            seq,
            sent_at: now,
            sent_visible: window.visible && !window.minimized,
        });

        TickOutcome {
            seq,
            emit: true,
            transition,
            reload,
        }
    }

    fn decide_reload(
        &mut self,
        now: Instant,
        window: WindowSnapshot,
        visible_probe_missed: bool,
    ) -> ReloadDecision {
        let defer = if !window.visible || window.minimized {
            Some(DeferReason::Hidden)
        } else if !visible_probe_missed {
            Some(DeferReason::AwaitingVisibleProbe)
        } else if self.consecutive_reloads >= RELOAD_MAX_CONSECUTIVE {
            Some(DeferReason::GaveUp {
                reloads: self.consecutive_reloads,
            })
        } else {
            self.reload_retry_in(now)
                .map(|retry_in| DeferReason::RateLimited { retry_in })
        };

        match defer {
            Some(reason) => {
                let changed = !matches!(
                    (self.last_defer_reported, reason),
                    (Some(DeferReason::Hidden), DeferReason::Hidden)
                        | (
                            Some(DeferReason::AwaitingVisibleProbe),
                            DeferReason::AwaitingVisibleProbe
                        )
                        | (
                            Some(DeferReason::RateLimited { .. }),
                            DeferReason::RateLimited { .. }
                        )
                        | (Some(DeferReason::GaveUp { .. }), DeferReason::GaveUp { .. })
                );
                self.last_defer_reported = Some(reason);
                ReloadDecision::Deferred(changed.then_some(reason))
            }
            None => {
                self.last_reload_at = Some(now);
                self.consecutive_reloads += 1;
                self.last_defer_reported = None;
                ReloadDecision::Reload
            }
        }
    }

    /// The frontend answered heartbeat `seq`. Any ack proves the page is
    /// alive, so the miss counter resets regardless of which seq it names;
    /// latency is only measured against the currently outstanding heartbeat.
    pub fn on_ack(&mut self, seq: u64, now: Instant) -> AckOutcome {
        if seq == 0 || seq >= self.next_seq {
            return AckOutcome {
                latency: None,
                transition: None,
            };
        }

        let latency = match self.outstanding {
            Some(o) if o.seq == seq => {
                self.outstanding = None;
                Some(now.saturating_duration_since(o.sent_at))
            }
            _ => None,
        };
        self.last_ack = Some(LastAck {
            seq,
            at: now,
            latency,
        });

        let missed = std::mem::replace(&mut self.missed, 0);
        self.consecutive_reloads = 0;
        let transition = self.stalled_since.take().map(|since| {
            self.last_defer_reported = None;
            Transition::Recovered {
                stalled_for: now.saturating_duration_since(since),
                missed,
            }
        });

        AckOutcome {
            latency,
            transition,
        }
    }

    /// A reload happened outside the policy's own decision (tray "Reload UI").
    /// It counts against the cooldown so the watchdog does not reload the
    /// freshly loaded page again before it has had a chance to ack, and it
    /// re-arms automatic reloads after the watchdog gave up.
    pub fn note_reload(&mut self, now: Instant) {
        self.last_reload_at = Some(now);
        self.consecutive_reloads = 0;
        self.last_defer_reported = None;
    }

    fn stall_report(&self, now: Instant, window: WindowSnapshot) -> StallReport {
        StallReport {
            missed: self.missed,
            last_ack_seq: self.last_ack.map(|a| a.seq),
            last_ack_age: self.last_ack.map(|a| now.saturating_duration_since(a.at)),
            last_ack_latency: self.last_ack.and_then(|a| a.latency),
            window,
        }
    }

    fn reload_retry_in(&self, now: Instant) -> Option<Duration> {
        let last = self.last_reload_at?;
        let elapsed = now.saturating_duration_since(last);
        (elapsed < RELOAD_COOLDOWN).then(|| RELOAD_COOLDOWN - elapsed)
    }
}

// ---- Tauri glue --------------------------------------------------------------

#[derive(Default)]
pub struct UiWatchdogState {
    policy: Mutex<UiWatchdogPolicy>,
}

#[derive(Serialize, Clone)]
struct HeartbeatPayload {
    seq: u64,
    sent_at_ms: u64,
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn fmt_opt_ms(d: Option<Duration>) -> String {
    d.map(|d| format!("{}ms", d.as_millis()))
        .unwrap_or_else(|| "none".to_string())
}

fn fmt_opt_secs(d: Option<Duration>) -> String {
    d.map(|d| format!("{}s", d.as_secs()))
        .unwrap_or_else(|| "never".to_string())
}

fn snapshot_main_window(app: &AppHandle) -> WindowSnapshot {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return WindowSnapshot::default();
    };
    WindowSnapshot {
        visible: window.is_visible().unwrap_or(false),
        focused: window.is_focused().unwrap_or(false),
        minimized: window.is_minimized().unwrap_or(false),
    }
}

/// Reload the main webview. Shared by the watchdog and the tray escape hatch.
pub fn reload_main_webview(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "main window not found".to_string())?;
    window.reload().map_err(|e| e.to_string())
}

/// Reload the main webview on the user's behalf (tray "Reload UI") and start
/// the watchdog's reload cooldown so it does not immediately reload again.
pub fn reload_main_webview_manual(app: &AppHandle) -> Result<(), String> {
    reload_main_webview(app)?;
    if let Some(state) = app.try_state::<UiWatchdogState>() {
        let mut policy = match state.policy.lock() {
            Ok(p) => p,
            Err(poisoned) => poisoned.into_inner(),
        };
        policy.note_reload(Instant::now());
    }
    Ok(())
}

fn log_transition(transition: Transition) {
    match transition {
        Transition::Stalled(r) => log::error!(
            "[ui] webview stalled missed={} threshold={} last_ack_seq={} last_ack_age={} last_ack_latency={} visible={} focused={} minimized={}",
            r.missed,
            STALL_THRESHOLD,
            r.last_ack_seq.map(|s| s.to_string()).unwrap_or_else(|| "none".to_string()),
            fmt_opt_secs(r.last_ack_age),
            fmt_opt_ms(r.last_ack_latency),
            r.window.visible,
            r.window.focused,
            r.window.minimized,
        ),
        Transition::Recovered {
            stalled_for,
            missed,
        } => log::info!(
            "[ui] webview recovered stalled_for={}s missed={}",
            stalled_for.as_secs(),
            missed
        ),
    }
}

fn log_defer(reason: DeferReason, window: WindowSnapshot) {
    match reason {
        DeferReason::Hidden => log::info!(
            "[ui] reload deferred reason=hidden visible={} minimized={}",
            window.visible,
            window.minimized
        ),
        DeferReason::AwaitingVisibleProbe => {
            log::info!("[ui] reload deferred reason=awaiting_visible_heartbeat")
        }
        DeferReason::RateLimited { retry_in } => log::info!(
            "[ui] reload deferred reason=rate_limited retry_in={}s",
            retry_in.as_secs()
        ),
        DeferReason::GaveUp { reloads } => log::error!(
            "[ui] reload gave up: {} consecutive reloads without an ack; not reloading again until the page acks or the user picks Reload UI",
            reloads
        ),
    }
}

/// Run one watchdog tick against the live app: settle the previous heartbeat,
/// act on the resulting decision, and emit the next heartbeat.
fn run_tick(app: &AppHandle) {
    let Some(state) = app.try_state::<UiWatchdogState>() else {
        return;
    };
    let window = snapshot_main_window(app);
    let now = Instant::now();
    let outcome = {
        let mut policy = match state.policy.lock() {
            Ok(p) => p,
            Err(poisoned) => poisoned.into_inner(),
        };
        policy.tick(now, window)
    };

    if let Some(t) = outcome.transition {
        log_transition(t);
    }
    match outcome.reload {
        ReloadDecision::None => {}
        ReloadDecision::Deferred(Some(reason)) => log_defer(reason, window),
        ReloadDecision::Deferred(None) => {}
        ReloadDecision::Reload => {
            log::warn!("[ui] reloading stalled webview trigger=watchdog");
            if let Err(e) = reload_main_webview(app) {
                log::warn!("[ui] reload failed trigger=watchdog error={}", e);
            }
        }
    }

    if !outcome.emit {
        return;
    }
    let payload = HeartbeatPayload {
        seq: outcome.seq,
        sent_at_ms: unix_ms(),
    };
    if let Err(e) = app.emit_to(MAIN_WINDOW_LABEL, "ui-heartbeat", payload) {
        log::debug!("[ui] heartbeat emit failed seq={} error={}", outcome.seq, e);
    }
}

/// Spawn the heartbeat loop. Ticks every [`HEARTBEAT_INTERVAL`]; the first
/// tick is delayed by one interval so the page has time to load.
pub fn spawn_heartbeat(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(HEARTBEAT_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        interval.tick().await;
        loop {
            interval.tick().await;
            run_tick(&app);
        }
    });
    log::info!(
        "[ui] heartbeat watchdog started interval={}s stall_threshold={} reload_cooldown={}s",
        HEARTBEAT_INTERVAL.as_secs(),
        STALL_THRESHOLD,
        RELOAD_COOLDOWN.as_secs()
    );
}

/// Called when the main window gains focus. If the page is currently
/// stalled, run an immediate tick so a stall that began while hidden is
/// re-evaluated (and reloaded, if still active) without waiting up to 30 s.
pub fn on_main_window_focused(app: &AppHandle) {
    let Some(state) = app.try_state::<UiWatchdogState>() else {
        return;
    };
    let stalled = state.policy.lock().map(|p| p.is_stalled()).unwrap_or(false);
    if !stalled {
        return;
    }
    log::info!("[ui] main window focused while stalled; probing now");
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        run_tick(&app);
    });
}

fn truncate_at_char_boundary(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Collapse CR/LF/tab so the message fits on one log line, then truncate to
/// [`UI_LOG_MAX_BYTES`] on a char boundary. The input is pre-truncated so a
/// huge message is not normalized in full; the output is truncated again
/// because expanding separators to ` | ` can grow it.
fn sanitize_ui_message(message: &str) -> String {
    let flattened = truncate_at_char_boundary(message, UI_LOG_MAX_BYTES)
        .split(['\r', '\n'])
        .map(|line| line.trim().replace('\t', " "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" | ");
    truncate_at_char_boundary(&flattened, UI_LOG_MAX_BYTES).to_string()
}

#[tauri::command]
pub fn ui_log(webview: Webview, level: String, message: String) {
    let msg = sanitize_ui_message(&message);
    let label = webview.label();
    let prefix = if label == MAIN_WINDOW_LABEL {
        "[ui]".to_string()
    } else {
        format!("[ui:{label}]")
    };
    match level.as_str() {
        "error" => log::error!("{prefix} {msg}"),
        "warn" | "warning" => log::warn!("{prefix} {msg}"),
        "debug" | "trace" => log::debug!("{prefix} {msg}"),
        _ => log::info!("{prefix} {msg}"),
    }
}

#[tauri::command]
pub fn ui_heartbeat_ack(webview: Webview, state: State<'_, UiWatchdogState>, seq: u64) {
    if webview.label() != MAIN_WINDOW_LABEL {
        return;
    }
    let outcome = {
        let mut policy = match state.policy.lock() {
            Ok(p) => p,
            Err(poisoned) => poisoned.into_inner(),
        };
        policy.on_ack(seq, Instant::now())
    };
    if let Some(t) = outcome.transition {
        log_transition(t);
    }
    if let Some(latency) = outcome.latency {
        log::debug!(
            "[ui] heartbeat ack seq={} latency={}ms",
            seq,
            latency.as_millis()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VISIBLE: WindowSnapshot = WindowSnapshot {
        visible: true,
        focused: true,
        minimized: false,
    };
    const HIDDEN: WindowSnapshot = WindowSnapshot {
        visible: false,
        focused: false,
        minimized: false,
    };

    /// Advance `n` ticks without acking; returns the last outcome.
    fn miss_ticks(
        p: &mut UiWatchdogPolicy,
        t0: Instant,
        from: u32,
        n: u32,
        w: WindowSnapshot,
    ) -> TickOutcome {
        let mut last = None;
        for i in from..from + n {
            last = Some(p.tick(t0 + HEARTBEAT_INTERVAL * i, w));
        }
        last.unwrap()
    }

    fn is_stalled(t: &TickOutcome) -> bool {
        matches!(t.transition, Some(Transition::Stalled(_)))
    }

    #[test]
    fn transitions_to_stalled_at_exactly_three_misses() {
        let mut p = UiWatchdogPolicy::new();
        let t0 = Instant::now();
        // Tick 0 sends seq 1 (nothing outstanding yet → no miss).
        let o = p.tick(t0, VISIBLE);
        assert_eq!(o.seq, 1);
        assert_eq!(p.missed(), 0);
        // Ticks 1 and 2 record misses 1 and 2 — still healthy.
        let o = miss_ticks(&mut p, t0, 1, 2, VISIBLE);
        assert_eq!(p.missed(), 2);
        assert!(!is_stalled(&o));
        assert!(!p.is_stalled());
        // Tick 3 records miss 3 → stalled.
        let o = miss_ticks(&mut p, t0, 3, 1, VISIBLE);
        assert_eq!(p.missed(), 3);
        assert!(p.is_stalled());
        let Some(Transition::Stalled(r)) = o.transition else {
            panic!("expected Stalled, got {:?}", o.transition);
        };
        assert_eq!(r.missed, 3);
        assert_eq!(r.last_ack_seq, None);
        assert_eq!(r.window, VISIBLE);
        // Subsequent ticks do not re-report the transition.
        let o = miss_ticks(&mut p, t0, 4, 1, VISIBLE);
        assert!(o.transition.is_none());
    }

    #[test]
    fn stall_report_carries_last_ack_context() {
        let mut p = UiWatchdogPolicy::new();
        let t0 = Instant::now();
        let o = p.tick(t0, VISIBLE);
        let ack = p.on_ack(o.seq, t0 + Duration::from_millis(40));
        assert_eq!(ack.latency, Some(Duration::from_millis(40)));
        let o = miss_ticks(&mut p, t0, 1, 4, VISIBLE);
        let Some(Transition::Stalled(r)) = o.transition else {
            panic!("expected Stalled");
        };
        assert_eq!(r.last_ack_seq, Some(1));
        assert_eq!(r.last_ack_latency, Some(Duration::from_millis(40)));
        assert_eq!(
            r.last_ack_age,
            Some(HEARTBEAT_INTERVAL * 4 - Duration::from_millis(40))
        );
    }

    #[test]
    fn ack_resets_counter_and_recovers() {
        let mut p = UiWatchdogPolicy::new();
        let t0 = Instant::now();
        p.tick(t0, VISIBLE);
        miss_ticks(&mut p, t0, 1, 2, VISIBLE);
        assert_eq!(p.missed(), 2);
        // A late ack for an older seq still proves liveness.
        let ack = p.on_ack(1, t0 + HEARTBEAT_INTERVAL * 2 + Duration::from_secs(1));
        assert_eq!(p.missed(), 0);
        assert_eq!(ack.latency, None);
        assert!(ack.transition.is_none());

        // Drive into a stall, then ack the outstanding heartbeat.
        let o = miss_ticks(&mut p, t0, 3, 3, VISIBLE);
        assert!(is_stalled(&o));
        let ack = p.on_ack(o.seq, t0 + HEARTBEAT_INTERVAL * 5 + Duration::from_secs(2));
        assert!(!p.is_stalled());
        assert_eq!(p.missed(), 0);
        let Some(Transition::Recovered {
            stalled_for,
            missed,
        }) = ack.transition
        else {
            panic!("expected Recovered, got {:?}", ack.transition);
        };
        assert_eq!(missed, 3);
        assert_eq!(stalled_for, Duration::from_secs(2));
        assert_eq!(ack.latency, Some(Duration::from_secs(2)));

        // Ack for an unknown / future seq is ignored.
        let ack = p.on_ack(999, t0);
        assert_eq!(
            ack,
            AckOutcome {
                latency: None,
                transition: None
            }
        );
    }

    #[test]
    fn visible_stall_reloads_once_per_cooldown() {
        let mut p = UiWatchdogPolicy::new();
        let t0 = Instant::now();
        p.tick(t0, VISIBLE);
        let o = miss_ticks(&mut p, t0, 1, 3, VISIBLE);
        assert!(is_stalled(&o));
        assert_eq!(o.reload, ReloadDecision::Reload);

        // Still stalled inside the cooldown: rate-limited, reported once.
        let o = miss_ticks(&mut p, t0, 4, 1, VISIBLE);
        assert_eq!(
            o.reload,
            ReloadDecision::Deferred(Some(DeferReason::RateLimited {
                retry_in: RELOAD_COOLDOWN - HEARTBEAT_INTERVAL
            }))
        );
        let o = miss_ticks(&mut p, t0, 5, 1, VISIBLE);
        assert_eq!(o.reload, ReloadDecision::Deferred(None));

        // Once the cooldown has elapsed the next visible miss reloads again.
        let ticks_per_cooldown = (RELOAD_COOLDOWN.as_secs() / HEARTBEAT_INTERVAL.as_secs()) as u32;
        let o = p.tick(t0 + HEARTBEAT_INTERVAL * (3 + ticks_per_cooldown), VISIBLE);
        assert_eq!(o.reload, ReloadDecision::Reload);
    }

    #[test]
    fn hidden_stall_defers_reload_until_shown() {
        let mut p = UiWatchdogPolicy::new();
        let t0 = Instant::now();
        p.tick(t0, HIDDEN);
        let o = miss_ticks(&mut p, t0, 1, 3, HIDDEN);
        assert!(is_stalled(&o));
        assert_eq!(
            o.reload,
            ReloadDecision::Deferred(Some(DeferReason::Hidden))
        );
        // Repeated hidden ticks stay deferred and are not re-reported.
        let o = miss_ticks(&mut p, t0, 4, 1, HIDDEN);
        assert_eq!(o.reload, ReloadDecision::Deferred(None));

        // Window shown: the outstanding heartbeat was sent hidden, so the
        // page gets one visible heartbeat before we reload.
        let o = miss_ticks(&mut p, t0, 5, 1, VISIBLE);
        assert_eq!(
            o.reload,
            ReloadDecision::Deferred(Some(DeferReason::AwaitingVisibleProbe))
        );
        // That visible heartbeat also went unanswered → reload.
        let o = miss_ticks(&mut p, t0, 6, 1, VISIBLE);
        assert_eq!(o.reload, ReloadDecision::Reload);
    }

    #[test]
    fn hidden_stall_recovers_on_show_without_reload() {
        let mut p = UiWatchdogPolicy::new();
        let t0 = Instant::now();
        p.tick(t0, HIDDEN);
        miss_ticks(&mut p, t0, 1, 3, HIDDEN);
        assert!(p.is_stalled());
        // Shown; throttled page wakes up and acks the visible heartbeat.
        let o = miss_ticks(&mut p, t0, 4, 1, VISIBLE);
        assert_ne!(o.reload, ReloadDecision::Reload);
        let ack = p.on_ack(
            o.seq,
            t0 + HEARTBEAT_INTERVAL * 4 + Duration::from_millis(5),
        );
        assert!(matches!(ack.transition, Some(Transition::Recovered { .. })));
        assert!(!p.is_stalled());
        // Healthy tick afterwards: no reload, no transition.
        let o = miss_ticks(&mut p, t0, 5, 1, VISIBLE);
        assert_eq!(o.reload, ReloadDecision::None);
        assert!(o.transition.is_none());
    }

    #[test]
    fn manual_reload_starts_cooldown_so_watchdog_does_not_reload_again() {
        let mut p = UiWatchdogPolicy::new();
        let t0 = Instant::now();
        p.tick(t0, HIDDEN);
        miss_ticks(&mut p, t0, 1, 3, HIDDEN);
        assert!(p.is_stalled());
        // User picks tray "Reload UI"; the window is shown and focused.
        let reload_at = t0 + HEARTBEAT_INTERVAL * 3 + PROBE_MIN_AGE + Duration::from_secs(5);
        p.note_reload(reload_at);
        // Focus tick: outstanding heartbeat was sent hidden → visible probe.
        let o = p.tick(reload_at, VISIBLE);
        assert_eq!(
            o.reload,
            ReloadDecision::Deferred(Some(DeferReason::AwaitingVisibleProbe))
        );
        // The probe emitted mid-reload is lost; the next tick must not reload
        // the freshly loaded page again while the cooldown is running.
        let o = p.tick(reload_at + HEARTBEAT_INTERVAL, VISIBLE);
        assert!(matches!(
            o.reload,
            ReloadDecision::Deferred(Some(DeferReason::RateLimited { .. }))
        ));
        // The reloaded page acks → recovered without a second reload.
        let ack = p.on_ack(
            o.seq,
            reload_at + HEARTBEAT_INTERVAL + Duration::from_millis(10),
        );
        assert!(matches!(ack.transition, Some(Transition::Recovered { .. })));
        // Once the cooldown has elapsed a fresh visible stall reloads normally.
        let later = reload_at + RELOAD_COOLDOWN;
        p.tick(later, VISIBLE);
        let o = miss_ticks(&mut p, later, 1, 3, VISIBLE);
        assert_eq!(o.reload, ReloadDecision::Reload);
    }

    #[test]
    fn focus_probe_younger_than_min_age_is_not_a_miss() {
        let mut p = UiWatchdogPolicy::new();
        let t0 = Instant::now();
        p.tick(t0, HIDDEN);
        miss_ticks(&mut p, t0, 1, 3, HIDDEN);
        assert!(p.is_stalled());

        // Window shown well after the last hidden heartbeat: a visible probe
        // goes out and the reload waits on it.
        let shown = t0 + HEARTBEAT_INTERVAL * 3 + PROBE_MIN_AGE + Duration::from_secs(1);
        let o = p.tick(shown, VISIBLE);
        assert!(o.emit);
        assert_eq!(
            o.reload,
            ReloadDecision::Deferred(Some(DeferReason::AwaitingVisibleProbe))
        );
        let probe_seq = o.seq;
        let missed_before = p.missed();

        // A second Focused(true) two seconds later must not count the probe
        // as missed (and reload the page) before it had a chance to answer.
        let o = p.tick(shown + Duration::from_secs(2), VISIBLE);
        assert!(!o.emit);
        assert_eq!(o.seq, probe_seq);
        assert_eq!(o.reload, ReloadDecision::None);
        assert!(o.transition.is_none());
        assert_eq!(p.missed(), missed_before);

        // The page answers the probe → recovered, no reload.
        let ack = p.on_ack(probe_seq, shown + Duration::from_secs(3));
        assert!(matches!(ack.transition, Some(Transition::Recovered { .. })));
        assert!(!p.is_stalled());
    }

    #[test]
    fn focus_probe_older_than_min_age_counts_as_missed() {
        let mut p = UiWatchdogPolicy::new();
        let t0 = Instant::now();
        p.tick(t0, HIDDEN);
        miss_ticks(&mut p, t0, 1, 3, HIDDEN);
        let shown = t0 + HEARTBEAT_INTERVAL * 3 + PROBE_MIN_AGE;
        let o = p.tick(shown, VISIBLE);
        assert!(o.emit);
        // Unanswered for PROBE_MIN_AGE: the next focus reloads.
        let o = p.tick(shown + PROBE_MIN_AGE, VISIBLE);
        assert!(o.emit);
        assert_eq!(o.reload, ReloadDecision::Reload);
    }

    #[test]
    fn gives_up_after_max_consecutive_reloads_until_ack() {
        let mut p = UiWatchdogPolicy::new();
        let t0 = Instant::now();
        let ticks_per_cooldown = (RELOAD_COOLDOWN.as_secs() / HEARTBEAT_INTERVAL.as_secs()) as u32;
        p.tick(t0, VISIBLE);
        let o = miss_ticks(&mut p, t0, 1, 3, VISIBLE);
        assert_eq!(o.reload, ReloadDecision::Reload);

        let mut tick = 3;
        for _ in 1..RELOAD_MAX_CONSECUTIVE {
            tick += ticks_per_cooldown;
            let o = p.tick(t0 + HEARTBEAT_INTERVAL * tick, VISIBLE);
            assert_eq!(o.reload, ReloadDecision::Reload);
        }

        // The cap is reached: one GaveUp report, then silence.
        tick += ticks_per_cooldown;
        let o = p.tick(t0 + HEARTBEAT_INTERVAL * tick, VISIBLE);
        assert_eq!(
            o.reload,
            ReloadDecision::Deferred(Some(DeferReason::GaveUp {
                reloads: RELOAD_MAX_CONSECUTIVE
            }))
        );
        let o = p.tick(t0 + HEARTBEAT_INTERVAL * (tick + 1), VISIBLE);
        assert_eq!(o.reload, ReloadDecision::Deferred(None));
        tick += ticks_per_cooldown;
        let o = p.tick(t0 + HEARTBEAT_INTERVAL * tick, VISIBLE);
        assert_eq!(o.reload, ReloadDecision::Deferred(None));

        // A healthy ack re-arms automatic reloads.
        let ack = p.on_ack(
            o.seq,
            t0 + HEARTBEAT_INTERVAL * tick + Duration::from_secs(1),
        );
        assert!(matches!(ack.transition, Some(Transition::Recovered { .. })));
        let later = t0 + HEARTBEAT_INTERVAL * (tick + 1);
        p.tick(later, VISIBLE);
        let o = miss_ticks(&mut p, later, 1, 3, VISIBLE);
        assert_eq!(o.reload, ReloadDecision::Reload);
    }

    #[test]
    fn manual_reload_rearms_after_give_up() {
        let mut p = UiWatchdogPolicy::new();
        let t0 = Instant::now();
        let ticks_per_cooldown = (RELOAD_COOLDOWN.as_secs() / HEARTBEAT_INTERVAL.as_secs()) as u32;
        p.tick(t0, VISIBLE);
        miss_ticks(&mut p, t0, 1, 3, VISIBLE);
        let mut tick = 3;
        for _ in 0..RELOAD_MAX_CONSECUTIVE {
            tick += ticks_per_cooldown;
            p.tick(t0 + HEARTBEAT_INTERVAL * tick, VISIBLE);
        }
        assert!(matches!(
            p.tick(t0 + HEARTBEAT_INTERVAL * (tick + 1), VISIBLE).reload,
            ReloadDecision::Deferred(_)
        ));

        // Tray "Reload UI" resets the counter; after its cooldown the
        // watchdog reloads a still-stalled visible page again.
        let reload_at = t0 + HEARTBEAT_INTERVAL * (tick + 2);
        p.note_reload(reload_at);
        let o = p.tick(reload_at + RELOAD_COOLDOWN, VISIBLE);
        assert_eq!(o.reload, ReloadDecision::Reload);
    }

    #[test]
    fn minimized_counts_as_hidden() {
        let mut p = UiWatchdogPolicy::new();
        let t0 = Instant::now();
        let minimized = WindowSnapshot {
            visible: true,
            focused: false,
            minimized: true,
        };
        p.tick(t0, minimized);
        let o = miss_ticks(&mut p, t0, 1, 3, minimized);
        assert_eq!(
            o.reload,
            ReloadDecision::Deferred(Some(DeferReason::Hidden))
        );
    }

    #[test]
    fn sanitize_ui_message_truncates_and_flattens() {
        assert_eq!(sanitize_ui_message("a\nb\r\n\tc"), "a | b | c");
        let long = "é".repeat(UI_LOG_MAX_BYTES);
        let out = sanitize_ui_message(&long);
        assert!(out.len() <= UI_LOG_MAX_BYTES);
        assert_eq!(out.len(), UI_LOG_MAX_BYTES);
        assert!(out.chars().all(|c| c == 'é'));
    }

    #[test]
    fn sanitize_ui_message_stays_within_limit_after_newline_expansion() {
        // Every "\n" becomes " | " (3 bytes), so a message right at the byte
        // limit grows past it once flattened; the output must still fit.
        let long = "a\n".repeat(UI_LOG_MAX_BYTES / 2);
        let out = sanitize_ui_message(&long);
        assert!(out.len() <= UI_LOG_MAX_BYTES, "len={}", out.len());
        assert!(out.starts_with("a | a | a"));
        // Multi-byte input mixed with newlines: no char split, still bounded.
        let long = "é\n".repeat(UI_LOG_MAX_BYTES);
        let out = sanitize_ui_message(&long);
        assert!(out.len() <= UI_LOG_MAX_BYTES);
        assert!(out.chars().all(|c| c == 'é' || c == ' ' || c == '|'));
    }
}
