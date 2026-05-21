import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';

import { canRetryRelay, getSettingsStatusLabel, restartRelay } from '$lib/relaySidecarUi';

// Mock the relay API surface so we can assert the read path doesn't touch
// `getConfig` and that the write path still calls `reloadConfig`.
const getConfigMock = vi.fn();
const reloadConfigMock = vi.fn();
vi.mock('$lib/api', () => ({
  getConfig: getConfigMock,
  reloadConfig: reloadConfigMock,
  getStatus: vi.fn(),
}));

describe('Settings relay retry behavior', () => {
  it('shows the retry button when the sidecar failed', () => {
    expect(canRetryRelay('failed')).toBe(true);
  });

  it('shows the retry button when the sidecar stopped', () => {
    expect(canRetryRelay('stopped')).toBe(true);
  });

  it('does not show the retry button when the sidecar is running', () => {
    expect(canRetryRelay('running')).toBe(false);
  });

  it('does not show the retry button when the sidecar is starting', () => {
    expect(canRetryRelay('starting')).toBe(false);
  });

  it('does not show the retry button when the sidecar status is unknown', () => {
    expect(canRetryRelay('unknown')).toBe(false);
  });

  it('does not show the retry button when the sidecar is restarting', () => {
    expect(canRetryRelay('restarting')).toBe(false);
  });

  it('invokes restart_relay when retry is triggered', async () => {
    const invokeFn = vi.fn().mockResolvedValue(undefined);

    await restartRelay(invokeFn);

    expect(invokeFn).toHaveBeenCalledWith('restart_relay');
  });
});

describe('Settings status label', () => {
  it('returns "Running" when sidecar is running and relay is connected', () => {
    expect(getSettingsStatusLabel('running', true)).toBe('Running');
  });

  it('returns "Port Conflict" when sidecar failed but relay is connected', () => {
    expect(getSettingsStatusLabel('failed', true)).toBe('Port Conflict');
  });

  it('returns "Restarting…" when sidecar is restarting (regardless of connected state)', () => {
    expect(getSettingsStatusLabel('restarting', false)).toBe('Restarting…');
    expect(getSettingsStatusLabel('restarting', true)).toBe('Restarting…');
  });

  it('returns "Stopped" when sidecar is stopped', () => {
    expect(getSettingsStatusLabel('stopped', false)).toBe('Stopped');
  });

  it('returns "Failed" when sidecar failed and relay is not connected', () => {
    expect(getSettingsStatusLabel('failed', false)).toBe('Failed');
  });

  it('returns "Starting..." when sidecar is starting', () => {
    expect(getSettingsStatusLabel('starting', false)).toBe('Starting...');
  });

  it('returns "Starting..." when sidecar status is unknown', () => {
    expect(getSettingsStatusLabel('unknown', false)).toBe('Starting...');
  });
});

