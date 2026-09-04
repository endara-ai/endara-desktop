import type { OAuthCatalogEntry } from '$lib/data/oauth-catalog';
import type { CatalogServer } from '$lib/catalog';
import type { AddEndpointParams, EmaAuthConfig } from '$lib/api';

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

/**
 * Splits the values the user entered for a catalog entry's config vars into
 * the `env` and `headers` maps sent to the relay. Vars carrying a `header`
 * target land in `headers` under the header name with `valuePrefix`
 * prepended (e.g. `Authorization: Bearer <pat>`); all others land in `env`
 * under the var name. Values are trimmed and empty ones are skipped.
 */
export function buildCatalogEnvAndHeaders(
  catalog: Pick<CatalogServer, 'envVars'>,
  values: Record<string, string>,
): { env: Record<string, string>; headers: Record<string, string> } {
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  for (const ev of catalog.envVars) {
    const value = (values[ev.name] ?? '').trim();
    if (!value) continue;
    if (ev.header) {
      headers[ev.header.name] = `${ev.header.valuePrefix ?? ''}${value}`;
    } else {
      env[ev.name] = value;
    }
  }
  return { env, headers };
}

/**
 * Applies the user's custom header rows on top of catalog-seeded headers.
 * HTTP header names are case-insensitive, so a custom row replaces any seeded
 * key that matches ignoring case (e.g. `authorization` overrides
 * `Authorization`) instead of adding a second, ambiguous key. Rows with a
 * blank key are skipped.
 */
export function mergeHeaders(
  base: Record<string, string>,
  overrides: { key: string; value: string }[],
): Record<string, string> {
  const merged: Record<string, string> = { ...base };
  for (const row of overrides) {
    const key = row.key.trim();
    if (!key) continue;
    for (const existing of Object.keys(merged)) {
      if (existing !== key && existing.toLowerCase() === key.toLowerCase()) {
        delete merged[existing];
      }
    }
    merged[key] = row.value;
  }
  return merged;
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
 * Resolves the explicit `isolation` value sent when creating an endpoint.
 *
 * Stdio endpoints ALWAYS get an explicit value — `"container"` or `"none"`,
 * never omitted — because the relay treats an absent field as direct spawn
 * and we want new endpoints to containerize by default. Catalog entries
 * flagged `containerizable: false` force `"none"` regardless of the toggle.
 * Non-stdio transports return `undefined` (the field does not apply).
 */
export function resolveIsolation(
  transport: AddEndpointTransport,
  containerizable: boolean,
  isolationEnabled: boolean,
): 'container' | 'none' | undefined {
  if (transport !== 'stdio') return undefined;
  if (!containerizable) return 'none';
  return isolationEnabled ? 'container' : 'none';
}

/**
 * Whether the EMA Organization selector applies to the custom add flow for a
 * given transport. The relay only accepts EMA on `http` or `oauth` transports
 * (`watcher.rs`: "EMA endpoint requires transport http or oauth"), and EMA
 * endpoints are built as `http` by construction
 * (`buildOrgBoundEndpointParams` builds an `http` endpoint whose EMA `resource`
 * is the server URL) — so offering the selector under `oauth` is safe (it just
 * routes the org-bound add through the same EMA `http` path, dropping the
 * per-server OAuth setup). `sse` and `stdio` stay excluded: SSE carries no
 * per-request headers so EMA can't inject the Authorization header, and stdio
 * has no remote auth surface at all. The caller still applies the catalog /
 * OAuth-entry guards.
 */
export function orgBindingApplies(transport: AddEndpointTransport): boolean {
  return transport === 'http' || transport === 'oauth';
}

/**
 * Maps a stored endpoint `isolation` value to the toggle's on/off state.
 *
 * Only an explicit `"container"` means containerized; `"none"`, an empty
 * string, or an absent field all mean direct spawn (the relay's default for
 * an omitted field), so the toggle reads OFF for those.
 */
export function isolationEnabledFromConfig(isolation: string | undefined): boolean {
  return isolation === 'container';
}

/**
 * A single editable volume-mount row in the Add/Config mount editors. Mirrors
 * the env-var `{ key, value }` shape: two separate inputs whose `:`-joined
 * form is the verbatim docker `-v` bind-mount string the relay stores in the
 * stdio config's `mounts` array.
 */
export interface MountRow {
  host: string;
  container: string;
}

/**
 * Seeds the mount editor from a stored `mounts: string[]` array. Each entry is
 * split on its first `:` into host/container halves (trimmed); an entry with
 * no `:` becomes a host-only row so the user can finish it. Absent/empty input
 * yields no rows.
 */
export function parseMountRows(mounts: string[] | undefined): MountRow[] {
  if (!mounts) return [];
  return mounts.map((entry) => {
    const idx = entry.indexOf(':');
    if (idx === -1) return { host: entry.trim(), container: '' };
    return { host: entry.slice(0, idx).trim(), container: entry.slice(idx + 1).trim() };
  });
}

/**
 * Validates a single mount row. Returns an inline error message, or `null`
 * when the row is OK (including a fully-empty row, which is skipped on
 * submit). Enforces a single `:` separator with non-empty host and container
 * parts — since the two halves are separate inputs, a literal `:` in either
 * one would produce a malformed `host:container` string, so it is rejected.
 */
export function mountRowError(row: MountRow): string | null {
  const host = row.host.trim();
  const container = row.container.trim();
  if (!host && !container) return null;
  if (!host) return 'Host path is required';
  if (!container) return 'Container path is required';
  if (host.includes(':') || container.includes(':')) {
    return 'Paths must not contain ":"';
  }
  return null;
}

/** True when any row fails {@link mountRowError}. Blocks submit. */
export function hasMountRowErrors(rows: MountRow[]): boolean {
  return rows.some((row) => mountRowError(row) !== null);
}

/**
 * Serializes mount rows into the relay's `mounts: string[]` form. Trims each
 * half, skips fully-empty rows, and joins the rest as `host:container`.
 * Callers should gate submit on {@link hasMountRowErrors} first; this does no
 * validation of its own.
 */
export function serializeMountRows(rows: MountRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const host = row.host.trim();
    const container = row.container.trim();
    if (!host && !container) continue;
    out.push(`${host}:${container}`);
  }
  return out;
}

