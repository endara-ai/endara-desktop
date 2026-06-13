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
 * - actual = container → "CONTAINERIZED (runtime)" badge.
 * - configured = container but actual = direct → warning "DIRECT (fallback)"
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
      label: isolation.runtime ? `CONTAINERIZED (${isolation.runtime})` : 'CONTAINERIZED',
      title: 'This server runs inside an isolated container',
    };
  }
  if (isolation.configured === 'container') {
    return {
      kind: 'fallback',
      label: 'DIRECT (fallback)',
      title:
        'Container isolation is configured, but the server fell back to running directly on the host (no usable container runtime)',
    };
  }
  return null;
}

/**
 * Default container image the relay runs stdio servers in. When an endpoint
 * reports this exact image, it is the out-of-the-box default and we don't
 * surface it in the UI — only a user-supplied custom image is worth showing.
 */
export const DEFAULT_CONTAINER_IMAGE = 'ghcr.io/endara-ai/mcp-runner:latest';

/**
 * Custom container image for the detail panel, shown only when the endpoint
 * is actually containerized AND a user-supplied image is in effect (i.e. it
 * differs from {@link DEFAULT_CONTAINER_IMAGE}). Returns `null` when not
 * containerized, when no image is reported, or when the image is the default.
 * The internal `container_name` (e.g. `endara-mcp-<endpoint>`) is deliberately
 * ignored — it is plumbing and never surfaced in the normal UI.
 */
export function getCustomImage(
  isolation: IsolationState | null | undefined,
): string | null {
  if (!isolation || isolation.actual !== 'container') return null;
  const image = isolation.image?.trim();
  if (!image || image === DEFAULT_CONTAINER_IMAGE) return null;
  return image;
}
