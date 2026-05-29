// Typed Svelte writable-store fed by the `tool-call-event` Tauri stream.
//
// Behaviour mirrors the prototype `makeStore` in
// `~/Downloads/desktop-visual-indicator-for-mcp-activity/project/toast-feed.jsx`
// (lines 168–245) but operates on the typed `ToolCallEvent` objects from the
// relay event bus rather than synthetic log lines:
//
//   - groups by `(server_type | server_name | tool)` — same key shape the
//     overlay UI will use to dedupe a flurry of repeats into one stacked card;
//   - tracks per-group `{ inflight, success, error }` counters AND the
//     individual `requests` list (so a Phase 4 card can render a mini state
//     breakdown);
//   - schedules a dismiss-timer after the last in-flight request of a group
//     settles; a new `started` event for the same key cancels the timer and
//     moves the group to the end of the list (newest position);
//   - `clear()` cancels every timer; `setOpts({...})` shallow-merges options.

import { writable, type Readable } from 'svelte/store';
import type {
  CompletedEvent,
  FailedEvent,
  StartedEvent,
  ToolCallAnnotations,
} from './types';

export type ToolCallRequest = {
  requestId: string;
  ts: string;
  status: 'inflight' | 'success' | 'error';
  durationMs?: number;
  errorMessage?: string;
  // JSON-RPC envelope id captured from the originating event's `jsonrpc_id`
  // field. Surfaced on each request so the overlay card click handler can
  // emit it to the main window to scroll the matching log row into view.
  // `null` when the relay event had no `request` span on the stack.
  jsonrpcId: string | null;
};

export type ToolCallGroup = {
  id: string;
  serverType: string | null;
  serverName: string | null;
  tool: string;
  annotations?: ToolCallAnnotations;
  profile: string | null;
  inflight: number;
  success: number;
  error: number;
  requests: ToolCallRequest[];
  lastUpdatedAt: number;
  dismissStartedAt: number | null;
};

export type ToastStoreOpts = {
  dismissMs: number;
  maxVisible: number;
  showProfile: boolean;
};

const DEFAULT_OPTS: ToastStoreOpts = {
  dismissMs: 6000,
  maxVisible: 4,
  showProfile: true,
};

export type ToastStore = Readable<ToolCallGroup[]> & {
  addStarted: (event: StartedEvent) => void;
  settle: (event: CompletedEvent | FailedEvent) => void;
  scheduleDismiss: (groupId: string) => void;
  cancelDismiss: (groupId: string) => void;
  setOpts: (opts: Partial<ToastStoreOpts>) => void;
  getOpts: () => ToastStoreOpts;
  clear: () => void;
};

function groupKey(event: StartedEvent): string {
  // Treat null/undefined as empty string so `(null, null, "tool")` and
  // `(undefined, null, "tool")` collapse into the same key — the only fields
  // the user can distinguish are the ones the event carries.
  const t = event.server_type ?? '';
  const n = event.server_name ?? '';
  return `${t}|${n}|${event.tool}`;
}

