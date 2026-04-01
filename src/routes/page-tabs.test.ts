import { describe, expect, it } from 'vitest';

import { getActiveTopLevelTab, getVisibleTopLevelTabs, relayTabsRestricted, shouldShowRelayStartupFailure, shouldSkipEndpointPolling } from '$lib/relaySidecarUi';

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

describe('shouldShowRelayStartupFailure', () => {
  it('returns true when sidecar failed, not connected, and not dismissed', () => {
    expect(shouldShowRelayStartupFailure('failed', false, false)).toBe(true);
  });

  it('returns false when sidecar failed but relay is connected (port conflict)', () => {
    expect(shouldShowRelayStartupFailure('failed', true, false)).toBe(false);
  });

  it('returns false when sidecar failed but user dismissed the modal', () => {
    expect(shouldShowRelayStartupFailure('failed', false, true)).toBe(false);
  });

  it('returns false when sidecar is running', () => {
    expect(shouldShowRelayStartupFailure('running', true, false)).toBe(false);
  });

  it('returns false when sidecar is starting', () => {
    expect(shouldShowRelayStartupFailure('starting', false, false)).toBe(false);
  });
});

describe('shouldSkipEndpointPolling', () => {
  it('returns true when sidecar status is failed', () => {
    expect(shouldSkipEndpointPolling('failed')).toBe(true);
  });

  it('returns false when sidecar status is running', () => {
    expect(shouldSkipEndpointPolling('running')).toBe(false);
  });

  it('returns false when sidecar status is starting', () => {
    expect(shouldSkipEndpointPolling('starting')).toBe(false);
  });

  it('returns false when sidecar status is unknown', () => {
    expect(shouldSkipEndpointPolling('unknown')).toBe(false);
  });

  it('returns true when sidecar status is stopped', () => {
    expect(shouldSkipEndpointPolling('stopped')).toBe(true);
  });
});

describe('relayTabsRestricted', () => {
  it('returns true when sidecar status is failed', () => {
    expect(relayTabsRestricted('failed')).toBe(true);
  });
  it('returns true when sidecar status is stopped', () => {
    expect(relayTabsRestricted('stopped')).toBe(true);
  });
  it('returns false when sidecar status is running', () => {
    expect(relayTabsRestricted('running')).toBe(false);
  });
  it('returns false when sidecar status is starting', () => {
    expect(relayTabsRestricted('starting')).toBe(false);
  });
  it('returns false when sidecar status is unknown', () => {
    expect(relayTabsRestricted('unknown')).toBe(false);
  });
});
