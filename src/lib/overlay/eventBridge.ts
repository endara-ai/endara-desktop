// Tauri event bridge: subscribes to the renderer's `tool-call-event` stream,
// invokes the host's `subscribe_tool_call_events` command so the SSE side of
// the bridge starts pulling frames, and routes events into the typed
// `ToastStore`.
//
// The Rust side (`src-tauri/src/overlay.rs`) forwards every SSE frame from
// the relay's `/api/events/tool-calls` endpoint as a window event named
// `tool-call-event`. We use the app-level `listen()` from
// `@tauri-apps/api/event` (the same pattern as `logListener.ts`) — the
// emit in `overlay.rs` is `window.emit(...)` which fans out to all
// listeners, so the app-level listener picks the events up cleanly.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  CompletedEvent,
  FailedEvent,
  StartedEvent,
  ToolCallEvent,
} from './types';
import type { ToastStore } from './toastStore';

/**
 * Attach the bridge: kicks off the host SSE subscription, listens for
 * forwarded events, and routes them into the store. Returns a disposer
 * that unlistens AND tells the host to drop its SSE subscription.
 */
export async function attachOverlayBridge(store: ToastStore): Promise<() => Promise<void>> {
  let unlisten: UnlistenFn | null = null;
  try {
    unlisten = await listen<ToolCallEvent>('tool-call-event', (event) => {
      route(store, event.payload);
    });
  } catch (e) {
    console.error('[overlay] failed to attach tool-call-event listener:', e);
  }

  try {
    await invoke('subscribe_tool_call_events');
  } catch (e) {
    console.error('[overlay] subscribe_tool_call_events failed:', e);
  }

  return async () => {
    if (unlisten) {
      try {
        unlisten();
      } catch (e) {
        console.warn('[overlay] unlisten threw:', e);
      }
      unlisten = null;
    }
    try {
      await invoke('unsubscribe_tool_call_events');
    } catch (e) {
      console.warn('[overlay] unsubscribe_tool_call_events failed:', e);
    }
  };
}

/**
 * Route a single decoded `ToolCallEvent` payload to the store. Exposed for
 * direct unit testing of the dispatch table without spinning up a fake
 * Tauri runtime.
 */
export function route(store: ToastStore, event: ToolCallEvent | unknown): void {
  if (!event || typeof event !== 'object') return;
  const kind = (event as { kind?: unknown }).kind;
  switch (kind) {
    case 'started':
      store.addStarted(event as StartedEvent);
      return;
    case 'completed':
      store.settle(event as CompletedEvent);
      return;
    case 'failed':
      store.settle(event as FailedEvent);
      return;
    default:
      // Forward-compat: future event kinds added by the relay must not
      // crash the bridge. Drop unknowns silently — the SSE bridge already
      // logs a `lagged` warning when broadcast frames are dropped.
      console.warn('[overlay] dropping unknown tool-call-event kind:', kind);
  }
}
