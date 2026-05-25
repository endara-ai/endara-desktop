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
