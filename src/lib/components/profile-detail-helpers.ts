import type { ProfileDetail, ProfileSummary, UpdateProfileParams } from '$lib/api';

/**
 * The "edited" snapshot of the right-pane form. Held in `$state` while the
 * user types/toggles; committed to the relay on Save via {@link runSaveProfile}.
 *
 * `endpoints` is a `Set<string>` so the checklist UI can flip membership in
 * O(1). The set is converted back to a deterministic array (alphabetical) when
 * we build the PUT body.
 */
export interface ProfileEditForm {
  name: string;
  path: string;
  endpoints: Set<string>;
  jsExecution: boolean;
  toonOutput: boolean;
}

/**
 * Seed the form from a freshly-loaded `ProfileDetail`. The membership set is
 * built from the relay's `endpoints` array so server-side ordering doesn't
 * leak into the form's identity. Used both on initial load and on revert.
 *
 * `defaults` provides the current global `jsExecution` / `toonOutput` values
 * (typically read once from the `jsExecutionMode` / `toonOutput` stores). When
 * the stored detail value is `null` — the legacy "inherit from global" marker
 * the relay still emits on the wire — the form resolves to the matching
 * default. This is a one-way copy-on-write: the next save persists a concrete
 * boolean, so the `null` disappears on first edit-save.
 */
export function formFromDetail(
  detail: ProfileDetail,
  defaults: { jsExecution: boolean; toonOutput: boolean },
): ProfileEditForm {
  return {
    name: detail.name,
    path: detail.path,
    endpoints: new Set(detail.endpoints),
    jsExecution: detail.js_execution ?? defaults.jsExecution,
    toonOutput: detail.toon_output ?? defaults.toonOutput,
  };
}

/**
 * Toggle one endpoint name in the staged membership set. Returns a new `Set`
 * so Svelte reactivity sees the change. The check-then-mutate-then-clone shape
 * keeps the helper pure (no aliasing of the caller's set).
 */
export function toggleStagedEndpoint(staged: Set<string>, name: string): Set<string> {
  const next = new Set(staged);
  if (next.has(name)) {
    next.delete(name);
  } else {
    next.add(name);
  }
  return next;
}

/**
 * Whether the form has uncommitted edits relative to the loaded detail.
 * Compares all four user-editable fields plus membership-as-a-set so order
 * differences in the underlying array don't register as dirty.
 *
 * `defaults` are the same global values used to seed the form in
 * {@link formFromDetail} so we can recognise "user did nothing" on a profile
 * that was loaded with stored `null`. The comparison is therefore against
 * `detail.js_execution ?? defaults.jsExecution` (and same for toon): a
 * profile loaded with stored `null` is dirty IFF the user toggles to the
 * opposite of the global default. The first save then persists a concrete
 * boolean and the `null` disappears from the stored config.
 */
export function computeProfileIsDirty(
  detail: ProfileDetail,
  form: ProfileEditForm,
  defaults: { jsExecution: boolean; toonOutput: boolean },
): boolean {
  if (form.name !== detail.name) return true;
  if (form.path !== detail.path) return true;
  if (form.jsExecution !== (detail.js_execution ?? defaults.jsExecution)) return true;
  if (form.toonOutput !== (detail.toon_output ?? defaults.toonOutput)) return true;
  const original = new Set(detail.endpoints);
  if (original.size !== form.endpoints.size) return true;
  for (const n of form.endpoints) {
    if (!original.has(n)) return true;
  }
  return false;
}

/**
 * Build the `PUT /api/profiles/{path}` body from the current form snapshot.
 * `name` is trimmed (matches the create-profile modal) and `endpoints` is
 * emitted in stable alphabetical order so two semantically-equal saves
 * produce byte-identical bodies. `js_execution` and `toon_output` are always
 * emitted as concrete booleans — the relay still accepts `null` on the wire
 * for backward compat but the desktop never produces it.
 */
export function buildUpdateProfileParams(form: ProfileEditForm): UpdateProfileParams {
  return {
    name: form.name.trim(),
    path: form.path,
    endpoints: Array.from(form.endpoints).sort(),
    js_execution: form.jsExecution,
    toon_output: form.toonOutput,
  };
}

/**
 * Sort summaries for the left-rail sidebar. Engineering Spec §9.2 specifies
 * "List of profiles, sorted by name"; ties break on path so the order is
 * deterministic even when two profiles share a friendly name.
 */
export function sortProfilesByName(profiles: ReadonlyArray<ProfileSummary>): ProfileSummary[] {
  return [...profiles].sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return a.path.localeCompare(b.path);
  });
}

// ── Save/delete handlers (extracted for testability) ─────────────────────────
//
// These mirror the dependency-injection pattern used by
// `detail-panel-helpers.test.ts::runHandleDelete` so we can cover the toast +
// state-refresh contract for profile mutations without mounting Svelte.

export interface SaveProfileDeps {
  originalPath: string;
  params: UpdateProfileParams;
  updateProfile: (path: string, params: UpdateProfileParams) => Promise<ProfileSummary>;
  listProfiles: () => Promise<ProfileSummary[]>;
  setProfiles: (data: ProfileSummary[]) => void;
  setSelectedPath: (path: string) => void;
  applyDetail: (summary: ProfileSummary) => void;
  toastSuccess: (msg: string) => void;
  toastError: (msg: string) => void;
}

/**
 * Run the Save flow: PUT the params, then best-effort refresh the sidebar list
 * and rebase the right-pane selection on the (possibly renamed) path. Errors
 * from the refresh step are swallowed because the mutation already succeeded
 * and the parent's poll will reconcile; only PUT failures surface as toasts.
 */
export async function runSaveProfile(deps: SaveProfileDeps): Promise<void> {
  try {
    const updated = await deps.updateProfile(deps.originalPath, deps.params);
    deps.applyDetail(updated);
    deps.setSelectedPath(updated.path);
    try {
      const data = await deps.listProfiles();
      deps.setProfiles(data);
    } catch {
      // Mutation already succeeded — silent on purpose; the sidebar will
      // reconcile on the next outer refresh.
    }
    deps.toastSuccess(`Profile "${updated.name}" saved`);
  } catch {
    deps.toastError(`Failed to save "${deps.params.name}"`);
  }
}

export interface DeleteProfileDeps {
  path: string;
  name: string;
  deleteProfile: (path: string) => Promise<void>;
  listProfiles: () => Promise<ProfileSummary[]>;
  setProfiles: (data: ProfileSummary[]) => void;
  clearSelection: () => void;
  toastSuccess: (msg: string) => void;
  toastError: (msg: string) => void;
}

/**
 * Run the Delete flow: DELETE the profile, clear the right-pane selection,
 * best-effort refresh the sidebar list, and toast success/error. Mirrors the
 * `handleDelete` shape from `DetailPanel.svelte`.
 */
export async function runDeleteProfile(deps: DeleteProfileDeps): Promise<void> {
  try {
    await deps.deleteProfile(deps.path);
    deps.clearSelection();
    try {
      const data = await deps.listProfiles();
      deps.setProfiles(data);
    } catch {
      // Mutation already succeeded — silent on purpose.
    }
    deps.toastSuccess(`Profile "${deps.name}" deleted`);
  } catch {
    deps.toastError(`Failed to delete "${deps.name}"`);
  }
}
