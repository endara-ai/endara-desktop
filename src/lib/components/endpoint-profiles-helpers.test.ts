import { describe, it, expect, vi } from 'vitest';
import type { ProfileSummary, UpdateProfileParams } from '$lib/api';
import {
  buildEndpointProfileRows,
  toggleEndpointInProfile,
  buildToggleUpdatePayload,
} from './endpoint-profiles-helpers';

// Engineering Spec §11 desktop test #10 — per-endpoint Profiles sub-tab shows
// the correct membership checkboxes and toggling them sends a well-formed
// PUT /api/profiles/{path} payload. Component is implemented in
// `ProfilesTab.svelte`; pure logic lives in `endpoint-profiles-helpers.ts`.

function p(
  name: string,
  path: string,
  endpoints: string[],
  overrides: Partial<ProfileSummary> = {},
): ProfileSummary {
  return {
    name,
    path,
    endpoints,
    js_execution: false,
    toon_output: true,
    endpoint_count: endpoints.length,
    tool_count: 0,
    ...overrides,
  };
}

describe('buildEndpointProfileRows', () => {
  const profiles: ProfileSummary[] = [
    p('Work', 'work', ['github', 'slack']),
    p('Personal', 'personal', ['gmail']),
    p('Empty', 'empty', []),
  ];

  it('flags each profile as member iff endpoint appears in the membership list', () => {
    const rows = buildEndpointProfileRows(profiles, ['work']);
    expect(rows).toEqual([
      { name: 'Work', path: 'work', member: true },
      { name: 'Personal', path: 'personal', member: false },
      { name: 'Empty', path: 'empty', member: false },
    ]);
  });

  it('preserves the input profile order regardless of membership', () => {
    const rows = buildEndpointProfileRows(profiles, ['personal', 'work']);
    expect(rows.map((r) => r.path)).toEqual(['work', 'personal', 'empty']);
    expect(rows.every((r) => r.member === (r.path !== 'empty'))).toBe(true);
  });

  it('returns all-unchecked rows when membership is empty', () => {
    const rows = buildEndpointProfileRows(profiles, []);
    expect(rows.every((r) => !r.member)).toBe(true);
  });

  it('ignores stale paths in the membership list', () => {
    const rows = buildEndpointProfileRows(profiles, ['nonexistent']);
    expect(rows.every((r) => !r.member)).toBe(true);
  });
});

describe('toggleEndpointInProfile', () => {
  it('adds the endpoint when nextMember=true and it is absent', () => {
    expect(toggleEndpointInProfile({ endpoints: ['a', 'b'] }, 'c', true)).toEqual(['a', 'b', 'c']);
  });

  it('is idempotent when adding an already-present endpoint', () => {
    expect(toggleEndpointInProfile({ endpoints: ['a', 'b'] }, 'a', true)).toEqual(['a', 'b']);
  });

  it('removes every occurrence when nextMember=false', () => {
    expect(toggleEndpointInProfile({ endpoints: ['a', 'b', 'a'] }, 'a', false)).toEqual(['b']);
  });

  it('is idempotent when removing an absent endpoint', () => {
    expect(toggleEndpointInProfile({ endpoints: ['a', 'b'] }, 'c', false)).toEqual(['a', 'b']);
  });

  it('does not mutate the input array', () => {
    const original: string[] = ['a', 'b'];
    toggleEndpointInProfile({ endpoints: original }, 'c', true);
    expect(original).toEqual(['a', 'b']);
  });
});

describe('buildToggleUpdatePayload', () => {
  it('preserves all profile-level fields and updates only endpoints (add)', () => {
    const profile = p('Work', 'work', ['github'], { js_execution: true, toon_output: false });
    const payload = buildToggleUpdatePayload(profile, 'slack', true);
    const expected: UpdateProfileParams = {
      name: 'Work',
      path: 'work',
      endpoints: ['github', 'slack'],
      js_execution: true,
      toon_output: false,
    };
    expect(payload).toEqual(expected);
  });

  it('mirrors the profile booleans through unchanged on remove', () => {
    const profile = p('Personal', 'personal', ['gmail', 'github']);
    const payload = buildToggleUpdatePayload(profile, 'github', false);
    expect(payload).toEqual({
      name: 'Personal',
      path: 'personal',
      endpoints: ['gmail'],
      js_execution: false,
      toon_output: true,
    });
  });
});

// Driver mirroring the handleToggle logic in ProfilesTab.svelte so we can
// assert end-to-end membership refresh behaviour without mounting Svelte.
interface ToggleDeps {
  updateProfile: (path: string, params: UpdateProfileParams) => Promise<unknown>;
  refresh: () => Promise<void>;
  toastError: (msg: string) => void;
}

async function runHandleToggle(
  profile: ProfileSummary,
  endpointName: string,
  nextMember: boolean,
  deps: ToggleDeps,
): Promise<void> {
  try {
    await deps.updateProfile(profile.path, buildToggleUpdatePayload(profile, endpointName, nextMember));
    await deps.refresh();
  } catch {
    deps.toastError(`Failed to update profile "${profile.name}"`);
  }
}

describe('ProfilesTab toggle round-trip', () => {
  it('PUTs the correct payload and refreshes membership on success', async () => {
    const profile = p('Work', 'work', ['github']);
    const updateProfile = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => undefined);
    const toastError = vi.fn();
    await runHandleToggle(profile, 'slack', true, { updateProfile, refresh, toastError });
    expect(updateProfile).toHaveBeenCalledWith('work', {
      name: 'Work',
      path: 'work',
      endpoints: ['github', 'slack'],
      js_execution: false,
      toon_output: true,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('toasts an error and skips refresh when the PUT rejects', async () => {
    const profile = p('Work', 'work', ['github']);
    const updateProfile = vi.fn(async () => { throw new Error('HTTP 500'); });
    const refresh = vi.fn(async () => undefined);
    const toastError = vi.fn();
    await runHandleToggle(profile, 'slack', true, { updateProfile, refresh, toastError });
    expect(refresh).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('Failed to update profile "Work"');
  });
});
