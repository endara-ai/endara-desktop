import { describe, it, expect, vi } from 'vitest';
import profileDetailSource from './ProfileDetail.svelte?raw';
import profilesSource from './Profiles.svelte?raw';
import createProfileModalSource from './CreateProfileModal.svelte?raw';
import type { ProfileDetail, ProfileSummary, UpdateProfileParams } from '$lib/api';
import {
  buildUpdateProfileParams,
  computeProfileIsDirty,
  formFromDetail,
  runDeleteProfile,
  runSaveProfile,
  sortProfilesByName,
  toggleStagedEndpoint,
} from './profile-detail-helpers';

function makeDetail(overrides: Partial<ProfileDetail> = {}): ProfileDetail {
  return {
    name: 'Work',
    path: 'work',
    endpoints: ['Gmail', 'Linear'],
    js_execution: true,
    toon_output: true,
    endpoint_count: 2,
    tool_count: 15,
    tools: [],
    ...overrides,
  };
}

describe('sortProfilesByName', () => {
  it('sorts by friendly name with path tiebreak', () => {
    const profiles: ProfileSummary[] = [
      { name: 'Personal', path: 'personal', endpoints: [], js_execution: false, toon_output: true, endpoint_count: 0, tool_count: 0 },
      { name: 'Work', path: 'work-a', endpoints: [], js_execution: false, toon_output: true, endpoint_count: 0, tool_count: 0 },
      { name: 'Work', path: 'work-b', endpoints: [], js_execution: false, toon_output: true, endpoint_count: 0, tool_count: 0 },
      { name: 'Apex', path: 'apex', endpoints: [], js_execution: false, toon_output: true, endpoint_count: 0, tool_count: 0 },
    ];
    expect(sortProfilesByName(profiles).map((p) => p.path)).toEqual([
      'apex',
      'personal',
      'work-a',
      'work-b',
    ]);
  });

  it('does not mutate the input array', () => {
    const profiles: ProfileSummary[] = [
      { name: 'B', path: 'b', endpoints: [], js_execution: false, toon_output: true, endpoint_count: 0, tool_count: 0 },
      { name: 'A', path: 'a', endpoints: [], js_execution: false, toon_output: true, endpoint_count: 0, tool_count: 0 },
    ];
    const before = profiles.map((p) => p.path);
    sortProfilesByName(profiles);
    expect(profiles.map((p) => p.path)).toEqual(before);
  });
});

// ── Test matrix row #6 — server checklist staging + commit ────────────────────
describe('toggleStagedEndpoint (matrix row #6 — checklist staging)', () => {
  it('adds a missing endpoint name to a new Set', () => {
    const staged = new Set(['Gmail']);
    const next = toggleStagedEndpoint(staged, 'Linear');
    expect(next).not.toBe(staged);
    expect(Array.from(next).sort()).toEqual(['Gmail', 'Linear']);
  });

  it('removes a present endpoint name', () => {
    const staged = new Set(['Gmail', 'Linear']);
    const next = toggleStagedEndpoint(staged, 'Gmail');
    expect(Array.from(next)).toEqual(['Linear']);
  });

  it('does not mutate the input set', () => {
    const staged = new Set(['Gmail']);
    toggleStagedEndpoint(staged, 'Linear');
    expect(Array.from(staged)).toEqual(['Gmail']);
  });

  it('repeated toggles round-trip back to the original membership', () => {
    let staged = new Set(['Gmail']);
    staged = toggleStagedEndpoint(staged, 'Linear');
    staged = toggleStagedEndpoint(staged, 'Linear');
    expect(Array.from(staged)).toEqual(['Gmail']);
  });
});

describe('formFromDetail', () => {
  it('copies the stored booleans verbatim', () => {
    const detail = makeDetail({ js_execution: false, toon_output: true });
    const form = formFromDetail(detail);
    expect(form.jsExecution).toBe(false);
    expect(form.toonOutput).toBe(true);
  });

  it('round-trips true/true', () => {
    const detail = makeDetail({ js_execution: true, toon_output: true });
    const form = formFromDetail(detail);
    expect(form.jsExecution).toBe(true);
    expect(form.toonOutput).toBe(true);
  });

  it('round-trips false/false', () => {
    const detail = makeDetail({ js_execution: false, toon_output: false });
    const form = formFromDetail(detail);
    expect(form.jsExecution).toBe(false);
    expect(form.toonOutput).toBe(false);
  });
});

