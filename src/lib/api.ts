import { invoke } from '@tauri-apps/api/core';
import type { RelayStatus, Endpoint, Tool, EndpointLogs, CatalogEntry, OAuthStatus, OAuthStartResult, OAuthSetupResponse, OAuthSetupStatusResponse, CallsResponse, CallDetail, AggregatesResponse, ObservabilityConfig, OAuthProbeResult, IdpProvider, Organization, OrganizationSsoResponse, OrgProbeResponse } from './types';

const MAX_RETRIES = 2;
const RETRY_DELAY = 1000;

interface ApiResponse {
  status: number;
  body: string;
}

/**
 * Proxy an HTTP request to the relay's management API via the Tauri backend.
 * The relay listens on a per-user Unix-domain socket / Windows named pipe; the
 * WebView cannot dial those directly, so every `/api/*` call is forwarded
 * through `mgmt_api_request`.
 */
async function mgmtRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse> {
  return await invoke<ApiResponse>('mgmt_api_request', {
    method,
    path: `/api${path}`,
    body: body === undefined ? null : body,
  });
}

async function fetchJson<T>(path: string, options?: { method?: string; body?: unknown }): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await mgmtRequest(options?.method ?? 'GET', path, options?.body);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${res.status}: ${res.body}`);
      }
      return (res.body ? JSON.parse(res.body) : null) as T;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY));
      }
    }
  }
  throw lastError;
}

export async function getStatus(): Promise<RelayStatus> {
  return fetchJson<RelayStatus>('/status');
}

export async function getEndpoints(): Promise<Endpoint[]> {
  const data = await fetchJson<Endpoint[]>('/endpoints');
  for (const ep of data) {
    if (ep.lifecycle?.state === 'Failed') {
      ep.health = 'error';
      ep.error = ep.lifecycle.error.detail;
    }
  }
  return data;
}

export async function getCatalog(): Promise<CatalogEntry[]> {
  return fetchJson<CatalogEntry[]>('/catalog');
}

export async function getEndpointTools(name: string): Promise<Tool[]> {
  return fetchJson<Tool[]>(`/endpoints/${encodeURIComponent(name)}/tools`);
}

export async function restartEndpoint(name: string): Promise<void> {
  await fetchJson(`/endpoints/${encodeURIComponent(name)}/restart`, { method: 'POST' });
}

export async function refreshEndpoint(name: string): Promise<void> {
  await fetchJson(`/endpoints/${encodeURIComponent(name)}/refresh`, { method: 'POST' });
}

export async function getEndpointLogs(name: string): Promise<EndpointLogs> {
  return fetchJson<EndpointLogs>(`/endpoints/${encodeURIComponent(name)}/logs`);
}

export async function getConfig(): Promise<Record<string, unknown>> {
  return fetchJson<Record<string, unknown>>('/config');
}

export async function reloadConfig(): Promise<void> {
  await fetchJson('/config/reload', { method: 'POST' });
}

export interface TestConnectionParams {
  transport: 'stdio' | 'sse' | 'http' | 'oauth';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface TestConnectionResult {
  success: boolean;
  tool_count?: number;
  tools?: string[];
  error?: string;
}

export async function testConnection(params: TestConnectionParams): Promise<TestConnectionResult> {
  const res = await mgmtRequest('POST', '/test-connection', params);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status}: ${res.body}`);
  }
  return JSON.parse(res.body) as TestConnectionResult;
}

/**
 * Enterprise-Managed Authorization (EMA) auth block, sent inside
 * `AddEndpointParams.auth` to create an org-bound endpoint. Mirrors the relay's
 * `[endpoints.auth]` (`type = "ema"`) config: `organization` names the
 * `[[organizations]]` entry whose shared ID token the endpoint reuses, and
 * `resource` is the upstream MCP server URL the minted access token is scoped
 * to. Used by the onboarding flow's review-&-select step.
 */
export interface EmaAuthConfig {
  type: 'ema';
  organization: string;
  resource: string;
}

