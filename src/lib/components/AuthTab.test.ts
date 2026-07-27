import { describe, it, expect, beforeAll } from 'vitest';

// Re-implement the pure logic from AuthTab.svelte so we can unit-test it.
// These must stay in sync with the component implementation.

function formatTime(unixSeconds: number | null): string {
  if (unixSeconds === null || unixSeconds === undefined) return '—';
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleString();
}

function formatCountdown(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds <= 0) return 'Expired';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m > 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// Pure mirror of the `canRefresh` derivation in AuthTab.svelte. Kept in sync
// with the component so we can unit-test which OAuth statuses surface the
// "Refresh Now" button. `connection_failed` is included because the relay
// accepts a refresh from that state when a refresh token exists; `auth_required`
// stays excluded — once the token is fully expired the user must re-authorize,
// not silently refresh.
type OAuthStatusValue =
  | 'authenticated'
  | 'needs_login'
  | 'refreshing'
  | 'auth_required'
  | 'disconnected'
  | 'connection_failed';

interface MinimalOAuthStatus {
  status: OAuthStatusValue;
  has_refresh_token: boolean;
}

function canRefresh(status: MinimalOAuthStatus | null): boolean {
  return (
    status !== null &&
    status.has_refresh_token &&
    (['authenticated', 'connection_failed'] as OAuthStatusValue[]).includes(status.status)
  );
}

// Pure mirror of the `canReauth` derivation in AuthTab.svelte, which delegates
// to `canReauthorize()` from $lib/oauth/actions. Kept in sync with that helper's
// REAUTHORIZE_STATUSES so we can unit-test which statuses surface the
// "Re-authenticate" button.
function canReauth(status: MinimalOAuthStatus | null): boolean {
  return (
    status !== null &&
    (['disconnected', 'auth_required', 'needs_login', 'connection_failed'] as OAuthStatusValue[]).includes(
      status.status,
    )
  );
}

// Pure mirror of the `connectivityFailure` derivation in AuthTab.svelte, which
// delegates to `isConnectivityFailure()` from $lib/oauth/actions. Kept in sync
// so we can unit-test which statuses trigger the connectivity presentation
// (explanatory copy + Refresh Now promoted to primary).
function connectivityFailure(status: MinimalOAuthStatus | null): boolean {
  return status !== null && status.status === 'connection_failed';
}

// Pure mirror of the `actionBusy` derivation in AuthTab.svelte. Both the
// "Refresh Now" and "Re-authenticate" buttons bind their `disabled` state to
// this shared guard so neither can be triggered while either flow is running,
// avoiding an overlapping token refresh + browser OAuth flow.
function actionBusy(actionInProgress: boolean, reauthInProgress: boolean): boolean {
  return actionInProgress || reauthInProgress;
}


describe('formatTime', () => {
  it('returns "—" for null', () => {
    expect(formatTime(null)).toBe('—');
  });

  it('returns a reasonable 2024 date for unix timestamp 1712188800', () => {
    const result = formatTime(1712188800);
    // 1712188800 = April 4, 2024 00:00:00 UTC
    expect(result).toContain('2024');
    // Should NOT contain "1970"
    expect(result).not.toContain('1970');
  });

  it('returns "—" for undefined (cast as null)', () => {
    expect(formatTime(undefined as unknown as null)).toBe('—');
  });

  it('handles zero (epoch) correctly', () => {
    const result = formatTime(0);
    // 0 seconds = Jan 1, 1970 — but this is the correct epoch, not a bug
    expect(result).toContain('1970');
  });
});

describe('formatCountdown', () => {
  it('returns "—" for null', () => {
    expect(formatCountdown(null)).toBe('—');
  });

  it('returns "—" for undefined (cast as null)', () => {
    expect(formatCountdown(undefined as unknown as null)).toBe('—');
  });

  it('returns "Expired" for 0', () => {
    expect(formatCountdown(0)).toBe('Expired');
  });

  it('returns "Expired" for negative values', () => {
    expect(formatCountdown(-10)).toBe('Expired');
  });

  it('formats 3600 seconds as "60m 0s"', () => {
    expect(formatCountdown(3600)).toBe('60m 0s');
  });

  it('formats 90 seconds as "1m 30s"', () => {
    expect(formatCountdown(90)).toBe('1m 30s');
  });

  it('formats 30 seconds as "30s"', () => {
    expect(formatCountdown(30)).toBe('30s');
  });

  it('formats large values with hours', () => {
    // 7200 seconds = 120 minutes = 2h 0m
    expect(formatCountdown(7200)).toBe('2h 0m');
  });

  it('formats 3661 seconds as "1h 1m"', () => {
    // 3661 seconds = 61 minutes 1 second → 1h 1m
    expect(formatCountdown(3661)).toBe('1h 1m');
  });
});

