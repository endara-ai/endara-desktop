import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import type { RelayStatus, Endpoint, Tool, EndpointLogs, CatalogEntry } from './types';
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
  return fetchJson<Endpoint[]>('/endpoints');
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
  transport: 'stdio' | 'sse' | 'http';
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
  transport: 'stdio' | 'sse' | 'http';
  tool_prefix?: string;
  command?: string;
  args?: string[];
  url?: string;
  description?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
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
  transport: 'stdio' | 'sse' | 'http';
  tool_prefix?: string;
  command?: string;
  args?: string[];
  url?: string;
  description?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export async function getEndpointConfig(name: string): Promise<EndpointConfig> {
  return invoke<EndpointConfig>('get_endpoint_config', { name });
}

export interface UpdateEndpointParams {
  originalName: string;
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  tool_prefix?: string;
  command?: string;
  args?: string[];
  url?: string;
  description?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
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

