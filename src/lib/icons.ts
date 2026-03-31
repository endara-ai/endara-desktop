import { CATALOG_SERVERS } from '$lib/catalog';
import type { Endpoint } from '$lib/types';

export type IconResult =
  | { type: 'svg'; svg: string }
  | { type: 'favicon'; url: string };

/** Terminal/command-line icon for stdio endpoints */
export const STDIO_ICON = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="16" height="14" rx="2"/><path d="M5.5 7.5l3 2.5-3 2.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.5 13h4" stroke-linecap="round"/></svg>`;

/** Globe/network icon for sse/http endpoints */
export const NETWORK_ICON = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="7.5"/><ellipse cx="10" cy="10" rx="3" ry="7.5"/><path d="M3 10h14"/><path d="M3.5 6h13M3.5 14h13"/></svg>`;

/**
 * Resolve the icon for an endpoint using the priority chain:
 * 1. Catalog match by name
 * 2. Favicon fallback for SSE/HTTP endpoints with a URL
 * 3. Transport-based fallback icon
 */
export function endpointIcon(endpoint: Endpoint, url?: string): IconResult {
  // 1. Catalog match
  const catalogMatch = CATALOG_SERVERS.find(
    (s) => s.name.toLowerCase() === endpoint.name.toLowerCase(),
  );
  if (catalogMatch) {
    return { type: 'svg', svg: catalogMatch.icon };
  }

  // 2. Favicon fallback for SSE/HTTP with a URL
  if ((endpoint.transport === 'sse' || endpoint.transport === 'http') && url) {
    try {
      const origin = new URL(url).origin;
      return { type: 'favicon', url: `${origin}/favicon.ico` };
    } catch {
      // Invalid URL, fall through to transport fallback
    }
  }

  // 3. Transport fallback
  if (endpoint.transport === 'stdio') {
    return { type: 'svg', svg: STDIO_ICON };
  }
  return { type: 'svg', svg: NETWORK_ICON };
}

