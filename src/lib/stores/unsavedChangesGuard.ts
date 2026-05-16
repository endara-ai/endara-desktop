import { writable, get } from 'svelte/store';

type DirtyChecker = () => boolean;

const dirtyCheckers = new Set<DirtyChecker>();

// Writable holding the pending navigation action when a confirm prompt is in
// flight. Components render a ConfirmModal driven off this store.
export const pendingNavigationAction = writable<null | (() => void)>(null);

export function registerDirtyChecker(check: DirtyChecker): () => void {
  dirtyCheckers.add(check);
  return () => {
    dirtyCheckers.delete(check);
  };
}

export function isAnyDirty(): boolean {
  for (const c of dirtyCheckers) {
    if (c()) return true;
  }
  return false;
}

export function requestNavigation(action: () => void): void {
  if (isAnyDirty()) {
    pendingNavigationAction.set(action);
  } else {
    action();
  }
}

export function confirmPendingNavigation(): void {
  const action = get(pendingNavigationAction);
  pendingNavigationAction.set(null);
  if (action) action();
}

export function cancelPendingNavigation(): void {
  pendingNavigationAction.set(null);
}

