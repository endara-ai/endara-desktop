import { describe, expect, it, vi } from 'vitest';

import { createTrayHealthDispatcher } from './tray-health';

// Engineering spec §8 test matrix rows #16 and #17 — dedupe behavior for the
// `set_tray_health` IPC dispatcher consumed by +page.svelte's `$effect`.

describe('createTrayHealthDispatcher', () => {
  // #16
  it('invokes set_tray_health exactly once on a state transition (healthy → degraded)', () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createTrayHealthDispatcher(invoke);

    dispatcher.dispatch('healthy', null);
    dispatcher.dispatch('degraded', '2 endpoints unhealthy');

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(1, 'set_tray_health', {
      state: 'healthy',
      detail: null,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'set_tray_health', {
      state: 'degraded',
      detail: '2 endpoints unhealthy',
    });
  });

  // #17
  it('does not re-invoke set_tray_health when the same (state, detail) pair is observed twice in a row', () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createTrayHealthDispatcher(invoke);

    dispatcher.dispatch('healthy', null);
    dispatcher.dispatch('healthy', null);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('set_tray_health', { state: 'healthy', detail: null });
  });

  it('re-invokes set_tray_health when toggling back to a previous state', () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createTrayHealthDispatcher(invoke);

    dispatcher.dispatch('healthy', null);
    dispatcher.dispatch('degraded', 'X unhealthy');
    dispatcher.dispatch('healthy', null);

    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('re-invokes set_tray_health when state is unchanged but detail changes', () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createTrayHealthDispatcher(invoke);

    dispatcher.dispatch('degraded', 'github-mcp unhealthy');
    dispatcher.dispatch('degraded', '2 endpoints unhealthy');

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(2, 'set_tray_health', {
      state: 'degraded',
      detail: '2 endpoints unhealthy',
    });
  });

  it('re-invokes set_tray_health when detail is unchanged but state changes', () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createTrayHealthDispatcher(invoke);

    dispatcher.dispatch('degraded', 'Relay not reachable');
    dispatcher.dispatch('down', 'Relay not reachable');

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(2, 'set_tray_health', {
      state: 'down',
      detail: 'Relay not reachable',
    });
  });

  it('swallows synchronous invoke errors via onError (non-Tauri environments)', () => {
    const onError = vi.fn();
    const invoke = vi.fn(() => {
      throw new Error('no tauri host');
    });
    const dispatcher = createTrayHealthDispatcher(invoke, onError);

    expect(() => dispatcher.dispatch('down', null)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('swallows async invoke rejections via onError', async () => {
    const onError = vi.fn();
    const invoke = vi.fn().mockRejectedValue(new Error('ipc failed'));
    const dispatcher = createTrayHealthDispatcher(invoke, onError);

    dispatcher.dispatch('down', null);
    // Let the rejected promise's .catch handler run.
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledTimes(1);
  });
});
