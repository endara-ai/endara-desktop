import type { OAuthCatalogEntry } from '$lib/data/oauth-catalog';

export type ScopeMode = 'free' | 'checkbox';

export interface ScopesPayload {
  /** Space-separated form, used by `testConnection` / `AddEndpointParams.scopes`. */
  string: string | undefined;
  /** Array form, used by `oauthSetup` / `OAuthSetupParams.scopes`. */
  array: string[] | undefined;
}

/**
 * Serialize the user-edited scopes into the two shapes the rest of the modal
 * needs.
 *
 * Free-text mode (no `availableScopes` on the catalog entry):
 *   - whitespace-collapsed and trimmed for the string form
 *   - `split(/\s+/)` for the array form
 *   - empty/whitespace-only input → `undefined` for both (omit from payload)
 *
 * Checkbox mode (catalog entry exposes `availableScopes`):
 *   - the array form is built directly from the Set; iteration order
 *     is the Set's insertion order, which the modal seeds from
 *     `defaultScopes` so the on-the-wire order matches the catalog
 *   - the string form joins that array with single spaces
 *   - empty Set → `undefined` for both (treated like blank scopes)
 */
export function buildScopesPayload(
  mode: ScopeMode,
  value: string | Set<string>,
): ScopesPayload {
  if (mode === 'free') {
    const raw = typeof value === 'string' ? value : '';
    const trimmed = raw.trim();
    if (!trimmed) return { string: undefined, array: undefined };
    const arr = trimmed.split(/\s+/);
    return { string: arr.join(' '), array: arr };
  }

  const set = value instanceof Set ? value : new Set<string>();
  if (set.size === 0) return { string: undefined, array: undefined };
  const arr = Array.from(set);
  return { string: arr.join(' '), array: arr };
}

/**
 * Returns true when an OAuth catalog entry should display the red star
 * indicator in the Add Server modal browse list — i.e. the provider does
 * not support Dynamic Client Registration and the user has to bring their
 * own Client ID/Secret.
 */
export function shouldShowManualOAuthStar(entry: OAuthCatalogEntry): boolean {
  return entry.supportsDcr === false;
}

