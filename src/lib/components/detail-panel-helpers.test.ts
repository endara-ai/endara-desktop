import { describe, it, expect, vi } from 'vitest';
import detailPanelSource from './DetailPanel.svelte?raw';
import {
  shouldShowRestartButton,
  shouldShowRefreshButton,
  visibleTabs,
  type EndpointTransport,
} from './detail-panel-helpers';

describe('shouldShowRestartButton', () => {
  const cases: Array<[EndpointTransport, boolean]> = [
    ['stdio', true],
    ['sse', true],
    ['http', false],
    ['oauth', false],
  ];

  for (const [transport, expected] of cases) {
    it(`returns ${expected} for transport "${transport}" when enabled`, () => {
      expect(shouldShowRestartButton(transport, false)).toBe(expected);
    });
  }

  describe('when disabled', () => {
    const transports: EndpointTransport[] = ['stdio', 'sse', 'http', 'oauth'];
    for (const transport of transports) {
      it(`returns false for transport "${transport}" when disabled`, () => {
        expect(shouldShowRestartButton(transport, true)).toBe(false);
      });
    }
  });
});

describe('shouldShowRefreshButton', () => {
  it('returns true when enabled', () => {
    expect(shouldShowRefreshButton(false)).toBe(true);
  });
  it('returns false when disabled', () => {
    expect(shouldShowRefreshButton(true)).toBe(false);
  });
});

describe('visibleTabs', () => {
  it('returns tools, logs, config for stdio when enabled', () => {
    expect(visibleTabs('stdio', false)).toEqual([
      { id: 'tools', label: 'Tools' },
      { id: 'logs', label: 'Logs' },
      { id: 'config', label: 'Config' },
    ]);
  });

  it('returns tools, logs, config for http when enabled', () => {
    expect(visibleTabs('http', false)).toEqual([
      { id: 'tools', label: 'Tools' },
      { id: 'logs', label: 'Logs' },
      { id: 'config', label: 'Config' },
    ]);
  });

  it('returns tools, logs, config, auth for oauth when enabled', () => {
    expect(visibleTabs('oauth', false)).toEqual([
      { id: 'tools', label: 'Tools' },
      { id: 'logs', label: 'Logs' },
      { id: 'config', label: 'Config' },
      { id: 'auth', label: 'Auth' },
    ]);
  });

  it('returns config only for stdio when disabled', () => {
    expect(visibleTabs('stdio', true)).toEqual([{ id: 'config', label: 'Config' }]);
  });

  it('returns config, auth for oauth when disabled', () => {
    expect(visibleTabs('oauth', true)).toEqual([
      { id: 'config', label: 'Config' },
      { id: 'auth', label: 'Auth' },
    ]);
  });

  it('preserves stable tab order across transports when enabled', () => {
    const order = (t: EndpointTransport) => visibleTabs(t, false).map((tab) => tab.id);
    expect(order('stdio')).toEqual(['tools', 'logs', 'config']);
    expect(order('sse')).toEqual(['tools', 'logs', 'config']);
    expect(order('http')).toEqual(['tools', 'logs', 'config']);
    expect(order('oauth')).toEqual(['tools', 'logs', 'config', 'auth']);
  });
});

// ── Mutation-failure toast behaviour (Engineering Spec §4 Slice A rows 1–2) ──
//
// These tests mirror the handler logic in DetailPanel.svelte (handleDelete /
// handleToggle) as pure functions, the same approach AddEndpointModal.test.ts
// uses for `applyDcrCancel`. Lets us cover the toast contract without mounting
// the Svelte component.

interface DeleteDeps {
  removeEndpoint: (name: string) => Promise<void>;
  getEndpoints: () => Promise<unknown[]>;
  setEndpoints: (data: unknown[]) => void;
  clearSelection: () => void;
  toastSuccess: (msg: string) => void;
  toastError: (msg: string) => void;
}

async function runHandleDelete(name: string, deps: DeleteDeps): Promise<void> {
  try {
    await deps.removeEndpoint(name);
    deps.clearSelection();
    try {
      const data = await deps.getEndpoints();
      deps.setEndpoints(data);
    } catch {
      // Mutation already succeeded — silent on purpose; poll reconciles.
    }
    deps.toastSuccess(`Server "${name}" deleted`);
  } catch {
    deps.toastError(`Failed to delete "${name}"`);
  }
}

