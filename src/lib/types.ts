export type HealthStatus = 'healthy' | 'degraded' | 'offline' | 'unknown' | 'error' | 'failed' | 'starting';

export interface RelayStatus {
  status: string;
  uptime_seconds: number;
  endpoint_count: number;
  healthy_count: number;
  /**
   * Whether the relay detected a usable container runtime (Docker/Podman)
   * on the host. Optional — older relays omit it, so only an explicit
   * `false` should drive the "no runtime" notice in the Add Server flow.
   */
  container_runtime_available?: boolean;
}

/**
 * Live resource usage polled from the container runtime for a containerized
 * stdio endpoint. Mirrors the relay's `container_stats` management-API field.
 */
export interface ContainerStats {
  cpu_percent: number;
  mem_bytes: number;
  net_rx_bytes: number;
  net_tx_bytes: number;
}

/**
 * Isolation status reported by the relay for stdio endpoints. `configured`
 * is what `config.toml` asked for; `actual` is what the relay actually did
 * (it falls back to a direct spawn when no container runtime is usable).
 * Absent for non-stdio endpoints and for older relays that predate the field.
 */
export interface IsolationState {
  configured: 'container' | 'none';
  actual: 'container' | 'direct';
  runtime?: 'docker' | 'podman';
  container_name?: string;
  image?: string;
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
  /**
   * Present only for containerized stdio endpoints; absent/null for
   * direct-spawn endpoints. Updated by the relay's stats poller and picked
   * up by the desktop's 2s endpoint poll loop.
   */
  container_stats?: ContainerStats | null;
  /**
   * Present only for stdio endpoints on relays that report it; absent for
   * non-stdio endpoints and older relays.
   */
  isolation_state?: IsolationState | null;
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

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------
//
// ⚠️ Casing is intentionally mixed to mirror the relay's serialization exactly:
// CallRecordDto / AggregateBucketDto / ObservabilitySummary are camelCase, while
// StoredPayloads and ObservabilityConfig are snake_case (no `rename_all`).

/**
 * A single proxied `tools/call` metadata row from `observability.db`. camelCase;
 * the relay omits `Option` fields when null, so most fields are optional.
 * Returned by the drill-through `GET /observability/calls/{request_uid}` route
 * — the list route returns the slim {@link CallSummaryDto} instead.
 */
export interface CallRecordDto {
  id: number;
  requestUid: string;
  endpoint: string;
  serverName: string;
  serverType?: string;
  transport?: string;
  profile?: string;
  clientName?: string;
  clientVersion?: string;
  clientUserAgent?: string;
  clientOrigin?: string;
  tool: string;
  tsStart: number;
  tsEnd?: number;
  durationMs?: number;
  success: boolean;
  errorMessage?: string;
  requestBytes?: number;
  responseBytes?: number;
  streamed: boolean;
}

/**
 * Slim per-row DTO for the calls list table — the only fields the list view
 * actually renders. Drops transport/client/payload-byte detail so a 100-row
 * page stays a few KB on the wire. The full {@link CallRecordDto} is still
 * served by the drill-through detail route.
 */
export interface CallSummaryDto {
  id: number;
  requestUid: string;
  serverName?: string;
  tool: string;
  tsStart: number;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
  requestBytes: number;
  responseBytes: number;
}

/** One aggregate time bucket (camelCase). `server` absent = all-servers bucket. */
export interface AggregateBucketDto {
  server?: string;
  bucketStart: number;
  count: number;
  errorCount: number;
  p50Ms: number;
  p95Ms: number;
}

/** Live observability pipeline summary (camelCase). */
export interface ObservabilitySummary {
  enabled: boolean;
  storePayloads: boolean;
  dropped: number;
  payloadBufferLen: number;
  payloadBufferBytes: number;
}

/** Buffered request/response payloads for a single call (⚠️ snake_case). */
export interface StoredPayloads {
  request: string;
  response: string;
  request_truncated: boolean;
  response_truncated: boolean;
  streamed: boolean;
  captured_at_ms: number;
}

/** Global observability configuration (⚠️ snake_case). */
export interface ObservabilityConfig {
  enabled: boolean;
  store_payloads: boolean;
  payload_window_minutes: number;
  record_retention_days: number;
  max_db_size_mb: number;
  max_payload_bytes: number;
  payload_buffer_budget_mb: number;
}

/**
 * `GET /observability/calls` response wrapper. Pagination is keyset on
 * `(tsStart, id)` via an opaque `nextCursor` token — absent when the page is
 * the last one. Pass the token back as the `cursor` query param to fetch the
 * next page.
 */
export interface CallsResponse {
  calls: CallSummaryDto[];
  limit: number;
  nextCursor?: string;
}

/** `GET /observability/calls/{request_uid}` response wrapper. */
export interface CallDetail {
  record: CallRecordDto;
  payloadStatus: 'stored' | 'expired' | 'disabled';
  payloads?: StoredPayloads;
}

/** `GET /observability/aggregates` response wrapper. */
export interface AggregatesResponse {
  buckets: AggregateBucketDto[];
  summary: ObservabilitySummary;
}

/**
 * Result of the add-time OAuth capability probe (POST /api/oauth/probe).
 * `authorization_server` and `scopes_supported` are present only when
 * `oauth_supported` is `true`. Any probe failure/timeout is reported by the
 * relay (and by the desktop client) as `{ oauth_supported: false }`.
 */
export interface OAuthProbeResult {
  oauth_supported: boolean;
  authorization_server?: string;
  scopes_supported?: string[];
}

export type Theme = 'light' | 'dark' | 'system';

// Re-export the parsed relay log type so components can import it from
// `$lib/types` alongside the rest of the desktop type surface.
export type { ParsedLogLine, LogLevel } from './logParser';

