import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import type { RelayStatus, Endpoint, Tool, EndpointLogs, CatalogEntry, OAuthStatus, OAuthStartResult, OAuthSetupResponse, OAuthSetupStatusResponse } from './types';
import { relayPort } from './stores';

function getBaseUrl() {
  return `http://localhost:${get(relayPort)}/api`;
}

const MAX_RETRIES = 2;
const RETRY_DELAY = 1000;

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${getBaseUrl()}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...options?.headers },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      return await res.json() as T;
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
  // Map relay's health states to UI-friendly values
  for (const ep of data) {
    if ((ep.health as string) === 'starting') {
      ep.health = 'unknown';
    }
    // Handle lifecycle.state === "Failed" from the management API
    if (ep.lifecycle?.state === 'Failed') {
      ep.health = 'error';
      // Extract error detail from lifecycle
      ep.error = ep.lifecycle.error;
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
  const res = await fetch(`${getBaseUrl()}/test-connection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  return await res.json() as TestConnectionResult;
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
  client_secret?: string;
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
  client_secret?: string;
  scopes?: string;
  token_endpoint?: string;
}

export async function startOAuth(name: string): Promise<OAuthStartResult> {
  const res = await fetch(`${getBaseUrl()}/endpoints/${encodeURIComponent(name)}/oauth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  // If the server returns dcr_unsupported, return it as a typed result instead of throwing
  if (!res.ok && data?.error === 'dcr_unsupported') {
    return data as OAuthStartResult;
  }
  if (!res.ok && data?.error === 'discovery_failed') {
    return data as OAuthStartResult;
  }
  if (!res.ok) {
    throw new Error(data?.detail || data?.error || `HTTP ${res.status}: ${res.statusText}`);
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
  const res = await fetch(`${getBaseUrl()}/endpoints/${encodeURIComponent(name)}/oauth/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.message || data?.error || `HTTP ${res.status}: ${res.statusText}`);
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
}

export async function oauthSetup(params: OAuthSetupParams): Promise<OAuthSetupResponse> {
  const res = await fetch(`${getBaseUrl()}/oauth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  // 422 with dcr_error is an expected flow — return typed response
  if (!res.ok && res.status === 422 && data?.dcr_error) {
    return data as OAuthSetupResponse;
  }
  if (!res.ok) {
    throw new Error(data?.detail || data?.error || `HTTP ${res.status}: ${res.statusText}`);
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
  const res = await fetch(`${getBaseUrl()}/oauth/setup/${encodeURIComponent(sessionId)}/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.detail || data?.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function oauthSetupStatus(sessionId: string): Promise<OAuthSetupStatusResponse> {
  return fetchJson<OAuthSetupStatusResponse>(`/oauth/setup/${encodeURIComponent(sessionId)}/status`);
}

export async function oauthSetupCommit(sessionId: string): Promise<{ status: string; name: string }> {
  const res = await fetch(`${getBaseUrl()}/oauth/setup/${encodeURIComponent(sessionId)}/commit`, {
    method: 'POST',
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.detail || data?.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function oauthSetupCancel(sessionId: string): Promise<void> {
  const res = await fetch(`${getBaseUrl()}/oauth/setup/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.detail || data?.error || `HTTP ${res.status}`);
  }
}

