import { describe, it, expect } from 'vitest';
import { parseLogLine, extractTimestamp } from '$lib/logParser';

describe('parseLogLine', () => {
  it('extracts endpoint name from endpoint{endpoint=github} span', () => {
    const parsed = parseLogLine('info', 'endpoint{endpoint=github}: Initialize handshake complete');
    expect(parsed.endpoint).toBe('github');
    expect(parsed.message).toBe('Initialize handshake complete');
    expect(parsed.level).toBe('info');
  });

  it('extracts multiple span fields (endpoint, transport, server_type)', () => {
    const parsed = parseLogLine(
      'info',
      'endpoint{endpoint=github transport=stdio server_type=github}: Initialize handshake complete'
    );
    expect(parsed.endpoint).toBe('github');
    expect(parsed.transport).toBe('stdio');
    expect(parsed.serverType).toBe('github');
    expect(parsed.message).toBe('Initialize handshake complete');
  });

  it('extracts inline fields (tool, status, duration_ms) and request span', () => {
    const parsed = parseLogLine(
      'info',
      'request{method=tools/call id=42} endpoint{endpoint=github}: Tool call completed tool=get_file_contents status=ok duration_ms=312'
    );
    expect(parsed.endpoint).toBe('github');
    expect(parsed.method).toBe('tools/call');
    expect(parsed.requestId).toBe('42');
    expect(parsed.tool).toBe('get_file_contents');
    expect(parsed.status).toBe('ok');
    expect(parsed.durationMs).toBe(312);
    expect(parsed.message).toBe('Tool call completed');
  });

  it('handles lines with no span context (relay-level events)', () => {
    const parsed = parseLogLine('info', 'Relay listening on 127.0.0.1:47107');
    expect(parsed.endpoint).toBeUndefined();
    expect(parsed.transport).toBeUndefined();
    expect(parsed.method).toBeUndefined();
    expect(parsed.message).toBe('Relay listening on 127.0.0.1:47107');
    expect(parsed.raw).toBe('Relay listening on 127.0.0.1:47107');
  });

  it('extracts ISO timestamp from message prefix', () => {
    const parsed = parseLogLine(
      'info',
      '2026-05-20T10:32:05.123Z endpoint{endpoint=github}: Initialize handshake complete'
    );
    expect(parsed.timestamp.toISOString()).toBe('2026-05-20T10:32:05.123Z');
    expect(parsed.endpoint).toBe('github');
    expect(parsed.message).toBe('Initialize handshake complete');
  });

  it('falls back to client-side timestamp when no timestamp in message', () => {
    const before = Date.now();
    const parsed = parseLogLine('info', 'endpoint{endpoint=github}: Initialize handshake complete');
    const after = Date.now();
    const t = parsed.timestamp.getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });

  it('normalizes unknown levels to info and lowercases known ones', () => {
    expect(parseLogLine('ERROR', 'boom').level).toBe('error');
    expect(parseLogLine('Warn', 'careful').level).toBe('warn');
    expect(parseLogLine('TRACE', 'noisy').level).toBe('trace');
    expect(parseLogLine('whatever', 'fallback').level).toBe('info');
  });

  describe('isToolCall detection', () => {
    it('flags completed tool calls when tool field is present', () => {
      const parsed = parseLogLine(
        'info',
        'endpoint{endpoint=github}: Tool call completed tool=get_file_contents status=ok duration_ms=312'
      );
      expect(parsed.isToolCall).toBe(true);
      expect(parsed.tool).toBe('get_file_contents');
    });

    it('flags failed tool calls when tool field is present', () => {
      const parsed = parseLogLine(
        'warn',
        'endpoint{endpoint=slack}: Tool call failed tool=send_message status=error duration_ms=1204'
      );
      expect(parsed.isToolCall).toBe(true);
      expect(parsed.tool).toBe('send_message');
      expect(parsed.status).toBe('error');
      expect(parsed.durationMs).toBe(1204);
    });

    it('flags rows that carry status + duration_ms even without "Tool call" phrasing', () => {
      const parsed = parseLogLine(
        'info',
        'endpoint{endpoint=github}: handled status=ok duration_ms=42'
      );
      expect(parsed.isToolCall).toBe(true);
      expect(parsed.status).toBe('ok');
      expect(parsed.durationMs).toBe(42);
    });

    it('does not flag plain informational lines as tool calls', () => {
      const parsed = parseLogLine('info', 'endpoint{endpoint=github}: Initialize handshake complete');
      expect(parsed.isToolCall).toBe(false);
    });
  });
});

