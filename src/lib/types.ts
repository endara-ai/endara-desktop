export type HealthStatus = 'healthy' | 'degraded' | 'offline' | 'unknown' | 'error';

export interface RelayStatus {
  status: string;
  uptime_seconds: number;
  endpoint_count: number;
  healthy_count: number;
}

export interface Endpoint {
  name: string;
  transport: 'stdio' | 'sse' | 'http' | 'oauth';
  health: HealthStatus;
  tool_count: number;
  last_activity: string | null;
  disabled: boolean;
  error?: string;
}

export interface Tool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  disabled?: boolean;
  annotations?: Record<string, unknown>;
}

export interface CatalogEntry {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  endpoint: string;
  available: boolean;
}

export interface EndpointLogs {
  lines: string[];
}

export type OAuthStatusValue = 'authenticated' | 'needs_login' | 'refreshing' | 'auth_required' | 'disconnected' | 'connection_failed';

export interface OAuthStatus {
  status: OAuthStatusValue;
  has_access_token: boolean;
  has_refresh_token: boolean;
  expires_at: string | null;
  expires_in_seconds: number | null;
  last_refreshed_at: string | null;
  next_refresh_at: string | null;
  state: string | null;
}

export type Theme = 'light' | 'dark' | 'system';