export function createToastStore(initial?: Partial<ToastStoreOpts>): ToastStore {
  let groups: ToolCallGroup[] = [];
  let opts: ToastStoreOpts = { ...DEFAULT_OPTS, ...initial };
  const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const inner = writable<ToolCallGroup[]>(groups);

  function publish() {
    inner.set(groups.slice());
  }

  function clearDismissTimer(id: string) {
    const t = dismissTimers.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      dismissTimers.delete(id);
    }
  }

  function removeGroup(id: string) {
    clearDismissTimer(id);
    const before = groups.length;
    groups = groups.filter((g) => g.id !== id);
    if (groups.length !== before) publish();
  }

  function scheduleDismiss(id: string) {
    const exists = groups.some((g) => g.id === id);
    if (!exists) return;
    clearDismissTimer(id);
    const now = Date.now();
    // Copy-on-write: replace the group with a new object reference so
    // Svelte 5 `$derived` expressions in OverlayCard re-run when only
    // inner fields change. The `{#each groups as g (g.id)}` keyed block
    // keeps the same component instance across updates, so we rely on a
    // new prop identity to trigger a re-render.
    groups = groups.map((g) =>
      g.id === id ? { ...g, dismissStartedAt: now, lastUpdatedAt: now } : g,
    );
    const tid = setTimeout(() => removeGroup(id), opts.dismissMs);
    dismissTimers.set(id, tid);
    publish();
  }

  function cancelDismiss(id: string) {
    clearDismissTimer(id);
    let changed = false;
    groups = groups.map((g) => {
      if (g.id !== id || g.dismissStartedAt === null) return g;
      changed = true;
      return { ...g, dismissStartedAt: null };
    });
    // Publish so direct external callers (the `scheduleDismiss /
    // cancelDismiss can be driven directly` test path, and any future
    // UI code path) observe the cleared `dismissStartedAt` via
    // `get(store)`. The previous in-place-mutation implementation got
    // this for free because the published array shared object refs with
    // `groups`; copy-on-write loses that, so we explicitly republish.
    // `addStarted` calls `cancelDismiss` then publishes again after
    // its own mutation — one redundant publish per repeat-start is
    // acceptable; the alternative (skipping the publish here) breaks
    // the direct-driver API.
    if (changed) publish();
  }

  function addStarted(event: StartedEvent) {
    const id = groupKey(event);
    const now = Date.now();
    const existing = groups.find((g) => g.id === id);
    const req: ToolCallRequest = {
      requestId: event.request_id,
      ts: event.ts,
      status: 'inflight',
      jsonrpcId: event.jsonrpc_id ?? null,
    };
    if (existing) {
      cancelDismiss(id);
      // Copy-on-write: build a fresh ToolCallGroup so OverlayCard's
      // `group` prop changes identity and Svelte 5 re-runs its derived
      // expressions. Mutating `existing` in place would leave the prop
      // identity unchanged and the UI would not redraw.
      const updated: ToolCallGroup = {
        ...existing,
        inflight: existing.inflight + 1,
        requests: [...existing.requests, req],
        lastUpdatedAt: now,
        // Most recent values from the latest started event win.
        annotations: event.annotations ?? existing.annotations,
        profile: event.profile ?? null,
        dismissStartedAt: null,
      };
      // Move to end (newest position).
      groups = groups.filter((g) => g.id !== id).concat(updated);
    } else {
      groups = groups.concat({
        id,
        serverType: event.server_type ?? null,
        serverName: event.server_name ?? null,
        tool: event.tool,
        annotations: event.annotations,
        profile: event.profile ?? null,
        inflight: 1,
        success: 0,
        error: 0,
        requests: [req],
        lastUpdatedAt: now,
        dismissStartedAt: null,
      });
    }
    publish();
  }


  function settle(event: CompletedEvent | FailedEvent) {
    // Find the group containing a request with this request_id. We do not
    // assume the started event was observed for this request — out-of-order
    // delivery (e.g. a settle for a request the SSE bridge missed the start
    // of, because the renderer subscribed late) is silently dropped.
    const target = groups.find((grp) =>
      grp.requests.some((r) => r.requestId === event.request_id),
    );
    if (!target) return;
    const existingReq = target.requests.find((r) => r.requestId === event.request_id);
    if (!existingReq || existingReq.status !== 'inflight') return;
    const isError = event.kind === 'failed' || event.status === 'error';
    // Build a fresh ToolCallRequest with the settled fields. Carry the
    // JSON-RPC id from the terminal event when the started event lacked
    // one (broadcast subscribers joining mid-request); never downgrade a
    // known id back to null.
    const settledReq: ToolCallRequest = {
      ...existingReq,
      status: isError ? 'error' : 'success',
      durationMs: event.duration_ms,
      ...(event.kind === 'failed' ? { errorMessage: event.error_message } : {}),
      jsonrpcId:
        existingReq.jsonrpcId === null && event.jsonrpc_id != null
          ? event.jsonrpc_id
          : existingReq.jsonrpcId,
    };
    // Copy-on-write: replace both the group and the matching request with
    // fresh object references so OverlayCard sees a new `group` prop
    // identity and Svelte 5 re-runs the derived expressions that read
    // `group.inflight`, `group.success`, etc.
    const updated: ToolCallGroup = {
      ...target,
      requests: target.requests.map((r) =>
        r.requestId === event.request_id ? settledReq : r,
      ),
      inflight: Math.max(0, target.inflight - 1),
      success: target.success + (isError ? 0 : 1),
      error: target.error + (isError ? 1 : 0),
      lastUpdatedAt: Date.now(),
    };
    groups = groups.map((g) => (g.id === target.id ? updated : g));
    publish();
    if (updated.inflight === 0) scheduleDismiss(updated.id);
  }

  function setOpts(next: Partial<ToastStoreOpts>) {
    opts = { ...opts, ...next };
  }

  function getOpts(): ToastStoreOpts {
    return { ...opts };
  }

  function clear() {
    for (const tid of dismissTimers.values()) clearTimeout(tid);
    dismissTimers.clear();
    groups = [];
    publish();
  }

  return {
    subscribe: inner.subscribe,
    addStarted,
    settle,
    scheduleDismiss,
    cancelDismiss,
    setOpts,
    getOpts,
    clear,
  };
}
