import { describe, expect, it } from 'vitest';

import { getActiveTopLevelTab, getVisibleTopLevelTabs } from '$lib/relaySidecarUi';

describe('+page relay tab logic', () => {
  it('shows only relay logs and settings tabs when the relay sidecar failed', () => {
    expect(getVisibleTopLevelTabs('failed').map((tab) => tab.id)).toEqual(['relay-logs', 'settings']);
  });

  it('shows only relay logs and settings tabs when the relay sidecar stopped', () => {
    expect(getVisibleTopLevelTabs('stopped').map((tab) => tab.id)).toEqual(['relay-logs', 'settings']);
  });

  it('shows all top-level tabs when the relay sidecar is running', () => {
    expect(getVisibleTopLevelTabs('running').map((tab) => tab.id)).toEqual([
      'servers',
      'unified-catalog',
      'relay-logs',
      'settings',
    ]);
  });

  it('switches to settings when the active tab is hidden by relay restrictions', () => {
    expect(getActiveTopLevelTab('servers', 'failed')).toBe('settings');
  });
});