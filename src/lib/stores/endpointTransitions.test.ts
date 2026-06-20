import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

import type { Endpoint } from '$lib/types';
import {
  endpointTransitions,
  markStarting,
  markStopping,
  clearTransition,
  transitionLabel,
  shouldClearTransition,
  TRANSITION_TIMEOUT_MS,
  type PendingTransition,
} from './endpointTransitions';

function endpoint(overrides: Partial<Endpoint> = {}): Endpoint {
  return {
    name: 'github',
    transport: 'stdio',
    health: 'unknown',
    tool_count: 0,
    last_activity: null,
    disabled: false,
    ...overrides,
  };
}

describe('endpointTransitions store', () => {
  beforeEach(() => {
    endpointTransitions.set(new Map());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('markStarting / markStopping record the kind and a startedAt timestamp', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    markStarting('github');
    markStopping('slack');

    const map = get(endpointTransitions);
    expect(map.get('github')).toEqual({ kind: 'starting', startedAt: 1000 });
    expect(map.get('slack')).toEqual({ kind: 'stopping', startedAt: 1000 });
  });

  it('clearTransition removes only the named transition', () => {
    markStarting('github');
    markStarting('slack');
    clearTransition('github');

    const map = get(endpointTransitions);
    expect(map.has('github')).toBe(false);
    expect(map.has('slack')).toBe(true);
  });

  it('clearTransition is a no-op (same reference) when nothing is pending', () => {
    const before = get(endpointTransitions);
    clearTransition('github');
    expect(get(endpointTransitions)).toBe(before);
  });

  it('updates publish a new Map reference so subscribers re-render', () => {
    const seen: Map<string, PendingTransition>[] = [];
    const unsub = endpointTransitions.subscribe((m) => seen.push(m));
    markStarting('github');
    unsub();
    expect(seen.length).toBe(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe('transitionLabel', () => {
  it('maps the kind to a human-readable hint', () => {
    expect(transitionLabel({ kind: 'starting', startedAt: 0 })).toBe('Starting…');
    expect(transitionLabel({ kind: 'stopping', startedAt: 0 })).toBe('Stopping…');
  });

  it('returns null when nothing is pending', () => {
    expect(transitionLabel(null)).toBeNull();
    expect(transitionLabel(undefined)).toBeNull();
  });
});

describe('shouldClearTransition', () => {
  const starting: PendingTransition = { kind: 'starting', startedAt: 1000 };
  const stopping: PendingTransition = { kind: 'stopping', startedAt: 1000 };

  it('returns false when there is no pending transition', () => {
    expect(shouldClearTransition(null, endpoint(), 2000)).toBe(false);
  });

  it('clears once the safety timeout elapses regardless of endpoint state', () => {
    const now = 1000 + TRANSITION_TIMEOUT_MS;
    expect(shouldClearTransition(starting, endpoint({ health: 'starting' }), now)).toBe(true);
    expect(shouldClearTransition(stopping, endpoint(), now)).toBe(true);
    expect(shouldClearTransition(starting, undefined, now)).toBe(true);
  });

  it('does not clear (yet) when the endpoint has dropped from the list and timeout has not elapsed', () => {
    expect(shouldClearTransition(starting, undefined, 1500)).toBe(false);
  });

  it('starting clears when the relay reports Ready or healthy', () => {
    expect(
      shouldClearTransition(starting, endpoint({ lifecycle: { state: 'Ready', server_name: 'gh' } }), 1500),
    ).toBe(true);
    expect(shouldClearTransition(starting, endpoint({ health: 'healthy' }), 1500)).toBe(true);
  });

  it('starting keeps waiting while still Initializing', () => {
    expect(
      shouldClearTransition(starting, endpoint({ lifecycle: { state: 'Initializing' }, health: 'starting' }), 1500),
    ).toBe(false);
  });

  it('any Failed/error state clears the transition (resolves to error display)', () => {
    expect(shouldClearTransition(starting, endpoint({ error: 'boom' }), 1500)).toBe(true);
    expect(shouldClearTransition(starting, endpoint({ health: 'failed' }), 1500)).toBe(true);
    expect(
      shouldClearTransition(stopping, endpoint({ lifecycle: { state: 'Failed', error: { kind: 'x', detail: 'y' } } }), 1500),
    ).toBe(true);
  });

  it('stopping clears once the endpoint reports disabled or Stopped', () => {
    expect(shouldClearTransition(stopping, endpoint({ disabled: true }), 1500)).toBe(true);
    expect(shouldClearTransition(stopping, endpoint({ lifecycle: { state: 'Stopped' } }), 1500)).toBe(true);
  });

  it('stopping keeps waiting while the endpoint still reports enabled/Ready', () => {
    expect(
      shouldClearTransition(stopping, endpoint({ lifecycle: { state: 'Ready', server_name: 'gh' }, health: 'healthy' }), 1500),
    ).toBe(false);
  });
});
