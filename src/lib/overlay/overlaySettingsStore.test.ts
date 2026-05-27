import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import {
  DEFAULT_OVERLAY_SETTINGS,
  fetchOverlaySettings,
  overlaySettings,
  subscribeOverlaySettingsChanges,
  updateOverlaySettings,
  type OverlaySettings,
} from './overlaySettingsStore';

// Phase 5: shared store backing the Settings UI + the overlay window. Tests
// mock the Tauri invoke / listen surface and assert the store value tracks
// the backend.
describe('overlaySettingsStore', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
  const listenMock = listen as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    overlaySettings.set(DEFAULT_OVERLAY_SETTINGS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetchOverlaySettings invokes get_overlay_settings and seeds the store', async () => {
    const payload: OverlaySettings = {
      enabled: false,
      position: 'top-left',
      auto_dismiss_ms: 4200,
      max_visible: 6,
      show_profile: false,
    };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_overlay_settings') return Promise.resolve(payload);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await fetchOverlaySettings();

    expect(invokeMock).toHaveBeenCalledWith('get_overlay_settings');
    expect(get(overlaySettings)).toEqual(payload);
  });

  it('fetchOverlaySettings swallows backend errors and leaves the store alone', async () => {
    invokeMock.mockImplementation(() => Promise.reject(new Error('backend down')));
    const before = get(overlaySettings);
    await expect(fetchOverlaySettings()).resolves.toBeUndefined();
    expect(get(overlaySettings)).toEqual(before);
  });

  it('updateOverlaySettings optimistically merges then calls set_overlay_settings', async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === 'set_overlay_settings') return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    await updateOverlaySettings({ position: 'top-right', enabled: false });

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('set_overlay_settings');
    const sent = calls[0].args?.settings as OverlaySettings;
    expect(sent.position).toBe('top-right');
    expect(sent.enabled).toBe(false);
    // Unspecified fields preserved from current store value.
    expect(sent.auto_dismiss_ms).toBe(DEFAULT_OVERLAY_SETTINGS.auto_dismiss_ms);
    expect(get(overlaySettings).position).toBe('top-right');
    expect(get(overlaySettings).enabled).toBe(false);
  });

  it('updateOverlaySettings reverts the store when the Tauri write rejects', async () => {
    invokeMock.mockImplementation(() => Promise.reject(new Error('write failed')));
    const before = get(overlaySettings);

    await expect(
      updateOverlaySettings({ position: 'bottom-left' }),
    ).rejects.toThrow('write failed');

    expect(get(overlaySettings)).toEqual(before);
  });

  it('subscribeOverlaySettingsChanges pushes broadcast events into the store', async () => {
    let captured: ((e: { payload: OverlaySettings }) => void) | null = null;
    listenMock.mockImplementation(async (_name: string, handler: unknown) => {
      captured = handler as typeof captured;
      return () => {};
    });

    await subscribeOverlaySettingsChanges();
    expect(listenMock).toHaveBeenCalledWith(
      'overlay:settings-changed',
      expect.any(Function),
    );

    captured!({
      payload: {
        enabled: true,
        position: 'bottom-left',
        auto_dismiss_ms: 1500,
        max_visible: 3,
        show_profile: false,
      },
    });

    expect(get(overlaySettings)).toEqual({
      enabled: true,
      position: 'bottom-left',
      auto_dismiss_ms: 1500,
      max_visible: 3,
      show_profile: false,
    });
  });
});
