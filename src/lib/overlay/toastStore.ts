// Typed Svelte writable-store fed by the `tool-call-event` Tauri stream.
//
// Per-group dismissal model:
//   - groups by `(server_type | server_name | tool)` to dedupe a flurry of
//     repeats into one stacked card;
//   - tracks per-group `{ inflight, success, error }` counters AND the
//     individual `requests` list so the card can render a state breakdown;
//   - dismissal is PER-CARD, not feed-level. Each group owns its own
//     6-second countdown that arms when the group transitions from
//     `inflight > 0` to `inflight === 0` (the last in-flight request
//     settles). When the timer fires, ONLY that one group is removed
//     and the matching `OverlayCard` slides out individually — other
//     cards keep their own independent countdowns;
//   - a new `addStarted` for an existing group whose `inflight` WAS 0
//     (it was counting down) cancels that group's timer, hides its
//     bar, and lets the card flip back to the in-flight visual state;
//   - `clear()` cancels every per-group timer and empties the store;
//   - `setOpts({...})` shallow-merges options. No hover-pause: the
//     per-card progress bar runs to completion regardless of cursor
//     position and the matching `setTimeout` fires at the same offset.
//
// Per-card progress bar plumbing:
//   - `ToolCallGroup.dismissAt` is `Date.now() + opts.dismissMs` while
//     the group is counting down, `null` otherwise. The UI reads
//     `group.inflight === 0 && (group.success > 0 || group.error > 0)`
//     to decide whether to render the bar; it doesn't drive the CSS
//     keyframe from `dismissAt` directly (the keyframe is purely
//     time-based via `animation-duration`).
//   - `ToolCallGroup.dismissTick` is a monotonically increasing
//     counter scoped to the group. It increments on every (re)arm,
//     and on cancel via a same-group `addStarted` (so the
//     `{#key group.dismissTick}` in the card re-mounts the bar fresh
//     on the next arm). It NEVER decreases.

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
  // When this group started its own countdown (`Date.now() + opts.dismissMs`
  // at arm time), or `null` when no timer is running for this group.
  dismissAt: number | null;
  // Monotonically increasing per-group arm counter. The `OverlayCard`
  // uses this in `{#key group.dismissTick}` so the CSS keyframe on the
  // dismiss-fill remounts from 0% on every (re)arm.
  dismissTick: number;
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
  // Per-group dismiss timers, keyed by `group.id`. Each group's countdown
  // is independent: arming one does not affect any other, and firing one
  // only removes that single group.
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inner = writable<ToolCallGroup[]>(groups);

  function publish() {
    inner.set(groups.slice());
  }

  function clearGroupTimer(id: string) {
    const t = timers.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      timers.delete(id);
    }
  }

  function armGroupTimer(id: string) {
    // Defensive clear — the arming callers also recompute `dismissAt` and
    // `dismissTick` on the group, and `setTimeout` here owns the lifetime
    // of the actual JS timer.
    clearGroupTimer(id);
    const delay = opts.dismissMs;
    const handle = setTimeout(() => {
      timers.delete(id);
      groups = groups.filter((g) => g.id !== id);
      publish();
    }, delay);
    timers.set(id, handle);
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
      // If this group was counting down (inflight had been 0), a new
      // started event cancels its timer, hides its bar, and the card
      // flips back to the in-flight visual state. Bump `dismissTick`
      // so the next arm's `{#key}` remount starts the bar fresh.
      const wasCountingDown = existing.inflight === 0;
      if (wasCountingDown) {
        clearGroupTimer(id);
      }
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
        dismissAt: wasCountingDown ? null : existing.dismissAt,
        dismissTick: wasCountingDown ? existing.dismissTick + 1 : existing.dismissTick,
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
        dismissAt: null,
        dismissTick: 0,
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
    const newInflight = Math.max(0, target.inflight - 1);
    const willArm = newInflight === 0;
    const now = Date.now();
    // Copy-on-write: replace both the group and the matching request with
    // fresh object references so OverlayCard sees a new `group` prop
    // identity and Svelte 5 re-runs the derived expressions that read
    // `group.inflight`, `group.success`, etc.
    const updated: ToolCallGroup = {
      ...target,
      requests: target.requests.map((r) =>
        r.requestId === event.request_id ? settledReq : r,
      ),
      inflight: newInflight,
      success: target.success + (isError ? 0 : 1),
      error: target.error + (isError ? 1 : 0),
      lastUpdatedAt: now,
      dismissAt: willArm ? now + opts.dismissMs : target.dismissAt,
      dismissTick: willArm ? target.dismissTick + 1 : target.dismissTick,
    };
    groups = groups.map((g) => (g.id === target.id ? updated : g));
    if (willArm) {
      armGroupTimer(target.id);
    }
    publish();
  }

  function setOpts(next: Partial<ToastStoreOpts>) {
    opts = { ...opts, ...next };
  }

  function getOpts(): ToastStoreOpts {
    return { ...opts };
  }

  function clear() {
    for (const id of Array.from(timers.keys())) {
      clearGroupTimer(id);
    }
    groups = [];
    publish();
  }

  return {
    subscribe: inner.subscribe,
    addStarted,
    settle,
    setOpts,
    getOpts,
    clear,
  };
}
