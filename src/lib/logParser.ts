// Parser for the relay's compact tracing log format. The relay (PR #67) emits
// lines like:
//
//   2026-05-20T10:32:05.123Z endpoint{endpoint=github transport=stdio}: Tool call completed tool=foo status=ok duration_ms=312
//
// The Tauri host already splits level from the message, so this parser
// operates on the level + message pair and extracts the relay timestamp,
// span context (endpoint / request) and inline key=value fields.

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface ParsedLogLine {
  timestamp: Date;
  level: LogLevel;
  endpoint?: string;
  transport?: string;
  serverType?: string;
  method?: string;
  requestId?: string;
  tool?: string;
  status?: string;
  durationMs?: number;
  profile?: string;
  // Relay-event metrics emitted on `MCP request` lines (distinct from
  // `durationMs`, which only ever comes from a tool-call `duration_ms` field —
  // keeping `elapsedMs` separate is what stops `MCP request` rows from being
  // misclassified as tool-call rows by `isToolCall`).
  elapsedMs?: number;
  reqBytes?: number;
  respBytes?: number;
  // Prefixed tool name (`<endpoint>__<tool>`) emitted on `Routing tool call`
  // lines by the relay registry.
  prefixed?: string;
  // Identity of the calling MCP client, captured from the relay's flat
  // `client_name=...` / `client_version=...` event fields. Either may be
  // missing independently — the renderer treats "missing" and `""` the same.
  clientName?: string;
  clientVersion?: string;
  message: string;
  raw: string;
  isToolCall: boolean;
}

const SPAN_RE = /(\w+)\{([^}]+)\}/g;
// The quoted alternative must come first: regex alternation is leftmost-first,
// not longest-match, so trying `[^\s,}]+` ahead of `"[^"]*"` would greedily
// match `"Clement` and stop at the space inside `endpoint="Clement Whatsapp"`,
// leaving a stray leading quote in the captured value.
// Capture groups: 1 = field name, 2 = full value, 3 = inside-quotes (when
// quoted), 4 = unquoted value.
const FIELD_RE = /(\w+)=("([^"]*)"|([^\s,}]+))/g;
// Event-level fields appended after the message text (outside any span). Same
// shape as FIELD_RE but the unquoted alternative is `\S*` so a trailing
// `endpoint=` with no value still matches and gets stripped from the message
// instead of leaking as a stray token.
const EVENT_FIELD_RE = /(\w+)=("([^"]*)"|(\S*))/g;
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z?)\s+/;
// Whole-word level token that the relay emits right after the timestamp. The
// regex is case-sensitive because the relay always emits these upper-case;
// matching lower-case "error" would also swallow English words in the message
// body.
const LEVEL_RE = /^(ERROR|WARN|INFO|DEBUG|TRACE)\s+/;

export function extractTimestamp(message: string): { timestamp: Date; rest: string } {
  const match = message.match(TIMESTAMP_RE);
  if (match) {
    return { timestamp: new Date(match[1]), rest: message.slice(match[0].length) };
  }
  return { timestamp: new Date(), rest: message };
}

function normalizeLevel(level: string): LogLevel {
  const l = level.toLowerCase();
  if (l === 'error' || l === 'warn' || l === 'info' || l === 'debug' || l === 'trace') {
    return l;
  }
  return 'info';
}

export interface ParseLogLineOptions {
  /**
   * Authoritative endpoint name supplied by the Rust sidecar (Slice D). When
   * non-null/undefined, overrides whatever the regex extracts from the span
   * context — the Rust side reads the same tracing span and knows the
   * canonical value even when the formatted message is ambiguous.
   */
  endpointOverride?: string | null;
}

// Shape of one line emitted by tracing-subscriber's `.json()` formatter. Every
// field is optional/defensive because the desktop never controls the exact
// layout — see the spec's "Cross-stack contract — the relay's tracing JSON
// line shape".
interface TracingJsonSpan {
  name?: string;
  endpoint?: string;
  transport?: string;
  server_type?: string;
  method?: string;
  id?: string | number;
  profile?: string;
  [key: string]: unknown;
}
interface TracingJsonLine {
  timestamp?: string;
  level?: string;
  target?: string;
  fields?: Record<string, unknown>;
  spans?: TracingJsonSpan[];
}

function asString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : String(value);
}

// Coerce a JSON value to a finite number, dropping `undefined`/`null`/NaN.
// The relay emits `elapsed_ms` / `req_bytes` / `resp_bytes` as JSON numbers.
function asNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  return Number.isNaN(n) ? undefined : n;
}

