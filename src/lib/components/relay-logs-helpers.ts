import { activeTopLevelTab, selectedEndpoint } from '$lib/stores';
import type { ParsedLogLine } from '$lib/logParser';

/**
 * Helpers for the relay log view endpoint affordances (Slice B,
 * engineering spec §2.4). Extracted as pure functions so they can be unit
 * tested in the Node test env without spinning up a Svelte runtime.
 */

let nextLineId = 0;
const lineIds = new WeakMap<ParsedLogLine, string>();

/**
 * Stable string key for a log line, for `VirtualLogList`'s `getKey`.
 *
 * Keyed by object identity via a lazily-assigned monotonic id — the string
 * equivalent of the old `{#each filteredLines as line (line)}` object key.
 * `raw` alone is not usable: the relay-logs buffer is not deduped, so two
 * identical lines would collide. The WeakMap keeps trimmed/cleared lines
 * collectable.
 */
export function lineKey(line: ParsedLogLine): string {
  let key = lineIds.get(line);
  if (key === undefined) {
    key = `rl-${nextLineId++}`;
    lineIds.set(line, key);
  }
  return key;
}

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
