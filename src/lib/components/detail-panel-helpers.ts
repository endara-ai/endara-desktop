import type { Endpoint, OAuthStatusValue } from '$lib/types';

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
): boolean {
  if (transport !== 'oauth') return false;
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
 * This gate only lets the bar appear once a reauth-needed status is STABLE:
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
}

export interface ReauthGateInput {
  endpointName: string | null;
  reauthNeeded: boolean;
  now: number;
}

export interface ReauthGateResult {
  state: ReauthGateState;
  showBar: boolean;
}

export function createReauthGateState(): ReauthGateState {
  return { endpointName: null, consecutiveCount: 0, firstSeenAt: null };
}

export function evaluateReauthGate(
  prev: ReauthGateState,
  input: ReauthGateInput,
): ReauthGateResult {
  const { endpointName, reauthNeeded, now } = input;

  // Endpoint changed -> drop any accumulated gate state for the old endpoint.
  const base: ReauthGateState =
    prev.endpointName === endpointName
      ? prev
      : { endpointName, consecutiveCount: 0, firstSeenAt: null };

  // Not reauth-needed (e.g. authenticated/refreshing) -> reset the gate so a
  // later genuine reauth need starts a fresh stability window.
  if (!reauthNeeded) {
    return {
      state: { endpointName, consecutiveCount: 0, firstSeenAt: null },
      showBar: false,
    };
  }

  const consecutiveCount = base.consecutiveCount + 1;
  const firstSeenAt = base.firstSeenAt ?? now;
  const stableByCount = consecutiveCount >= REAUTH_GATE_MIN_CONSECUTIVE;
  const stableByTime = now - firstSeenAt >= REAUTH_GATE_GRACE_MS;

  return {
    state: { endpointName, consecutiveCount, firstSeenAt },
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
  return transport === 'stdio' || transport === 'sse';
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
