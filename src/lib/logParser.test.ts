import { describe, it, expect } from 'vitest';
import { parseLogLine, extractTimestamp } from '$lib/logParser';

// The relay sidecar is launched with `--log-format text` (Full formatter),
// which emits span field values WITH surrounding double-quotes — e.g.
// `endpoint{endpoint="github" transport="stdio"}`. Fixtures below match that
// real wire shape so a regression in the unquoting path would fail loudly.
describe('parseLogLine', () => {
  it('extracts endpoint name from endpoint{endpoint="github"} span', () => {
    const parsed = parseLogLine('info', 'endpoint{endpoint="github"}: Initialize handshake complete');
    expect(parsed.endpoint).toBe('github');
    expect(parsed.message).toBe('Initialize handshake complete');
    expect(parsed.level).toBe('info');
  });

  it('extracts a quoted span value containing whitespace without stray quotes', () => {
    // Regression: the previous alternation tried the unquoted branch first
    // and would capture `"Clement` (stopping at the inner space), leaking a
    // leading quote into the endpoint dropdown.
    const parsed = parseLogLine(
      'info',
      'endpoint{endpoint="Clement Whatsapp" transport="stdio"}: Initialize handshake complete',
    );
    expect(parsed.endpoint).toBe('Clement Whatsapp');
    expect(parsed.transport).toBe('stdio');
  });

  it('extracts a quoted endpoint name with a space from a full relay log line', () => {
    // Mirrors the Rust-side fixture in src-tauri/src/lib.rs
    // (`parse_endpoint_from_span_tests::endpoint_present_in_span_returns_some`)
    // so the JS parser stays in lockstep with the authoritative parser on the
    // real Full-format wire shape — timestamp + level + quoted span fields.
    const parsed = parseLogLine(
      'info',
      '2026-05-20T10:00:00.000Z  INFO endpoint{endpoint="Clement Whatsapp" transport="stdio"}: Initialize handshake complete',
    );
    expect(parsed.endpoint).toBe('Clement Whatsapp');
    expect(parsed.transport).toBe('stdio');
    expect(parsed.timestamp.toISOString()).toBe('2026-05-20T10:00:00.000Z');
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('Initialize handshake complete');
  });

  it('extracts multiple span fields (endpoint, transport, server_type)', () => {
    const parsed = parseLogLine(
      'info',
      'endpoint{endpoint="github" transport="stdio" server_type="github"}: Initialize handshake complete'
    );
    expect(parsed.endpoint).toBe('github');
    expect(parsed.transport).toBe('stdio');
    expect(parsed.serverType).toBe('github');
    expect(parsed.message).toBe('Initialize handshake complete');
  });

  it('extracts inline fields (tool, status, duration_ms) and request span', () => {
    const parsed = parseLogLine(
      'info',
      'request{method="tools/call" id=42} endpoint{endpoint="github"}: Tool call completed tool=get_file_contents status=ok duration_ms=312'
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
      '2026-05-20T10:32:05.123Z endpoint{endpoint="github"}: Initialize handshake complete'
    );
    expect(parsed.timestamp.toISOString()).toBe('2026-05-20T10:32:05.123Z');
    expect(parsed.endpoint).toBe('github');
    expect(parsed.message).toBe('Initialize handshake complete');
  });

  it('falls back to client-side timestamp when no timestamp in message', () => {
    const before = Date.now();
    const parsed = parseLogLine('info', 'endpoint{endpoint="github"}: Initialize handshake complete');
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
        'endpoint{endpoint="github"}: Tool call completed tool=get_file_contents status=ok duration_ms=312'
      );
      expect(parsed.isToolCall).toBe(true);
      expect(parsed.tool).toBe('get_file_contents');
    });

    it('flags failed tool calls when tool field is present', () => {
      const parsed = parseLogLine(
        'warn',
        'endpoint{endpoint="slack"}: Tool call failed tool=send_message status=error duration_ms=1204'
      );
      expect(parsed.isToolCall).toBe(true);
      expect(parsed.tool).toBe('send_message');
      expect(parsed.status).toBe('error');
      expect(parsed.durationMs).toBe(1204);
    });

    it('flags rows that carry status + duration_ms even without "Tool call" phrasing', () => {
      const parsed = parseLogLine(
        'info',
        'endpoint{endpoint="github"}: handled status=ok duration_ms=42'
      );
      expect(parsed.isToolCall).toBe(true);
      expect(parsed.status).toBe('ok');
      expect(parsed.durationMs).toBe(42);
    });

    it('does not flag plain informational lines as tool calls', () => {
      const parsed = parseLogLine('info', 'endpoint{endpoint="github"}: Initialize handshake complete');
      expect(parsed.isToolCall).toBe(false);
    });
  });
});

