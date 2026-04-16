export type HealthStatus = 'healthy' | 'degraded' | 'offline' | 'unknown' | 'error' | 'failed';

export interface RelayStatus {
  status: string;
  uptime_seconds: number;
  endpoint_count: number;
  healthy_count: number;
}

// Lifecycle state from the management API (GET /api/endpoints)
export type LifecycleState = 'Initializing' | 'Ready' | 'Failed' | 'Stopped';

export interface LifecycleReady {
  state: 'Ready';
  server_name: string;
  server_name_raw?: string;
}

export interface LifecycleError {
  kind: string;
  detail: string;
}

export interface LifecycleFailed {
  state: 'Failed';
  error: LifecycleError;
}

export interface LifecycleInitializing {
  state: 'Initializing';
}

export interface LifecycleStopped {
  state: 'Stopped';
}

export type Lifecycle = LifecycleReady | LifecycleFailed | LifecycleInitializing | LifecycleStopped;

export interface Endpoint {
  name: string;
  transport: 'stdio' | 'sse' | 'http' | 'oauth';
  health: HealthStatus;
  tool_count: number;
  last_activity: string | null;
  disabled: boolean;
  error?: string;
  lifecycle?: Lifecycle;
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
  expires_at: number | null;
  expires_in_seconds: number | null;
  last_refreshed_at: number | null;
  next_refresh_at: number | null;
  state: string | null;
  transition_history?: Array<{ from: string; to: string; reason: string; ago_ms: number }>;
}

export interface OAuthDisplayStatus {
  color: 'green' | 'yellow' | 'blue' | 'orange' | 'gray' | 'red';
  label: string;
  healthDotVariant: HealthStatus;
  canConnect: boolean;
  canDisconnect: boolean;
  canRefresh: boolean;
}

export interface OAuthStartSuccess {
  authorize_url: string;
}

export interface OAuthStartDcrUnsupported {
  error: 'dcr_unsupported';
  authorization_endpoint?: string;
  message?: string;
}

export interface OAuthStartDiscoveryFailed {
  error: 'discovery_failed';
  detail?: string;
}

export type OAuthStartResult = OAuthStartSuccess | OAuthStartDcrUnsupported | OAuthStartDiscoveryFailed;

export type OAuthSetupStatus = 'awaiting_credentials' | 'awaiting_auth' | 'authorized';

export interface OAuthSetupResponse {
  session_id: string;
  status: OAuthSetupStatus;
  authorize_url?: string;
  discovery?: {
    auth_server: string;
    dcr_used: boolean;
    scopes_available?: string[];
  };
  dcr_error?: string;
}

export interface OAuthSetupStatusResponse {
  session_id: string;
  status: OAuthSetupStatus;
  name: string;
  url: string;
}

export type Theme = 'light' | 'dark' | 'system';

