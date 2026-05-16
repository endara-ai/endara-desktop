import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

import {
  cancelPendingNavigation,
  confirmPendingNavigation,
  isAnyDirty,
  pendingNavigationAction,
  registerDirtyChecker,
  requestNavigation,
} from './unsavedChangesGuard';

// Reset the module-level checker set + pending store between cases by
// unregistering everything via the unregister handles returned from register.
// Tracked locally per test.

describe('unsavedChangesGuard store', () => {
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

  it('isAnyDirty returns false with no checkers', () => {
    expect(isAnyDirty()).toBe(false);
  });

  it('registerDirtyChecker returns an unregister function that removes the checker', () => {
    const unreg = register(() => true);
    expect(isAnyDirty()).toBe(true);
    unreg();
    expect(isAnyDirty()).toBe(false);
  });

  it('isAnyDirty is true when any checker returns true', () => {
    register(() => false);
    register(() => true);
    register(() => false);
    expect(isAnyDirty()).toBe(true);
  });

  it('requestNavigation runs the action immediately when nothing is dirty', () => {
    const action = vi.fn();
    requestNavigation(action);
    expect(action).toHaveBeenCalledTimes(1);
    expect(get(pendingNavigationAction)).toBeNull();
  });

  it('requestNavigation queues the action when any checker is dirty', () => {
    register(() => true);
    const action = vi.fn();
    requestNavigation(action);
    expect(action).not.toHaveBeenCalled();
    expect(get(pendingNavigationAction)).toBe(action);
  });

  it('confirmPendingNavigation runs the queued action and clears the store', () => {
    register(() => true);
    const action = vi.fn();
    requestNavigation(action);
    confirmPendingNavigation();
    expect(action).toHaveBeenCalledTimes(1);
    expect(get(pendingNavigationAction)).toBeNull();
  });

  it('confirmPendingNavigation is a no-op when nothing is queued', () => {
    expect(() => confirmPendingNavigation()).not.toThrow();
    expect(get(pendingNavigationAction)).toBeNull();
  });

  it('cancelPendingNavigation clears the queued action without running it', () => {
    register(() => true);
    const action = vi.fn();
    requestNavigation(action);
    cancelPendingNavigation();
    expect(action).not.toHaveBeenCalled();
    expect(get(pendingNavigationAction)).toBeNull();
  });
});

