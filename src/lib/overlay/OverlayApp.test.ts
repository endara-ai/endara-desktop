// Tests for the OverlayApp mount-time show-after-paint contract.
//
// Vitest runs without jsdom (see `vitest.config.ts` -> `environment: 'node'`),
// so we cannot mount the `.svelte` component directly. Instead we exercise
// the `showOverlayAfterPaint` helper that `OverlayApp.svelte` calls from
// `onMount`; this is the unit under test for the "no white flash" fix.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { showOverlayAfterPaint } from './showOverlayAfterPaint';

let rafCallbacks: Array<() => void> = [];
let prevRaf: unknown;

function installRafShim() {
  rafCallbacks = [];
  prevRaf = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (
    cb: () => void,
  ) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  };
}

function restoreRaf() {
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = prevRaf;
}

function flushOneFrame() {
  const cbs = rafCallbacks;
  rafCallbacks = [];
  for (const cb of cbs) cb();
}

describe('showOverlayAfterPaint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installRafShim();
  });

  afterEach(() => {
    restoreRaf();
  });

  it('invokes show_overlay exactly once after a double requestAnimationFrame', async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined);

    showOverlayAfterPaint();

    // After scheduling but before any frame fires, invoke must not be called.
    expect(mockInvoke).not.toHaveBeenCalled();

    // First rAF: schedules the inner rAF, still must not invoke.
    flushOneFrame();
    expect(mockInvoke).not.toHaveBeenCalled();

    // Second rAF: now we invoke show_overlay exactly once.
    flushOneFrame();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('show_overlay');
  });

  it('swallows a rejected show_overlay invoke without throwing', async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockRejectedValue(new Error('command not registered'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => showOverlayAfterPaint()).not.toThrow();
    flushOneFrame();
    flushOneFrame();
    // Let the rejected promise's .catch handler run.
    await Promise.resolve();
    await Promise.resolve();

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
