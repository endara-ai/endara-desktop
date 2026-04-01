import type { RelaySidecarStatusType } from './stores';

export type TopLevelTabId = 'servers' | 'unified-catalog' | 'relay-logs' | 'settings';

export const allTopLevelTabs = [
  { id: 'servers' as const, label: 'MCP Servers' },
  { id: 'unified-catalog' as const, label: 'Unified Catalog' },
  { id: 'relay-logs' as const, label: 'Relay Logs' },
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

export async function restartRelay(invokeFn: (command: string) => Promise<unknown>): Promise<void> {
  await invokeFn('restart_relay');
}