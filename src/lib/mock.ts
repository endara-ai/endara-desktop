import type { Endpoint, RelayStatus, Tool } from './types';

export const mockStatus: RelayStatus = {
  status: 'running',
  uptime_seconds: 3600,
  endpoint_count: 4,
  healthy_count: 2,
};

export const mockEndpoints: Endpoint[] = [
  { name: 'filesystem', transport: 'stdio', health: 'healthy', tool_count: 5, last_activity: '2026-03-27T10:00:00Z' },
  { name: 'github', transport: 'sse', health: 'healthy', tool_count: 12, last_activity: '2026-03-27T09:55:00Z' },
  { name: 'database', transport: 'http', health: 'degraded', tool_count: 3, last_activity: '2026-03-27T09:30:00Z' },
  { name: 'slack', transport: 'stdio', health: 'offline', tool_count: 8, last_activity: null },
];

export const mockTools: Tool[] = [
  { name: 'read_file', description: 'Read the contents of a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'write_file', description: 'Write content to a file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
  { name: 'list_directory', description: 'List files in a directory', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
];

export const mockLogs: string[] = [
  '[2026-03-27 10:00:01] INFO  Connected to endpoint',
  '[2026-03-27 10:00:02] INFO  Discovering tools...',
  '[2026-03-27 10:00:03] INFO  Found 5 tools',
  '[2026-03-27 10:00:10] DEBUG Health check passed',
  '[2026-03-27 10:01:10] DEBUG Health check passed',
  '[2026-03-27 10:02:10] WARN  Slow response (1200ms)',
  '[2026-03-27 10:03:10] DEBUG Health check passed',
];