describe('parseLogLine — profile field (matrix row #7)', () => {
  it('extracts profile from the mcp_request span', () => {
    // Engineering Spec §7.1: the relay emits
    // tracing::info_span!("mcp_request", profile = %profile_path).
    const parsed = parseLogLine(
      'info',
      '2026-05-25T10:30:15Z INFO mcp_request{profile="work"} endpoint{endpoint="gmail"}: Tool call completed tool=send_email status=ok duration_ms=234',
    );
    expect(parsed.profile).toBe('work');
    expect(parsed.endpoint).toBe('gmail');
    expect(parsed.tool).toBe('send_email');
    expect(parsed.durationMs).toBe(234);
  });

  it('extracts profile from an unquoted span value', () => {
    // The Compact tracing formatter omits the quotes around span values.
    // The parser must handle both shapes per the recon §5 note.
    const parsed = parseLogLine(
      'info',
      '2026-05-25T10:30:15 INFO mcp_request{profile=work endpoint=gmail tool=send_email} completed duration_ms=234',
    );
    expect(parsed.profile).toBe('work');
  });

  it('falls back to any span carrying a profile field when mcp_request is absent', () => {
    // Robustness to R3.E's exact span name: if the field shows up on a
    // different span (e.g. `request{profile=work id=42}`), we still surface it.
    const parsed = parseLogLine(
      'info',
      'request{method="tools/call" id=42 profile="personal"} endpoint{endpoint="slack"}: hello',
    );
    expect(parsed.profile).toBe('personal');
  });

  it('leaves profile undefined when no span carries the field', () => {
    const parsed = parseLogLine(
      'info',
      'endpoint{endpoint="github" transport="stdio"}: Initialize handshake complete',
    );
    expect(parsed.profile).toBeUndefined();
  });

  it('leaves profile undefined for lines with no span context', () => {
    const parsed = parseLogLine('info', 'Relay listening on 127.0.0.1:47107');
    expect(parsed.profile).toBeUndefined();
  });
});

describe('parseLogLine — client identity fields', () => {
  it('extracts quoted client_name and client_version from a tool-call line', () => {
    const parsed = parseLogLine(
      'info',
      'endpoint{endpoint="github"}: Tool call completed tool=get_file_contents status=ok duration_ms=312 client_name="Claude Desktop" client_version="0.7.0"',
    );
    expect(parsed.clientName).toBe('Claude Desktop');
    expect(parsed.clientVersion).toBe('0.7.0');
    expect(parsed.tool).toBe('get_file_contents');
    expect(parsed.message).toBe('Tool call completed');
  });

  it('extracts an unquoted single-token client_name', () => {
    const parsed = parseLogLine(
      'info',
      'endpoint{endpoint="github"}: MCP request client_name=claude-ai client_version=0.1.0',
    );
    expect(parsed.clientName).toBe('claude-ai');
    expect(parsed.clientVersion).toBe('0.1.0');
  });

  it('leaves clientVersion undefined when only client_name is present', () => {
    const parsed = parseLogLine(
      'info',
      'endpoint{endpoint="github"}: MCP request client_name="Cursor"',
    );
    expect(parsed.clientName).toBe('Cursor');
    expect(parsed.clientVersion).toBeUndefined();
  });

  it('leaves both undefined when neither field is present', () => {
    const parsed = parseLogLine(
      'info',
      'endpoint{endpoint="github"}: Initialize handshake complete',
    );
    expect(parsed.clientName).toBeUndefined();
    expect(parsed.clientVersion).toBeUndefined();
  });

  it('silently drops empty client_name= without leaking it into the message', () => {
    const parsed = parseLogLine(
      'info',
      'endpoint{endpoint="github"}: MCP request client_name= client_version=',
    );
    expect(parsed.clientName).toBeUndefined();
    expect(parsed.clientVersion).toBeUndefined();
    expect(parsed.message).toBe('MCP request');
  });
});