/**
 * Host-side fallback for the volume-mount example when the user's home
 * directory can't be resolved (e.g. the Tauri `homeDir()` call fails). Must
 * be an absolute path — docker rejects `~/...` as an invalid local volume
 * name and requires an absolute host path.
 */
export const MOUNT_EXAMPLE_FALLBACK_HOST = '/path/to/example';

/**
 * Builds the `host:container` example string shown under the volume-mount
 * editor. The host side uses the resolved home directory (e.g.
 * `/Users/alex/example`) so it is a valid absolute docker arg; the container
 * side is always the generic `/home/node/example`. When `home` is absent or
 * blank, the host side falls back to {@link MOUNT_EXAMPLE_FALLBACK_HOST}.
 */
export function buildMountExample(home: string | null | undefined): string {
  const trimmed = typeof home === 'string' ? home.trim() : '';
  const host = trimmed ? `${trimmed.replace(/\/+$/, '')}/example` : MOUNT_EXAMPLE_FALLBACK_HOST;
  return `${host}:/home/node/example`;
}

/** Structural equality for mount-row lists, used by the dirty check. */
function sameMountList(a: MountRow[], b: MountRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].host !== b[i].host || a[i].container !== b[i].container) return false;
  }
  return true;
}

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
 * Build the EMA endpoint create-params for the Add Server custom configure step
 * when the user binds the server to an organization. Returns `null` when no org
 * is selected (blank/whitespace), signalling the caller to fall through to the
 * normal per-server add path unchanged.
 *
 * Mirrors the onboarding flow's EMA shape (`onboarding-helpers.ts`
 * `buildEmaEndpointParams`): a plain `http` transport carrying an
 * `auth.type="ema"` block whose `resource` is the server URL the minted access
 * token is scoped to. The URL is required (it becomes the `resource`); the name
 * is still required by the caller's own form validation.
 *
 * Optional `scopes` / `resourceClientId` / `resourceClientSecret` mirror the
 * D2 Config-tab fields and are included on the returned params **only when
 * non-empty after trim**. `scopes` stays on the POST `/endpoints` body (lands
 * in the endpoint's `config.toml` and drives R2's IdP scope on first sign-in);
 * the resource pair is stripped by `addEndpoint()` and POSTed to
 * `/api/endpoints/{name}/credentials` (DCR file, chmod 0600), never in
 * `config.toml`. Blank/whitespace input for any of the three behaves exactly
 * as the no-extras path (field omitted entirely).
 */
export function buildOrgBoundEndpointParams(
  organization: string,
  fields: {
    name: string;
    url: string;
    description?: string;
    scopes?: string;
    resourceClientId?: string;
    resourceClientSecret?: string;
  },
): AddEndpointParams | null {
  const org = organization.trim();
  if (!org) return null;
  const trimmedUrl = fields.url.trim();
  const auth: EmaAuthConfig = {
    type: 'ema',
    organization: org,
    resource: trimmedUrl,
  };
  const params: AddEndpointParams = {
    name: fields.name.trim(),
    transport: 'http',
    url: trimmedUrl,
    auth,
  };
  const description = fields.description?.trim();
  if (description) {
    params.description = description;
  }
  const scopes = fields.scopes?.trim();
  if (scopes) {
    params.scopes = scopes.split(/\s+/).join(' ');
  }
  const resourceClientId = fields.resourceClientId?.trim();
  if (resourceClientId) {
    params.resource_client_id = resourceClientId;
  }
  const resourceClientSecret = fields.resourceClientSecret?.trim();
  if (resourceClientSecret) {
    params.resource_client_secret = resourceClientSecret;
  }
  return params;
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
  /** Org-bound (EMA) endpoint scopes — separate from the OAuth `scopes` field
   *  above since the org-bound advanced block is mutually exclusive with the
   *  per-server OAuth advanced block (`{#if !orgBound}`). */
  orgBoundScopes: string;
  resourceClientId: string;
  resourceClientSecret: string;
  serverTypeOverride: string;
  isolationEnabled: boolean;
  mounts: MountRow[];
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
  if (snapshot.orgBoundScopes !== current.orgBoundScopes) return true;
  if (snapshot.resourceClientId !== current.resourceClientId) return true;
  if (snapshot.resourceClientSecret !== current.resourceClientSecret) return true;
  if (snapshot.serverTypeOverride !== current.serverTypeOverride) return true;
  if (snapshot.isolationEnabled !== current.isolationEnabled) return true;
  if (!sameMountList(snapshot.mounts, current.mounts)) return true;
  if (!sameKvList(snapshot.envVars, current.envVars)) return true;
  if (!sameKvList(snapshot.headerVars, current.headerVars)) return true;
  if (!sameRecord(snapshot.catalogEnvValues, current.catalogEnvValues)) return true;
  if (!sameStringList(snapshot.userArgValues, current.userArgValues)) return true;
  return false;
}
