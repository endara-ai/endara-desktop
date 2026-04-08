import type { RelaySidecarStatusType } from './stores';

export type TopLevelTabId = 'servers' | 'unified-catalog' | 'relay-logs' | 'settings';

export const allTopLevelTabs = [
  { id: 'servers' as const, label: 'Servers' },
  { id: 'unified-catalog' as const, label: 'Catalog' },
  { id: 'relay-logs' as const, label: 'Logs' },
  { id: 'settings' as const, label: 'Settings' },
];

export function relayTabsRestricted(status: RelaySidecarStatusType): boolean {
  return status === 'failed' || status === 'stopped';
}

export function getVisibleTopLevelTabs(status: RelaySidecarStatusType) {
  return relayTabsRestricted(status)
    ? allTopLevelTabs.filter((tab) => tab.id === 'relay-logs' || tab.id === 'settings')
    : allTopLevelTabs;
}

export function getActiveTopLevelTab(
  activeTab: TopLevelTabId,
  status: RelaySidecarStatusType
): TopLevelTabId {
  return getVisibleTopLevelTabs(status).some((tab) => tab.id === activeTab) ? activeTab : 'settings';
}

export function canRetryRelay(status: RelaySidecarStatusType): boolean {
  return status === 'failed' || status === 'stopped';
}

export function shouldShowRelayStartupFailure(
  sidecarStatus: RelaySidecarStatusType,
  relayConnected: boolean,
  dismissed: boolean
): boolean {
  return sidecarStatus === 'failed' && !relayConnected && !dismissed;
}

export function shouldSkipEndpointPolling(sidecarStatus: RelaySidecarStatusType): boolean {
  return sidecarStatus === 'failed' || sidecarStatus === 'stopped';
}

export async function restartRelay(invokeFn: (command: string) => Promise<unknown>): Promise<void> {
  await invokeFn('restart_relay');
}