describe('parseLogLine — endpointOverride (Slice D.2)', () => {
  it('uses the override when provided, ignoring the parsed span value', () => {
    const parsed = parseLogLine(
      'info',
      'endpoint{endpoint="github" transport="stdio"}: hello',
      { endpointOverride: 'gmail' },
    );
    expect(parsed.endpoint).toBe('gmail');
    // span-level fields beyond endpoint still come from the regex
    expect(parsed.transport).toBe('stdio');
  });

  it('falls back to the parsed value when override is null', () => {
    const parsed = parseLogLine(
      'info',
      'endpoint{endpoint="github"}: hello',
      { endpointOverride: null },
    );
    expect(parsed.endpoint).toBe('github');
  });

  it('falls back to the parsed value when override is undefined', () => {
    const parsed = parseLogLine(
      'info',
      'endpoint{endpoint="github"}: hello',
      { endpointOverride: undefined },
    );
    expect(parsed.endpoint).toBe('github');
  });

  it('supplies the endpoint when the message has no span context', () => {
    const parsed = parseLogLine('info', 'plain message', { endpointOverride: 'slack' });
    expect(parsed.endpoint).toBe('slack');
  });
});

describe('parseLogLine — JSON-first structured lines (Wave C)', () => {
  // The relay sidecar now runs with `--log-format json`, so the live pipeline
  // hands the frontend one tracing-subscriber JSON object per line. These
  // fixtures mirror the exact shape locked in the spec's cross-stack contract.
  it('parses a tool-call JSON line with endpoint span + flat fields', () => {
    const line = JSON.stringify({
      timestamp: '2026-05-22T15:10:43.123456Z',
      level: 'INFO',
      fields: {
        message: 'Tool call completed',
        tool: 'get_file_contents',
        status: 'ok',
        duration_ms: 312,
        client_name: 'Claude Desktop',
        client_version: '1.4.2',
      },
      target: 'endara_relay::adapter::http',
      spans: [
        { name: 'endpoint', endpoint: 'github', transport: 'stdio', server_type: 'http' },
        { name: 'mcp_request', profile: 'default' },
        { name: 'request', method: 'tools/call', id: '7' },
      ],
    });
    const parsed = parseLogLine('info', line);
    expect(parsed.level).toBe('info');
    expect(parsed.endpoint).toBe('github');
    expect(parsed.transport).toBe('stdio');
    expect(parsed.serverType).toBe('http');
    expect(parsed.method).toBe('tools/call');
    expect(parsed.requestId).toBe('7');
    expect(parsed.profile).toBe('default');
    expect(parsed.tool).toBe('get_file_contents');
    expect(parsed.status).toBe('ok');
    expect(parsed.durationMs).toBe(312);
    expect(parsed.clientName).toBe('Claude Desktop');
    expect(parsed.clientVersion).toBe('1.4.2');
    // Clean message — no `}: ` artifact, no leaked client=/content-/user- tokens.
    expect(parsed.message).toBe('Tool call completed');
    expect(parsed.message).not.toContain('}: ');
    expect(parsed.message).not.toContain('client=');
    expect(parsed.isToolCall).toBe(true);
  });

  it('does not leak a nested client={…} blob into the message (regression)', () => {
    // The text formatter let the `request` span carry a balanced-brace
    // `client={"name":...}` value that produced a `}: ` artifact and stray
    // quotes. In JSON the desktop reads only the flat client_name/version.
    const line = JSON.stringify({
      timestamp: '2026-05-22T15:10:43.123456Z',
      level: 'INFO',
      fields: {
        message: 'Tool call completed',
        tool: 'send_email',
        status: 'ok',
        duration_ms: 234,
        client_name: 'Claude Desktop',
        client_version: '0.7.0',
      },
      spans: [
        { name: 'endpoint', endpoint: 'gmail' },
        {
          name: 'request',
          method: 'tools/call',
          id: '9',
          client: '{"name":"Claude Desktop","version":"0.7.0"}',
        },
      ],
    });
    const parsed = parseLogLine('info', line);
    expect(parsed.message).toBe('Tool call completed');
    expect(parsed.message).not.toContain('}: ');
    expect(parsed.message).not.toContain('{');
    expect(parsed.message).not.toContain('"');
    expect(parsed.clientName).toBe('Claude Desktop');
    expect(parsed.clientVersion).toBe('0.7.0');
  });

  it('parses a relay-level JSON line with no endpoint span (endpoint undefined)', () => {
    const line = JSON.stringify({
      timestamp: '2026-05-22T15:10:43.123456Z',
      level: 'INFO',
      fields: { message: 'Relay listening on 127.0.0.1:47107' },
      target: 'endara_relay',
      spans: [],
    });
    const parsed = parseLogLine('info', line);
    expect(parsed.endpoint).toBeUndefined();
    expect(parsed.transport).toBeUndefined();
    expect(parsed.method).toBeUndefined();
    expect(parsed.profile).toBeUndefined();
    expect(parsed.message).toBe('Relay listening on 127.0.0.1:47107');
    expect(parsed.isToolCall).toBe(false);
  });

  it('coerces a numeric duration_ms and drops a non-numeric one', () => {
    const numeric = parseLogLine(
      'info',
      JSON.stringify({ level: 'INFO', fields: { message: 'x', status: 'ok', duration_ms: 42 } }),
    );
    expect(numeric.durationMs).toBe(42);
    expect(numeric.isToolCall).toBe(true);
    const garbage = parseLogLine(
      'info',
      JSON.stringify({ level: 'INFO', fields: { message: 'x', duration_ms: 'nope' } }),
    );
    expect(garbage.durationMs).toBeUndefined();
  });

  it('lowercases the JSON level token', () => {
    const parsed = parseLogLine(
      'info',
      JSON.stringify({ level: 'ERROR', fields: { message: 'boom' } }),
    );
    expect(parsed.level).toBe('error');
  });

  it('lets endpointOverride win over the JSON endpoint span', () => {
    const line = JSON.stringify({
      level: 'INFO',
      fields: { message: 'hello' },
      spans: [{ name: 'endpoint', endpoint: 'github', transport: 'stdio' }],
    });
    const parsed = parseLogLine('info', line, { endpointOverride: 'gmail' });
    expect(parsed.endpoint).toBe('gmail');
    // Other span fields still come from the JSON.
    expect(parsed.transport).toBe('stdio');
  });

  it('keeps the raw JSON string on the parsed line', () => {
    const line = JSON.stringify({ level: 'INFO', fields: { message: 'hi' } });
    const parsed = parseLogLine('info', line);
    expect(parsed.raw).toBe(line);
  });

  it('falls back to the text parser for the activity-log seed shape', () => {
    // The per-endpoint `/logs` seed returns the adapters' custom text
    // activity-log lines (NOT tracing JSON); the text fallback must keep
    // parsing them exactly as before.
    const parsed = parseLogLine(
      'info',
      '2026-05-22T15:10:43.123Z INFO call_tool tool=get_file_contents status=ok duration=312ms',
    );
    expect(parsed.tool).toBe('get_file_contents');
    expect(parsed.status).toBe('ok');
    expect(parsed.message).toContain('call_tool');
    expect(parsed.level).toBe('info');
  });
});