/**
 * Read/round-trip shape of the persisted `[endpoints.auth]` sub-table, as
 * surfaced by `getEndpointConfig` and echoed back on `updateEndpoint`. Unlike
 * the strict add-time `EmaAuthConfig`, `organization`/`resource` are optional
 * here because the Tauri backend serializes them from an `Option`-typed
 * `EndpointAuth`, so a stored binding may round-trip without every field
 * present. `type` stays the `'ema'` discriminant the UI keys off.
 */
export interface EmaAuthSummary {
  type: 'ema';
  organization?: string;
  resource?: string;
}

export interface AddEndpointParams {
  name: string;
  transport: 'stdio' | 'sse' | 'http' | 'oauth';
  tool_prefix?: string;
  command?: string;
  args?: string[];
  url?: string;
  description?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  oauth_server_url?: string;
  client_id?: string;
  /**
   * Write-only OAuth client secret. Sent to the relay's
   * `/api/endpoints/{name}/credentials` endpoint and stored in the DCR file
   * (chmod 0600); never persisted in `config.toml`. Empty/absent = no secret.
   */
  client_secret?: string;
  /**
   * Optional EMA **resource** `client_id` presented at the MCP Authorization
   * Server in Step 3 (ID-JAG redemption). Per-resource (R3), so it is persisted
   * out-of-band via `/api/endpoints/{name}/credentials` (DCR file, chmod 0600),
   * never in `config.toml`. Only needed for xaa.dev/Okta-style MASes.
   */
  resource_client_id?: string;
  /**
   * Optional EMA **resource** `client_secret` paired with `resource_client_id`.
   * Write-only; persisted via `/api/endpoints/{name}/credentials` (DCR file,
   * chmod 0600), never in `config.toml`.
   */
  resource_client_secret?: string;
  scopes?: string;
  token_endpoint?: string;
  /**
   * Optional override for the server type the relay advertises to MCP clients.
   * When set, replaces the upstream `serverInfo.name` (useful when an upstream
   * server returns a placeholder like `statelessserver`). Lowercase letters,
   * digits, `-`, `_` only — empty/absent leaves the field unset.
   */
  server_type_override?: string;
  /**
   * Isolation mode for stdio endpoints. The desktop always sends an explicit
   * value when creating a stdio endpoint — `"container"` or `"none"`, never
   * omitted — because the relay treats an absent field as direct spawn.
   */
  isolation?: 'container' | 'none';
  /**
   * Bind mounts for containerized stdio endpoints. Each entry is a verbatim
   * docker `-v` `"host_path:container_path"` pair (relative host paths are
   * resolved by the relay). Omitted when empty.
   */
  mounts?: string[];
  /**
   * Enterprise-Managed Authorization block for org-bound endpoints. When set,
   * the relay binds the endpoint to the named organization and mints EMA
   * access tokens from the org's shared ID token (the `(org, resource)`
   * credential pool). Omitted for ordinary stdio/sse/http/oauth endpoints.
   */
  auth?: EmaAuthConfig;
}

/**
 * Surface a relay management-API error as a `throw`-able `Error` with the
 * server-provided `detail` / `error` message when the body parses as JSON,
 * otherwise fall back to the raw body and status.
 */
function mgmtError(res: ApiResponse): Error {
  let detail: string | undefined;
  try {
    const data = JSON.parse(res.body);
    detail = data?.detail || data?.error;
  } catch {
    // body not JSON
  }
  return new Error(detail || `HTTP ${res.status}: ${res.body}`);
}

/**
 * POST any non-empty OAuth credentials to the relay's
 * `/api/endpoints/{name}/credentials` endpoint so the secret lands in the DCR
 * file (chmod 0600) instead of `config.toml`. No-ops when neither `client_id`
 * nor `client_secret` is supplied.
 */