describe('canRefresh', () => {
  it('returns true when authenticated and a refresh token is present', () => {
    expect(canRefresh({ status: 'authenticated', has_refresh_token: true })).toBe(true);
  });

  it('returns false when authenticated but no refresh token is present', () => {
    expect(canRefresh({ status: 'authenticated', has_refresh_token: false })).toBe(false);
  });

  // Regression guard: prior to moving Re-authorize into the error bar,
  // `auth_required` qualified for Refresh Now. After the change, an expired
  // token should hide Refresh Now so the user re-authorizes instead.
  it('returns false for auth_required (regression guard)', () => {
    expect(canRefresh({ status: 'auth_required', has_refresh_token: true })).toBe(false);
  });

  it('returns false for needs_login', () => {
    expect(canRefresh({ status: 'needs_login', has_refresh_token: true })).toBe(false);
  });

  it('returns false for disconnected', () => {
    expect(canRefresh({ status: 'disconnected', has_refresh_token: true })).toBe(false);
  });

  it('returns true for connection_failed when a refresh token is present', () => {
    expect(canRefresh({ status: 'connection_failed', has_refresh_token: true })).toBe(true);
  });

  it('returns false for connection_failed when no refresh token is present', () => {
    expect(canRefresh({ status: 'connection_failed', has_refresh_token: false })).toBe(false);
  });

  it('returns false when status is null', () => {
    expect(canRefresh(null)).toBe(false);
  });
});

describe('canReauth', () => {
  it('returns true for connection_failed (with or without a refresh token)', () => {
    expect(canReauth({ status: 'connection_failed', has_refresh_token: true })).toBe(true);
    expect(canReauth({ status: 'connection_failed', has_refresh_token: false })).toBe(true);
  });

  it('returns true for needs_login', () => {
    expect(canReauth({ status: 'needs_login', has_refresh_token: false })).toBe(true);
  });

  it('returns true for auth_required', () => {
    expect(canReauth({ status: 'auth_required', has_refresh_token: true })).toBe(true);
  });

  it('returns true for disconnected', () => {
    expect(canReauth({ status: 'disconnected', has_refresh_token: false })).toBe(true);
  });

  it('returns false for authenticated', () => {
    expect(canReauth({ status: 'authenticated', has_refresh_token: true })).toBe(false);
  });

  it('returns false for refreshing', () => {
    expect(canReauth({ status: 'refreshing', has_refresh_token: true })).toBe(false);
  });

  it('returns false when status is null', () => {
    expect(canReauth(null)).toBe(false);
  });
});

describe('connectivityFailure', () => {
  it('returns true only for connection_failed', () => {
    expect(connectivityFailure({ status: 'connection_failed', has_refresh_token: true })).toBe(true);
    expect(connectivityFailure({ status: 'connection_failed', has_refresh_token: false })).toBe(true);
  });

  it('returns false for auth-expiry and other statuses', () => {
    for (const status of [
      'authenticated',
      'needs_login',
      'refreshing',
      'auth_required',
      'disconnected',
    ] as OAuthStatusValue[]) {
      expect(connectivityFailure({ status, has_refresh_token: true })).toBe(false);
    }
  });

  it('returns false when status is null', () => {
    expect(connectivityFailure(null)).toBe(false);
  });
});