describe('parseLogLine — JSON relay-event fields (Wave D2)', () => {
  // The relay emits `client_name`/`client_version` via Rust Debug (`?`), so in
  // the JSON output their values arrive wrapped in a literal surrounding
  // quote-pair. The parser strips exactly one pair so the caller is unquoted.
  it('strips the Debug quote-pair from client_name / client_version', () => {
    const parsed = parseLogLine(
      'info',
      JSON.stringify({
        level: 'INFO',
        fields: {
          message: 'MCP request',
          method: 'tools/call',
          status: 200,
          elapsed_ms: 42,
          client_name: '"LiveTest JSON Logs"',
          client_version: '"2.0.0"',
        },
        spans: [{ name: 'request', method: 'tools/call', id: '3' }],
      }),
    );
    expect(parsed.clientName).toBe('LiveTest JSON Logs');
    expect(parsed.clientVersion).toBe('2.0.0');
  });

  it('treats an empty Debug string ("") as missing', () => {
    const parsed = parseLogLine(
      'info',
      JSON.stringify({
        level: 'INFO',
        fields: { message: 'MCP request', client_name: '""', client_version: '""' },
      }),
    );
    expect(parsed.clientName).toBeUndefined();
    expect(parsed.clientVersion).toBeUndefined();
  });

  it('leaves an already-unquoted client_name unchanged', () => {
    const parsed = parseLogLine(
      'info',
      JSON.stringify({ level: 'INFO', fields: { message: 'MCP request', client_name: 'Cursor' } }),
    );
    expect(parsed.clientName).toBe('Cursor');
  });

  it('captures elapsedMs / reqBytes / respBytes / status without setting durationMs', () => {
    const parsed = parseLogLine(
      'info',
      JSON.stringify({
        level: 'INFO',
        fields: {
          message: 'MCP request',
          method: 'tools/call',
          status: 200,
          elapsed_ms: 87,
          req_bytes: 120,
          resp_bytes: 4096,
        },
        spans: [{ name: 'request', method: 'tools/call', id: '5' }],
      }),
    );
    expect(parsed.elapsedMs).toBe(87);
    expect(parsed.reqBytes).toBe(120);
    expect(parsed.respBytes).toBe(4096);
    expect(parsed.status).toBe('200');
    expect(parsed.method).toBe('tools/call');
    // CRITICAL: elapsed_ms must NOT leak into durationMs, otherwise the row
    // gets misclassified as a tool-call row by isToolCall.
    expect(parsed.durationMs).toBeUndefined();
    expect(parsed.isToolCall).toBe(false);
  });

  it('falls back to fields.method when no request span is present', () => {
    const parsed = parseLogLine(
      'info',
      JSON.stringify({
        level: 'INFO',
        fields: { message: 'MCP request', method: 'initialize', status: 200, elapsed_ms: 3 },
      }),
    );
    expect(parsed.method).toBe('initialize');
  });

  it('maps the Routing tool call prefixed/tool/endpoint flat fields', () => {
    const parsed = parseLogLine(
      'info',
      JSON.stringify({
        level: 'INFO',
        fields: {
          message: 'Routing tool call',
          tool: 'getAccessibleAtlassianResources',
          endpoint: 'Atlassian',
          prefixed: 'atlassian__getAccessibleAtlassianResources',
        },
      }),
    );
    expect(parsed.prefixed).toBe('atlassian__getAccessibleAtlassianResources');
    expect(parsed.tool).toBe('getAccessibleAtlassianResources');
    expect(parsed.endpoint).toBe('Atlassian');
    expect(parsed.isToolCall).toBe(false);
  });

  it('leaves the new fields undefined on lines that do not carry them', () => {
    const parsed = parseLogLine(
      'info',
      JSON.stringify({ level: 'INFO', fields: { message: 'Relay listening' } }),
    );
    expect(parsed.elapsedMs).toBeUndefined();
    expect(parsed.reqBytes).toBeUndefined();
    expect(parsed.respBytes).toBeUndefined();
    expect(parsed.prefixed).toBeUndefined();
  });
});

