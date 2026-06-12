import type { Endpoint, OAuthStatusValue } from '$lib/types';

export type EndpointTransport = Endpoint['transport'];

const REAUTH_NEEDED_STATUSES: ReadonlyArray<OAuthStatusValue> = [
  'disconnected',
  'auth_required',
  'needs_login',
];

export function shouldShowReauthorizeButton(
  transport: EndpointTransport,
  oauthStatus: OAuthStatusValue | null | undefined,
): boolean {
  if (transport !== 'oauth') return false;
  if (!oauthStatus) return false;
  return REAUTH_NEEDED_STATUSES.includes(oauthStatus);
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