async function postEndpointCredentials(
  name: string,
  fields: {
    client_id?: string;
    client_secret?: string;
    oauth_server_url?: string;
    resource_client_id?: string;
    resource_client_secret?: string;
  },
): Promise<void> {
  const body: Record<string, string> = {};
  // Requesting creds are write-only: only sent when non-empty (blank = keep).
  if (fields.client_id) body.client_id = fields.client_id;
  if (fields.client_secret) body.client_secret = fields.client_secret;
  if (fields.oauth_server_url) body.oauth_server_url = fields.oauth_server_url;
  // EMA resource pair (R3): absent = keep, empty string = clear, value = set.
  // Distinguish `undefined` (omit) from `''` (explicit clear) so the relay's
  // merge can drop a stored value.
  if (fields.resource_client_id !== undefined) body.resource_client_id = fields.resource_client_id;
  if (fields.resource_client_secret !== undefined) {
    body.resource_client_secret = fields.resource_client_secret;
  }
  // No-op when there is no credential material to set or clear. A lone
  // `oauth_server_url` is informational and never worth a round-trip.
  if (
    !body.client_id &&
    !body.client_secret &&
    body.resource_client_id === undefined &&
    body.resource_client_secret === undefined
  ) {
    return;
  }
  const res = await mgmtRequest(
    'POST',
    `/endpoints/${encodeURIComponent(name)}/credentials`,
    body,
  );
  if (res.status < 200 || res.status >= 300) {
    throw mgmtError(res);
  }
}

export async function addEndpoint(params: AddEndpointParams): Promise<void> {
  // Body excludes the write-only client_secret and the EMA resource pair;
  // credentials are persisted via the separate /credentials endpoint below
  // (DCR file, chmod 0600).
  const { client_secret, resource_client_id, resource_client_secret, ...body } = params;
  const res = await mgmtRequest('POST', '/endpoints', body);
  if (res.status < 200 || res.status >= 300) {
    throw mgmtError(res);
  }
  await postEndpointCredentials(params.name, {
    client_id: params.client_id,
    client_secret,
    oauth_server_url: params.oauth_server_url,
    resource_client_id,
    resource_client_secret,
  });
}

export async function disableEndpoint(name: string): Promise<void> {
  await fetchJson(`/endpoints/${encodeURIComponent(name)}/disable`, { method: 'POST' });
}

export async function enableEndpoint(name: string): Promise<void> {
  await fetchJson(`/endpoints/${encodeURIComponent(name)}/enable`, { method: 'POST' });
}

export async function disableTool(endpointName: string, toolName: string): Promise<void> {
  await fetchJson(`/endpoints/${encodeURIComponent(endpointName)}/tools/${encodeURIComponent(toolName)}/disable`, { method: 'POST' });
}

export async function enableTool(endpointName: string, toolName: string): Promise<void> {
  await fetchJson(`/endpoints/${encodeURIComponent(endpointName)}/tools/${encodeURIComponent(toolName)}/enable`, { method: 'POST' });
}

export async function removeEndpoint(name: string): Promise<void> {
  await invoke('remove_endpoint', { name });
  // Best-effort reload — relay may not be running
  try {
    await new Promise((r) => setTimeout(r, 200));
    await reloadConfig();
  } catch {
    // Relay not reachable; it will pick up config changes on next start
  }
}

