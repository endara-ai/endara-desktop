import type { Endpoint, IsolationState } from '$lib/types';

/**
 * Compact secondary label rendered next to the transport badge in
 * `EndpointRow.svelte` for non-failed / non-disabled endpoints. Endpoints in
 * the `Initializing` lifecycle state still report `tool_count: 0` over the
 * management API, so a naïve "0 tools" would look like an empty server.
 * Show "Initializing…" instead while we're waiting for the upstream session
 * to come up; once the relay flips the lifecycle to `Ready`, the tool count
 * renders normally.
 */
export function getEndpointStatusLabel(
  endpoint: Pick<Endpoint, 'lifecycle' | 'health' | 'tool_count'>,
): string {
  if (endpoint.lifecycle?.state === 'Initializing' || endpoint.health === 'starting') {
    return 'Initializing…';
  }
  return `${endpoint.tool_count} tools`;
}

/**
 * Badge descriptor for the relay's `isolation_state` field, shared by
 * `EndpointRow.svelte` and `DetailPanel.svelte` (rendered via
 * `IsolationBadge.svelte`).
 */
export interface IsolationBadgeInfo {
  kind: 'container' | 'fallback';
  label: string;
  title: string;
}

/**
 * Compute the isolation badge for an endpoint, or `null` when no badge
 * should render:
 * - actual = container → "Containerized (runtime)" badge.
 * - configured = container but actual = direct → warning "Direct (fallback)"
 *   badge so silent fallbacks are visible.
 * - absent (non-stdio / older relay) or a normal direct spawn
 *   (configured = none, actual = direct) → no badge.
 */
export function getIsolationBadge(
  isolation: IsolationState | null | undefined,
): IsolationBadgeInfo | null {
  if (!isolation) return null;
  if (isolation.actual === 'container') {
    return {
      kind: 'container',
      label: isolation.runtime ? `Containerized (${isolation.runtime})` : 'Containerized',
      title: 'This server runs inside an isolated container',
    };
  }
  if (isolation.configured === 'container') {
    return {
      kind: 'fallback',
      label: 'Direct (fallback)',
      title:
        'Container isolation is configured, but the server fell back to running directly on the host (no usable container runtime)',
    };
  }
  return null;
}

/**
 * Secondary detail line for the detail panel: container image and name for
 * an endpoint that is actually containerized (e.g. `node:20-alpine ·
 * endara-mcp-github`). `null` when not containerized or when neither field
 * is reported.
 */
export function getIsolationDetail(
  isolation: IsolationState | null | undefined,
): string | null {
  if (!isolation || isolation.actual !== 'container') return null;
  const parts = [isolation.image, isolation.container_name].filter(
    (p): p is string => !!p,
  );
  return parts.length > 0 ? parts.join(' · ') : null;
}