describe('parseLogLine — endpointOverride (Slice D.2)', () => {
  it('uses the override when provided, ignoring the parsed span value', () => {
    const parsed = parseLogLine(
      'info',
      'endpoint{endpoint=github transport=stdio}: hello',
      { endpointOverride: 'gmail' },
    );
    expect(parsed.endpoint).toBe('gmail');
    // span-level fields beyond endpoint still come from the regex
    expect(parsed.transport).toBe('stdio');
  });

  it('falls back to the parsed value when override is null', () => {
    const parsed = parseLogLine(
      'info',
      'endpoint{endpoint=github}: hello',
      { endpointOverride: null },
    );
    expect(parsed.endpoint).toBe('github');
  });

  it('falls back to the parsed value when override is undefined', () => {
    const parsed = parseLogLine(
      'info',
      'endpoint{endpoint=github}: hello',
      { endpointOverride: undefined },
    );
    expect(parsed.endpoint).toBe('github');
  });

  it('supplies the endpoint when the message has no span context', () => {
    const parsed = parseLogLine('info', 'plain message', { endpointOverride: 'slack' });
    expect(parsed.endpoint).toBe('slack');
  });
});

describe('extractTimestamp', () => {
  it('parses an ISO timestamp prefix and returns the rest of the message', () => {
    const { timestamp, rest } = extractTimestamp(
      '2026-05-20T10:32:05.123Z endpoint{endpoint=github}: hello'
    );
    expect(timestamp.toISOString()).toBe('2026-05-20T10:32:05.123Z');
    expect(rest).toBe('endpoint{endpoint=github}: hello');
  });

  it('falls back to the current time when no timestamp prefix is present', () => {
    const before = Date.now();
    const { timestamp, rest } = extractTimestamp('endpoint{endpoint=github}: hello');
    const after = Date.now();
    expect(timestamp.getTime()).toBeGreaterThanOrEqual(before);
    expect(timestamp.getTime()).toBeLessThanOrEqual(after);
    expect(rest).toBe('endpoint{endpoint=github}: hello');
  });
});

describe('parseLogLine — in-text level extraction (hotfix)', () => {
  it('extracts DEBUG level from the line and strips it from the message', () => {
    const parsed = parseLogLine(
      'info',
      '2026-05-20T17:54:47.123Z DEBUG endara_relay::registry: Registering adapter',
    );
    expect(parsed.level).toBe('debug');
    // The "DEBUG" token is stripped; the module path that follows is left
    // intact (parsing module paths is out of scope for this hotfix).
    expect(parsed.message.startsWith('DEBUG')).toBe(false);
    expect(parsed.message).toBe('endara_relay::registry: Registering adapter');
  });

  it('extracts INFO level even when the sidecar passed a different default', () => {
    const parsed = parseLogLine(
      'info',
      '2026-05-20T17:54:47.123Z INFO endpoint{endpoint=github transport=stdio}: Initialize handshake complete',
    );
    expect(parsed.level).toBe('info');
    expect(parsed.message.startsWith('INFO')).toBe(false);
    expect(parsed.endpoint).toBe('github');
    expect(parsed.message).toBe('Initialize handshake complete');
  });

  it('extracts WARN level and strips it from the message', () => {
    const parsed = parseLogLine(
      'info',
      '2026-05-20T17:54:47.123Z WARN endpoint{endpoint=slack}: Connection lost, reconnecting',
    );
    expect(parsed.level).toBe('warn');
    expect(parsed.message.startsWith('WARN')).toBe(false);
    expect(parsed.message).toBe('Connection lost, reconnecting');
  });

  it('extracts ERROR level and strips it from the message', () => {
    const parsed = parseLogLine(
      'info',
      '2026-05-20T17:54:47.123Z ERROR endpoint{endpoint=postgres}: MCP server exited',
    );
    expect(parsed.level).toBe('error');
    expect(parsed.message.startsWith('ERROR')).toBe(false);
    expect(parsed.message).toBe('MCP server exited');
  });

  it('extracts TRACE level and strips it from the message', () => {
    const parsed = parseLogLine(
      'info',
      '2026-05-20T17:54:47.123Z TRACE endara_relay::core: very noisy',
    );
    expect(parsed.level).toBe('trace');
    expect(parsed.message.startsWith('TRACE')).toBe(false);
  });

  it('preserves the passed-in level when no level token is present in the message', () => {
    const parsed = parseLogLine('warn', 'raw text from an adapter');
    expect(parsed.level).toBe('warn');
    expect(parsed.message).toBe('raw text from an adapter');
  });

  it('does not strip lower-case level words from the message body', () => {
    // The regex is case-sensitive and anchored — only the upper-case token
    // immediately after the timestamp counts. An English "error" later in
    // the line must stay in the message text.
    const parsed = parseLogLine('info', '2026-05-20T17:54:47.123Z some error occurred');
    // No upper-case level token → fall back to the passed-in arg.
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('some error occurred');
  });
});
