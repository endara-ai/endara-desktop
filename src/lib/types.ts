export type HealthStatus = 'healthy' | 'degraded' | 'offline' | 'unknown';

export interface RelayStatus {
  status: string;
  uptime_seconds: number;
  endpoint_count: number;
  healthy_count: number;
}

export interface Endpoint {
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  health: HealthStatus;
  tool_count: number;
  last_activity: string | null;
}

export interface Tool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface EndpointLogs {
  lines: string[];
}

export type Theme = 'light' | 'dark' | 'system';

