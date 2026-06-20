import { writable } from 'svelte/store';
import type { Endpoint } from '$lib/types';

/**
 * Optimistic, desktop-only toggle-transition state for MCP endpoints. When a
 * user enables/disables a server the relay takes multiple seconds to actually
 * spin the upstream session up (process start + tool discovery), reported as
 * `lifecycle: 'Initializing'` / `health: 'starting'`. There is no relay-side
 * "Stopping" state, so the "Stopping…" hint is purely optimistic and clears as
 * soon as the endpoint reports disabled/Stopped.
 *
 * This module is intentionally UI-free so the reconciliation logic can be unit
 * tested without mounting Svelte components.
 */
export type TransitionKind = 'starting' | 'stopping';

export interface PendingTransition {
  kind: TransitionKind;
  startedAt: number;
}

/**
 * Safety valve: a pending transition older than this clears unconditionally so
 * the UI can never hang in "Starting…"/"Stopping…" forever (e.g. the relay
 * never reports Ready, or an endpoint vanishes from the list).
 */
export const TRANSITION_TIMEOUT_MS = 30000;

/** Map of `endpointName -> PendingTransition` for all in-flight toggles. */
export const endpointTransitions = writable<Map<string, PendingTransition>>(new Map());

function setTransition(name: string, kind: TransitionKind): void {
  endpointTransitions.update((map) => {
    const next = new Map(map);
    next.set(name, { kind, startedAt: Date.now() });
    return next;
  });
}

/** Mark an endpoint as starting (enable clicked). */
export function markStarting(name: string): void {
  setTransition(name, 'starting');
}

/** Mark an endpoint as stopping (disable clicked). */
export function markStopping(name: string): void {
  setTransition(name, 'stopping');
}

/** Clear any pending transition for an endpoint (no-op when none pending). */
export function clearTransition(name: string): void {
  endpointTransitions.update((map) => {
    if (!map.has(name)) return map;
    const next = new Map(map);
    next.delete(name);
    return next;
  });
}

/** Human-readable hint for a pending transition, or null when none pending. */
export function transitionLabel(
  pending: PendingTransition | null | undefined,
): 'Starting…' | 'Stopping…' | null {
  if (!pending) return null;
  return pending.kind === 'starting' ? 'Starting…' : 'Stopping…';
}

/**
 * Whether a pending transition has been reconciled by the latest polled
 * endpoint and should be cleared:
 * - safety timeout elapsed (regardless of endpoint state);
 * - the endpoint reports a Failed/error state (resolves to the error display);
 * - starting + the relay reports `lifecycle: 'Ready'` (or `health: 'healthy'`);
 * - stopping + the endpoint reports `disabled` (or `lifecycle: 'Stopped'`).
 *
 * `endpoint` may be undefined/null when it has dropped out of the polled list;
 * in that case only the safety timeout applies.
 */
export function shouldClearTransition(
  pending: PendingTransition | null | undefined,
  endpoint: Endpoint | null | undefined,
  now: number,
): boolean {
  if (!pending) return false;
  if (now - pending.startedAt >= TRANSITION_TIMEOUT_MS) return true;
  if (!endpoint) return false;

  const failed =
    !!endpoint.error ||
    endpoint.health === 'error' ||
    endpoint.health === 'failed' ||
    endpoint.lifecycle?.state === 'Failed';
  if (failed) return true;

  if (pending.kind === 'starting') {
    return endpoint.lifecycle?.state === 'Ready' || endpoint.health === 'healthy';
  }
  return !!endpoint.disabled || endpoint.lifecycle?.state === 'Stopped';
}
