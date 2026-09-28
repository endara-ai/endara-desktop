import { describe, it, expect, vi } from 'vitest';
import detailPanelSource from './DetailPanel.svelte?raw';
import type { Endpoint, OAuthStatusValue } from '$lib/types';
import {
  shouldShowRestartButton,
  restartButtonTitle,
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
    ['http', true],
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

// The hover title must be transport-specific so an http endpoint is not
// described as an SSE stream.
describe('restartButtonTitle', () => {
  const cases: Array<[EndpointTransport, string]> = [
    ['stdio', 'Kill and restart the server process'],
    ['sse', 'Reconnect the SSE event stream'],
    ['http', 'Reconnect to the server'],
    ['oauth', 'Reconnect to the server'],
  ];

  for (const [transport, expected] of cases) {
    it(`returns "${expected}" for transport "${transport}"`, () => {
      expect(restartButtonTitle(transport)).toBe(expected);
    });
  }
});

// Source-level check of the Restart/Reconnect button markup: the label is
// "Restart" for stdio and "Reconnect" otherwise, and the title is bound to
// the transport via restartButtonTitle.
describe('DetailPanel restart/reconnect button', () => {
  const restartBlock = detailPanelSource.match(
    /\{#if shouldShowRestartButton\([\s\S]*?<button[\s\S]*?<\/button>[\s\S]*?\{\/if\}/,
  );

  it('renders the button under a shouldShowRestartButton guard', () => {
    expect(restartBlock, 'expected to find the shouldShowRestartButton block').not.toBeNull();
    expect(restartBlock![0]).toMatch(
      /ep\.transport\s*===\s*['"]stdio['"]\s*\?\s*['"]Restart['"]\s*:\s*['"]Reconnect['"]/,
    );
  });

  it('binds the title to restartButtonTitle(ep.transport)', () => {
    expect(restartBlock![0]).toMatch(/title=\{\s*restartButtonTitle\(\s*ep\.transport\s*\)\s*\}/);
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
  const reauthStatuses: OAuthStatusValue[] = [
    'disconnected',
    'auth_required',
    'needs_login',
    'connection_failed',
  ];
  const nonReauthStatuses: OAuthStatusValue[] = ['authenticated', 'refreshing'];

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

  it.each([null, undefined, 'authenticated', 'refreshing', 'needs_login'] as const)(
    'uses the relay auth-required error before OAuth status catches up (%s)',
    (status) => {
      expect(shouldShowReauthorizeButton('oauth', status, 'auth required')).toBe(true);
    },
  );

  it.each(['needs login', 'connection failed', 'upstream timeout', 'request failed: auth required'])(
    'does not infer an authorization failure from "%s" without OAuth status',
    (error) => {
      expect(shouldShowReauthorizeButton('oauth', null, error)).toBe(false);
    },
  );

  it.each(['stdio', 'sse', 'http'] as const)(
    'ignores authorization-like errors for %s endpoints',
    (transport) => {
      expect(shouldShowReauthorizeButton(transport, 'auth_required', 'auth required')).toBe(false);
    },
  );
});

// ── Reauthorize-bar stability gate (anti-flash) ──
//
// A freshly-added/restarted OAuth server reports a transient `needs_login`
// for ~1-2s (one 2s poll) before its just-stored token loads and it flips to
// `authenticated`. The gate must swallow that single transient yet still
// surface a genuinely-persistent reauth need within a few seconds.
describe('evaluateReauthGate', () => {
  const endpoint: Pick<Endpoint, 'name' | 'transport' | 'error'> = {
    name: 'srv',
    transport: 'oauth',
  };

  // Feed real status values to the production gate, as successive polls do.
  function runPolls(statuses: OAuthStatusValue[]): boolean[] {
    let state: ReauthGateState = createReauthGateState();
    return statuses.map((oauthStatus, i) => {
      const result = evaluateReauthGate(state, {
        endpoint,
        oauthStatus: oauthStatus ? { status: oauthStatus } : oauthStatus,
        now: 1000 + i * 2000,
      });
      state = result.state;
      return result.showBar;
    });
  }

  it.each([null, undefined, 'authenticated', 'refreshing', 'needs_login'] as const)(
    'shows a confirmed endpoint auth error on the first evaluation with %s OAuth status',
    (oauthStatus) => {
      const result = evaluateReauthGate(createReauthGateState(), {
        endpoint: { ...endpoint, error: 'auth required' },
        oauthStatus: oauthStatus ? { status: oauthStatus } : oauthStatus,
        now: 1000,
      });
      expect(result.showBar).toBe(true);
    },
  );

  it.each(['auth_required', 'disconnected', 'connection_failed'] as const)(
    'shows %s immediately when OAuth status confirms it',
    (status) => {
      expect(runPolls([status])).toEqual([true]);
    },
  );

  it('does not show the action for a startup needs-login error while status is pending', () => {
    const result = evaluateReauthGate(createReauthGateState(), {
      endpoint: { ...endpoint, error: 'needs login' },
      oauthStatus: null,
      now: 1000,
    });
    expect(result.showBar).toBe(false);
  });

  it('does NOT show the bar on a single transient needs_login', () => {
    expect(runPolls(['needs_login', 'authenticated'])).toEqual([false, false]);
  });

  it('does not count an endpoint refresh as a second observation of cached needs_login', () => {
    const cachedStatus = { status: 'needs_login' as const };
    const first = evaluateReauthGate(createReauthGateState(), {
      endpoint,
      oauthStatus: cachedStatus,
      now: 1000,
    });
    const endpointUpdate = evaluateReauthGate(first.state, {
      endpoint: { ...endpoint },
      oauthStatus: cachedStatus,
      now: 2000,
    });
    const recovered = evaluateReauthGate(endpointUpdate.state, {
      endpoint,
      oauthStatus: { status: 'authenticated' },
      now: 2001,
    });
    expect([first.showBar, endpointUpdate.showBar, recovered.showBar])
      .toEqual([false, false, false]);
  });

  it('still shows a persistent cached needs_login after the grace window', () => {
    const cachedStatus = { status: 'needs_login' as const };
    const first = evaluateReauthGate(createReauthGateState(), {
      endpoint,
      oauthStatus: cachedStatus,
      now: 1000,
    });
    const later = evaluateReauthGate(first.state, {
      endpoint,
      oauthStatus: cachedStatus,
      now: 1000 + REAUTH_GATE_GRACE_MS,
    });
    expect([first.showBar, later.showBar]).toEqual([false, true]);
  });

  it('shows the bar once needs_login persists across >=2 consecutive polls', () => {
    expect(runPolls(['needs_login', 'needs_login'])).toEqual([false, true]);
  });

  it('never shows the bar while authenticated or refreshing', () => {
    expect(runPolls(['authenticated', 'refreshing', 'authenticated'])).toEqual([false, false, false]);
  });

  it('restarts the gate after needs_login recovers', () => {
    expect(runPolls(['needs_login', 'needs_login', 'authenticated', 'needs_login']))
      .toEqual([false, true, false, false]);
  });

  it('shows again after recovery once the new need persists', () => {
    expect(runPolls(['needs_login', 'needs_login', 'authenticated', 'needs_login', 'needs_login']))
      .toEqual([false, true, false, false, true]);
  });

  it.each(['authenticated', 'refreshing'] as const)(
    'hides after a confirmed failure recovers to %s and starts a fresh startup gate',
    (status) => {
      expect(runPolls(['auth_required', status, 'needs_login']))
        .toEqual([true, false, false]);
    },
  );

  it('does not count a confirmed failure toward a later needs_login grace period', () => {
    expect(runPolls(['auth_required', 'needs_login'])).toEqual([true, false]);
  });

  it('hides endpoint-derived authorization when the endpoint error clears', () => {
    const first = evaluateReauthGate(createReauthGateState(), {
      endpoint: { ...endpoint, error: 'auth required' },
      oauthStatus: null,
      now: 1000,
    });
    const recovered = evaluateReauthGate(first.state, {
      endpoint,
      oauthStatus: null,
      now: 2000,
    });
    expect([first.showBar, recovered.showBar]).toEqual([true, false]);
  });

  it('shows via the grace window without depending on the observation count', () => {
    const result = evaluateReauthGate({
      endpointName: endpoint.name,
      consecutiveCount: 0,
      firstSeenAt: 1000,
      lastStatus: null,
    }, {
      endpoint,
      oauthStatus: { status: 'needs_login' },
      now: 1000 + REAUTH_GATE_GRACE_MS,
    });
    expect(result.showBar).toBe(true);
  });

  it('resets accumulated state when the selected endpoint changes', () => {
    const first = evaluateReauthGate(createReauthGateState(), {
      endpoint,
      oauthStatus: { status: 'needs_login' },
      now: 1000,
    });
    const switched = evaluateReauthGate(first.state, {
      endpoint: { ...endpoint, name: 'srv-b' },
      oauthStatus: { status: 'needs_login' },
      now: 3000,
    });
    expect([first.showBar, switched.showBar]).toEqual([false, false]);
    expect(switched.state.endpointName).toBe('srv-b');
    expect(switched.state.consecutiveCount).toBe(1);
  });

  it.each(['stdio', 'sse', 'http'] as const)(
    'never shows for a %s error, including after switching from a confirmed OAuth failure',
    (transport) => {
      const first = evaluateReauthGate(createReauthGateState(), {
        endpoint: { ...endpoint, error: 'auth required' },
        oauthStatus: { status: 'auth_required' },
        now: 1000,
      });
      const switched = evaluateReauthGate(first.state, {
        endpoint: { name: 'other', transport, error: 'auth required' },
        oauthStatus: { status: 'auth_required' },
        now: 3000,
      });
      expect([first.showBar, switched.showBar]).toEqual([true, false]);
    },
  );

  it('hides and resets when there is no selected endpoint', () => {
    const first = evaluateReauthGate(createReauthGateState(), {
      endpoint,
      oauthStatus: { status: 'auth_required' },
      now: 1000,
    });
    const cleared = evaluateReauthGate(first.state, {
      endpoint: null,
      oauthStatus: { status: 'auth_required' },
      now: 3000,
    });
    expect([first.showBar, cleared.showBar]).toEqual([true, false]);
    expect(cleared.state).toEqual(createReauthGateState());
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

  it('centers the action vertically while retaining the text and icon alignment', () => {
    expect(reauthBlock![0]).toContain('self-center');
    expect(reauthBlock![0]).not.toContain('self-start');
  });

  it('right-aligns the Re-authorize button using ml-auto', () => {
    expect(reauthBlock, 'expected to find the Re-authorize {#if showReauthorize} block').not.toBeNull();
    expect(reauthBlock![0]).toContain('ml-auto');
  });
});

// ── Confirm-modal reset on endpoint switch ──
//
// A delete/restart confirm opened for one server must never carry over to a
// different server. DetailPanel guards this two ways: (1) the handlers clear
// their confirm flag immediately on confirm — before the async mutation — and
// (2) an effect resets both confirm flags whenever the selected endpoint name
// changes. Verified via static source inspection (the project has no
// component-mount test infra; test env is node, not jsdom).
describe('DetailPanel confirm-modal reset on endpoint switch', () => {
  const resetEffect = detailPanelSource.match(
    /\$effect\(\(\) => \{\s*const name = \$selectedEndpoint;[\s\S]*?\}\);/,
  );

  it('resets both confirm flags in an effect keyed on selectedEndpoint change', () => {
    expect(resetEffect, 'expected the selectedEndpoint reset effect').not.toBeNull();
    expect(resetEffect![0]).toContain('name !== prevConfirmEndpoint');
    expect(resetEffect![0]).toContain('prevConfirmEndpoint = name');
    expect(resetEffect![0]).toContain('showDeleteConfirm = false');
    expect(resetEffect![0]).toContain('showRestartConfirm = false');
  });

  it('tracks the previous endpoint in a plain (non-reactive) variable', () => {
    expect(detailPanelSource).toMatch(/let prevConfirmEndpoint: string \| null = null;/);
  });

  it('closes the delete confirm immediately at the start of handleDelete', () => {
    const handler = detailPanelSource.match(
      /async function handleDelete\(\) \{[\s\S]*?\n  \}/,
    );
    expect(handler, 'expected handleDelete').not.toBeNull();
    const body = handler![0];
    // The flag clear must precede the awaited removeEndpoint call.
    expect(body.indexOf('showDeleteConfirm = false')).toBeLessThan(
      body.indexOf('await removeEndpoint'),
    );
  });

  it('closes the restart confirm immediately at the start of handleRestart', () => {
    const handler = detailPanelSource.match(
      /async function handleRestart\(\) \{[\s\S]*?\n  \}/,
    );
    expect(handler, 'expected handleRestart').not.toBeNull();
    const body = handler![0];
    expect(body.indexOf('showRestartConfirm = false')).toBeLessThan(
      body.indexOf('await restartEndpoint'),
    );
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