export interface EndpointConfig {
  name: string;
  transport: 'stdio' | 'sse' | 'http' | 'oauth';
  tool_prefix?: string;
  command?: string;
  args?: string[];
  url?: string;
  description?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  oauth_server_url?: string;
  client_id?: string;
  /**
   * `true` when an OAuth client secret is stored for this endpoint (in the
   * DCR file or, for legacy entries, in `config.toml`). The secret value
   * itself is never returned by the backend; the UI renders a masked,
   * write-only field.
   */
  client_secret_set?: boolean;
  /**
   * The EMA **resource** `client_id` stored per-endpoint (R3); absent when
   * unset. Not a secret, so the value is returned and rendered editable.
   */
  resource_client_id?: string;
  /**
   * `true` when an EMA **resource** `client_secret` is stored for this endpoint
   * (DCR file). The secret value itself is never returned; the UI renders a
   * masked, write-only field.
   */
  resource_client_secret_set?: boolean;
  scopes?: string;
  token_endpoint?: string;
  /**
   * Optional override that replaces the upstream-reported server name in the
   * relay's connected-servers advertisement. Persisted to `config.toml` as
   * `server_type_override`. Absent when no override is configured.
   */
  server_type_override?: string;
  /**
   * Isolation mode stored for stdio endpoints (`"container"` or `"none"`).
   * Absent for legacy endpoints that never set it (= direct spawn).
   */
  isolation?: string;
  /**
   * Bind mounts stored for containerized stdio endpoints, as verbatim docker
   * `-v` `"host_path:container_path"` pairs. Absent when none are configured.
   */
  mounts?: string[];
  /**
   * EMA org-binding mirrored from the persisted `[endpoints.auth]` sub-table.
   * Absent for ordinary endpoints. The UI displays the bound organization
   * (read-only) and passes the block back on `updateEndpoint` so the relay's
   * PUT — which rebuilds the whole endpoint config from the body — preserves
   * the binding.
   */
  auth?: EmaAuthSummary;
}

export async function getEndpointConfig(name: string): Promise<EndpointConfig> {
  return invoke<EndpointConfig>('get_endpoint_config', { name });
}

export interface UpdateEndpointParams {
  original_name: string;
  name: string;
  transport: 'stdio' | 'sse' | 'http' | 'oauth';
  command?: string;
  tool_prefix?: string;
  args?: string[];
  url?: string;
  description?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  oauth_server_url?: string;
  client_id?: string;
  /**
   * Write-only OAuth client secret. Empty/absent means "do not change the
   * stored secret". When non-empty, the new value is sent to the relay's
   * credentials endpoint (DCR file, chmod 0600) and never written to
   * `config.toml`.
   */
  client_secret?: string;
  /**
   * EMA **resource** `client_id` (R3, MAS Step-3 credential). Absent preserves
   * the stored value, an empty string clears it, a non-empty value sets it.
   * Persisted via `/api/endpoints/{name}/credentials`, never in `config.toml`.
   */
  resource_client_id?: string;
  /**
   * EMA **resource** `client_secret` paired with `resource_client_id`. Same
   * merge semantics; write-only and never returned to the UI.
   */
  resource_client_secret?: string;
  scopes?: string;
  token_endpoint?: string;
  /**
   * Optional override for the server type advertised to MCP clients. Empty
   * string clears the override; absent leaves the stored value unchanged.
   */
  server_type_override?: string;
  /**
   * Isolation mode for stdio endpoints. The relay's PUT handler rebuilds the
   * whole endpoint config from the request body, so updates must pass the
   * stored value through or a containerized endpoint silently reverts to
   * direct spawn on save.
   */
  isolation?: string;
  /**
   * Bind mounts for containerized stdio endpoints, as verbatim docker `-v`
   * `"host_path:container_path"` pairs. The relay's PUT rebuilds the whole
   * endpoint config from the body, so the desktop always sends an explicit
   * array (possibly empty, to clear) for stdio endpoints.
   */
  mounts?: string[];
  /**
   * EMA org-binding block (`[endpoints.auth]`) round-tripped on update. The
   * relay's PUT rebuilds the whole endpoint config from the body, so the
   * stored binding must be sent back verbatim or it would be silently dropped.
   * Absent for ordinary (non-EMA) endpoints — no empty `auth` key is sent in
   * that case, keeping the PUT body byte-for-byte unchanged.
   */
  auth?: EmaAuthSummary;
}

export async function startOAuth(name: string): Promise<OAuthStartResult> {
  const res = await mgmtRequest('POST', `/endpoints/${encodeURIComponent(name)}/oauth/start`);
  const data = res.body ? JSON.parse(res.body) : {};
  if (res.status < 200 || res.status >= 300) {
    // dcr_unsupported / discovery_failed / discovery_unreachable are returned as typed responses, not thrown
    if (['dcr_unsupported', 'discovery_failed', 'discovery_unreachable'].includes(data?.error)) {
      return data as OAuthStartResult;
    }
    throw new Error(data?.detail || data?.error || `HTTP ${res.status}`);
  }
  return data as OAuthStartResult;
}

