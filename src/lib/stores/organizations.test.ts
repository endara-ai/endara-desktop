import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { Organization } from '$lib/types';

const { listOrganizationsMock } = vi.hoisted(() => ({
  listOrganizationsMock: vi.fn(),
}));
vi.mock('$lib/api', () => ({
  listOrganizations: listOrganizationsMock,
}));

import { organizations, refreshOrganizations } from './organizations';

// Wave 9: Settings → Organizations subscribes to this shared store so a newly
// created org (including one still pending sign-in) shows up live, with no
// app/relay restart and no component remount. These tests stand in for that
// data path: the Connect-org flow calls `refreshOrganizations()` and any
// already-mounted subscriber must see the new list.
const org = (name: string, authenticated: boolean): Organization => ({
  name,
  provider: 'okta',
  idp: 'okta',
  authenticated,
});

describe('organizations shared store', () => {
  beforeEach(() => {
    listOrganizationsMock.mockReset();
    organizations.set([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refreshOrganizations publishes the relay list to the store', async () => {
    listOrganizationsMock.mockResolvedValue([org('acme', true)]);

    await refreshOrganizations();

    expect(listOrganizationsMock).toHaveBeenCalledTimes(1);
    expect(get(organizations)).toEqual([org('acme', true)]);
  });

  // The core DoD: an already-subscribed view (Settings, mounted once) sees the
  // newly-created org after the Connect-org flow refreshes — no remount.
  it('an existing subscriber sees a newly-created org after refresh', async () => {
    const seen: number[] = [];
    const unsub = organizations.subscribe((v) => seen.push(v.length));

    listOrganizationsMock.mockResolvedValue([org('acme', true)]);
    await refreshOrganizations();

    unsub();
    expect(seen).toEqual([0, 1]);
    expect(get(organizations)[0].name).toBe('acme');
  });

  // Persisting-before-auth: a created-but-not-yet-signed-in org still lands in
  // the store with `authenticated: false` so the UI renders "Sign-in required".
  it('exposes a pending-auth org with authenticated=false', async () => {
    listOrganizationsMock.mockResolvedValue([org('pending-co', false)]);

    await refreshOrganizations();

    const current = get(organizations);
    expect(current).toHaveLength(1);
    expect(current[0].authenticated).toBe(false);
  });

  it('refreshOrganizations rejects when the relay call fails', async () => {
    organizations.set([org('keep-me', true)]);
    listOrganizationsMock.mockRejectedValue(new Error('relay down'));

    await expect(refreshOrganizations()).rejects.toThrow('relay down');
    // Store is left untouched so a transient failure doesn't blank the list.
    expect(get(organizations)).toEqual([org('keep-me', true)]);
  });
});
