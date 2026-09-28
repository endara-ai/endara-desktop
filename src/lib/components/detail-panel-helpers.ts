import type { Endpoint, OAuthStatus, OAuthStatusValue } from '$lib/types';

export type EndpointTransport = Endpoint['transport'];

const REAUTH_NEEDED_STATUSES: ReadonlyArray<OAuthStatusValue> = [
  'disconnected',
  'auth_required',
  'needs_login',
  'connection_failed',
];

export function shouldShowReauthorizeButton(
  transport: EndpointTransport,
  oauthStatus: OAuthStatusValue | null | undefined,
  endpointError?: string | null,
): boolean {
  if (transport !== 'oauth') return false;
  // The relay maps AuthRequired to this exact health error. Endpoint polls
  // arrive before OAuth details, which may still be missing or stale. Do not
  // infer auth failure from arbitrary errors (including startup needs login).
  if (endpointError === 'auth required') return true;
  if (!oauthStatus) return false;
  return REAUTH_NEEDED_STATUSES.includes(oauthStatus);
}

/**
 * Stability gate for the reauthorize bar.
 *
 * A freshly-built OAuth adapter reports a transient `needs_login` for ~1-2s
 * (one poll) before its just-stored token loads and it flips to
 * `authenticated`. Showing the bar on that first transient produces a
 * misleading 1-2s flash on add / app restart / endpoint restart.
 *
 * Only `needs_login` waits for stability; confirmed failures show immediately.
 * A startup warning is stable when it is:
 * observed across >= REAUTH_GATE_MIN_CONSECUTIVE consecutive polls OR
 * persisting beyond REAUTH_GATE_GRACE_MS. The gate resets the moment the
 * endpoint is authenticated (so a later genuine reauth need isn't suppressed)
 * and whenever the selected endpoint changes.
 */
export const REAUTH_GATE_MIN_CONSECUTIVE = 2;
export const REAUTH_GATE_GRACE_MS = 4000;

export interface ReauthGateState {
  endpointName: string | null;
  consecutiveCount: number;
  firstSeenAt: number | null;
  lastStatus: Pick<OAuthStatus, 'status'> | null;
}

export interface ReauthGateInput {
  endpoint: Pick<Endpoint, 'name' | 'transport' | 'error'> | null;
  oauthStatus: Pick<OAuthStatus, 'status'> | null | undefined;
  now: number;
}

export interface ReauthGateResult {
  state: ReauthGateState;
  showBar: boolean;
}

export function createReauthGateState(): ReauthGateState {
  return { endpointName: null, consecutiveCount: 0, firstSeenAt: null, lastStatus: null };
}

export function evaluateReauthGate(
  prev: ReauthGateState,
  input: ReauthGateInput,
): ReauthGateResult {
  const { endpoint, oauthStatus, now } = input;
  const endpointName = endpoint?.name ?? null;
  const reauthNeeded = endpoint
    ? shouldShowReauthorizeButton(endpoint.transport, oauthStatus?.status, endpoint.error)
    : false;

  // Endpoint changed -> drop any accumulated gate state for the old endpoint.
  const base: ReauthGateState =
    prev.endpointName === endpointName
      ? prev
      : { endpointName, consecutiveCount: 0, firstSeenAt: null, lastStatus: null };

  // Not reauth-needed (e.g. authenticated/refreshing) -> reset the gate so a
  // later genuine reauth need starts a fresh stability window.
  if (!reauthNeeded) {
    return {
      state: { endpointName, consecutiveCount: 0, firstSeenAt: null, lastStatus: null },
      showBar: false,
    };
  }

  // Definitive endpoint evidence and non-startup OAuth states do not need a
  // grace period. They also must not advance a later needs_login window.
  if (endpoint?.error === 'auth required' || oauthStatus?.status !== 'needs_login') {
    return {
      state: { endpointName, consecutiveCount: 0, firstSeenAt: null, lastStatus: null },
      showBar: true,
    };
  }

  // Endpoint updates can arrive before the OAuth request settles. Re-reading
  // the same cached response is not another poll confirming needs_login.
  const consecutiveCount = base.consecutiveCount + (oauthStatus !== base.lastStatus ? 1 : 0);
  const firstSeenAt = base.firstSeenAt ?? now;
  const stableByCount = consecutiveCount >= REAUTH_GATE_MIN_CONSECUTIVE;
  const stableByTime = now - firstSeenAt >= REAUTH_GATE_GRACE_MS;

  return {
    state: { endpointName, consecutiveCount, firstSeenAt, lastStatus: oauthStatus },
    showBar: stableByCount || stableByTime,
  };
}

export type DetailTabId = 'tools' | 'logs' | 'config' | 'auth' | 'profiles';

export interface DetailTab {
  id: DetailTabId;
  label: string;
}

const BASE_TABS: readonly DetailTab[] = [
  { id: 'tools', label: 'Tools' },
  { id: 'logs', label: 'Logs' },
  { id: 'config', label: 'Config' },
];

export function visibleTabs(transport: EndpointTransport, disabled: boolean): DetailTab[] {
  if (disabled) {
    const tabs: DetailTab[] = [{ id: 'config', label: 'Config' }];
    if (transport === 'oauth') {
      tabs.push({ id: 'auth', label: 'Auth' });
    }
    return tabs;
  }
  const tabs: DetailTab[] = [...BASE_TABS];
  if (transport === 'oauth') {
    tabs.push({ id: 'auth', label: 'Auth' });
  }
  tabs.push({ id: 'profiles', label: 'Profiles' });
  return tabs;
}

export function shouldShowRestartButton(transport: EndpointTransport, disabled: boolean): boolean {
  if (disabled) return false;
  return transport === 'stdio' || transport === 'sse' || transport === 'http';
}

const RESTART_BUTTON_TITLES: Record<EndpointTransport, string> = {
  stdio: 'Kill and restart the server process',
  sse: 'Reconnect the SSE event stream',
  http: 'Reconnect to the server',
  // The button never renders for oauth (see shouldShowRestartButton).
  oauth: 'Reconnect to the server',
};

export function restartButtonTitle(transport: EndpointTransport): string {
  return RESTART_BUTTON_TITLES[transport];
}

export function shouldShowRefreshButton(disabled: boolean): boolean {
  return !disabled;
}

/**
 * Compact byte formatter for the container-stats line (base 1024).
 * Examples: `512 B`, `1.5 KB`, `45.2 MB`, `1.2 GB`. Negative or
 * non-finite inputs render as `0 B`.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 'B';
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value.toFixed(1)} ${unit}`;
}

/**
 * CPU percentage for the container-stats line, one decimal place.
 * Negative or non-finite inputs render as `0.0%`.
 */
export function formatCpuPercent(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0.0%';
  return `${value.toFixed(1)}%`;
}