// The relay emits `client_name` / `client_version` via Rust Debug (`?`), so in
// the JSON output their values arrive wrapped in a literal surrounding
// quote-pair (e.g. the value string is `"Claude Desktop"`, quotes included).
// Strip exactly one surrounding quote-pair so the rendered caller is unquoted;
// an empty Debug string (`""`) collapses to undefined ("missing"). Values with
// no surrounding quotes (e.g. test fixtures) pass through unchanged.
function stripDebugQuotes(value: unknown): string | undefined {
  const s = asString(value);
  if (s === undefined) return undefined;
  const out =
    s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
  return out.length === 0 ? undefined : out;
}

// JSON-first branch: map a parsed tracing-subscriber JSON line onto
// `ParsedLogLine` per the locked field-mapping contract. Span/event fields are
// no longer a non-regular language we have to scrape, so the brittle text
// regexes never run for these lines.
function parseJsonLogLine(
  json: TracingJsonLine,
  level: string,
  raw: string,
  options?: ParseLogLineOptions,
): ParsedLogLine {
  const fields: Record<string, unknown> =
    json.fields && typeof json.fields === 'object' ? json.fields : {};
  const spans: TracingJsonSpan[] = Array.isArray(json.spans) ? json.spans : [];
  const findSpan = (name: string): TracingJsonSpan =>
    spans.find((s) => s && typeof s === 'object' && s.name === name) ?? {};
  const endpointSpan = findSpan('endpoint');
  const requestSpan = findSpan('request');
  const mcpRequestSpan = findSpan('mcp_request');

  const parsedTimestamp = json.timestamp ? new Date(json.timestamp) : new Date();
  const timestamp = Number.isNaN(parsedTimestamp.getTime()) ? new Date() : parsedTimestamp;

  // Prefer the `endpoint` span, falling back to a flat `fields.endpoint` so
  // relay events that carry the endpoint as an event field (e.g. the registry's
  // `Routing tool call` line) still resolve their endpoint.
  const parsedEndpoint = asString(endpointSpan.endpoint) ?? asString(fields.endpoint);
  const endpoint =
    options?.endpointOverride !== undefined && options.endpointOverride !== null
      ? options.endpointOverride
      : parsedEndpoint;

  const tool = asString(fields.tool);
  const status = asString(fields.status);
  // `duration_ms` arrives as a JSON number in this format (not a quoted string
  // as in the Full text format); coerce defensively and drop NaN.
  const durationNum = fields.duration_ms !== undefined ? Number(fields.duration_ms) : undefined;
  const durationMs =
    durationNum !== undefined && !Number.isNaN(durationNum) ? durationNum : undefined;

  const message = asString(fields.message) ?? '';

  const isToolCall =
    (tool !== undefined &&
      (message.includes('Tool call completed') || message.includes('Tool call failed'))) ||
    (status !== undefined && durationMs !== undefined);

  // Per Engineering Spec §7.1 the canonical span is `mcp_request`; fall back to
  // any span carrying a `profile` field to stay robust to the exact span name.
  const profile =
    asString(mcpRequestSpan.profile) ?? asString(spans.find((s) => s && s.profile)?.profile);

  return {
    timestamp,
    level: normalizeLevel(json.level ?? level),
    endpoint,
    transport: asString(endpointSpan.transport),
    serverType: asString(endpointSpan.server_type),
    method: asString(requestSpan.method) ?? asString(fields.method),
    requestId: asString(requestSpan.id),
    tool,
    status,
    durationMs,
    // Distinct from `durationMs` on purpose — see the `ParsedLogLine` note.
    elapsedMs: asNumber(fields.elapsed_ms),
    reqBytes: asNumber(fields.req_bytes),
    respBytes: asNumber(fields.resp_bytes),
    prefixed: asString(fields.prefixed),
    profile,
    clientName: stripDebugQuotes(fields.client_name),
    clientVersion: stripDebugQuotes(fields.client_version),
    message,
    raw,
    isToolCall,
  };
}

