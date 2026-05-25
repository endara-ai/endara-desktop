import { describe, it, expect } from 'vitest';
import {
  allTopLevelTabs,
  getVisibleTopLevelTabs,
  getActiveTopLevelTab,
  relayTabsRestricted,
} from './relaySidecarUi';
import type { RelaySidecarStatusType } from './stores';

describe('allTopLevelTabs', () => {
  it("includes 'profiles' between 'unified-catalog' and 'relay-logs'", () => {
    const ids = allTopLevelTabs.map((tab) => tab.id);
    const catalogIdx = ids.indexOf('unified-catalog');
    const profilesIdx = ids.indexOf('profiles');
    const logsIdx = ids.indexOf('relay-logs');
    expect(catalogIdx).toBeGreaterThanOrEqual(0);
    expect(profilesIdx).toBe(catalogIdx + 1);
    expect(logsIdx).toBe(profilesIdx + 1);
  });

  it("labels the profiles tab 'Profiles'", () => {
    const tab = allTopLevelTabs.find((t) => t.id === 'profiles');
    expect(tab?.label).toBe('Profiles');
  });
});

describe('getVisibleTopLevelTabs — profiles visibility (test matrix #9)', () => {
  const visibleStatuses: RelaySidecarStatusType[] = ['running', 'starting', 'unknown', 'restarting'];
  const restrictedStatuses: RelaySidecarStatusType[] = ['failed', 'stopped'];

  for (const status of visibleStatuses) {
    it(`shows 'profiles' when relay status is '${status}'`, () => {
      const ids = getVisibleTopLevelTabs(status).map((tab) => tab.id);
      expect(ids).toContain('profiles');
    });
  }

  for (const status of restrictedStatuses) {
    it(`hides 'profiles' when relay status is '${status}'`, () => {
      const ids = getVisibleTopLevelTabs(status).map((tab) => tab.id);
      expect(ids).not.toContain('profiles');
      expect(relayTabsRestricted(status)).toBe(true);
    });

    it(`hides 'profiles' alongside 'servers' and 'unified-catalog' when relay status is '${status}'`, () => {
      const ids = getVisibleTopLevelTabs(status).map((tab) => tab.id);
      expect(ids).not.toContain('servers');
      expect(ids).not.toContain('unified-catalog');
      expect(ids).not.toContain('profiles');
      expect(ids).toEqual(['relay-logs', 'settings']);
    });
  }
});

describe("getActiveTopLevelTab — 'profiles' selection", () => {
  it("keeps 'profiles' active when relay is running", () => {
    expect(getActiveTopLevelTab('profiles', 'running')).toBe('profiles');
  });

  it("falls back to 'settings' when 'profiles' is the active tab but relay is failed", () => {
    expect(getActiveTopLevelTab('profiles', 'failed')).toBe('settings');
  });

  it("falls back to 'settings' when 'profiles' is the active tab but relay is stopped", () => {
    expect(getActiveTopLevelTab('profiles', 'stopped')).toBe('settings');
  });
});
