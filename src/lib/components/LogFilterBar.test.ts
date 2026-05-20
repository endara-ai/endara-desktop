import { describe, it, expect } from 'vitest';
import { parseLogLine } from '$lib/logParser';
import type { LogLevel, ParsedLogLine } from '$lib/logParser';

// Pure mirror of the filter combine logic in `LogFilterBar.svelte` +
// `RelayLogs.svelte`. Kept in sync with the components so we can unit-test
// the AND-combine semantics without spinning up a Svelte runtime (the desktop
// test env is Node, not jsdom). Engineering spec §2.2 + tests #7–#10.

interface LogFilterState {
  activeLevels: Set<LogLevel>;
  searchText: string;
  selectedEndpoints: Set<string>; // empty = "All"
  toolCallsOnly?: boolean;
}

function applyLogFilters(lines: ParsedLogLine[], state: LogFilterState): ParsedLogLine[] {
  const q = state.searchText.trim().toLowerCase();
  const hasEndpointFilter = state.selectedEndpoints.size > 0;
  const toolCallsOnly = state.toolCallsOnly === true;
  return lines.filter((line) => {
    if (!state.activeLevels.has(line.level)) return false;
    if (toolCallsOnly && !line.isToolCall) return false;
    if (hasEndpointFilter) {
      if (!line.endpoint || !state.selectedEndpoints.has(line.endpoint)) return false;
    }
    if (q.length > 0 && !line.raw.toLowerCase().includes(q)) return false;
    return true;
  });
}

const ALL_LEVELS: Set<LogLevel> = new Set(['error', 'warn', 'info', 'debug', 'trace']);

function makeSampleLines(): ParsedLogLine[] {
  return [
    parseLogLine('info', 'endpoint{endpoint=github}: Initialize handshake complete'),
    parseLogLine('warn', 'endpoint{endpoint=slack}: Connection lost, reconnecting...'),
    parseLogLine('error', 'endpoint{endpoint=postgres}: MCP server exited exit_code=1'),
    parseLogLine(
      'info',
      'endpoint{endpoint=github}: Tool call completed tool=get_file_contents status=ok duration_ms=312'
    ),
    parseLogLine('debug', 'endpoint{endpoint=gmail}: Polling for messages'),
    parseLogLine('info', 'Relay listening on 127.0.0.1:47107'),
  ];
}