describe('computeProfileIsDirty', () => {
  it('returns false when form is unchanged from detail', () => {
    const detail = makeDetail();
    expect(computeProfileIsDirty(detail, formFromDetail(detail))).toBe(false);
  });

  it('returns true when the name changes', () => {
    const detail = makeDetail();
    const form = { ...formFromDetail(detail), name: 'Work Updated' };
    expect(computeProfileIsDirty(detail, form)).toBe(true);
  });

  it('returns true when the path changes', () => {
    const detail = makeDetail();
    const form = { ...formFromDetail(detail), path: 'work-2' };
    expect(computeProfileIsDirty(detail, form)).toBe(true);
  });

  it('returns true when js_execution flips between booleans', () => {
    const detail = makeDetail({ js_execution: true });
    const form = { ...formFromDetail(detail), jsExecution: false };
    expect(computeProfileIsDirty(detail, form)).toBe(true);
  });

  it('returns true when toon_output flips between booleans', () => {
    const detail = makeDetail({ toon_output: true });
    const form = { ...formFromDetail(detail), toonOutput: false };
    expect(computeProfileIsDirty(detail, form)).toBe(true);
  });

  it('returns true when an endpoint is staged on', () => {
    const detail = makeDetail();
    const form = formFromDetail(detail);
    form.endpoints = toggleStagedEndpoint(form.endpoints, 'Todoist');
    expect(computeProfileIsDirty(detail, form)).toBe(true);
  });

  it('returns true when an endpoint is staged off', () => {
    const detail = makeDetail();
    const form = formFromDetail(detail);
    form.endpoints = toggleStagedEndpoint(form.endpoints, 'Gmail');
    expect(computeProfileIsDirty(detail, form)).toBe(true);
  });

  it('returns false when the endpoint set has the same members in different order', () => {
    const detail = makeDetail({ endpoints: ['Gmail', 'Linear'] });
    const form = formFromDetail(detail);
    form.endpoints = new Set(['Linear', 'Gmail']);
    expect(computeProfileIsDirty(detail, form)).toBe(false);
  });
});

// ── Test matrix row #4 — Profile detail save ─────────────────────────────────
describe('buildUpdateProfileParams (matrix row #4 — save payload shape)', () => {
  it('emits the staged form as a UpdateProfileParams body', () => {
    const detail = makeDetail();
    const form = formFromDetail(detail);
    form.name = 'Work Updated';
    form.endpoints = toggleStagedEndpoint(form.endpoints, 'Todoist');
    const params = buildUpdateProfileParams(form);
    expect(params).toEqual({
      name: 'Work Updated',
      path: 'work',
      endpoints: ['Gmail', 'Linear', 'Todoist'],
      js_execution: true,
      toon_output: true,
    });
  });

  it('trims surrounding whitespace from the friendly name', () => {
    const detail = makeDetail();
    const form = { ...formFromDetail(detail), name: '  Work  ' };
    expect(buildUpdateProfileParams(form).name).toBe('Work');
  });

  it('always emits concrete booleans on js_execution / toon_output', () => {
    const detail = makeDetail({ js_execution: false, toon_output: true });
    const params = buildUpdateProfileParams(formFromDetail(detail));
    expect(typeof params.js_execution).toBe('boolean');
    expect(typeof params.toon_output).toBe('boolean');
    expect(params.js_execution).toBe(false);
    expect(params.toon_output).toBe(true);
  });
});

