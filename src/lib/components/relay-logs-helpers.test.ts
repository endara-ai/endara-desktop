import { describe, it, expect } from 'vitest';

import type { ParsedLogLine } from '$lib/logParser';
import { lineKey, toggleEndpointFilter } from './relay-logs-helpers';

function mkLine(raw: string): ParsedLogLine {
  return { timestamp: new Date(0), level: 'info', message: raw, raw, isToolCall: false };
}

describe('toggleEndpointFilter', () => {
  it('selects an endpoint when nothing is selected', () => {
    const next = toggleEndpointFilter(new Set(), 'github');
    expect([...next]).toEqual(['github']);
  });

  it('clears the filter when the only selection is toggled off', () => {
    const next = toggleEndpointFilter(new Set(['github']), 'github');
    expect(next.size).toBe(0);
  });

  it('replaces a different single selection with the clicked one', () => {
    const next = toggleEndpointFilter(new Set(['slack']), 'github');
    expect([...next]).toEqual(['github']);
  });
});

describe('lineKey (stable virtualizer keys)', () => {
  it('returns the same key for the same line object across calls', () => {
    const line = mkLine('2026-01-01T00:00:00Z INFO hello');
    expect(lineKey(line)).toBe(lineKey(line));
  });

  it('assigns distinct keys to distinct objects with identical raw text', () => {
    const raw = '2026-01-01T00:00:00Z INFO duplicate';
    expect(lineKey(mkLine(raw))).not.toBe(lineKey(mkLine(raw)));
  });

  it('keeps the key stable when the line moves position in a new array', () => {
    const line = mkLine('stable');
    const before = lineKey(line);
    const shifted = [mkLine('newer-a'), mkLine('newer-b'), line];
    expect(lineKey(shifted[2])).toBe(before);
  });
});
