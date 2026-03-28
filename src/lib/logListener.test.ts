import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { get } from 'svelte/store';

describe('logListener', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  describe('initRelayLogListener', () => {
    it('sets up three event listeners', async () => {
      const mockListen = vi.mocked(listen);
      mockListen.mockResolvedValue(vi.fn());

      const { initRelayLogListener } = await import('./logListener');
      initRelayLogListener();

      // Should register listeners for relay-log, relay-health, relay-sidecar-status
      expect(mockListen).toHaveBeenCalledTimes(3);
      expect(mockListen).toHaveBeenCalledWith('relay-log', expect.any(Function));
      expect(mockListen).toHaveBeenCalledWith('relay-health', expect.any(Function));
      expect(mockListen).toHaveBeenCalledWith('relay-sidecar-status', expect.any(Function));
    });

    it('only initializes once', async () => {
      const mockListen = vi.mocked(listen);
      mockListen.mockResolvedValue(vi.fn());

      const { initRelayLogListener } = await import('./logListener');
      initRelayLogListener();
      initRelayLogListener(); // second call should be no-op

      expect(mockListen).toHaveBeenCalledTimes(3); // still 3, not 6
    });

    it('adds log entries to relayLogLines store on relay-log event', async () => {
      const mockListen = vi.mocked(listen);
      let relayLogCallback: ((event: { payload: { level: string; message: string } }) => void) | undefined;

      mockListen.mockImplementation(async (eventName: string, handler: any) => {
        if (eventName === 'relay-log') {
          relayLogCallback = handler;
        }
        return (() => {}) as () => void;
      });

      const { initRelayLogListener } = await import('./logListener');
      const { relayLogLines } = await import('./stores');
      initRelayLogListener();

      expect(relayLogCallback).toBeDefined();
      relayLogCallback!({ payload: { level: 'info', message: 'test message' } });

      const lines = get(relayLogLines);
      expect(lines).toHaveLength(1);
      expect(lines[0].message).toBe('test message');
      expect(lines[0].level).toBe('info');
    });

    it('updates relayLastError on relay-health error event', async () => {
      const mockListen = vi.mocked(listen);
      let healthCallback: ((event: { payload: { status: string; message: string | null } }) => void) | undefined;

      mockListen.mockImplementation(async (eventName: string, handler: any) => {
        if (eventName === 'relay-health') {
          healthCallback = handler;
        }
        return (() => {}) as () => void;
      });

      const { initRelayLogListener } = await import('./logListener');
      const { relayLastError } = await import('./stores');
      initRelayLogListener();

      healthCallback!({ payload: { status: 'error', message: 'connection failed' } });
      expect(get(relayLastError)).toBe('connection failed');

      healthCallback!({ payload: { status: 'connected', message: null } });
      expect(get(relayLastError)).toBeNull();
    });

    it('updates sidecar status on relay-sidecar-status event', async () => {
      const mockListen = vi.mocked(listen);
      let sidecarCallback: ((event: { payload: { status: string; error?: string | null } }) => void) | undefined;

      mockListen.mockImplementation(async (eventName: string, handler: any) => {
        if (eventName === 'relay-sidecar-status') {
          sidecarCallback = handler;
        }
        return (() => {}) as () => void;
      });

      const { initRelayLogListener } = await import('./logListener');
      const { relaySidecarStatus, relaySidecarError } = await import('./stores');
      initRelayLogListener();

      sidecarCallback!({ payload: { status: 'running' } });
      expect(get(relaySidecarStatus)).toBe('running');
      expect(get(relaySidecarError)).toBeNull();

      sidecarCallback!({ payload: { status: 'failed', error: 'crash' } });
      expect(get(relaySidecarStatus)).toBe('failed');
      expect(get(relaySidecarError)).toBe('crash');
    });
  });
});

