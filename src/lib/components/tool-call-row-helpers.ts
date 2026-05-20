import type { ParsedLogLine } from '$lib/logParser';

// Pure helpers extracted from `ToolCallRow.svelte` so the duration-threshold
// colors, status icon mapping, and error-suffix truncation can be unit-tested
// without spinning up a Svelte runtime (the desktop test env is Node, not
// jsdom). Engineering spec §2.5 + tests #14–#17.

// Threshold buckets from spec §2.5:
//   <200ms = normal, 200–1000ms = degraded, >1000ms = offline.
export function durationColorClass(durationMs: number | undefined): string {
  if (durationMs === undefined || Number.isNaN(durationMs)) return 'text-(--fg2)';
  if (durationMs < 200) return 'text-(--fg2)';
  if (durationMs <= 1000) return 'text-(--degraded)';
  return 'text-(--offline)';
}

export function statusIcon(status: string | undefined): '✓' | '✗' {
  return status === 'ok' ? '✓' : '✗';
}

export function statusIconClass(status: string | undefined): string {
  return status === 'ok' ? 'text-(--healthy)' : 'text-(--offline)';
}

// Max characters we surface in the inline error suffix. Anything longer is
// truncated with an ellipsis — the full message is still available via the
// row's hover tooltip on `raw`.
export const ERROR_SUFFIX_MAX_LEN = 80;

// Derive the truncated error message shown after the ✗ icon on failed tool
// calls. The parser strips `key=value` pairs out of the message text, so on
// a `Tool call failed tool=foo status=error duration_ms=42 connection refused`
// line `line.message` ends up as "Tool call failed connection refused"; we
// trim the "Tool call failed/completed" prefix and return what remains.
// Returns null when the call succeeded or there is no extra text to show.
export function toolCallErrorSuffix(line: ParsedLogLine): string | null {
  if (!line.status || line.status === 'ok') return null;
  const rest = line.message.replace(/^Tool call (failed|completed)\s*/i, '').trim();
  if (rest.length === 0) return null;
  if (rest.length <= ERROR_SUFFIX_MAX_LEN) return rest;
  return rest.slice(0, ERROR_SUFFIX_MAX_LEN - 1) + '…';
}

export function formatDurationMs(durationMs: number | undefined): string {
  if (durationMs === undefined || Number.isNaN(durationMs)) return '';
  return `${durationMs}ms`;
}
