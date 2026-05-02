//! Detect WKWebView web-content process termination and attempt auto-recovery.
//!
//! Symptom this targets: the macOS desktop window goes blank after a few days of
//! uptime because WKWebView's web-content process was killed (memory pressure,
//! Jetsam, internal crash) and Tauri/wry has no built-in restart hook. We
//! install a forwarding `WKNavigationDelegate` proxy on the main webview that
//! preserves wry's existing delegate and adds a `webViewWebContentProcessDidTerminate:`
//! handler which calls `[webView reload]` and emits `webview-recovered`. If the
//! webview keeps crashing within a sliding window we emit `webview-fatal`
//! instead and stop reloading.
//!
//! The pure recovery state machine lives in this module and is unit-tested.
//! On non-macOS platforms `install` is a logged no-op (see TODOs).

use serde::Serialize;
use std::time::{Duration, Instant};

/// Sliding window used to count "recent" recovery attempts.
pub(crate) const RECOVERY_WINDOW: Duration = Duration::from_secs(60);

/// Maximum recoveries allowed within [`RECOVERY_WINDOW`] before declaring fatal.
/// The (N+1)th termination inside the window emits `webview-fatal`.
pub(crate) const RECOVERY_MAX_ATTEMPTS: usize = 3;

/// Pure recovery state. Tracks attempt timestamps inside the sliding window
/// and a sticky `fatal` flag so we only emit `webview-fatal` once.
#[derive(Default, Debug)]
pub(crate) struct RecoveryState {
    pub attempts: Vec<Instant>,
    pub fatal: bool,
}

/// Decision returned by the pure state machine for a single termination event.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RecoveryDecision {
    /// Reload the webview; this is recovery attempt `attempt` inside the window.
    Reload { attempt: usize },
    /// Stop trying — declare the webview fatal. `attempts` is the count that
    /// tripped the threshold.
    Fatal { attempts: usize },
    /// Already declared fatal previously; do nothing.
    AlreadyFatal,
}

/// Pure transition: prune attempts outside `window`, push `now`, then decide
/// whether to reload or escalate to fatal. Sticky once fatal.
pub(crate) fn record_termination(
    state: &mut RecoveryState,
    now: Instant,
    window: Duration,
    max_attempts: usize,
) -> RecoveryDecision {
    if state.fatal {
        return RecoveryDecision::AlreadyFatal;
    }
    state.attempts.retain(|t| now.duration_since(*t) < window);
    state.attempts.push(now);
    let attempts = state.attempts.len();
    if attempts > max_attempts {
        state.fatal = true;
        RecoveryDecision::Fatal { attempts }
    } else {
        RecoveryDecision::Reload { attempt: attempts }
    }
}

/// Event payload emitted on successful auto-recovery (reload was issued).
#[derive(Serialize, Clone)]
pub struct WebViewRecoveryPayload {
    pub attempt: usize,
    pub window_secs: u64,
}

/// Event payload emitted when too many crashes happened inside the window.
#[derive(Serialize, Clone)]
pub struct WebViewFatalPayload {
    pub attempts: usize,
    pub window_secs: u64,
}

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "macos")]
pub use macos::install;

/// Linux/Windows fallback. Compiles cleanly so the rest of the app builds; the
/// actual hook is platform-specific and tracked by future work.
#[cfg(not(target_os = "macos"))]
pub fn install(
    _window: &tauri::WebviewWindow,
    _app_handle: tauri::AppHandle,
) -> Result<(), String> {
    // TODO(T4): implement webview process termination detection on Linux
    // (webkit2gtk's `web-process-terminated` signal) and Windows
    // (WebView2's ProcessFailed event). Until then this is a no-op so the
    // setup path stays cross-platform.
    log::info!("[webview] crash-recovery hook not implemented on this platform");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_termination_triggers_reload() {
        let mut state = RecoveryState::default();
        let decision = record_termination(
            &mut state,
            Instant::now(),
            RECOVERY_WINDOW,
            RECOVERY_MAX_ATTEMPTS,
        );
        assert_eq!(decision, RecoveryDecision::Reload { attempt: 1 });
        assert!(!state.fatal);
        assert_eq!(state.attempts.len(), 1);
    }

    #[test]
    fn nth_plus_one_termination_in_window_is_fatal() {
        let mut state = RecoveryState::default();
        let now = Instant::now();
        for i in 1..=RECOVERY_MAX_ATTEMPTS {
            let decision =
                record_termination(&mut state, now, RECOVERY_WINDOW, RECOVERY_MAX_ATTEMPTS);
            assert_eq!(decision, RecoveryDecision::Reload { attempt: i });
        }
        let final_decision =
            record_termination(&mut state, now, RECOVERY_WINDOW, RECOVERY_MAX_ATTEMPTS);
        assert_eq!(
            final_decision,
            RecoveryDecision::Fatal {
                attempts: RECOVERY_MAX_ATTEMPTS + 1
            }
        );
        assert!(state.fatal);
    }

    #[test]
    fn fatal_is_sticky() {
        let mut state = RecoveryState {
            attempts: vec![],
            fatal: true,
        };
        let decision = record_termination(
            &mut state,
            Instant::now(),
            RECOVERY_WINDOW,
            RECOVERY_MAX_ATTEMPTS,
        );
        assert_eq!(decision, RecoveryDecision::AlreadyFatal);
    }

    #[test]
    fn old_attempts_outside_window_are_pruned() {
        let mut state = RecoveryState::default();
        let early = Instant::now();
        for _ in 0..RECOVERY_MAX_ATTEMPTS {
            record_termination(&mut state, early, RECOVERY_WINDOW, RECOVERY_MAX_ATTEMPTS);
        }
        // Far past the window: counter should reset to 1 and stay non-fatal.
        let later = early + RECOVERY_WINDOW + Duration::from_secs(1);
        let decision =
            record_termination(&mut state, later, RECOVERY_WINDOW, RECOVERY_MAX_ATTEMPTS);
        assert_eq!(decision, RecoveryDecision::Reload { attempt: 1 });
        assert!(!state.fatal);
    }
}
