import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

import profileDetailSource from './ProfileDetail.svelte?raw';
import profileSidebarRowSource from './ProfileSidebarRow.svelte?raw';
import profilesSource from './Profiles.svelte?raw';
import {
  cancelPendingNavigation,
  confirmPendingNavigation,
  isAnyDirty,
  pendingNavigationAction,
  registerDirtyChecker,
  requestNavigation,
} from '$lib/stores/unsavedChangesGuard';

// Matrix-row coverage for D3.A — "unsaved-changes guard on profile detail".
//
// The guard is composed of three independent pieces that all have to be wired
// for the flow to work end-to-end:
//   1. ProfileDetail registers a dirty-checker so `isAnyDirty()` reflects its
//      `isDirty` derived value (mirrors ConfigTab.svelte:134–136).
//   2. ProfileSidebarRow wraps the row click with `requestNavigation` so a
//      sibling profile switch is gated by the guard (mirrors
//      EndpointRow.svelte:27).
//   3. Profiles.svelte wraps the post-create selection with `requestNavigation`
//      so creating a new profile while another is dirty also gates.
//
// The Svelte components themselves can't be mounted in the JSDOM environment
// without significant scaffolding, so we assert the wiring at the source
// level (matching the existing convention in profile-detail-helpers.test.ts
// and detail-panel-helpers.test.ts) and exercise the guard store itself with
// a representative dirty-state simulation.

describe('Profiles unsaved-changes guard (D3.A — matrix row)', () => {
  let unregistrators: Array<() => void> = [];

  function register(check: () => boolean) {
    const unreg = registerDirtyChecker(check);
    unregistrators.push(unreg);
    return unreg;
  }

  beforeEach(() => {
    for (const u of unregistrators) u();
    unregistrators = [];
    pendingNavigationAction.set(null);
  });

  // ── 1. ProfileDetail registers a checker tied to its `isDirty` value ──
  it('ProfileDetail imports registerDirtyChecker from the shared guard store', () => {
    expect(profileDetailSource).toMatch(
      /import\s*\{\s*registerDirtyChecker\s*\}\s*from\s*['"]\$lib\/stores\/unsavedChangesGuard['"]/,
    );
  });

  it('ProfileDetail registers a dirty-checker that returns `isDirty`', () => {
    // $effect block returning the unregister handle, mirroring ConfigTab.
    expect(profileDetailSource).toMatch(
      /\$effect\(\s*\(\)\s*=>\s*\{[\s\S]*?return\s+registerDirtyChecker\(\s*\(\)\s*=>\s*isDirty\s*\)[\s\S]*?\}\s*\)/,
    );
  });

  // ── 2. Left-rail row clicks gate navigation via requestNavigation ────
  it('ProfileSidebarRow wraps the row click with requestNavigation', () => {
    expect(profileSidebarRowSource).toMatch(
      /import\s*\{\s*requestNavigation\s*\}\s*from\s*['"]\$lib\/stores\/unsavedChangesGuard['"]/,
    );
    expect(profileSidebarRowSource).toMatch(
      /requestNavigation\(\s*\(\)\s*=>\s*onselect\(profile\.path\)\s*\)/,
    );
  });

  it('ProfileSidebarRow short-circuits when clicking the already-selected row', () => {
    // Mirrors EndpointRow.svelte:27 — prevents an unnecessary discard prompt
    // when the user clicks the row that is already active.
    expect(profileSidebarRowSource).toMatch(/if\s*\(\s*selected\s*\)\s*return/);
  });

  // ── 3. Post-create selection is also gated ────────────────────────────
  it('Profiles.svelte gates the post-create selection with requestNavigation', () => {
    expect(profilesSource).toMatch(
      /import\s*\{\s*requestNavigation\s*\}\s*from\s*['"]\$lib\/stores\/unsavedChangesGuard['"]/,
    );
    expect(profilesSource).toMatch(
      /requestNavigation\(\s*\(\)\s*=>\s*\{[\s\S]*?selectedPath\s*=\s*profile\.path[\s\S]*?\}\s*\)/,
    );
  });

  // ── 4. Behavioural simulation of the registered checker ──────────────
  it('switching profiles with dirty state queues the action (clean state runs immediately)', () => {
    let dirty = false;
    register(() => dirty);

    const switchToOther = vi.fn();
    requestNavigation(switchToOther);
    // Clean state — switch happens immediately, nothing queued.
    expect(switchToOther).toHaveBeenCalledTimes(1);
    expect(get(pendingNavigationAction)).toBeNull();

    // Now simulate a dirty form (e.g. the user toggled an endpoint).
    dirty = true;
    expect(isAnyDirty()).toBe(true);

    const switchAgain = vi.fn();
    requestNavigation(switchAgain);
    expect(switchAgain).not.toHaveBeenCalled();
    expect(get(pendingNavigationAction)).toBe(switchAgain);
  });

  it('confirmPendingNavigation discards changes and runs the queued switch', () => {
    register(() => true);
    const switchToOther = vi.fn();
    requestNavigation(switchToOther);
    expect(switchToOther).not.toHaveBeenCalled();

    confirmPendingNavigation();
    expect(switchToOther).toHaveBeenCalledTimes(1);
    expect(get(pendingNavigationAction)).toBeNull();
  });

  it('cancelPendingNavigation keeps the dirty state and drops the queued switch', () => {
    register(() => true);
    const switchToOther = vi.fn();
    requestNavigation(switchToOther);

    cancelPendingNavigation();
    expect(switchToOther).not.toHaveBeenCalled();
    expect(get(pendingNavigationAction)).toBeNull();
    // The dirty state itself is unchanged — the profile stays editable.
    expect(isAnyDirty()).toBe(true);
  });
});