export function parseLogLine(
  level: string,
  message: string,
  options?: ParseLogLineOptions,
): ParsedLogLine {
  // JSON-first: the relay sidecar runs with `--log-format json`, so the live
  // pipeline hands us one tracing JSON object per line. Parse it structurally
  // and map per the contract. Non-JSON input — the per-endpoint `/logs`
  // activity-log seed and raw adapter stdout — throws here and falls through to
  // the text-regex parser below, which keeps those lines rendering as today.
  try {
    const parsed: unknown = JSON.parse(message);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parseJsonLogLine(parsed as TracingJsonLine, level, message, options);
    }
  } catch {
    // Not JSON — fall through to the text-regex parser.
  }

  const { timestamp, rest: afterTimestamp } = extractTimestamp(message);

  // Strip the level token (ERROR/WARN/INFO/DEBUG/TRACE) that the relay emits
  // right after the timestamp. The extracted token is the authoritative pill
  // level — the Rust sidecar may have defaulted to "info" when the line
  // arrived on stdout, so the in-text token wins when present.
  let rest = afterTimestamp;
  let extractedLevel: string | undefined;
  const lvlMatch = rest.match(LEVEL_RE);
  if (lvlMatch) {
    extractedLevel = lvlMatch[1].toLowerCase();
    rest = rest.slice(lvlMatch[0].length);
  }

  const spans: Record<string, Record<string, string>> = {};
  const fields: Record<string, string> = {};

  let cleanMessage = rest;
  for (const match of rest.matchAll(SPAN_RE)) {
    const [full, spanName, spanFields] = match;
    spans[spanName] = {};
    for (const fm of spanFields.matchAll(FIELD_RE)) {
      spans[spanName][fm[1]] = fm[3] !== undefined ? fm[3] : fm[4];
    }
    cleanMessage = cleanMessage.replace(full, '');
  }
  // After span removal we may be left with leading whitespace and one or more
  // stray ":" separators (one per removed span, e.g. nested spans leave `::`)
  // that preceded the message text. Strip every leading whitespace/colon in a
  // single pass; in-message colons are untouched.
  cleanMessage = cleanMessage.replace(/^[\s:]+/, '').trim();

  // Scan with a regex (not split-on-whitespace) so quoted multi-word values
  // such as `endpoint="Two Words"` stay intact instead of leaking the trailing
  // word into the message. Empty values (`endpoint=`) are removed from the
  // message but not stored, so they cannot overwrite a real endpoint from the
  // span or from `endpointOverride`.
  for (const fm of cleanMessage.matchAll(EVENT_FIELD_RE)) {
    const value = fm[3] !== undefined ? fm[3] : fm[4];
    if (value !== '') {
      fields[fm[1]] = value;
    }
  }
  const cleanedMessage = cleanMessage
    .replace(EVENT_FIELD_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  const tool = fields.tool;
  const status = fields.status;
  const durationMs = fields.duration_ms !== undefined ? parseInt(fields.duration_ms, 10) : undefined;

  const isToolCall =
    (tool !== undefined &&
      (cleanedMessage.includes('Tool call completed') ||
        cleanedMessage.includes('Tool call failed'))) ||
    (status !== undefined && durationMs !== undefined && !Number.isNaN(durationMs));

  // Fall back to event-level fields when no `endpoint` span is present, so
  // `info!(endpoint = %name, …)` calls outside a span still render correctly.
  // Empty values were skipped above, so `??` won't promote `""` over undefined.
  const parsedEndpoint = spans.endpoint?.endpoint ?? fields.endpoint;
  const endpoint =
    options?.endpointOverride !== undefined && options.endpointOverride !== null
      ? options.endpointOverride
      : parsedEndpoint;

  // Per Engineering Spec §7.1 the relay emits `tracing::info_span!("mcp_request",
  // profile = %profile_path)`, so the canonical span name is `mcp_request`.
  // Fall back to scanning every captured span for a `profile` field so the
  // parser stays robust to the exact span name R3.E ends up emitting (see
  // Desktop recon §5 and the spec's "Recon findings — locked decisions"
  // Desktop #6).
  const profile =
    spans.mcp_request?.profile ?? Object.values(spans).find((s) => s.profile)?.profile;

  return {
    timestamp,
    level: normalizeLevel(extractedLevel ?? level),
    endpoint,
    transport: spans.endpoint?.transport ?? fields.transport,
    serverType: spans.endpoint?.server_type ?? fields.server_type,
    method: spans.request?.method,
    requestId: spans.request?.id,
    tool,
    status,
    durationMs: durationMs !== undefined && !Number.isNaN(durationMs) ? durationMs : undefined,
    profile,
    clientName: fields.client_name,
    clientVersion: fields.client_version,
    message: cleanedMessage,
    raw: message,
    isToolCall,
  };
}