export async function setOAuthCredentials(
  name: string,
  clientId: string,
  clientSecret?: string,
): Promise<void> {
  const body: Record<string, string> = { client_id: clientId };
  if (clientSecret) body.client_secret = clientSecret;
  const res = await mgmtRequest('POST', `/endpoints/${encodeURIComponent(name)}/oauth/credentials`, body);
  if (res.status < 200 || res.status >= 300) {
    let detail: string | undefined;
    try {
      const data = JSON.parse(res.body);
      detail = data?.message || data?.error;
    } catch {
      // body not JSON
    }
    throw new Error(detail || `HTTP ${res.status}: ${res.body}`);
  }
}

export async function getOAuthStatus(name: string): Promise<OAuthStatus> {
  return fetchJson<OAuthStatus>(`/endpoints/${encodeURIComponent(name)}/oauth/status`);
}

export async function revokeOAuth(name: string): Promise<void> {
  await fetchJson(`/endpoints/${encodeURIComponent(name)}/oauth/revoke`, { method: 'POST' });
}

export async function refreshOAuth(name: string): Promise<void> {
  await fetchJson(`/endpoints/${encodeURIComponent(name)}/oauth/refresh`, { method: 'POST' });
}

export async function updateEndpoint(params: UpdateEndpointParams): Promise<void> {
  // Body mirrors the POST `/api/endpoints` shape: `original_name` moves to the
  // path, and `client_secret` is excluded so it is persisted out-of-band via
  // /credentials (DCR file, chmod 0600) rather than stored in `config.toml`.
  const { original_name, client_secret, resource_client_id, resource_client_secret, ...body } =
    params;
  const res = await mgmtRequest(
    'PUT',
    `/endpoints/${encodeURIComponent(original_name)}`,
    body,
  );
  if (res.status < 200 || res.status >= 300) {
    throw mgmtError(res);
  }
  await postEndpointCredentials(params.name, {
    client_id: params.client_id,
    client_secret,
    oauth_server_url: params.oauth_server_url,
    resource_client_id,
    resource_client_secret,
  });
}

// ---------------------------------------------------------------------------
// OAuth Setup (preflight) API
// ---------------------------------------------------------------------------

export interface OAuthSetupParams {
  name: string;
  url: string;
  scopes?: string[];
  tool_prefix?: string;
  oauth_server_url?: string;
  client_id?: string;
  client_secret?: string;
  /**
   * Optional override for the upstream-reported server name; forwarded to the
   * relay's `/oauth/setup` endpoint so it is persisted alongside the endpoint
   * config on commit. Lowercase letters, digits, `-`, `_` only.
   */
  server_type_override?: string;
}

export async function oauthSetup(params: OAuthSetupParams): Promise<OAuthSetupResponse> {
  const res = await mgmtRequest('POST', '/oauth/setup', params);
  const data = res.body ? JSON.parse(res.body) : {};
  // 422 with dcr_error is an expected flow — return typed response
  if (res.status === 422 && data?.dcr_error) {
    return data as OAuthSetupResponse;
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(data?.detail || data?.error || `HTTP ${res.status}`);
  }
  return data as OAuthSetupResponse;
}

