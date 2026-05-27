// Inline SVG path/group fragments for server-type icons used by overlay cards.
// Mirrors the prototype's `ICONS` table from
// `~/Downloads/desktop-visual-indicator-for-mcp-activity/project/toast-feed.jsx`
// (lines 97–104). The fragment is rendered inside a 20×20 viewBox <svg> in
// the card component; the lookup is case-insensitive and falls back to a
// generic plug icon when the server type doesn't match.

export type ServerIconKey =
  | 'github'
  | 'slack'
  | 'filesystem'
  | 'postgres'
  | 'search'
  | 'sentry'
  | 'generic';

const ICON_FRAGMENTS: Record<ServerIconKey, string> = {
  github:
    '<path d="M10 1.5a8.5 8.5 0 0 0-2.69 16.56c.43.08.58-.18.58-.4v-1.54c-2.37.52-2.87-1.01-2.87-1.01-.39-.99-.95-1.25-.95-1.25-.78-.53.06-.52.06-.52.86.06 1.31.88 1.31.88.76 1.3 2 .93 2.49.71.08-.55.3-.93.54-1.14-1.89-.21-3.88-.94-3.88-4.2 0-.93.33-1.69.88-2.28-.09-.22-.38-1.08.08-2.25 0 0 .72-.23 2.35.87a8.18 8.18 0 0 1 4.28 0c1.63-1.1 2.35-.87 2.35-.87.46 1.17.17 2.03.08 2.25.55.59.88 1.35.88 2.28 0 3.27-1.99 3.99-3.89 4.2.31.26.58.78.58 1.58v2.34c0 .22.15.49.58.4A8.5 8.5 0 0 0 10 1.5Z" fill="currentColor" />',
  slack:
    '<path d="M7.5 2a1.5 1.5 0 1 0 0 3H9V3.5A1.5 1.5 0 0 0 7.5 2ZM4 7.5A1.5 1.5 0 0 0 2 7.5 1.5 1.5 0 0 0 3.5 9H5V7.5ZM12.5 5a1.5 1.5 0 1 0 0-3A1.5 1.5 0 0 0 11 3.5V5h1.5ZM16 7.5A1.5 1.5 0 0 1 18 7.5 1.5 1.5 0 0 1 16.5 9H15V7.5ZM12.5 18a1.5 1.5 0 1 0 0-3H11v1.5a1.5 1.5 0 0 0 1.5 1.5ZM16 12.5a1.5 1.5 0 0 1 0 3h-1.5V14h1.5ZM7.5 15a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 1.5-1.5V15H7.5ZM4 12.5a1.5 1.5 0 0 0-2 0A1.5 1.5 0 0 0 3.5 14H5v-1.5Z" fill="currentColor" />',
  filesystem:
    '<path d="M3 4.5C3 3.67 3.67 3 4.5 3h4.59a1.5 1.5 0 0 1 1.06.44l1.41 1.41a1.5 1.5 0 0 0 1.06.44H15.5c.83 0 1.5.67 1.5 1.5V15.5c0 .83-.67 1.5-1.5 1.5h-11A1.5 1.5 0 0 1 3 15.5V4.5Z" fill="none" stroke="currentColor" stroke-width="1.5" />',
  postgres:
    '<g fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="10" cy="5" rx="6" ry="2.5" /><path d="M4 5v10c0 1.38 2.69 2.5 6 2.5s6-1.12 6-2.5V5" /><path d="M4 10c0 1.38 2.69 2.5 6 2.5s6-1.12 6-2.5" /></g>',
  search:
    '<g fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="9" cy="9" r="5.5" /><path stroke-linecap="round" d="M13 13l4 4" /></g>',
  sentry:
    '<g fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 2l7 12H3L10 2Z" /><path d="M10 7v4" /><circle cx="10" cy="13" r=".5" fill="currentColor" stroke="none" /></g>',
  generic:
    '<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M7 3v3M13 3v3M5 6h10v3a5 5 0 0 1-10 0V6Z" /><path d="M10 14v3" /></g>',
};

const ALIASES: Record<string, ServerIconKey> = {
  github: 'github',
  slack: 'slack',
  filesystem: 'filesystem',
  files: 'filesystem',
  fs: 'filesystem',
  postgres: 'postgres',
  postgresql: 'postgres',
  pg: 'postgres',
  search: 'search',
  brave: 'search',
  'brave search': 'search',
  websearch: 'search',
  sentry: 'sentry',
};

/**
 * Resolve a server-type string (case-insensitive, trimmed) to an icon key.
 * Unknown types fall back to `generic` so the card always renders an icon.
 */
export function serverIconKeyFor(serverType: string | null | undefined): ServerIconKey {
  if (!serverType) return 'generic';
  const key = serverType.trim().toLowerCase();
  return ALIASES[key] ?? 'generic';
}

/** Inline SVG fragment for the given key. Always non-empty. */
export function serverIconFragment(key: ServerIconKey): string {
  return ICON_FRAGMENTS[key];
}

/** Convenience: resolve and return SVG fragment directly. */
export function serverIconFor(serverType: string | null | undefined): string {
  return serverIconFragment(serverIconKeyFor(serverType));
}
