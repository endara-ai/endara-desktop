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

