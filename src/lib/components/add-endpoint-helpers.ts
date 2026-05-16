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

/** Total wall-clock budget for OAuth setup polling, in milliseconds. */
export const OAUTH_SETUP_POLL_BUDGET_MS = 120_000;

/**
 * Schedule for `pollForSetupAuth` in `AddEndpointModal`. Returns the delay
 * (in ms) to wait before the next status check given the zero-based attempt
 * index. Sequence: 1s, 2s, 4s, 5s, 5s, … (capped at 5s). Keeps the modal
 * responsive early on (when the user is most likely to have just clicked
 * "Authorize") without hammering the relay for the rest of the 120s window.
 */
export function nextPollDelayMs(attempt: number): number {
  if (attempt < 0) return 1000;
  return Math.min(1000 * 2 ** attempt, 5000);
}

/**
 * Decides whether the next poll fits inside `budgetMs`. Returns the delay to
 * wait, or `null` when the cumulative time would exceed the budget and the
 * caller should surface a timeout instead.
 */
export function nextPollOrTimeout(
  attempt: number,
  elapsedMs: number,
  budgetMs: number = OAUTH_SETUP_POLL_BUDGET_MS,
): number | null {
  const delay = nextPollDelayMs(attempt);
  if (elapsedMs + delay > budgetMs) return null;
  return delay;
}

/** Transports supported by the Add Server modal. Mirrors the inline literal in `AddEndpointModal.svelte`. */
export type AddEndpointTransport = 'stdio' | 'sse' | 'http' | 'oauth';

/**
 * Per-field error map for inputs that surface `aria-invalid` in the Add
 * Server modal. Presence of a key means that field failed validation; the
 * value is the human-readable message reused for both the inline state and
 * the bottom-of-form summary (see `firstAddEndpointFieldError`).
 *
 * Only required fields shared by all transports live here — advanced or
 * optional checks (server type override sanitization, DCR client-id
 * fallback, etc.) stay inline in the component since they have their own
 * UI affordances.
 */
export type AddEndpointFieldErrors = {
  name?: string;
  command?: string;
  url?: string;
};

export interface AddEndpointFormInput {
  transport: AddEndpointTransport;
  name: string;
  command: string;
  url: string;
}

/**
 * Validates the required-field inputs of the Add Server modal and returns a
 * per-field error map. An empty object means everything checked here is OK.
 *
 * No new rules are introduced: this surfaces the same conditions the
 * inline `handleSubmit`/`handleOAuthSubmit` checks used to bail out on,
 * just collected up front so the modal can flag every offending input at
 * once instead of stopping at the first.
 */
export function validateAddEndpointForm(input: AddEndpointFormInput): AddEndpointFieldErrors {
  const errors: AddEndpointFieldErrors = {};
  if (!input.name.trim()) errors.name = 'Name is required';
  if (input.transport === 'stdio') {
    if (!input.command.trim()) errors.command = 'Command is required for stdio';
  } else {
    if (!input.url.trim()) {
      errors.url = input.transport === 'oauth' ? 'Server URL is required' : 'URL is required';
    }
  }
  return errors;
}

/**
 * Returns the first error message in field-declaration order
 * (`name` → `command` → `url`), or an empty string when the map is empty.
 * Used to keep the bottom-of-form summary text matching the priority of
 * the previous early-return validation flow.
 */
export function firstAddEndpointFieldError(errors: AddEndpointFieldErrors): string {
  return errors.name ?? errors.command ?? errors.url ?? '';
}

/**
 * Snapshot of the user-editable fields in the Add Server modal's configure
 * step. Captured when `step` transitions to `'configure'` (in
 * `selectCatalog` / `selectOAuthService` / `selectCustom`) so the entry's
 * own pre-fills become the dirty-check baseline rather than empty strings.
 */
export interface AddEndpointFormSnapshot {
  name: string;
  command: string;
  args: string;
  url: string;
  prefixCustom: boolean;
  description: string;
  envVars: { key: string; value: string }[];
  headerVars: { key: string; value: string }[];
  catalogEnvValues: Record<string, string>;
  userArgValues: string[];
  oauthServerUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  serverTypeOverride: string;
}

function sameKvList(
  a: { key: string; value: string }[],
  b: { key: string; value: string }[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].key !== b[i].key || a[i].value !== b[i].value) return false;
  }
  return true;
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function sameStringList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Returns true when `current` differs from `snapshot` on any user-editable
 * field. Drives the "Discard changes?" confirmation in `AddEndpointModal`:
 * Esc / backdrop click / Cancel routes through this so the user is only
 * prompted when there's something to lose. The snapshot must already
 * include any catalog pre-fills — see `AddEndpointFormSnapshot`.
 */
export function computeAddEndpointIsDirty(
  snapshot: AddEndpointFormSnapshot,
  current: AddEndpointFormSnapshot,
): boolean {
  if (snapshot.name !== current.name) return true;
  if (snapshot.command !== current.command) return true;
  if (snapshot.args !== current.args) return true;
  if (snapshot.url !== current.url) return true;
  if (snapshot.prefixCustom !== current.prefixCustom) return true;
  if (snapshot.description !== current.description) return true;
  if (snapshot.oauthServerUrl !== current.oauthServerUrl) return true;
  if (snapshot.clientId !== current.clientId) return true;
  if (snapshot.clientSecret !== current.clientSecret) return true;
  if (snapshot.scopes !== current.scopes) return true;
  if (snapshot.serverTypeOverride !== current.serverTypeOverride) return true;
  if (!sameKvList(snapshot.envVars, current.envVars)) return true;
  if (!sameKvList(snapshot.headerVars, current.headerVars)) return true;
  if (!sameRecord(snapshot.catalogEnvValues, current.catalogEnvValues)) return true;
  if (!sameStringList(snapshot.userArgValues, current.userArgValues)) return true;
  return false;
}
