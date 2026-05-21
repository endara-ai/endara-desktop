import type { Endpoint } from '$lib/types';

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
