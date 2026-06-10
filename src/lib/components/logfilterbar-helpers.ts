// Pure open/close transitions for the LogFilterBar dropdowns. Kept as a
// standalone helper (mirroring sidebar-helpers.ts) so the mutual-exclusion +
// close-all logic can be unit-tested without a Svelte runtime.

export type LogMenu = 'endpoint' | 'profile';

export interface MenuState {
  endpoint: boolean;
  profile: boolean;
}

export function closeAllMenus(): MenuState {
  return { endpoint: false, profile: false };
}

// Toggle one menu's open state. Opening a menu always closes the other
// (mutual exclusion) so at most one dropdown is open at a time.
export function nextMenuState(current: MenuState, menu: LogMenu): MenuState {
  const willOpen = !current[menu];
  return {
    endpoint: menu === 'endpoint' ? willOpen : false,
    profile: menu === 'profile' ? willOpen : false,
  };
}
