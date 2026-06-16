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

/**
 * Resolve an overlay highlight target that may not be rendered yet.
 *
 * When the main window is brought back from a hidden/closed state, the
 * relay-log rows can take a moment to mount/populate, so the row for
 * `jsonrpcId` is not in `getLines()` on the first synchronous pass. Rather
 * than warn-and-give-up, this polls `getLines()` until a matching row appears
 * (firing `onFound` with its index) or the `budgetMs` budget elapses (firing
 * `onTimeout`). If a matching row is already present it resolves synchronously.
 *
 * Returns a cancel function — call it to abort an in-flight poll (e.g. when a
 * newer overlay click supersedes this one, or on component destroy). The cancel
 * is idempotent.
 */
export function resolvePendingHighlight<T extends { requestId?: string }>(opts: {
  jsonrpcId: string;
  getLines: () => readonly T[];
  onFound: (idx: number) => void;
  onTimeout: () => void;
  budgetMs?: number;
  intervalMs?: number;
}): () => void {
  const { jsonrpcId, getLines, onFound, onTimeout, budgetMs = 2000, intervalMs = 100 } = opts;

  const immediate = findRequestRowIndex(getLines(), jsonrpcId);
  if (immediate !== -1) {
    onFound(immediate);
    return () => {};
  }

  const deadline = Date.now() + budgetMs;
  let interval: ReturnType<typeof setInterval> | null = null;
  const cancel = () => {
    if (interval !== null) {
      clearInterval(interval);
      interval = null;
    }
  };
  interval = setInterval(() => {
    const idx = findRequestRowIndex(getLines(), jsonrpcId);
    if (idx !== -1) {
      cancel();
      onFound(idx);
      return;
    }
    if (Date.now() >= deadline) {
      cancel();
      onTimeout();
    }
  }, intervalMs);
  return cancel;
}

/**
 * Wait until the scroll container reports real layout (a non-zero
 * `getBoundingClientRect()`), i.e. the relay-logs tab has actually been
 * painted after its `style:display:none` → `block` toggle.
 *
 * The overlay:focus-log handler switches tabs and then runs `scrollIntoView`
 * plus the `highlight-row-fade` CSS animation. Because that animation uses
 * `forwards`, if it starts while the tab is still hidden it finishes at the
 * transparent end state and the user never sees the pulse. Gating the
 * highlight on real container dimensions guarantees the animation starts on a
 * visible row.
 *
 * Resolves `true` as soon as the element has non-zero dimensions (immediately
 * when already visible, so the working same-tab case adds no delay), or
 * `false` once `deadlineMs` elapses without the tab becoming visible (e.g. the
 * user navigated away again before resolution).
 */
export async function waitForVisibleContainer(
  getEl: () => { getBoundingClientRect: () => { width: number; height: number } } | null | undefined,
  deadlineMs = 2000,
  intervalMs = 16,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const el = getEl();
    if (el) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
