//! macOS-specific WKWebView crash detection and auto-recovery.
//!
//! Installs a forwarding `WKNavigationDelegate` proxy on the main webview that
//! preserves wry's existing delegate (so navigation policy and pending-script
//! injection keep working) and adds a `webViewWebContentProcessDidTerminate:`
//! handler. On termination we issue `[webView reload]` and emit
//! `webview-recovered`. After [`super::RECOVERY_MAX_ATTEMPTS`] reloads inside
//! [`super::RECOVERY_WINDOW`] we stop reloading and emit `webview-fatal`.
//!
//! The proxy uses `forwardingTargetForSelector:` so unhandled selectors
//! (navigation policy, script-injection callbacks) flow through to wry's
//! delegate unchanged.

use std::sync::Mutex;
use std::time::Instant;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject, Sel};
use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_web_kit::{WKNavigationDelegate, WKWebView};
use tauri::{AppHandle, Emitter};

use super::{
    record_termination, RecoveryDecision, RecoveryState, WebViewFatalPayload,
    WebViewRecoveryPayload, RECOVERY_MAX_ATTEMPTS, RECOVERY_WINDOW,
};

/// Event names emitted by the recovery hook.
const RECOVERY_EVENT: &str = "webview-recovered";
const FATAL_EVENT: &str = "webview-fatal";

/// Instance state carried by [`WebviewRecoveryDelegate`].
struct ProxyIvars {
    /// Wry's original navigation delegate, retained so message forwarding stays
    /// valid even though the WKWebView only holds it weakly via
    /// `setNavigationDelegate:` (we replaced that weak ref with our proxy).
    inner_delegate: Option<Retained<NSObject>>,
    state: Mutex<RecoveryState>,
    app_handle: AppHandle,
    window_label: String,
}

define_class!(
    /// Forwarding `WKNavigationDelegate` that intercepts web-content process
    /// termination and forwards every other selector to wry's original
    /// delegate via `forwardingTargetForSelector:`.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ProxyIvars]
    struct WebviewRecoveryDelegate;

    unsafe impl NSObjectProtocol for WebviewRecoveryDelegate {}

    unsafe impl WKNavigationDelegate for WebviewRecoveryDelegate {
        #[unsafe(method(webView:webContentProcessDidTerminate:))]
        fn web_content_process_did_terminate(&self, webview: &WKWebView) {
            self.handle_termination(webview);
        }
    }

    impl WebviewRecoveryDelegate {
        /// Override `respondsToSelector:` so WKWebView also dispatches
        /// methods that wry's original delegate handles to us; we then
        /// forward them via `forwardingTargetForSelector:`.
        #[unsafe(method(respondsToSelector:))]
        fn responds_to_selector(&self, selector: Sel) -> Bool {
            let me_responds: bool =
                unsafe { msg_send![super(self), respondsToSelector: selector] };
            if me_responds {
                return Bool::YES;
            }
            if let Some(inner) = &self.ivars().inner_delegate {
                let inner_responds: bool =
                    unsafe { msg_send![&**inner, respondsToSelector: selector] };
                return Bool::from(inner_responds);
            }
            Bool::NO
        }

        /// Fast-path message forwarding: any selector our class doesn't
        /// implement directly is dispatched to wry's original delegate.
        #[unsafe(method(forwardingTargetForSelector:))]
        fn forwarding_target_for_selector(&self, _selector: Sel) -> *mut AnyObject {
            match &self.ivars().inner_delegate {
                Some(inner) => Retained::as_ptr(inner) as *mut AnyObject,
                None => std::ptr::null_mut(),
            }
        }
    }
);

impl WebviewRecoveryDelegate {
    fn handle_termination(&self, webview: &WKWebView) {
        let now = Instant::now();
        let decision = {
            let mut guard = self
                .ivars()
                .state
                .lock()
                .expect("recovery state mutex poisoned");
            record_termination(&mut guard, now, RECOVERY_WINDOW, RECOVERY_MAX_ATTEMPTS)
        };
        let label = self.ivars().window_label.as_str();
        let window_secs = RECOVERY_WINDOW.as_secs();
        match decision {
            RecoveryDecision::Reload { attempt } => {
                log::warn!(
                    "[webview] web content process terminated label={} attempt={}/{} action=reload",
                    label,
                    attempt,
                    RECOVERY_MAX_ATTEMPTS
                );
                unsafe {
                    let _ = webview.reload();
                }
                let _ = self.ivars().app_handle.emit(
                    RECOVERY_EVENT,
                    WebViewRecoveryPayload {
                        attempt,
                        window_secs,
                    },
                );
            }
            RecoveryDecision::Fatal { attempts } => {
                log::error!(
                    "[webview] web content process terminated repeatedly label={} attempts={} window_secs={} action=give_up",
                    label,
                    attempts,
                    window_secs
                );
                let _ = self.ivars().app_handle.emit(
                    FATAL_EVENT,
                    WebViewFatalPayload {
                        attempts,
                        window_secs,
                    },
                );
            }
            RecoveryDecision::AlreadyFatal => {
                log::error!(
                    "[webview] web content process terminated again after fatal label={}",
                    label
                );
            }
        }
    }
}

/// Install the recovery delegate on the main webview. Safe to call once at
/// startup; subsequent calls would replace the delegate again.
pub fn install(window: &tauri::WebviewWindow, app_handle: AppHandle) -> Result<(), String> {
    let label = window.label().to_string();
    window
        .with_webview(move |platform_webview| {
            let raw = platform_webview.inner();
            if raw.is_null() {
                log::warn!(
                    "[webview] cannot install crash hook: null WKWebView label={}",
                    label
                );
                return;
            }
            let Some(mtm) = MainThreadMarker::new() else {
                log::error!(
                    "[webview] crash hook install must run on main thread label={}",
                    label
                );
                return;
            };
            // SAFETY: `raw` comes from tauri's wry-backed PlatformWebview and
            // points at a live WKWebView owned by the window. We only deref
            // it on the main thread (we just checked `mtm`).
            let webview = unsafe { &*(raw as *const WKWebView) };
            unsafe {
                // Snapshot wry's current delegate; retain it so message
                // forwarding stays valid after we replace the weak property.
                let inner_delegate: Option<Retained<NSObject>> = webview
                    .navigationDelegate()
                    .map(|d| Retained::cast_unchecked::<NSObject>(d));

                let proxy = mtm
                    .alloc::<WebviewRecoveryDelegate>()
                    .set_ivars(ProxyIvars {
                        inner_delegate,
                        state: Mutex::new(RecoveryState::default()),
                        app_handle: app_handle.clone(),
                        window_label: label.clone(),
                    });
                let proxy: Retained<WebviewRecoveryDelegate> = msg_send![super(proxy), init];
                let proto: &ProtocolObject<dyn WKNavigationDelegate> =
                    ProtocolObject::from_ref(&*proxy);
                webview.setNavigationDelegate(Some(proto));
                // The webview's navigationDelegate is a weak property; leak
                // the proxy so it lives for the rest of the process.
                let _ = Retained::into_raw(proxy);
            }
            log::info!("[webview] crash-recovery hook installed label={}", label);
        })
        .map_err(|e| format!("with_webview failed: {e}"))?;
    Ok(())
}