export async function oauthSetupCredentials(
  sessionId: string,
  clientId: string,
  clientSecret?: string,
): Promise<{ status: string; authorize_url: string }> {
  const body: Record<string, string> = { client_id: clientId };
  if (clientSecret) body.client_secret = clientSecret;
  const res = await mgmtRequest(
    'POST',
    `/oauth/setup/${encodeURIComponent(sessionId)}/credentials`,
    body,
  );
  if (res.status < 200 || res.status >= 300) {
    let detail: string | undefined;
    try {
      const data = JSON.parse(res.body);
      detail = data?.detail || data?.error;
    } catch {
      // body not JSON
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return JSON.parse(res.body);
}

export async function oauthSetupStatus(sessionId: string): Promise<OAuthSetupStatusResponse> {
  return fetchJson<OAuthSetupStatusResponse>(`/oauth/setup/${encodeURIComponent(sessionId)}/status`);
}

export async function oauthSetupCommit(sessionId: string): Promise<{ status: string; name: string }> {
  const res = await mgmtRequest('POST', `/oauth/setup/${encodeURIComponent(sessionId)}/commit`);
  if (res.status < 200 || res.status >= 300) {
    let detail: string | undefined;
    try {
      const data = JSON.parse(res.body);
      detail = data?.detail || data?.error;
    } catch {
      // body not JSON
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return JSON.parse(res.body);
}

export async function oauthSetupCancel(sessionId: string): Promise<void> {
  const res = await mgmtRequest('DELETE', `/oauth/setup/${encodeURIComponent(sessionId)}`);
  if (res.status < 200 || res.status >= 300) {
    let detail: string | undefined;
    try {
      const data = JSON.parse(res.body);
      detail = data?.detail || data?.error;
    } catch {
      // body not JSON
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// OAuth capability probe (add-time)
// ---------------------------------------------------------------------------

/**
 * Best-effort probe of whether an MCP server supports OAuth, used by the
 * add-server flow to offer escalation into the OAuth setup wizard. This is
 * deliberately non-blocking: any transport error, non-2xx status, or
 * unparseable body resolves to `{ oauth_supported: false }` so the caller can
 * silently fall back to a plain (non-OAuth) add. It never throws and never
 * retries — the relay already backstops slow/unreachable probes with a 15s
 * timeout.
 */
export async function oauthProbe(url: string): Promise<OAuthProbeResult> {
  try {
    const res = await mgmtRequest('POST', '/oauth/probe', { url });
    if (res.status < 200 || res.status >= 300) {
      return { oauth_supported: false };
    }
    return (res.body ? JSON.parse(res.body) : { oauth_supported: false }) as OAuthProbeResult;
  } catch {
    return { oauth_supported: false };
  }
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export interface ProfileSummary {
  name: string;
  path: string;
  endpoints: string[];
  /** Per-profile JS-execution toggle. Always a concrete boolean. */
  js_execution: boolean;
  /** Per-profile TOON output toggle. Always a concrete boolean. */
  toon_output: boolean;
  endpoint_count: number;
  tool_count: number;
}

export interface ProfileDetail extends ProfileSummary {
  /** Full catalog scoped to the profile's endpoints. */
  tools: Tool[];
}

export interface CreateProfileParams {
  name: string;
  path: string;
  endpoints: string[];
  /** Required; relay rejects requests that omit it. */
  js_execution: boolean;
  /** Required; relay rejects requests that omit it. */
  toon_output: boolean;
}

export type UpdateProfileParams = CreateProfileParams;

export async function listProfiles(): Promise<ProfileSummary[]> {
  return fetchJson<ProfileSummary[]>('/profiles');
}

export async function getProfile(path: string): Promise<ProfileDetail> {
  return fetchJson<ProfileDetail>(`/profiles/${encodeURIComponent(path)}`);
}

export async function createProfile(params: CreateProfileParams): Promise<ProfileSummary> {
  return fetchJson<ProfileSummary>('/profiles', { method: 'POST', body: params });
}

export async function updateProfile(
  path: string,
  params: UpdateProfileParams,
): Promise<ProfileSummary> {
  return fetchJson<ProfileSummary>(`/profiles/${encodeURIComponent(path)}`, {
    method: 'PUT',
    body: params,
  });
}

export async function deleteProfile(path: string): Promise<void> {
  await fetchJson(`/profiles/${encodeURIComponent(path)}`, { method: 'DELETE' });
}

export async function getEndpointProfiles(name: string): Promise<{ profiles: string[] }> {
  return fetchJson<{ profiles: string[] }>(
    `/endpoints/${encodeURIComponent(name)}/profiles`,
  );
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------
//
// All routes proxy through the management API. Endpoints return 503 when the
// observability store failed to open; `fetchJson` throws on non-2xx, so callers
// can catch and render an "unavailable" state. The relay's query params are
// snake_case (see the verified REST contract in the spec note).

/** Build a `?a=b&c=d` query string from an object, skipping null/undefined values. */
function buildQuery(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

export interface ObservabilityCallsFilter {
  server_name?: string;
  tool?: string;
  success?: boolean;
  request_uid?: string;
  since?: number;
  until?: number;
  limit?: number;
  /**
   * Opaque continuation token returned as `nextCursor` from the previous
   * page; omit for the first page. The relay encodes `(tsStart, id)` so
   * paging stays stable across concurrent inserts.
   */
  cursor?: string;
}

export async function getObservabilityCalls(
  filter: ObservabilityCallsFilter = {},
): Promise<CallsResponse> {
  return fetchJson<CallsResponse>(`/observability/calls${buildQuery(filter)}`);
}

/** Fetch a single call by request UUID. Returns null when the relay 404s. */
export async function getObservabilityCall(requestUid: string): Promise<CallDetail | null> {
  try {
    return await fetchJson<CallDetail>(
      `/observability/calls/${encodeURIComponent(requestUid)}`,
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes('HTTP 404')) {
      return null;
    }
    throw err;
  }
}

export interface ObservabilityAggregatesParams {
  bucket_seconds?: number;
  since?: number;
  until?: number;
}

export async function getObservabilityAggregates(
  params: ObservabilityAggregatesParams = {},
): Promise<AggregatesResponse> {
  return fetchJson<AggregatesResponse>(`/observability/aggregates${buildQuery(params)}`);
}

export async function purgeObservability(): Promise<{ ok: boolean; message: string }> {
  return fetchJson<{ ok: boolean; message: string }>('/observability/purge', {
    method: 'POST',
  });
}

export async function getObservabilityConfig(): Promise<ObservabilityConfig> {
  return fetchJson<ObservabilityConfig>('/observability/config');
}

export async function putObservabilityConfig(
  cfg: ObservabilityConfig,
): Promise<ObservabilityConfig> {
  return fetchJson<ObservabilityConfig>('/observability/config', {
    method: 'PUT',
    body: cfg,
  });
}

// ---------------------------------------------------------------------------
// Organizations + EMA (Enterprise-Managed Authorization)
// ---------------------------------------------------------------------------
//
// All routes proxy through the management API. The relay's JSON contracts live
// in management.rs (END-19 Waves 3–4): provider templates, organization
// lifecycle, and the per-org capability probe.

/**
 * GET /api/idp-providers — the static identity-provider template table the
 * "Add organization" UI renders and `createOrganization` resolves issuers from.
 */
export async function getIdpProviders(): Promise<IdpProvider[]> {
  return fetchJson<IdpProvider[]>('/idp-providers');
}

export interface CreateOrganizationParams {
  /** Display name / stable key; also the credential-pool key. */
  name: string;
  /** Provider template id: `okta`, `entra`, `google`, `ping`, or `custom`. */
  provider: string;
  /** Slug for templated providers (Okta subdomain, Entra tenant, Ping env id). */
  slug?: string;
  /** Full issuer URL for `provider = "custom"`. */
  idp?: string;
  /** Pre-registered IdP client id (required for Okta/Entra; omit for CIMD/DCR). */
  client_id?: string;
  /**
   * Pre-registered confidential-client `client_secret`. Required for Okta/Entra
   * apps configured as confidential clients. Persisted in the relay's secure
   * credential store (`{org}.dcr.json`, 0600); never written to `config.toml`
   * and never returned to the UI.
   */
  client_secret?: string;
}

/**
 * POST /api/organizations — validate the IdP issuer, persist the org, and
 * return a freshly-composed SSO authorize URL to open for the IdP sign-in.
 */
export async function createOrganization(
  params: CreateOrganizationParams,
): Promise<OrganizationSsoResponse> {
  return fetchJson<OrganizationSsoResponse>('/organizations', {
    method: 'POST',
    body: params,
  });
}

/**
 * Body for `PUT /api/organizations/{org}`. All fields are optional — omitted
 * fields preserve the current value. `client_id` and `client_secret` use an
 * empty string (`""`) as the explicit "clear" signal so callers can
 * distinguish "keep" (absent) from "remove" (present-and-empty).
 */
export interface UpdateOrganizationParams {
  /** New display name; rename purges pooled IdP credentials. */
  name?: string;
  /** New provider template id (`okta`, `entra`, `google`, `ping`, `custom`). */
  provider?: string;
  /** New slug for templated providers. */
  slug?: string;
  /** New full issuer URL for `provider = "custom"`. */
  idp?: string;
  /** New explicit `client_id`. Empty string clears the persisted id. */
  client_id?: string;
  /** New confidential-client `client_secret`. Empty string deletes the stored secret. */
  client_secret?: string;
}

/**
 * Identity-unchanged variant of the `PUT /api/organizations/{org}` response:
 * the org metadata was updated but credentials were preserved. Mirrors the
 * shape of an entry in `GET /api/organizations`.
 */
export interface OrganizationUpdated {
  name: string;
  provider: string;
  idp: string;
  authenticated: boolean;
  client_secret_set?: boolean;
}

/**
 * Identity-changed variant of the `PUT /api/organizations/{org}` response:
 * the rename/issuer/client_id change invalidated pooled credentials so the
 * caller must re-run the IdP sign-in by opening `authorize_url`.
 */
export interface OrganizationReauthRequired {
  name: string;
  provider: string;
  idp: string;
  authorize_url: string;
}

/** Discriminated by the presence of `authorize_url`. */
export type UpdateOrganizationResponse = OrganizationUpdated | OrganizationReauthRequired;

/** True when the PUT response requires re-running the IdP sign-in. */
export function updateRequiresReauth(
  res: UpdateOrganizationResponse,
): res is OrganizationReauthRequired {
  return 'authorize_url' in res && typeof res.authorize_url === 'string';
}

/**
 * PUT /api/organizations/{org} — update an existing organization's metadata
 * and/or its persisted IdP credentials. Returns either the refreshed org
 * metadata (credentials preserved) or a fresh SSO authorize URL (identity
 * changed; re-authentication required).
 */
export async function updateOrganization(
  name: string,
  params: UpdateOrganizationParams,
): Promise<UpdateOrganizationResponse> {
  return fetchJson<UpdateOrganizationResponse>(
    `/organizations/${encodeURIComponent(name)}`,
    { method: 'PUT', body: params },
  );
}

/** GET /api/organizations — configured organizations with auth status. */
export async function listOrganizations(): Promise<Organization[]> {
  return fetchJson<Organization[]>('/organizations');
}

/**
 * DELETE /api/organizations/{org} — remove the org from config and purge its
 * pooled IdP credentials.
 */
export async function deleteOrganization(name: string): Promise<void> {
  await fetchJson(`/organizations/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

/**
 * POST /api/organizations/{org}/reauthenticate — re-discover the org's IdP and
 * return a fresh SSO authorize URL for re-running the sign-in.
 */
export async function reauthenticateOrganization(
  name: string,
): Promise<OrganizationSsoResponse> {
  return fetchJson<OrganizationSsoResponse>(
    `/organizations/${encodeURIComponent(name)}/reauthenticate`,
    { method: 'POST' },
  );
}

/**
 * POST /api/organizations/{org}/probe — the "Detecting available MCP servers…"
 * engine. The desktop supplies candidate MCP server URLs (the EMA-flagged
 * catalog entries) and the relay reports `accessible` / `denied` / `unreachable`
 * per resource. The probe persists nothing.
 */
export async function probeOrganization(
  name: string,
  resources: string[],
): Promise<OrgProbeResponse> {
  return fetchJson<OrgProbeResponse>(
    `/organizations/${encodeURIComponent(name)}/probe`,
    { method: 'POST', body: { resources } },
  );
}
