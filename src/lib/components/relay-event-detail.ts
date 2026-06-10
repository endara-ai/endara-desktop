import type { ParsedLogLine } from '$lib/logParser';
import { callerSuffix } from './tool-call-row-helpers';

// Pure helper that turns an otherwise-bare relay-event row ("MCP request" /
// "Routing tool call") into a readable inline detail string, surfacing the
// structured fields the relay already emits. Returns null for every other
// message so the non-tool-call row renders its message exactly as today.
//
// Kept out of the Svelte component (matching the `*-helpers.ts` pattern) so the
// formatting can be unit-tested without a Svelte runtime.

const SEP = ' · ';

function trimmed(value: string | undefined | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

// `MCP request · <method> · <status> · <elapsedMs>ms · <caller>` — each segment
// is omitted when its field is absent. `caller` is the unquoted `name version`.
function mcpRequestDetail(line: ParsedLogLine): string {
  const parts: string[] = ['MCP request'];
  const method = trimmed(line.method);
  if (method) parts.push(method);
  const status = trimmed(line.status);
  if (status) parts.push(status);
  if (line.elapsedMs !== undefined && !Number.isNaN(line.elapsedMs)) {
    parts.push(`${line.elapsedMs}ms`);
  }
  const caller = callerSuffix(line.clientName, line.clientVersion);
  if (caller) parts.push(caller);
  return parts.join(SEP);
}

// `Routing tool call · <prefixed‖tool> → <endpoint>` — prefer the prefixed name
// (`<endpoint>__<tool>`), fall back to the bare tool; the `→ <endpoint>` tail is
// omitted when the endpoint is absent.
function routingToolCallDetail(line: ParsedLogLine): string {
  const name = trimmed(line.prefixed) || trimmed(line.tool);
  if (!name) return 'Routing tool call';
  const endpoint = trimmed(line.endpoint);
  return endpoint
    ? `Routing tool call${SEP}${name} → ${endpoint}`
    : `Routing tool call${SEP}${name}`;
}

export function relayEventDetail(line: ParsedLogLine): string | null {
  switch (line.message) {
    case 'MCP request':
      return mcpRequestDetail(line);
    case 'Routing tool call':
      return routingToolCallDetail(line);
    default:
      return null;
  }
}
