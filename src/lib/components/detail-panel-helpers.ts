import type { Endpoint } from '$lib/types';

export type EndpointTransport = Endpoint['transport'];

export type DetailTabId = 'tools' | 'logs' | 'config' | 'auth';

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
  return tabs;
}

export function shouldShowRestartButton(transport: EndpointTransport, disabled: boolean): boolean {
  if (disabled) return false;
  return transport === 'stdio' || transport === 'sse';
}

export function shouldShowRefreshButton(disabled: boolean): boolean {
  return !disabled;
}
