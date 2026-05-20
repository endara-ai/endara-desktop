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
  message: string;
  raw: string;
  isToolCall: boolean;
}

const SPAN_RE = /(\w+)\{([^}]+)\}/g;
const FIELD_RE = /(\w+)=([^\s,}]+|"[^"]*")/g;
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
      spans[spanName][fm[1]] = fm[2].replace(/^"|"$/g, '');
    }
    cleanMessage = cleanMessage.replace(full, '');
  }
  // After span removal we may be left with leading whitespace and a stray
  // ": " separator that preceded the message text. Collapse both.
  cleanMessage = cleanMessage.replace(/^\s+/, '').replace(/^:\s*/, '').trim();

  const msgParts = cleanMessage.length > 0 ? cleanMessage.split(/\s+/) : [];
  const messageParts: string[] = [];
  for (const part of msgParts) {
    const fieldMatch = part.match(/^(\w+)=(.+)$/);
    if (fieldMatch) {
      fields[fieldMatch[1]] = fieldMatch[2].replace(/^"|"$/g, '');
    } else {
      messageParts.push(part);
    }
  }

  const cleanedMessage = messageParts.join(' ').trim();
  const tool = fields.tool;
  const status = fields.status;
  const durationMs = fields.duration_ms !== undefined ? parseInt(fields.duration_ms, 10) : undefined;

  const isToolCall =
    (tool !== undefined &&
      (cleanedMessage.includes('Tool call completed') ||
        cleanedMessage.includes('Tool call failed'))) ||
    (status !== undefined && durationMs !== undefined && !Number.isNaN(durationMs));

  const parsedEndpoint = spans.endpoint?.endpoint;
  const endpoint =
    options?.endpointOverride !== undefined && options.endpointOverride !== null
      ? options.endpointOverride
      : parsedEndpoint;

  return {
    timestamp,
    level: normalizeLevel(extractedLevel ?? level),
    endpoint,
    transport: spans.endpoint?.transport,
    serverType: spans.endpoint?.server_type,
    method: spans.request?.method,
    requestId: spans.request?.id,
    tool,
    status,
    durationMs: durationMs !== undefined && !Number.isNaN(durationMs) ? durationMs : undefined,
    message: cleanedMessage,
    raw: message,
    isToolCall,
  };
}
