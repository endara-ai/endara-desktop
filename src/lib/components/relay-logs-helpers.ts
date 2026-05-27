import { activeTopLevelTab, selectedEndpoint } from '$lib/stores';

/**
 * Helpers for the relay log view endpoint affordances (Slice B,
 * engineering spec §2.4). Extracted as pure functions so they can be unit
 * tested in the Node test env without spinning up a Svelte runtime.
 */

/**
 * Click-to-filter toggle for the endpoint column.
 *
 * Behaviour (spec §2.4):
 *  - If the filter is already exactly `{name}` → clear back to "All" (empty).
 *  - Otherwise → replace whatever's selected with just `{name}`.
 *
 * Always returns a fresh Set so reactive consumers see a new reference.
 */
export function toggleEndpointFilter(
  current: ReadonlySet<string>,
  name: string,
): Set<string> {
  if (current.size === 1 && current.has(name)) return new Set();
  return new Set([name]);
}

/**
 * Cross-link side effect for the right-click "Go to endpoint" menu item.
 *
 * Sets the global stores so the Servers tab opens with that endpoint
 * selected. The `+page.svelte` handler wraps this in `requestNavigation`
 * so the shared unsaved-changes guard runs first.
 */
export function applyGoToEndpoint(name: string): void {
  selectedEndpoint.set(name);
  activeTopLevelTab.set('servers');
}

/**
 * Find the index of the latest log row whose `request{id="..."}` span
 * matches `jsonrpcId`. Used by the RelayLogs view to scroll to and
 * highlight the row that the overlay card click selected.
 *
 * Scans newest-first so a JSON-RPC id reused across reconnections (the
 * relay numbers from 0 on each fresh MCP session) resolves to the most
 * recent occurrence rather than an earlier one that has scrolled off
 * the user's attention.
 *
 * Returns `-1` when no row matches.
 */
export function findRequestRowIndex<T extends { requestId?: string }>(
  lines: readonly T[],
  jsonrpcId: string,
): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].requestId === jsonrpcId) return i;
  }
  return -1;
}
