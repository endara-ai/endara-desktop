import type { RelaySidecarStatusType } from '$lib/stores';
import type { Endpoint, OAuthStatus } from '$lib/types';

export type TrayHealthState = 'healthy' | 'degraded' | 'down';

export function deriveTrayHealth(
  sidecarStatus: RelaySidecarStatusType,
  relayConnected: boolean,
  endpoints: Endpoint[],
  oauthStatuses: Map<string, OAuthStatus>,
): TrayHealthState {
  // Red: relay process not running or not reachable
  if (sidecarStatus === 'failed' || sidecarStatus === 'stopped') {
    return 'down';
  }
  if (!relayConnected && sidecarStatus !== 'starting' && sidecarStatus !== 'unknown') {
    return 'down';
  }

  // During startup, don't show red — we're still connecting
  if (sidecarStatus === 'starting' || sidecarStatus === 'unknown' || sidecarStatus === 'restarting') {
    return 'healthy';
  }

  // Filter to only enabled endpoints
  const enabled = endpoints.filter((ep) => !ep.disabled);

  // If no endpoints configured, relay is healthy (nothing to be wrong with)
  if (enabled.length === 0) {
    return 'healthy';
  }

  // Check each enabled endpoint for problems
  const hasProblems = enabled.some((ep) => {
    // Non-healthy endpoint health status (starting is expected during init)
    if (ep.health !== 'healthy' && ep.health !== 'starting') {
      return true;
    }

    // Failed lifecycle
    if (ep.lifecycle?.state === 'Failed') {
      return true;
    }

    // OAuth endpoints: check for auth issues
    if (ep.transport === 'oauth') {
      const oauthStatus = oauthStatuses.get(ep.name);
      if (oauthStatus) {
        if (oauthStatus.status === 'auth_required' || oauthStatus.status === 'needs_login') {
          return true;
        }
      }
    }

    return false;
  });

  return hasProblems ? 'degraded' : 'healthy';
}

// Compute a short human-readable description of the current tray health
// problem, suitable for embedding in the tray menu's status line and tooltip.
// Returns `null` when the system is healthy (no detail to surface).
//
// Priority:
//   1. Sidecar issues (failed/stopped/not reachable) take precedence over
//      endpoint problems, since a dead relay invalidates per-endpoint state.
//   2. Otherwise, summarize enabled-endpoint problems. OAuth auth issues get
//      their own copy ("Sign in required for X" / "N endpoints need sign-in")
//      because they have a clear user remediation; other health / lifecycle
//      issues fall back to "X unhealthy" / "N endpoints unhealthy".
//   3. Healthy → null.
//
// Disabled endpoints are excluded from counts and names.
export function describeTrayHealthIssue(
  sidecarStatus: RelaySidecarStatusType,
  relaySidecarError: string | null,
  relayConnected: boolean,
  endpoints: Endpoint[],
  oauthStatuses: Map<string, OAuthStatus>,
): string | null {
  // 1. Sidecar issues take priority.
  if (sidecarStatus === 'failed') {
    const firstLine = relaySidecarError?.split('\n')[0]?.trim();
    return firstLine ? `Relay failed: ${firstLine}` : 'Relay failed';
  }
  if (sidecarStatus === 'stopped') {
    return 'Relay stopped';
  }
  if (
    !relayConnected &&
    sidecarStatus !== 'starting' &&
    sidecarStatus !== 'restarting' &&
    sidecarStatus !== 'unknown'
  ) {
    return 'Relay not reachable';
  }

  // 2. Enabled-endpoint problems. Classify each endpoint into at most one
  // bucket; auth wins over health on the same endpoint.
  const enabled = endpoints.filter((ep) => !ep.disabled);

  const authIssues: Endpoint[] = [];
  const healthIssues: Endpoint[] = [];

  for (const ep of enabled) {
    if (ep.transport === 'oauth') {
      const s = oauthStatuses.get(ep.name)?.status;
      if (s === 'auth_required' || s === 'needs_login') {
        authIssues.push(ep);
        continue;
      }
    }

    if (
      (ep.health !== 'healthy' && ep.health !== 'starting') ||
      ep.lifecycle?.state === 'Failed'
    ) {
      healthIssues.push(ep);
    }
  }

  const total = authIssues.length + healthIssues.length;
  if (total === 0) return null;

  if (total === 1) {
    if (authIssues.length === 1) {
      return `Sign in required for ${authIssues[0].name}`;
    }
    return `${healthIssues[0].name} unhealthy`;
  }

  // 2+ problems: collapse by bucket composition.
  if (healthIssues.length === 0) {
    return `${authIssues.length} endpoints need sign-in`;
  }
  if (authIssues.length === 0) {
    return `${healthIssues.length} endpoints unhealthy`;
  }
  return `${total} endpoints need attention`;
}

export type TrayHealthInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface TrayHealthDispatcher {
  dispatch(state: TrayHealthState, detail: string | null): void;
}

// Wraps the `invoke('set_tray_health', ...)` call with dedupe state so callers
// (the +page.svelte `$effect`) can fire on every derivation without spamming
// the backend. Dedupe key is the `(state, detail)` pair so a detail change at
// the same state (e.g. "github-mcp unhealthy" → "2 endpoints unhealthy") still
// reaches the backend. Errors are swallowed and forwarded to `onError`
// (defaults to `console.debug`) so non-Tauri environments (vitest, SSR) don't
// throw.
export function createTrayHealthDispatcher(
  invoke: TrayHealthInvoke,
  onError: (err: unknown) => void = (err) => console.debug('set_tray_health failed', err),
): TrayHealthDispatcher {
  let lastState: TrayHealthState | null = null;
  let lastDetail: string | null = null;
  let primed = false;
  return {
    dispatch(state: TrayHealthState, detail: string | null) {
      if (primed && state === lastState && detail === lastDetail) return;
      lastState = state;
      lastDetail = detail;
      primed = true;
      try {
        const result = invoke('set_tray_health', { state, detail });
        if (result && typeof (result as Promise<unknown>).catch === 'function') {
          (result as Promise<unknown>).catch(onError);
        }
      } catch (err) {
        onError(err);
      }
    },
  };
}