describe('actionBusy', () => {
  it('is false when neither action is in progress', () => {
    expect(actionBusy(false, false)).toBe(false);
  });

  // Both buttons share this guard: a refresh in progress must also disable the
  // "Re-authenticate" button so the two flows cannot overlap.
  it('is true when a refresh is in progress', () => {
    expect(actionBusy(true, false)).toBe(true);
  });

  // ...and a re-authentication in progress must also disable "Refresh Now".
  it('is true when a re-authentication is in progress', () => {
    expect(actionBusy(false, true)).toBe(true);
  });

  it('is true when both actions are in progress', () => {
    expect(actionBusy(true, true)).toBe(true);
  });
});

// The vitest environment here is `node`, so we can't mount the component and
// inspect a live DOM. Instead, assert against the component source so these
// tests are meaningfully tied to the real `disabled` bindings and handler
// guards (not just the mirrored `actionBusy` helper above). This guards the
// regression where each button only disabled on its own in-progress flag,
// allowing an overlapping token refresh + browser OAuth flow.
describe('AuthTab busy-guard wiring (source contract)', () => {
  let source = '';

  beforeAll(async () => {
    // @ts-expect-error node builtin types not installed
    const { readFileSync } = await import('node:fs');
    // @ts-expect-error node builtin types not installed
    const { fileURLToPath } = await import('node:url');
    source = readFileSync(fileURLToPath(new URL('./AuthTab.svelte', import.meta.url)), 'utf8') as string;
  });

  it('derives a shared actionBusy guard from both in-progress flags', () => {
    expect(source).toMatch(
      /actionBusy\s*=\s*\$derived\(\s*actionInProgress\s*\|\|\s*reauthInProgress\s*\)/,
    );
  });

  it('binds both Refresh Now and Re-authenticate buttons to the shared guard', () => {
    const disabledBindings = source.match(/disabled=\{actionBusy\}/g) ?? [];
    expect(disabledBindings).toHaveLength(2);
    // Neither button should bind disabled to a single per-flow flag anymore.
    expect(source).not.toMatch(/disabled=\{actionInProgress\}/);
    expect(source).not.toMatch(/disabled=\{reauthInProgress\}/);
  });

  it('early-returns from both handlers while either flow is active', () => {
    const guards =
      source.match(/if\s*\(!name\s*\|\|\s*actionInProgress\s*\|\|\s*reauthInProgress\)\s*return;/g) ??
      [];
    expect(guards).toHaveLength(2);
  });
});

// Source contract for the connection_failed presentation: when the server is
// unreachable the stored tokens are likely still valid, so Refresh Now becomes
// the primary action, Re-authenticate is demoted to secondary (only when a
// refresh is actually possible), and explanatory copy replaces the implied
// "auth expired" framing.
describe('AuthTab connectivity-failure wiring (source contract)', () => {
  let source = '';

  beforeAll(async () => {
    // @ts-expect-error node builtin types not installed
    const { readFileSync } = await import('node:fs');
    // @ts-expect-error node builtin types not installed
    const { fileURLToPath } = await import('node:url');
    source = readFileSync(fileURLToPath(new URL('./AuthTab.svelte', import.meta.url)), 'utf8') as string;
  });

  it('derives connectivityFailure from isConnectivityFailure(status.status)', () => {
    expect(source).toMatch(
      /connectivityFailure\s*=\s*\$derived\(\s*status\s*!==\s*null\s*&&\s*isConnectivityFailure\(status\.status\)\s*\)/,
    );
  });

  it('promotes Refresh Now to primary on connectivity failure', () => {
    expect(source).toMatch(/class=\{connectivityFailure\s*\?\s*'btn-pri'\s*:\s*'btn-sec'\}/);
  });

  it('demotes Re-authenticate to secondary only when a refresh is possible', () => {
    expect(source).toMatch(
      /class=\{connectivityFailure\s*&&\s*canRefresh\s*\?\s*'btn-sec'\s*:\s*'btn-pri'\}/,
    );
  });

  it('gates the connectivity copy block on connectivityFailure', () => {
    expect(source).toMatch(
      /\{#if connectivityFailure\}[\s\S]*?Server unreachable — your authorization is likely still valid\.[\s\S]*?\{\/if\}/,
    );
  });

  it('points the copy at Re-authenticate when no refresh token is available', () => {
    expect(source).toMatch(
      /\{canRefresh\s*\?\s*'Retry once your connection is back\.'\s*:\s*'Re-authenticate once your connection is back\.'\}/,
    );
  });
});