describe('Settings JS execution mode helpers', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    invokeMock.mockReset();
    getConfigMock.mockReset();
    reloadConfigMock.mockReset();
    // Reset the shared store to its default before each test so order
    // doesn't matter.
    const { jsExecutionMode } = await import('$lib/stores');
    jsExecutionMode.set(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetchJsExecutionMode updates the store from the Tauri command (true)', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_js_execution_mode') return Promise.resolve(true);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    const { fetchJsExecutionMode } = await import('$lib/jsExecutionModeUi');
    const { jsExecutionMode } = await import('$lib/stores');

    await fetchJsExecutionMode();

    expect(invokeMock).toHaveBeenCalledWith('get_js_execution_mode');
    expect(get(jsExecutionMode)).toBe(true);
  });

  it('fetchJsExecutionMode is resilient to a failing relay path (regression for cold-start race)', async () => {
    // The original bug: a slow/unavailable relay made the read path throw
    // and the toggle stuck at the default. Now the Tauri command is the
    // source of truth, and getConfig/reloadConfig rejecting must not stop
    // the store from picking up the on-disk value.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_js_execution_mode') return Promise.resolve(true);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    getConfigMock.mockRejectedValue(new Error('relay socket not ready'));
    reloadConfigMock.mockRejectedValue(new Error('relay socket not ready'));
    const { fetchJsExecutionMode } = await import('$lib/jsExecutionModeUi');
    const { jsExecutionMode } = await import('$lib/stores');

    await expect(fetchJsExecutionMode()).resolves.toBeUndefined();
    expect(get(jsExecutionMode)).toBe(true);
  });

  it('fetchJsExecutionMode does NOT call getConfig (relay is no longer in the read path)', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_js_execution_mode') return Promise.resolve(false);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    const { fetchJsExecutionMode } = await import('$lib/jsExecutionModeUi');

    await fetchJsExecutionMode();

    expect(getConfigMock).not.toHaveBeenCalled();
  });

  it('toggleJsExecutionMode calls set_js_execution_mode then reloadConfig, in order', async () => {
    const callOrder: string[] = [];
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'set_js_execution_mode') {
        callOrder.push(`set:${args?.enabled}`);
        return Promise.resolve(undefined);
      }
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    reloadConfigMock.mockImplementation(() => {
      callOrder.push('reload');
      return Promise.resolve();
    });
    const { toggleJsExecutionMode } = await import('$lib/jsExecutionModeUi');
    const { jsExecutionMode } = await import('$lib/stores');
    jsExecutionMode.set(false);

    await toggleJsExecutionMode();

    expect(invokeMock).toHaveBeenCalledWith('set_js_execution_mode', { enabled: true });
    expect(reloadConfigMock).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['set:true', 'reload']);
    expect(get(jsExecutionMode)).toBe(true);
  });

  it('toggleJsExecutionMode reverts the store when set_js_execution_mode rejects', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'set_js_execution_mode') return Promise.reject(new Error('write failed'));
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    const { toggleJsExecutionMode } = await import('$lib/jsExecutionModeUi');
    const { jsExecutionMode } = await import('$lib/stores');
    jsExecutionMode.set(false);

    await toggleJsExecutionMode();

    expect(get(jsExecutionMode)).toBe(false);
    expect(reloadConfigMock).not.toHaveBeenCalled();
  });
});

describe('Settings TOON output helpers', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    invokeMock.mockReset();
    getConfigMock.mockReset();
    reloadConfigMock.mockReset();
    // Reset the shared store to its default (`true`) before each test so
    // order doesn't matter.
    const { toonOutput } = await import('$lib/stores');
    toonOutput.set(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetchToonOutput updates the store from the Tauri command (false)', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_toon_output') return Promise.resolve(false);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    const { fetchToonOutput } = await import('$lib/toonOutputUi');
    const { toonOutput } = await import('$lib/stores');

    await fetchToonOutput();

    expect(invokeMock).toHaveBeenCalledWith('get_toon_output');
    expect(get(toonOutput)).toBe(false);
  });

  it('fetchToonOutput is resilient to a failing relay path', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_toon_output') return Promise.resolve(false);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    getConfigMock.mockRejectedValue(new Error('relay socket not ready'));
    reloadConfigMock.mockRejectedValue(new Error('relay socket not ready'));
    const { fetchToonOutput } = await import('$lib/toonOutputUi');
    const { toonOutput } = await import('$lib/stores');

    await expect(fetchToonOutput()).resolves.toBeUndefined();
    expect(get(toonOutput)).toBe(false);
  });

  it('fetchToonOutput does NOT call getConfig (relay is no longer in the read path)', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'get_toon_output') return Promise.resolve(true);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    const { fetchToonOutput } = await import('$lib/toonOutputUi');

    await fetchToonOutput();

    expect(getConfigMock).not.toHaveBeenCalled();
  });

  it('toggleToonOutput calls set_toon_output then reloadConfig, in order', async () => {
    const callOrder: string[] = [];
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'set_toon_output') {
        callOrder.push(`set:${args?.enabled}`);
        return Promise.resolve(undefined);
      }
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    reloadConfigMock.mockImplementation(() => {
      callOrder.push('reload');
      return Promise.resolve();
    });
    const { toggleToonOutput } = await import('$lib/toonOutputUi');
    const { toonOutput } = await import('$lib/stores');
    toonOutput.set(true);

    await toggleToonOutput();

    expect(invokeMock).toHaveBeenCalledWith('set_toon_output', { enabled: false });
    expect(reloadConfigMock).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['set:false', 'reload']);
    expect(get(toonOutput)).toBe(false);
  });

  it('toggleToonOutput reverts the store when set_toon_output rejects', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'set_toon_output') return Promise.reject(new Error('write failed'));
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    const { toggleToonOutput } = await import('$lib/toonOutputUi');
    const { toonOutput } = await import('$lib/stores');
    toonOutput.set(true);

    await toggleToonOutput();

    expect(get(toonOutput)).toBe(true);
    expect(reloadConfigMock).not.toHaveBeenCalled();
  });
});

