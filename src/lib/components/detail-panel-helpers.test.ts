import { describe, it, expect, vi } from 'vitest';
import detailPanelSource from './DetailPanel.svelte?raw';
import type { OAuthStatusValue } from '$lib/types';
import {
  shouldShowRestartButton,
  shouldShowRefreshButton,
  shouldShowReauthorizeButton,
  createReauthGateState,
  evaluateReauthGate,
  REAUTH_GATE_GRACE_MS,
  visibleTabs,
  formatBytes,
  formatCpuPercent,
  type EndpointTransport,
  type ReauthGateState,
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
  it('returns tools, logs, config, profiles for stdio when enabled', () => {
    expect(visibleTabs('stdio', false)).toEqual([
      { id: 'tools', label: 'Tools' },
      { id: 'logs', label: 'Logs' },
      { id: 'config', label: 'Config' },
      { id: 'profiles', label: 'Profiles' },
    ]);
  });

  it('returns tools, logs, config, profiles for http when enabled', () => {
    expect(visibleTabs('http', false)).toEqual([
      { id: 'tools', label: 'Tools' },
      { id: 'logs', label: 'Logs' },
      { id: 'config', label: 'Config' },
      { id: 'profiles', label: 'Profiles' },
    ]);
  });

  it('returns tools, logs, config, auth, profiles for oauth when enabled', () => {
    expect(visibleTabs('oauth', false)).toEqual([
      { id: 'tools', label: 'Tools' },
      { id: 'logs', label: 'Logs' },
      { id: 'config', label: 'Config' },
      { id: 'auth', label: 'Auth' },
      { id: 'profiles', label: 'Profiles' },
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

  it('omits profiles tab when disabled', () => {
    for (const t of ['stdio', 'sse', 'http', 'oauth'] as const) {
      const ids = visibleTabs(t, true).map((tab) => tab.id);
      expect(ids).not.toContain('profiles');
    }
  });

  it('preserves stable tab order across transports when enabled', () => {
    const order = (t: EndpointTransport) => visibleTabs(t, false).map((tab) => tab.id);
    expect(order('stdio')).toEqual(['tools', 'logs', 'config', 'profiles']);
    expect(order('sse')).toEqual(['tools', 'logs', 'config', 'profiles']);
    expect(order('http')).toEqual(['tools', 'logs', 'config', 'profiles']);
    expect(order('oauth')).toEqual(['tools', 'logs', 'config', 'auth', 'profiles']);
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

describe('shouldShowReauthorizeButton', () => {
  const reauthStatuses: OAuthStatusValue[] = ['disconnected', 'auth_required', 'needs_login'];
  const nonReauthStatuses: OAuthStatusValue[] = ['authenticated', 'refreshing', 'connection_failed'];

  for (const s of reauthStatuses) {
    it(`returns true for oauth + "${s}"`, () => {
      expect(shouldShowReauthorizeButton('oauth', s)).toBe(true);
    });
  }
  for (const s of nonReauthStatuses) {
    it(`returns false for oauth + "${s}"`, () => {
      expect(shouldShowReauthorizeButton('oauth', s)).toBe(false);
    });
  }
  it('returns false when oauthStatus is null', () => {
    expect(shouldShowReauthorizeButton('oauth', null)).toBe(false);
  });
  it('returns false when oauthStatus is undefined', () => {
    expect(shouldShowReauthorizeButton('oauth', undefined)).toBe(false);
  });
  for (const t of ['stdio', 'sse', 'http'] as const) {
    it(`returns false for non-oauth transport "${t}" even when auth_required`, () => {
      expect(shouldShowReauthorizeButton(t, 'auth_required')).toBe(false);
    });
  }
});

// ── Reauthorize-bar stability gate (anti-flash) ──
//
// A freshly-added/restarted OAuth server reports a transient `needs_login`
// for ~1-2s (one 2s poll) before its just-stored token loads and it flips to
// `authenticated`. The gate must swallow that single transient yet still
// surface a genuinely-persistent reauth need within a few seconds.
describe('evaluateReauthGate', () => {
  // Simulate consecutive poll cycles 2s apart, returning showBar per poll.
  function runPolls(needs: boolean[], endpointName = 'srv', startNow = 1000): boolean[] {
    let state: ReauthGateState = createReauthGateState();
    const shown: boolean[] = [];
    needs.forEach((reauthNeeded, i) => {
      const result = evaluateReauthGate(state, {
        endpointName,
        reauthNeeded,
        now: startNow + i * 2000,
      });
      state = result.state;
      shown.push(result.showBar);
    });
    return shown;
  }

  it('does NOT show the bar on a single transient needs_login', () => {
    // poll 1: needs_login (transient), poll 2: authenticated.
    expect(runPolls([true, false])).toEqual([false, false]);
  });

  it('shows the bar once needs_login persists across >=2 consecutive polls', () => {
    expect(runPolls([true, true])).toEqual([false, true]);
  });

  it('never shows the bar while authenticated', () => {
    expect(runPolls([false, false, false])).toEqual([false, false, false]);
  });

  it('resets the gate on needs_login -> authenticated -> needs_login (no early flash on the new need)', () => {
    // First need persists (shows), recovers (reset), then a single new
    // transient must NOT immediately re-show — the gate restarts clean.
    expect(runPolls([true, true, false, true])).toEqual([false, true, false, false]);
  });

  it('shows again after a reset once the new need persists', () => {
    expect(runPolls([true, true, false, true, true])).toEqual([false, true, false, false, true]);
  });

  it('shows via the grace window even if only a single (slow) poll has elapsed past it', () => {
    // One evaluation, but the time gap already exceeds the grace window.
    const first = evaluateReauthGate(createReauthGateState(), {
      endpointName: 'srv',
      reauthNeeded: true,
      now: 1000,
    });
    expect(first.showBar).toBe(false);
    const later = evaluateReauthGate(first.state, {
      endpointName: 'srv',
      reauthNeeded: true,
      now: 1000 + REAUTH_GATE_GRACE_MS + 1,
    });
    expect(later.showBar).toBe(true);
  });

  it('resets accumulated state when the selected endpoint changes', () => {
    let result = evaluateReauthGate(createReauthGateState(), {
      endpointName: 'srv-a',
      reauthNeeded: true,
      now: 1000,
    });
    expect(result.showBar).toBe(false);
    // Switching to a different endpoint that also needs reauth must start a
    // fresh window — not inherit srv-a's count and immediately flash.
    result = evaluateReauthGate(result.state, {
      endpointName: 'srv-b',
      reauthNeeded: true,
      now: 3000,
    });
    expect(result.showBar).toBe(false);
    expect(result.state.endpointName).toBe('srv-b');
    expect(result.state.consecutiveCount).toBe(1);
  });
});

// ── Re-authorize button source-inspection (mirrors the toggle a11y pattern) ──
//
// The Re-authorize button lives inside the red error bar in DetailPanel.svelte
// and must (a) be rendered only when `showReauthorize` is true and (b) be
// right-aligned via `ml-auto` so it sits opposite the message column.
describe('DetailPanel re-authorize button', () => {
  const reauthBlock = detailPanelSource.match(
    /\{#if showReauthorize\}[\s\S]*?<button[^>]*aria-label="Re-authorize"[\s\S]*?<\/button>[\s\S]*?\{\/if\}/,
  );

  it('renders the Re-authorize button under a showReauthorize guard', () => {
    expect(reauthBlock, 'expected to find the Re-authorize {#if showReauthorize} block').not.toBeNull();
    expect(reauthBlock![0]).toContain('>Re-authorize<');
  });

  it('right-aligns the Re-authorize button using ml-auto', () => {
    expect(reauthBlock, 'expected to find the Re-authorize {#if showReauthorize} block').not.toBeNull();
    expect(reauthBlock![0]).toContain('ml-auto');
  });
});

// ── Container-stats formatters (header metrics line) ──

describe('formatBytes', () => {
  it('formats sub-KB values as whole bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('formats KB/MB/GB with one decimal (base 1024)', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(45.2 * 1024 * 1024)).toBe('45.2 MB');
    expect(formatBytes(1.2 * 1024 * 1024 * 1024)).toBe('1.2 GB');
  });

  it('caps at TB for very large values', () => {
    expect(formatBytes(2.5 * 1024 ** 4)).toBe('2.5 TB');
    expect(formatBytes(5000 * 1024 ** 4)).toBe('5000.0 TB');
  });

  it('renders negative and non-finite inputs as 0 B', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(NaN)).toBe('0 B');
    expect(formatBytes(Infinity)).toBe('0 B');
  });
});

describe('formatCpuPercent', () => {
  it('formats with one decimal place', () => {
    expect(formatCpuPercent(0)).toBe('0.0%');
    expect(formatCpuPercent(1.25)).toBe('1.3%');
    expect(formatCpuPercent(100)).toBe('100.0%');
  });

  it('renders negative and non-finite inputs as 0.0%', () => {
    expect(formatCpuPercent(-3)).toBe('0.0%');
    expect(formatCpuPercent(NaN)).toBe('0.0%');
    expect(formatCpuPercent(Infinity)).toBe('0.0%');
  });
});

// The metrics line must only render when `container_stats` is present, so
// direct-spawn endpoints (absent/null stats) show no metrics.
describe('DetailPanel container-stats line', () => {
  const statsBlock = detailPanelSource.match(
    /\{#if ep\.container_stats\}[\s\S]*?\{\/if\}/,
  );

  it('renders the metrics line under an ep.container_stats guard', () => {
    expect(statsBlock, 'expected to find the {#if ep.container_stats} block').not.toBeNull();
    expect(statsBlock![0]).toContain('formatCpuPercent(ep.container_stats.cpu_percent)');
    expect(statsBlock![0]).toContain('formatBytes(ep.container_stats.mem_bytes)');
    expect(statsBlock![0]).toContain('formatBytes(ep.container_stats.net_rx_bytes)');
    expect(statsBlock![0]).toContain('formatBytes(ep.container_stats.net_tx_bytes)');
  });
});