describe('runSaveProfile (matrix row #4 — Save calls PUT /api/profiles/{path})', () => {
  function makeDeps(overrides: Partial<Parameters<typeof runSaveProfile>[0]> = {}) {
    const updated: ProfileSummary = {
      name: 'Work Updated',
      path: 'work',
      endpoints: ['Gmail', 'Linear', 'Todoist'],
      js_execution: true,
      toon_output: true,
      endpoint_count: 3,
      tool_count: 25,
    };
    const params: UpdateProfileParams = {
      name: 'Work Updated',
      path: 'work',
      endpoints: ['Gmail', 'Linear', 'Todoist'],
      js_execution: true,
      toon_output: true,
    };
    return {
      originalPath: 'work',
      params,
      updateProfile: vi.fn(async () => updated),
      listProfiles: vi.fn(async () => [updated]),
      setProfiles: vi.fn(),
      setSelectedPath: vi.fn(),
      applyDetail: vi.fn(),
      toastSuccess: vi.fn(),
      toastError: vi.fn(),
      ...overrides,
    };
  }

  it('PUTs the staged params and refreshes the sidebar list', async () => {
    const deps = makeDeps();
    await runSaveProfile(deps);
    expect(deps.updateProfile).toHaveBeenCalledTimes(1);
    expect(deps.updateProfile).toHaveBeenCalledWith('work', deps.params);
    expect(deps.listProfiles).toHaveBeenCalledTimes(1);
    expect(deps.setProfiles).toHaveBeenCalledTimes(1);
    expect(deps.toastSuccess).toHaveBeenCalledWith('Profile "Work Updated" saved');
    expect(deps.toastError).not.toHaveBeenCalled();
  });

  it('rebases the selection on the new path when the profile is renamed', async () => {
    const renamed: ProfileSummary = {
      name: 'Work',
      path: 'work-2',
      endpoints: ['Gmail'],
      js_execution: true,
      toon_output: true,
      endpoint_count: 1,
      tool_count: 5,
    };
    const deps = makeDeps({ updateProfile: vi.fn(async () => renamed) });
    await runSaveProfile(deps);
    expect(deps.setSelectedPath).toHaveBeenCalledWith('work-2');
    expect(deps.applyDetail).toHaveBeenCalledWith(renamed);
  });

  it('toasts an error and does NOT refresh when PUT rejects', async () => {
    const deps = makeDeps({
      updateProfile: vi.fn(async () => {
        throw new Error('HTTP 400: invalid path');
      }),
    });
    await runSaveProfile(deps);
    expect(deps.toastError).toHaveBeenCalledWith('Failed to save "Work Updated"');
    expect(deps.toastSuccess).not.toHaveBeenCalled();
    expect(deps.listProfiles).not.toHaveBeenCalled();
    expect(deps.setProfiles).not.toHaveBeenCalled();
    expect(deps.setSelectedPath).not.toHaveBeenCalled();
  });

  it('post-PUT refresh failure stays silent and still toasts success', async () => {
    const deps = makeDeps({
      listProfiles: vi.fn(async () => {
        throw new Error('HTTP 500: refresh failed');
      }),
    });
    await runSaveProfile(deps);
    expect(deps.toastSuccess).toHaveBeenCalledWith('Profile "Work Updated" saved');
    expect(deps.toastError).not.toHaveBeenCalled();
    expect(deps.setProfiles).not.toHaveBeenCalled();
  });
});

// Verify the integrated staging+save flow that matrix row #6 mandates: a
// toggle does NOT call PUT on its own, then a single Save PUTs the staged
// state once.
describe('checklist staging + save (matrix row #6 — staged, then committed)', () => {
  it('toggling does not call updateProfile; only Save does', async () => {
    const detail = makeDetail({ endpoints: ['Gmail', 'Linear'] });
    let form = formFromDetail(detail);

    const updateProfile = vi.fn(async () => ({
      ...detail,
      endpoints: ['Gmail', 'Todoist'],
    }) as ProfileSummary);

    form.endpoints = toggleStagedEndpoint(form.endpoints, 'Todoist');
    form.endpoints = toggleStagedEndpoint(form.endpoints, 'Linear');
    expect(updateProfile).not.toHaveBeenCalled();

    await runSaveProfile({
      originalPath: detail.path,
      params: buildUpdateProfileParams(form),
      updateProfile,
      listProfiles: vi.fn(async () => []),
      setProfiles: vi.fn(),
      setSelectedPath: vi.fn(),
      applyDetail: vi.fn(),
      toastSuccess: vi.fn(),
      toastError: vi.fn(),
    });

    expect(updateProfile).toHaveBeenCalledTimes(1);
    expect(updateProfile).toHaveBeenCalledWith('work', {
      name: 'Work',
      path: 'work',
      endpoints: ['Gmail', 'Todoist'],
      js_execution: true,
      toon_output: true,
    });
  });
});