describe('extractTimestamp', () => {
  it('parses an ISO timestamp prefix and returns the rest of the message', () => {
    const { timestamp, rest } = extractTimestamp(
      '2026-05-20T10:32:05.123Z endpoint{endpoint="github"}: hello'
    );
    expect(timestamp.toISOString()).toBe('2026-05-20T10:32:05.123Z');
    expect(rest).toBe('endpoint{endpoint="github"}: hello');
  });

  it('falls back to the current time when no timestamp prefix is present', () => {
    const before = Date.now();
    const { timestamp, rest } = extractTimestamp('endpoint{endpoint="github"}: hello');
    const after = Date.now();
    expect(timestamp.getTime()).toBeGreaterThanOrEqual(before);
    expect(timestamp.getTime()).toBeLessThanOrEqual(after);
    expect(rest).toBe('endpoint{endpoint="github"}: hello');
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
      '2026-05-20T17:54:47.123Z INFO endpoint{endpoint="github" transport="stdio"}: Initialize handshake complete',
    );
    expect(parsed.level).toBe('info');
    expect(parsed.message.startsWith('INFO')).toBe(false);
    expect(parsed.endpoint).toBe('github');
    expect(parsed.message).toBe('Initialize handshake complete');
  });

  it('extracts WARN level and strips it from the message', () => {
    const parsed = parseLogLine(
      'info',
      '2026-05-20T17:54:47.123Z WARN endpoint{endpoint="slack"}: Connection lost, reconnecting',
    );
    expect(parsed.level).toBe('warn');
    expect(parsed.message.startsWith('WARN')).toBe(false);
    expect(parsed.message).toBe('Connection lost, reconnecting');
  });

  it('extracts ERROR level and strips it from the message', () => {
    const parsed = parseLogLine(
      'info',
      '2026-05-20T17:54:47.123Z ERROR endpoint{endpoint="postgres"}: MCP server exited',
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

describe('parseLogLine — trailing event fields (defense-in-depth)', () => {
  // Pairs with the watcher span migration: any `info!(endpoint = %name, …)`
  // emitted outside an `endpoint{…}` span must still surface correctly and
  // must not leak quoted multi-word values into the message body.
  it('keeps quoted multi-word trailing event field intact and out of the message', () => {
    const parsed = parseLogLine(
      'info',
      'Relay handling request endpoint="Collins Whatsapp"',
    );
    expect(parsed.endpoint).toBe('Collins Whatsapp');
    expect(parsed.message).toBe('Relay handling request');
    expect(parsed.message).not.toContain('Words');
    expect(parsed.message).not.toContain('endpoint=');
  });

  it('surfaces an unquoted single-word trailing event field as the endpoint', () => {
    const parsed = parseLogLine('info', 'Relay handling request endpoint=Drive');
    expect(parsed.endpoint).toBe('Drive');
    expect(parsed.message).toBe('Relay handling request');
  });

  it('silently drops an empty trailing event field (endpoint=) without leaking it', () => {
    const parsed = parseLogLine('info', 'Relay handling request endpoint=');
    expect(parsed.endpoint).toBeUndefined();
    expect(parsed.message).toBe('Relay handling request');
    expect(parsed.message).not.toContain('endpoint=');
  });

  it('does not let an empty trailing endpoint= override a real span endpoint', () => {
    const parsed = parseLogLine(
      'info',
      'endpoint{endpoint="github"}: handled endpoint=',
    );
    expect(parsed.endpoint).toBe('github');
    expect(parsed.message).toBe('handled');
  });

  it('does not let an empty trailing endpoint= override an endpointOverride', () => {
    const parsed = parseLogLine(
      'info',
      'handled endpoint=',
      { endpointOverride: 'gmail' },
    );
    expect(parsed.endpoint).toBe('gmail');
    expect(parsed.message).toBe('handled');
  });

  it('parses multiple trailing event fields mixed with the message', () => {
    const parsed = parseLogLine(
      'info',
      'Relay handling request endpoint="Collins Whatsapp" transport=stdio',
    );
    expect(parsed.endpoint).toBe('Collins Whatsapp');
    expect(parsed.transport).toBe('stdio');
    expect(parsed.message).toBe('Relay handling request');
  });

  it('surfaces event-level transport and server_type when no endpoint span is present', () => {
    const parsed = parseLogLine(
      'info',
      'Relay handling request endpoint=gmail transport=stdio server_type=github',
    );
    expect(parsed.endpoint).toBe('gmail');
    expect(parsed.transport).toBe('stdio');
    expect(parsed.serverType).toBe('github');
    expect(parsed.message).toBe('Relay handling request');
  });

  it('prefers the endpoint span over a trailing event-level endpoint field', () => {
    const parsed = parseLogLine(
      'info',
      'endpoint{endpoint="github"}: handled endpoint="other"',
    );
    expect(parsed.endpoint).toBe('github');
    expect(parsed.message).toBe('handled');
  });
});

describe('parseLogLine — leading colon cleanup after span removal', () => {
  // A single span leaves one `: ` separator before the message text. The
  // cleanup must drop it so users never see a leading colon on the row.
  it('strips the leading colon left by a single endpoint span', () => {
    const parsed = parseLogLine(
      'info',
      'endpoint{endpoint="github"}: MCP server process spawned',
    );
    expect(parsed.endpoint).toBe('github');
    expect(parsed.message).toBe('MCP server process spawned');
    expect(parsed.message.startsWith(':')).toBe(false);
  });

  // Nested spans (e.g. the watcher's `endpoint{…}` wrapping the adapter's
  // `endpoint{…}`) leave `::` once both are removed. All leading colons go.
  it('strips the double colon left by two nested endpoint spans', () => {
    const parsed = parseLogLine(
      'info',
      'endpoint{endpoint="github"}:endpoint{endpoint="github"}: MCP server process spawned',
    );
    expect(parsed.endpoint).toBe('github');
    expect(parsed.message).toBe('MCP server process spawned');
    expect(parsed.message.startsWith(':')).toBe(false);
  });

  // No span at all, but a stray leading colon (e.g. left after timestamp/level
  // stripping) must still be removed.
  it('strips a stray leading colon when no span is present', () => {
    const parsed = parseLogLine(
      'info',
      '2026-05-20T17:54:47.123Z INFO : MCP server process spawned',
    );
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('MCP server process spawned');
    expect(parsed.message.startsWith(':')).toBe(false);
  });

  // Only leading colons are stripped — a colon inside the message body
  // (e.g. `Reason: foo`) must be preserved.
  it('preserves colons inside the message body', () => {
    const parsed = parseLogLine(
      'info',
      'endpoint{endpoint="github"}: Reason: connection refused',
    );
    expect(parsed.endpoint).toBe('github');
    expect(parsed.message).toBe('Reason: connection refused');
  });
});

