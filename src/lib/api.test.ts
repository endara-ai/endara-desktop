import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

// Mock fetch globally
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

describe('api', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  function mockFetchSuccess(data: unknown) {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(data),
      status: 200,
      statusText: 'OK',
    });
  }

  function mockFetchError(status: number, statusText: string) {
    mockFetch.mockResolvedValue({
      ok: false,
      status,
      statusText,
    });
  }

  describe('getStatus', () => {
    it('fetches relay status', async () => {
      const { getStatus } = await import('./api');
      const mockStatus = { status: 'ok', uptime_seconds: 100, endpoint_count: 2, healthy_count: 2 };
      mockFetchSuccess(mockStatus);

      const result = await getStatus();
      expect(result).toEqual(mockStatus);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/status'),
        expect.objectContaining({ headers: expect.objectContaining({ 'Content-Type': 'application/json' }) }),
      );
    });
  });

  describe('getEndpoints', () => {
    it('fetches endpoints list', async () => {
      const { getEndpoints } = await import('./api');
      const mockEndpoints = [{ name: 'ep1', transport: 'stdio', health: 'healthy', tool_count: 3, last_activity: null }];
      mockFetchSuccess(mockEndpoints);

      const result = await getEndpoints();
      expect(result).toEqual(mockEndpoints);
    });

    it('maps starting health to unknown', async () => {
      const { getEndpoints } = await import('./api');
      const mockEndpoints = [{ name: 'ep1', transport: 'stdio', health: 'starting', tool_count: 0, last_activity: null }];
      mockFetchSuccess(mockEndpoints);

      const result = await getEndpoints();
      expect(result[0].health).toBe('unknown');
    });

    it('maps lifecycle Failed state to error health with error message', async () => {
      const { getEndpoints } = await import('./api');
      const mockEndpoints = [{
        name: 'failed-ep',
        transport: 'stdio',
        health: 'healthy',
        tool_count: 0,
        last_activity: null,
        lifecycle: { state: 'Failed', error: { kind: 'Transport', detail: 'Connection refused' } },
      }];
      mockFetchSuccess(mockEndpoints);

      const result = await getEndpoints();
      expect(result[0].health).toBe('error');
      expect(result[0].error).toBe('Connection refused');
      expect(result[0].lifecycle).toEqual({ state: 'Failed', error: { kind: 'Transport', detail: 'Connection refused' } });
    });

    it('preserves lifecycle Ready state without modifying health', async () => {
      const { getEndpoints } = await import('./api');
      const mockEndpoints = [{
        name: 'ready-ep',
        transport: 'stdio',
        health: 'healthy',
        tool_count: 5,
        last_activity: null,
        lifecycle: { state: 'Ready', server_name: 'my-server' },
      }];
      mockFetchSuccess(mockEndpoints);

      const result = await getEndpoints();
      expect(result[0].health).toBe('healthy');
      expect(result[0].error).toBeUndefined();
      expect(result[0].lifecycle).toEqual({ state: 'Ready', server_name: 'my-server' });
    });

    it('handles lifecycle Initializing state', async () => {
      const { getEndpoints } = await import('./api');
      const mockEndpoints = [{
        name: 'init-ep',
        transport: 'stdio',
        health: 'starting',
        tool_count: 0,
        last_activity: null,
        lifecycle: { state: 'Initializing' },
      }];
      mockFetchSuccess(mockEndpoints);

      const result = await getEndpoints();
      expect(result[0].health).toBe('unknown');
      expect(result[0].lifecycle).toEqual({ state: 'Initializing' });
    });
  });

  describe('getEndpointTools', () => {
    it('fetches tools for endpoint', async () => {
      const { getEndpointTools } = await import('./api');
      const mockTools = [{ name: 'tool1', description: 'A tool' }];
      mockFetchSuccess(mockTools);

      const result = await getEndpointTools('my-ep');
      expect(result).toEqual(mockTools);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/endpoints/my-ep/tools'),
        expect.any(Object),
      );
    });
  });

  describe('addEndpoint', () => {
    it('calls invoke with correct command and params', async () => {
      const { addEndpoint } = await import('./api');
      const mockInvoke = vi.mocked(invoke);
      mockInvoke.mockResolvedValue(undefined);
      // Mock reloadConfig fetch (best-effort, may fail)
      mockFetch.mockRejectedValue(new Error('relay not running'));

      const params = { name: 'new-ep', transport: 'stdio' as const, command: '/usr/bin/my-mcp' };
      await addEndpoint(params);

      expect(mockInvoke).toHaveBeenCalledWith('add_endpoint', { args: params });
    });
  });

  describe('addEndpoint with env vars', () => {
    it('passes env vars through to invoke', async () => {
      const { addEndpoint } = await import('./api');
      const mockInvoke = vi.mocked(invoke);
      mockInvoke.mockResolvedValue(undefined);
      mockFetch.mockRejectedValue(new Error('relay not running'));

      const params = {
        name: 'github-server',
        transport: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: '$GITHUB_TOKEN', PLAIN_VAL: 'hello' },
      };
      await addEndpoint(params);

      expect(mockInvoke).toHaveBeenCalledWith('add_endpoint', { args: params });
      // Verify the env field is passed as-is (relay handles resolution)
      const passedArgs = mockInvoke.mock.calls[0][1] as { args: typeof params };
      expect(passedArgs.args.env).toEqual({ GITHUB_TOKEN: '$GITHUB_TOKEN', PLAIN_VAL: 'hello' });
    });
  });

  describe('removeEndpoint', () => {
    it('calls invoke with correct command and name', async () => {
      const { removeEndpoint } = await import('./api');
      const mockInvoke = vi.mocked(invoke);
      mockInvoke.mockResolvedValue(undefined);
      mockFetch.mockRejectedValue(new Error('relay not running'));

      await removeEndpoint('old-ep');

      expect(mockInvoke).toHaveBeenCalledWith('remove_endpoint', { name: 'old-ep' });
    });
  });

  describe('getCatalog', () => {
    it('fetches the unified tool catalog', async () => {
      const { getCatalog } = await import('./api');
      const mockCatalog = [
        { name: 'm__ep1__tool1', description: 'A tool', inputSchema: { type: 'object' }, endpoint: 'ep1', available: true },
        { name: 'm__ep2__tool2', description: 'Another', inputSchema: { type: 'object' }, endpoint: 'ep2', available: false },
      ];
      mockFetchSuccess(mockCatalog);

      const result = await getCatalog();
      expect(result).toEqual(mockCatalog);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/catalog'),
        expect.any(Object),
      );
    });
  });

  describe('testConnection', () => {
    it('sends POST with connection params and returns success', async () => {
      const { testConnection } = await import('./api');
      const mockResult = { success: true, tool_count: 3, tools: ['a', 'b', 'c'] };
      mockFetchSuccess(mockResult);

      const result = await testConnection({
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
      });
      expect(result).toEqual(mockResult);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/test-connection'),
        expect.objectContaining({
          method: 'POST',
          body: expect.any(String),
        }),
      );
    });

    it('returns error result on connection failure', async () => {
      const { testConnection } = await import('./api');
      const mockResult = { success: false, error: 'Connection failed: spawn error' };
      mockFetchSuccess(mockResult);

      const result = await testConnection({ transport: 'stdio', command: '/bad/cmd' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection failed');
    });

    it('throws on HTTP error', async () => {
      const { testConnection } = await import('./api');
      mockFetchError(500, 'Internal Server Error');

      await expect(testConnection({ transport: 'stdio', command: 'test' })).rejects.toThrow('HTTP 500');
    });

    it('parses tool names from successful response', async () => {
      const { testConnection } = await import('./api');
      const mockResult = {
        success: true,
        tool_count: 5,
        tools: ['read_file', 'write_file', 'list_dir', 'delete_file', 'move_file'],
      };
      mockFetchSuccess(mockResult);

      const result = await testConnection({
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
        env: { HOME: '/tmp' },
      });
      expect(result.success).toBe(true);
      expect(result.tool_count).toBe(5);
      expect(result.tools).toHaveLength(5);
      expect(result.tools).toContain('read_file');
      expect(result.tools).toContain('move_file');
      // Verify the request body included all params
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.transport).toBe('stdio');
      expect(callBody.command).toBe('npx');
      expect(callBody.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem']);
      expect(callBody.env).toEqual({ HOME: '/tmp' });
    });
  });

  describe('error handling', () => {
    it('retries on fetch failure and eventually throws', async () => {
      const { getStatus } = await import('./api');
      mockFetch.mockRejectedValue(new Error('Network error'));

      await expect(getStatus()).rejects.toThrow('Network error');
      // Should have retried: 1 initial + 2 retries = 3 calls
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('throws on HTTP error status after retries', async () => {
      const { getConfig } = await import('./api');
      mockFetchError(500, 'Internal Server Error');

      await expect(getConfig()).rejects.toThrow('HTTP 500: Internal Server Error');
    });
  });
});