// ── Test matrix row #5 — Profile detail delete ────────────────────────────────
describe('runDeleteProfile (matrix row #5 — confirmation, then DELETE)', () => {
  function makeDeps(overrides: Partial<Parameters<typeof runDeleteProfile>[0]> = {}) {
    return {
      path: 'work',
      name: 'Work',
      deleteProfile: vi.fn(async () => undefined),
      listProfiles: vi.fn(async () => []),
      setProfiles: vi.fn(),
      clearSelection: vi.fn(),
      toastSuccess: vi.fn(),
      toastError: vi.fn(),
      ...overrides,
    };
  }

  it('DELETEs the profile, clears selection, refreshes list and toasts success', async () => {
    const deps = makeDeps();
    await runDeleteProfile(deps);
    expect(deps.deleteProfile).toHaveBeenCalledTimes(1);
    expect(deps.deleteProfile).toHaveBeenCalledWith('work');
    expect(deps.clearSelection).toHaveBeenCalledTimes(1);
    expect(deps.listProfiles).toHaveBeenCalledTimes(1);
    expect(deps.setProfiles).toHaveBeenCalledTimes(1);
    expect(deps.toastSuccess).toHaveBeenCalledWith('Profile "Work" deleted');
    expect(deps.toastError).not.toHaveBeenCalled();
  });

  it('toasts an error and does NOT clear selection when DELETE rejects', async () => {
    const deps = makeDeps({
      deleteProfile: vi.fn(async () => {
        throw new Error('HTTP 500: internal error');
      }),
    });
    await runDeleteProfile(deps);
    expect(deps.toastError).toHaveBeenCalledWith('Failed to delete "Work"');
    expect(deps.toastSuccess).not.toHaveBeenCalled();
    expect(deps.clearSelection).not.toHaveBeenCalled();
    expect(deps.listProfiles).not.toHaveBeenCalled();
    expect(deps.setProfiles).not.toHaveBeenCalled();
  });

  it('post-DELETE refresh failure stays silent and still toasts success', async () => {
    const deps = makeDeps({
      listProfiles: vi.fn(async () => {
        throw new Error('HTTP 500: refresh failed');
      }),
    });
    await runDeleteProfile(deps);
    expect(deps.toastSuccess).toHaveBeenCalledWith('Profile "Work" deleted');
    expect(deps.toastError).not.toHaveBeenCalled();
    expect(deps.clearSelection).toHaveBeenCalledTimes(1);
    expect(deps.setProfiles).not.toHaveBeenCalled();
  });
});

// ── Source-level assertion that the detail panel mounts a ConfirmModal for
// delete (test matrix row #5: "Confirmation modal, then DELETE"). Mirrors the
// detail-panel-helpers.test.ts pattern of scanning the .svelte source string
// via Vite's `?raw` query so the test stays runtime-agnostic.
describe('ProfileDetail delete confirmation (matrix row #5 — modal gate)', () => {
  it('renders a ConfirmModal under a showDeleteConfirm guard', () => {
    expect(profileDetailSource).toMatch(/\{#if\s+showDeleteConfirm\}/);
    expect(profileDetailSource).toMatch(/<ConfirmModal[\s\S]*?confirmLabel="Delete"/);
  });

  it("delete button opens the modal instead of calling DELETE directly", () => {
    expect(profileDetailSource).toMatch(
      /onclick=\{\(\)\s*=>\s*\(?\s*showDeleteConfirm\s*=\s*true/,
    );
  });
});

// ── D3.B — empty state + toast notifications ────────────────────────────────
//
// The tab-level empty state lives in `Profiles.svelte` and is gated on
// `!loading && profiles.length === 0` so the loading skeleton and a populated
// list both keep the two-panel layout. The CTA opens the existing
// `CreateProfileModal` from the same component.

describe('Profiles.svelte empty state (D3.B)', () => {
  it('renders the empty-state branch only when no profiles exist and not loading', () => {
    expect(profilesSource).toMatch(
      /\{:else if\s+!loading\s+&&\s+profiles\.length\s*===\s*0\}/,
    );
    expect(profilesSource).toMatch(/data-testid="profiles-empty-state"/);
  });

  it('shows the spec copy and a Create Profile CTA inside the empty state', () => {
    expect(profilesSource).toMatch(/No profiles yet/);
    expect(profilesSource).toMatch(/namespace your servers by project/);
    expect(profilesSource).toMatch(/>\s*Create Profile\s*<\/span>/);
  });

  it('mounts CreateProfileModal from the empty state CTA', () => {
    expect(profilesSource).toMatch(
      /onclick=\{\(\)\s*=>\s*\(?\s*showCreateModal\s*=\s*true/,
    );
    expect(profilesSource).toMatch(/<CreateProfileModal/);
  });
});

describe('CreateProfileModal toast coverage (D3.B)', () => {
  it('toasts success on create', () => {
    expect(createProfileModalSource).toMatch(
      /toast\.success\(`Profile "\$\{created\.name\}" created`\)/,
    );
  });

  it('toasts error on create failure (keeps inline submitError for the relay message)', () => {
    expect(createProfileModalSource).toMatch(
      /toast\.error\(`Failed to create "\$\{name\.trim\(\)\}"`\)/,
    );
    expect(createProfileModalSource).toMatch(/submitError\s*=\s*e instanceof Error/);
  });
});
