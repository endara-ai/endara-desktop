import { describe, it, expect } from 'vitest';

import { parseLogLine } from '$lib/logParser';
import type { ParsedLogLine } from '$lib/logParser';
import {
  durationColorClass,
  statusIcon,
  statusIconClass,
  toolCallErrorSuffix,
  formatDurationMs,
  ERROR_SUFFIX_MAX_LEN,
} from './tool-call-row-helpers';

// Engineering spec §5 — Slice C test rows #14–#17. The test env is Node
// (vitest.config.ts), so we exercise the pure helpers extracted from
// `ToolCallRow.svelte` rather than mounting the Svelte component — same
// pattern used elsewhere in this folder (LogFilterBar.test.ts,
// relay-logs-helpers.ts, etc).

function toolCallLine(opts: {
  tool: string;
  status: 'ok' | 'error';
  durationMs: number;
  errorText?: string;
}): ParsedLogLine {
  const verb = opts.status === 'ok' ? 'completed' : 'failed';
  const trailer = opts.errorText ? ' ' + opts.errorText : '';
  return parseLogLine(
    opts.status === 'ok' ? 'info' : 'warn',
    `endpoint{endpoint=github}: Tool call ${verb} tool=${opts.tool} status=${opts.status} duration_ms=${opts.durationMs}${trailer}`
  );
}

// #14 — Tool-call events render with tool name, duration badge, and status icon.
describe('ToolCallRow — fields (test #14)', () => {
  it('exposes tool name, duration label, and status icon for a successful call', () => {
    const line = toolCallLine({ tool: 'get_file_contents', status: 'ok', durationMs: 312 });
    expect(line.isToolCall).toBe(true);
    expect(line.tool).toBe('get_file_contents');
    expect(formatDurationMs(line.durationMs)).toBe('312ms');
    expect(statusIcon(line.status)).toBe('✓');
  });

  it('exposes tool name, duration label, and status icon for a failed call', () => {
    const line = toolCallLine({
      tool: 'send_message',
      status: 'error',
      durationMs: 1204,
      errorText: 'timeout',
    });
    expect(line.isToolCall).toBe(true);
    expect(line.tool).toBe('send_message');
    expect(formatDurationMs(line.durationMs)).toBe('1204ms');
    expect(statusIcon(line.status)).toBe('✗');
  });

  it('returns an empty duration label when duration is missing', () => {
    expect(formatDurationMs(undefined)).toBe('');
    expect(formatDurationMs(Number.NaN)).toBe('');
  });
});

// #15 — Duration badge color: <200ms = normal, 200-1000ms = yellow, >1000ms = red.
describe('ToolCallRow — duration thresholds (test #15)', () => {
  it('treats sub-200ms calls as normal', () => {
    expect(durationColorClass(0)).toBe('text-(--fg2)');
    expect(durationColorClass(50)).toBe('text-(--fg2)');
    expect(durationColorClass(199)).toBe('text-(--fg2)');
  });

  it('treats 200–1000ms calls as degraded (yellow)', () => {
    expect(durationColorClass(200)).toBe('text-(--degraded)');
    expect(durationColorClass(500)).toBe('text-(--degraded)');
    expect(durationColorClass(1000)).toBe('text-(--degraded)');
  });

  it('treats >1000ms calls as offline (red)', () => {
    expect(durationColorClass(1001)).toBe('text-(--offline)');
    expect(durationColorClass(5000)).toBe('text-(--offline)');
  });

  it('falls back to normal when duration is missing', () => {
    expect(durationColorClass(undefined)).toBe('text-(--fg2)');
    expect(durationColorClass(Number.NaN)).toBe('text-(--fg2)');
  });
});

// #16 — covered alongside the rest of LogFilterBar.test.ts; here we only
// double-check the status-icon color mapping that the spec calls out.
describe('ToolCallRow — status icon color', () => {
  it('shows ✓ in the healthy color for ok', () => {
    expect(statusIcon('ok')).toBe('✓');
    expect(statusIconClass('ok')).toBe('text-(--healthy)');
  });

  it('shows ✗ in the offline color for any non-ok status', () => {
    expect(statusIcon('error')).toBe('✗');
    expect(statusIconClass('error')).toBe('text-(--offline)');
    expect(statusIcon('timeout')).toBe('✗');
    expect(statusIconClass('timeout')).toBe('text-(--offline)');
  });
});

// #17 — Error tool calls show truncated error message.
describe('ToolCallRow — error suffix (test #17)', () => {
  it('returns null for a successful call', () => {
    const line = toolCallLine({ tool: 'foo', status: 'ok', durationMs: 50 });
    expect(toolCallErrorSuffix(line)).toBeNull();
  });

  it('returns the error text after stripping the "Tool call failed" prefix', () => {
    const line = toolCallLine({
      tool: 'send_message',
      status: 'error',
      durationMs: 1204,
      errorText: 'connection refused',
    });
    expect(toolCallErrorSuffix(line)).toBe('connection refused');
  });

  it('returns null when the failed line has no extra error text', () => {
    const line = toolCallLine({ tool: 'send_message', status: 'error', durationMs: 1204 });
    expect(toolCallErrorSuffix(line)).toBeNull();
  });

  it('truncates very long error messages with an ellipsis', () => {
    const errorText = 'x'.repeat(ERROR_SUFFIX_MAX_LEN + 50);
    const line = toolCallLine({
      tool: 'send_message',
      status: 'error',
      durationMs: 500,
      errorText,
    });
    const suffix = toolCallErrorSuffix(line);
    expect(suffix).not.toBeNull();
    expect(suffix!.length).toBe(ERROR_SUFFIX_MAX_LEN);
    expect(suffix!.endsWith('…')).toBe(true);
  });
});
