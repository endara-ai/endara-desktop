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

export function parseLogLine(
  level: string,
  message: string,
  options?: ParseLogLineOptions,
): ParsedLogLine {
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
  // After span removal we may be left with leading whitespace and a stray
  // ": " separator that preceded the message text. Collapse both.
  cleanMessage = cleanMessage.replace(/^\s+/, '').replace(/^:\s*/, '').trim();

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
    message: cleanedMessage,
    raw: message,
    isToolCall,
  };
}
