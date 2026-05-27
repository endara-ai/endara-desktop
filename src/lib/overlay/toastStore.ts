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
  dismissMs: 2000,
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
    const g = groups.find((x) => x.id === id);
    if (!g) return;
    clearDismissTimer(id);
    g.dismissStartedAt = Date.now();
    g.lastUpdatedAt = Date.now();
    const tid = setTimeout(() => removeGroup(id), opts.dismissMs);
    dismissTimers.set(id, tid);
    publish();
  }

  function cancelDismiss(id: string) {
    const g = groups.find((x) => x.id === id);
    clearDismissTimer(id);
    if (g) g.dismissStartedAt = null;
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
      existing.inflight += 1;
      existing.requests.push(req);
      existing.lastUpdatedAt = now;
      // Most recent values from the latest started event win.
      existing.annotations = event.annotations ?? existing.annotations;
      existing.profile = event.profile ?? null;
      // Move to end (newest position).
      groups = groups.filter((g) => g.id !== id);
      groups.push(existing);
    } else {
      groups.push({
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
    const g = groups.find((grp) => grp.requests.some((r) => r.requestId === event.request_id));
    if (!g) return;
    const req = g.requests.find((r) => r.requestId === event.request_id);
    if (!req || req.status !== 'inflight') return;
    const isError = event.kind === 'failed' || event.status === 'error';
    req.status = isError ? 'error' : 'success';
    req.durationMs = event.duration_ms;
    if (event.kind === 'failed') req.errorMessage = event.error_message;
    // Carry through the JSON-RPC id from the terminal event when the
    // started event did not provide one (e.g. broadcast subscriber joined
    // mid-request). Never downgrade a known id back to null.
    if (req.jsonrpcId === null && event.jsonrpc_id != null) {
      req.jsonrpcId = event.jsonrpc_id;
    }
    g.inflight = Math.max(0, g.inflight - 1);
    if (isError) g.error += 1;
    else g.success += 1;
    g.lastUpdatedAt = Date.now();
    publish();
    if (g.inflight === 0) scheduleDismiss(g.id);
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
