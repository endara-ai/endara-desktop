import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';

import { autoStartEnabled, fetchAutoStart, toggleAutoStart } from './autostart';

// Spec §4 Slice C row 11 / row 12: a single shared autostart store backing
// both Onboarding and Settings. These tests mock the Tauri command surface
// and assert the store value tracks the backend.
describe('autostart shared store', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
    // Reset to the documented default so test order doesn't matter.
    autoStartEnabled.set(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Row 11: store reflects Tauri backend state on init.
  it('fetchAutoStart updates the store from the Tauri command (true)', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_autostart') return Promise.resolve(true);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await fetchAutoStart();

    expect(invokeMock).toHaveBeenCalledWith('get_autostart');
    expect(get(autoStartEnabled)).toBe(true);
  });

  it('fetchAutoStart updates the store from the Tauri command (false)', async () => {
    autoStartEnabled.set(true);
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_autostart') return Promise.resolve(false);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await fetchAutoStart();

    expect(get(autoStartEnabled)).toBe(false);
  });

  it('fetchAutoStart swallows backend errors and leaves the store value alone', async () => {
    autoStartEnabled.set(true);
    invokeMock.mockImplementation(() => Promise.reject(new Error('backend down')));

    await expect(fetchAutoStart()).resolves.toBeUndefined();
    expect(get(autoStartEnabled)).toBe(true);
  });

  // Row 12: toggling (as Settings would) updates the shared store.
  it('toggleAutoStart writes through Tauri and updates the shared store', async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === 'set_autostart') return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await toggleAutoStart();

    expect(invokeMock).toHaveBeenCalledWith('set_autostart', { enabled: true });
    expect(calls).toEqual([{ cmd: 'set_autostart', args: { enabled: true } }]);
    expect(get(autoStartEnabled)).toBe(true);
  });

  it('toggleAutoStart flips back from true to false', async () => {
    autoStartEnabled.set(true);
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'set_autostart') return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await toggleAutoStart();

    expect(invokeMock).toHaveBeenCalledWith('set_autostart', { enabled: false });
    expect(get(autoStartEnabled)).toBe(false);
  });

  it('toggleAutoStart reverts the store when the Tauri write rejects', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'set_autostart') return Promise.reject(new Error('write failed'));
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await toggleAutoStart();

    expect(get(autoStartEnabled)).toBe(false);
  });

  // Both Onboarding and Settings subscribe to `autoStartEnabled`; this asserts
  // that a `fetchAutoStart` triggered by one view propagates to anyone else
  // subscribed (i.e. the store is truly shared, not per-component).
  it('subscribers see the updated value after fetchAutoStart', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_autostart') return Promise.resolve(true);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    const seen: boolean[] = [];
    const unsub = autoStartEnabled.subscribe((v) => seen.push(v));

    await fetchAutoStart();

    unsub();
    expect(seen).toEqual([false, true]);
  });
});