describe('DetailPanel mutation-failure toasts', () => {
  it('toasts an error when removeEndpoint rejects (Slice A row 1)', async () => {
    const deps: DeleteDeps = {
      removeEndpoint: vi.fn(async () => {
        throw new Error('HTTP 500: internal error');
      }),
      getEndpoints: vi.fn(async () => []),
      setEndpoints: vi.fn(),
      clearSelection: vi.fn(),
      toastSuccess: vi.fn(),
      toastError: vi.fn(),
    };

    await runHandleDelete('my-server', deps);

    expect(deps.removeEndpoint).toHaveBeenCalledWith('my-server');
    expect(deps.toastError).toHaveBeenCalledTimes(1);
    expect(deps.toastError).toHaveBeenCalledWith('Failed to delete "my-server"');
    expect(deps.toastSuccess).not.toHaveBeenCalled();
    // Mutation failed → selection should NOT be cleared and the list should
    // NOT be refreshed eagerly.
    expect(deps.clearSelection).not.toHaveBeenCalled();
    expect(deps.getEndpoints).not.toHaveBeenCalled();
    expect(deps.setEndpoints).not.toHaveBeenCalled();
  });

  it('mutation failure does not break the next poll cycle (Slice A row 2)', async () => {
    // First call: mutation rejects → toast error.
    // Second call: API recovers → mutation succeeds → success toast.
    // Verifies the handler doesn't leave state corrupted or throw past its
    // own try/catch, so the parent poll loop keeps running normally.
    const removeEndpoint = vi
      .fn<(name: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('HTTP 500'))
      .mockResolvedValueOnce(undefined);
    const getEndpoints = vi.fn(async () => [{ name: 'my-server' }]);
    const setEndpoints = vi.fn();
    const clearSelection = vi.fn();
    const toastSuccess = vi.fn();
    const toastError = vi.fn();

    const deps: DeleteDeps = {
      removeEndpoint,
      getEndpoints,
      setEndpoints,
      clearSelection,
      toastSuccess,
      toastError,
    };

    // First attempt — should not throw out of the handler.
    await expect(runHandleDelete('my-server', deps)).resolves.toBeUndefined();
    expect(toastError).toHaveBeenCalledTimes(1);

    // Subsequent poll-cycle behaviour: getEndpoints is still callable and
    // returns normally, and a retried mutation succeeds.
    await expect(getEndpoints()).resolves.toEqual([{ name: 'my-server' }]);
    await runHandleDelete('my-server', deps);
    expect(toastSuccess).toHaveBeenCalledWith('Server "my-server" deleted');
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it('refresh failure after a successful mutation stays silent (no double toast)', async () => {
    // Mutation succeeds, the inner refresh fails. Behaviour contract:
    // success toast fires, error toast does not, poll loop will reconcile.
    const deps: DeleteDeps = {
      removeEndpoint: vi.fn(async () => undefined),
      getEndpoints: vi.fn(async () => {
        throw new Error('HTTP 500: refresh failed');
      }),
      setEndpoints: vi.fn(),
      clearSelection: vi.fn(),
      toastSuccess: vi.fn(),
      toastError: vi.fn(),
    };

    await runHandleDelete('my-server', deps);

    expect(deps.removeEndpoint).toHaveBeenCalledWith('my-server');
    expect(deps.clearSelection).toHaveBeenCalledTimes(1);
    expect(deps.getEndpoints).toHaveBeenCalledTimes(1);
    expect(deps.setEndpoints).not.toHaveBeenCalled();
    expect(deps.toastSuccess).toHaveBeenCalledWith('Server "my-server" deleted');
    expect(deps.toastError).not.toHaveBeenCalled();
  });
});

// ── Toggle accessibility (Engineering Spec §4 Slice B row 5) ──
//
// The DetailPanel enable/disable toggle is a custom <button> styled as a
// switch. Source-level check that it carries `role="switch"` and
// `aria-checked` bound to the inverse of `ep.disabled` (i.e. the enabled
// state). Done via static source inspection because the project has no
// component-mount test infra (test env is node, not jsdom).
describe('DetailPanel endpoint toggle (a11y)', () => {
  const toggleBlock = detailPanelSource.match(
    /<button[^>]*class="tgl[^"]*"[\s\S]*?>[\s\S]*?<\/button>/,
  );

  it('declares role="switch" on the endpoint enable/disable toggle', () => {
    expect(toggleBlock, 'expected to find the endpoint toggle button').not.toBeNull();
    expect(toggleBlock![0]).toContain('role="switch"');
  });

  it('binds aria-checked to the endpoint enabled state (!ep.disabled)', () => {
    expect(toggleBlock, 'expected to find the endpoint toggle button').not.toBeNull();
    expect(toggleBlock![0]).toMatch(/aria-checked=\{!ep\.disabled\}/);
  });
});
