import { invoke } from '@tauri-apps/api/core';
import type { RelayStatus, Endpoint, Tool, EndpointLogs, CatalogEntry, OAuthStatus, OAuthStartResult, OAuthSetupResponse, OAuthSetupStatusResponse } from './types';

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
  scopes?: string;
  token_endpoint?: string;
}

export async function addEndpoint(params: AddEndpointParams): Promise<void> {
  await invoke('add_endpoint', { args: params });
  // Best-effort reload — relay may not be running yet during onboarding
  try {
    await new Promise((r) => setTimeout(r, 200));
    await reloadConfig();
  } catch {
    // Relay not reachable; it will pick up config changes on next start
  }
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
  scopes?: string;
  token_endpoint?: string;
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
  scopes?: string;
  token_endpoint?: string;
}

export async function startOAuth(name: string): Promise<OAuthStartResult> {
  const res = await mgmtRequest('POST', `/endpoints/${encodeURIComponent(name)}/oauth/start`);
  const data = res.body ? JSON.parse(res.body) : {};
  // dcr_unsupported / discovery_failed are returned as typed responses, not thrown
  if ((res.status < 200 || res.status >= 300) && data?.error === 'dcr_unsupported') {
    return data as OAuthStartResult;
  }
  if ((res.status < 200 || res.status >= 300) && data?.error === 'discovery_failed') {
    return data as OAuthStartResult;
  }
  if (res.status < 200 || res.status >= 300) {
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
  await invoke('update_endpoint', { args: params });
  // Best-effort reload — relay may not be running
  try {
    await new Promise((r) => setTimeout(r, 200));
    await reloadConfig();
  } catch {
    // Relay not reachable; it will pick up config changes on next start
  }
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

