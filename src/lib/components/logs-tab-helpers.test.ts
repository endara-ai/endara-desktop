import { describe, it, expect } from 'vitest';

import { parseLogLine } from '$lib/logParser';
import type { ParsedLogLine } from '$lib/logParser';
import {
  parseHistoricalSeed,
  mergeDeduped,
  filterLinesForEndpoint,
} from './logs-tab-helpers';

// Engineering spec §5 — Slice D.2 test rows #20, #21, #22, #23. The desktop
// test env is Node (vitest.config.ts), so we exercise the pure helpers that
// back `LogsTab.svelte` and assert structural-identity by sharing the same
// `ParsedLogLine` data path that `LogRow.svelte` consumes in both views —
// mirrors the relay-logs-helpers / tool-call-row-helpers pattern used by
// every other component in this folder.

function liveLine(opts: { endpoint: string | undefined; raw: string; level?: string }): ParsedLogLine {
  const msg = opts.endpoint
    ? `endpoint{endpoint=${opts.endpoint}}: ${opts.raw}`
    : opts.raw;
  return parseLogLine(opts.level ?? 'info', msg);
}

// #20 — LogsTab shows live-updating lines matching the selected endpoint.
describe('filterLinesForEndpoint (test #20 — live updates per endpoint)', () => {
  it('keeps only lines whose endpoint matches the selection', () => {
    const stream = [
      liveLine({ endpoint: 'github', raw: 'one' }),
      liveLine({ endpoint: 'slack', raw: 'two' }),
      liveLine({ endpoint: 'github', raw: 'three' }),
      liveLine({ endpoint: undefined, raw: 'relay-level' }),
    ];
    const filtered = filterLinesForEndpoint(stream, 'github');
    expect(filtered.map((l) => l.message)).toEqual(['one', 'three']);
  });

  it('returns an empty list when no live line matches', () => {
    const stream = [liveLine({ endpoint: 'slack', raw: 'noise' })];
    expect(filterLinesForEndpoint(stream, 'github')).toEqual([]);
  });

  it('reflects new lines appended to the live stream without re-fetching', () => {
    // The "no re-fetch" semantic in production is enforced by the store
    // subscription; here we model that by appending to the same array and
    // re-running the filter — the consumer sees the new line on next tick.
    const stream: ParsedLogLine[] = [liveLine({ endpoint: 'github', raw: 'first' })];
    expect(filterLinesForEndpoint(stream, 'github')).toHaveLength(1);
    stream.push(liveLine({ endpoint: 'github', raw: 'second' }));
    const next = filterLinesForEndpoint(stream, 'github');
    expect(next).toHaveLength(2);
    expect(next[1].message).toBe('second');
  });
});

// #21 — LogsTab prepends historical lines from one-shot API fetch.
describe('parseHistoricalSeed + mergeDeduped (test #21 — historical seed prepended)', () => {
  it('parses raw historical strings using the endpoint override', () => {
    const seed = parseHistoricalSeed(
      ['Initialize handshake complete', 'Tool call completed tool=foo status=ok duration_ms=5'],
      'github',
    );
    expect(seed).toHaveLength(2);
    expect(seed[0].endpoint).toBe('github');
    expect(seed[0].message).toBe('Initialize handshake complete');
    expect(seed[1].endpoint).toBe('github');
    expect(seed[1].isToolCall).toBe(true);
  });

  it('puts historical seed before live lines in the merged view', () => {
    const seed = parseHistoricalSeed(['old-1', 'old-2'], 'github');
    const live = [liveLine({ endpoint: 'github', raw: 'new-1' })];
    const merged = mergeDeduped(seed, live);
    expect(merged.map((l) => l.message)).toEqual(['old-1', 'old-2', 'new-1']);
  });
});

// #22 — Dedupe: overlap between historical + live doesn't produce duplicates.
describe('mergeDeduped (test #22 — dedupe by raw)', () => {
  it('suppresses live lines that already appear in the historical seed', () => {
    // The relay's ring buffer may include the same line that the live event
    // channel re-emits. The historical line keeps its slot at the top and the
    // duplicate live line is dropped.
    const sharedRaw = 'endpoint{endpoint=github}: Tool call completed tool=foo status=ok duration_ms=5';
    const seedLines = parseHistoricalSeed([sharedRaw], 'github');
    const liveDuplicate = parseLogLine('info', sharedRaw);
    const liveNew = liveLine({ endpoint: 'github', raw: 'fresh' });

    const merged = mergeDeduped(seedLines, [liveDuplicate, liveNew]);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(seedLines[0]);
    expect(merged[1].message).toBe('fresh');
  });

  it('keeps the first occurrence when the historical seed itself has duplicates', () => {
    const seed = parseHistoricalSeed(['same', 'same', 'different'], 'github');
    const merged = mergeDeduped(seed, []);
    expect(merged.map((l) => l.message)).toEqual(['same', 'different']);
  });

  it('drops duplicate live lines even when no historical seed exists', () => {
    const a = liveLine({ endpoint: 'github', raw: 'one' });
    const b = parseLogLine(a.level, a.raw); // same raw, fresh instance
    expect(mergeDeduped([], [a, b])).toHaveLength(1);
  });
});

// #23 — LogRow renders identically in RelayLogs and LogsTab for the same
// ParsedLogLine. Both consumers feed `<LogRow line={...} />` with the same
// `ParsedLogLine` payload, so identity is established by showing that:
//   (a) the helpers RelayLogs uses to build a row's input (the raw store
//       value) and the helpers LogsTab uses (parseHistoricalSeed + filter)
//       produce the same canonical `ParsedLogLine` for a shared raw string;
//   (b) consequently both views pass an identically-shaped object into the
//       same `LogRow.svelte` component, which is the only place a row is
//       rendered after this slice.
describe('LogRow structural identity across RelayLogs + LogsTab (test #23)', () => {
  it('feeds the shared LogRow with byte-equivalent ParsedLogLine fields', () => {
    const raw = 'endpoint{endpoint=github}: Tool call completed tool=get_file_contents status=ok duration_ms=312';

    // RelayLogs path: the line lands in the global store after the listener
    // calls parseLogLine on the Tauri payload — modeled here directly.
    const relayLogsLine = parseLogLine('info', raw, { endpointOverride: 'github' });

    // LogsTab path: same raw string surfaces either via the live filter (also
    // parseLogLine in logListener.ts) or via parseHistoricalSeed.
    const liveLineForTab = parseLogLine('info', raw, { endpointOverride: 'github' });
    const seedLineForTab = parseHistoricalSeed([raw], 'github')[0];

    const fields = (l: ParsedLogLine) => ({
      level: l.level,
      endpoint: l.endpoint,
      transport: l.transport,
      serverType: l.serverType,
      method: l.method,
      requestId: l.requestId,
      tool: l.tool,
      status: l.status,
      durationMs: l.durationMs,
      message: l.message,
      raw: l.raw,
      isToolCall: l.isToolCall,
    });

    expect(fields(liveLineForTab)).toEqual(fields(relayLogsLine));
    expect(fields(seedLineForTab)).toEqual(fields(relayLogsLine));
  });
});
