import { describe, it, expect } from 'vitest';

import { parseLogLine } from '$lib/logParser';
import type { ParsedLogLine } from '$lib/logParser';
import {
  parseHistoricalSeed,
  mergeDeduped,
  filterLinesForEndpoint,
  logLineKey,
} from './logs-tab-helpers';
import {
  DEFAULT_OVERSCAN,
  DEFAULT_ROW_ESTIMATE_PX,
  computeMountedRange,
  itemKeyAt,
} from './virtual-log-list-helpers';

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

// Wave 2 — LogsTab renders through VirtualLogList with stable string keys.
describe('logLineKey (stable keys for VirtualLogList)', () => {
  it('keys on raw, so a re-seeded fresh instance keeps the same key', () => {
    const raw = 'endpoint{endpoint=github}: Initialize handshake complete';
    const first = parseHistoricalSeed([raw], 'github')[0];
    const reSeeded = parseHistoricalSeed([raw], 'github')[0];
    expect(reSeeded).not.toBe(first);
    expect(logLineKey(reSeeded)).toBe(logLineKey(first));
  });

  it('is unique across a merged historical + live list (dedup by raw)', () => {
    const seed = parseHistoricalSeed(['a', 'b', 'a'], 'github');
    const live = [
      parseLogLine('info', 'endpoint{endpoint=github}: c'),
      parseLogLine('info', 'a'),
    ];
    const merged = mergeDeduped(seed, live);
    const keys = merged.map(logLineKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps keys stable when the merged array is rebuilt with more live lines', () => {
    const seed = parseHistoricalSeed(['old-1', 'old-2'], 'github');
    const before = mergeDeduped(seed, []);
    const after = mergeDeduped(seed, [
      parseLogLine('info', 'endpoint{endpoint=github}: new-1'),
    ]);
    expect(itemKeyAt(after, 1, logLineKey)).toBe(itemKeyAt(before, 1, logLineKey));
  });
});

// Definition of Done — with a 5,000-line historical seed, mounting LogsTab
// creates only the visible window (+ overscan) of LogRows, scrolled to the
// bottom. The vitest env is Node (no DOM), so per the Wave 1 pattern we
// assert the windowed subset through computeMountedRange, the pure mirror of
// VirtualLogList's windowing math.
describe('windowed mount with a 5,000-line historical seed', () => {
  it('mounts only the visible window (+ overscan) on first paint at the bottom', () => {
    const seed = parseHistoricalSeed(
      Array.from({ length: 5000 }, (_, i) => `seed-line-${i}`),
      'github',
    );
    const displayLines = mergeDeduped(seed, []);
    expect(displayLines).toHaveLength(5000);

    const rowHeight = DEFAULT_ROW_ESTIMATE_PX;
    const viewportHeight = 400;
    const totalHeight = displayLines.length * rowHeight;
    const range = computeMountedRange({
      count: displayLines.length,
      scrollOffset: totalHeight - viewportHeight,
      viewportHeight,
      rowHeight,
      overscan: DEFAULT_OVERSCAN,
    });

    expect(range).not.toBeNull();
    expect(range!.end).toBe(4999);
    const mounted = range!.end - range!.start + 1;
    const visibleRows = viewportHeight / rowHeight;
    expect(mounted).toBe(visibleRows + DEFAULT_OVERSCAN);
    expect(mounted).toBeLessThan(displayLines.length / 100);
  });
});