describe('applyLogFilters', () => {
  // #7 — Level filter toggles correctly include/exclude log lines
  it('includes a level only when it is in the active set', () => {
    const lines = makeSampleLines();
    const onlyErrors = applyLogFilters(lines, {
      activeLevels: new Set<LogLevel>(['error']),
      searchText: '',
      selectedEndpoints: new Set(),
    });
    expect(onlyErrors).toHaveLength(1);
    expect(onlyErrors[0].level).toBe('error');

    const errorAndWarn = applyLogFilters(lines, {
      activeLevels: new Set<LogLevel>(['error', 'warn']),
      searchText: '',
      selectedEndpoints: new Set(),
    });
    expect(errorAndWarn.map((l) => l.level).sort()).toEqual(['error', 'warn']);

    const none = applyLogFilters(lines, {
      activeLevels: new Set<LogLevel>(),
      searchText: '',
      selectedEndpoints: new Set(),
    });
    expect(none).toHaveLength(0);
  });

  // #8 — Text search filters lines by case-insensitive substring match
  it('filters lines by case-insensitive substring search against raw', () => {
    const lines = makeSampleLines();
    const githubLines = applyLogFilters(lines, {
      activeLevels: ALL_LEVELS,
      searchText: 'GITHUB',
      selectedEndpoints: new Set(),
    });
    expect(githubLines).toHaveLength(2);
    expect(githubLines.every((l) => l.endpoint === 'github')).toBe(true);

    const toolLines = applyLogFilters(lines, {
      activeLevels: ALL_LEVELS,
      searchText: 'tool call',
      selectedEndpoints: new Set(),
    });
    expect(toolLines).toHaveLength(1);
    expect(toolLines[0].tool).toBe('get_file_contents');

    const trimmed = applyLogFilters(lines, {
      activeLevels: ALL_LEVELS,
      searchText: '   ',
      selectedEndpoints: new Set(),
    });
    expect(trimmed).toHaveLength(lines.length);
  });

  // #9 — Endpoint filter shows only lines matching selected endpoint(s)
  it('restricts to the selected endpoints (empty set = All)', () => {
    const lines = makeSampleLines();
    const justGithub = applyLogFilters(lines, {
      activeLevels: ALL_LEVELS,
      searchText: '',
      selectedEndpoints: new Set(['github']),
    });
    expect(justGithub).toHaveLength(2);
    expect(justGithub.every((l) => l.endpoint === 'github')).toBe(true);

    const githubOrSlack = applyLogFilters(lines, {
      activeLevels: ALL_LEVELS,
      searchText: '',
      selectedEndpoints: new Set(['github', 'slack']),
    });
    expect(githubOrSlack.map((l) => l.endpoint).sort()).toEqual(['github', 'github', 'slack']);

    // Relay-level events (no endpoint) are excluded when an endpoint filter
    // is active — the "Relay listening on …" line is filtered out.
    const noRelayLevel = githubOrSlack.find((l) => l.endpoint === undefined);
    expect(noRelayLevel).toBeUndefined();

    // Empty selectedEndpoints means "All" — the relay-level line is kept.
    const all = applyLogFilters(lines, {
      activeLevels: ALL_LEVELS,
      searchText: '',
      selectedEndpoints: new Set(),
    });
    expect(all).toHaveLength(lines.length);
  });

  // #10 — Combined filters (level + text + endpoint) apply with AND logic
  it('combines level, search, and endpoint filters with AND semantics', () => {
    const lines = makeSampleLines();
    const result = applyLogFilters(lines, {
      activeLevels: new Set<LogLevel>(['info']),
      searchText: 'tool',
      selectedEndpoints: new Set(['github']),
    });
    expect(result).toHaveLength(1);
    expect(result[0].endpoint).toBe('github');
    expect(result[0].level).toBe('info');
    expect(result[0].tool).toBe('get_file_contents');

    const noMatch = applyLogFilters(lines, {
      activeLevels: new Set<LogLevel>(['error']),
      searchText: 'tool',
      selectedEndpoints: new Set(['github']),
    });
    expect(noMatch).toHaveLength(0);
  });

  // #16 — "Tool calls only" filter shows only isToolCall === true lines, and
  // AND-combines with the existing level / search / endpoint filters.
  it('"Tool calls only" toggle restricts to isToolCall lines and AND-combines', () => {
    const lines = makeSampleLines();

    // toolCallsOnly = false (default) keeps every line that the level filter allows.
    const allWhenOff = applyLogFilters(lines, {
      activeLevels: ALL_LEVELS,
      searchText: '',
      selectedEndpoints: new Set(),
      toolCallsOnly: false,
    });
    expect(allWhenOff).toHaveLength(lines.length);

    // toolCallsOnly = true keeps only the single Tool-call completed line.
    const onlyToolCalls = applyLogFilters(lines, {
      activeLevels: ALL_LEVELS,
      searchText: '',
      selectedEndpoints: new Set(),
      toolCallsOnly: true,
    });
    expect(onlyToolCalls).toHaveLength(1);
    expect(onlyToolCalls[0].isToolCall).toBe(true);
    expect(onlyToolCalls[0].tool).toBe('get_file_contents');

    // AND-combine with level/endpoint: turning off INFO drops the only tool call.
    const noInfoToolCalls = applyLogFilters(lines, {
      activeLevels: new Set<LogLevel>(['error', 'warn', 'debug', 'trace']),
      searchText: '',
      selectedEndpoints: new Set(),
      toolCallsOnly: true,
    });
    expect(noInfoToolCalls).toHaveLength(0);

    // AND-combine with endpoint: restricting to slack drops the github tool call.
    const slackToolCalls = applyLogFilters(lines, {
      activeLevels: ALL_LEVELS,
      searchText: '',
      selectedEndpoints: new Set(['slack']),
      toolCallsOnly: true,
    });
    expect(slackToolCalls).toHaveLength(0);
  });
});
