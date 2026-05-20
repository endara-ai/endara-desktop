import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { get } from 'svelte/store';

describe('logListener', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(invoke).mockResolvedValue({ status: 'unknown', error: null });
  });

  describe('initRelayLogListener', () => {
    it('sets up three event listeners', async () => {
      const mockListen = vi.mocked(listen);
      mockListen.mockResolvedValue(vi.fn());

      const { initRelayLogListener } = await import('./logListener');
      await initRelayLogListener();

      // Should register listeners for relay-log, relay-health, relay-sidecar-status
      expect(mockListen).toHaveBeenCalledTimes(3);
      expect(mockListen).toHaveBeenCalledWith('relay-log', expect.any(Function));
      expect(mockListen).toHaveBeenCalledWith('relay-health', expect.any(Function));
      expect(mockListen).toHaveBeenCalledWith('relay-sidecar-status', expect.any(Function));
      expect(invoke).toHaveBeenCalledWith('get_sidecar_status');
      expect(invoke).toHaveBeenCalledWith('get_buffered_relay_logs');
    });

    it('only initializes once', async () => {
      const mockListen = vi.mocked(listen);
      mockListen.mockResolvedValue(vi.fn());

      const { initRelayLogListener } = await import('./logListener');
      await initRelayLogListener();
      await initRelayLogListener(); // second call should be no-op

      expect(mockListen).toHaveBeenCalledTimes(3); // still 3, not 6
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(invoke).toHaveBeenCalledWith('get_buffered_relay_logs');
      expect(invoke).toHaveBeenCalledWith('get_sidecar_status');
    });

    it('syncs the current sidecar status after listeners are ready', async () => {
      const mockListen = vi.mocked(listen);
      const listenerResolvers: Array<(value: () => void) => void> = [];

      mockListen.mockImplementation(() => new Promise((resolve) => {
        listenerResolvers.push(resolve);
      }));
      vi.mocked(invoke).mockResolvedValue({ status: 'failed', error: 'startup crash' });

      const { initRelayLogListener } = await import('./logListener');
      const initPromise = initRelayLogListener();

      expect(invoke).not.toHaveBeenCalled();

      listenerResolvers.forEach((resolve) => resolve(() => {}));
      await initPromise;

      const { relaySidecarStatus, relaySidecarError } = await import('./stores');
      expect(invoke).toHaveBeenCalledWith('get_sidecar_status');
      expect(get(relaySidecarStatus)).toBe('failed');
      expect(get(relaySidecarError)).toBe('startup crash');
    });

    it('parses relay-log events into ParsedLogLine entries on the store', async () => {
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
      await initRelayLogListener();

      expect(relayLogCallback).toBeDefined();
      relayLogCallback!({
        payload: {
          level: 'info',
          message:
            '2026-05-20T10:32:05.123Z endpoint{endpoint=github transport=stdio}: Initialize handshake complete',
        },
      });

      const lines = get(relayLogLines);
      expect(lines).toHaveLength(1);
      expect(lines[0].level).toBe('info');
      expect(lines[0].endpoint).toBe('github');
      expect(lines[0].transport).toBe('stdio');
      expect(lines[0].message).toBe('Initialize handshake complete');
      expect(lines[0].raw).toContain('endpoint{endpoint=github');
      expect(lines[0].timestamp.toISOString()).toBe('2026-05-20T10:32:05.123Z');
    });

    it('replays buffered relay logs through parseLogLine on init', async () => {
      const mockListen = vi.mocked(listen);
      mockListen.mockResolvedValue(vi.fn());
      vi.mocked(invoke).mockImplementation((cmd: string) => {
        if (cmd === 'get_buffered_relay_logs') {
          return Promise.resolve([
            { level: 'warn', message: 'endpoint{endpoint=slack}: Connection lost, reconnecting...' },
          ]);
        }
        return Promise.resolve({ status: 'unknown', error: null });
      });

      const { initRelayLogListener } = await import('./logListener');
      const { relayLogLines } = await import('./stores');
      await initRelayLogListener();

      const lines = get(relayLogLines);
      expect(lines).toHaveLength(1);
      expect(lines[0].level).toBe('warn');
      expect(lines[0].endpoint).toBe('slack');
      expect(lines[0].message).toBe('Connection lost, reconnecting...');
    });

    it('registers relay-health listener without error', async () => {
      const mockListen = vi.mocked(listen);
      let healthCallback: ((event: { payload: { status: string; message: string | null } }) => void) | undefined;

      mockListen.mockImplementation(async (eventName: string, handler: any) => {
        if (eventName === 'relay-health') {
          healthCallback = handler;
        }
        return (() => {}) as () => void;
      });

      const { initRelayLogListener } = await import('./logListener');
      await initRelayLogListener();

      // relay-health listener is registered but no longer updates relayLastError
      expect(healthCallback).toBeDefined();
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
      await initRelayLogListener();

      sidecarCallback!({ payload: { status: 'running' } });
      expect(get(relaySidecarStatus)).toBe('running');
      expect(get(relaySidecarError)).toBeNull();

      sidecarCallback!({ payload: { status: 'failed', error: 'crash' } });
      expect(get(relaySidecarStatus)).toBe('failed');
      expect(get(relaySidecarError)).toBe('crash');
    });

    it('forwards the restarting status and preserves the supervisor reason', async () => {
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
      await initRelayLogListener();

      sidecarCallback!({ payload: { status: 'restarting', error: 'terminated by signal SIGTERM' } });
      expect(get(relaySidecarStatus)).toBe('restarting');
      expect(get(relaySidecarError)).toBe('terminated by signal SIGTERM');

      sidecarCallback!({ payload: { status: 'running' } });
      expect(get(relaySidecarStatus)).toBe('running');
      expect(get(relaySidecarError)).toBeNull();
    });
  });
});

