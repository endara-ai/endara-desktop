import { parseLogLine, type ParsedLogLine } from '$lib/logParser';

/**
 * Pure helpers backing `LogsTab.svelte`'s live-streaming view (engineering
 * spec §2.3 / Slice D.2). Extracted as plain functions so they can be
 * exercised in the Node test env — the rest of the desktop test suite
 * follows the same pattern (relay-logs-helpers, tool-call-row-helpers,
 * sidebar-helpers, ...).
 */

/**
 * Parse the historical lines returned by `GET /api/endpoints/{name}/logs`
 * into `ParsedLogLine` records. The one-shot API hands us raw strings with
 * no level field, so we default to 'info' and let `parseLogLine` infer the
 * relay-side level when the message itself includes one. The endpoint name
 * is supplied as the authoritative override since the historical response
 * is already scoped to a single endpoint.
 */
export function parseHistoricalSeed(
  rawLines: readonly string[],
  endpointName: string,
): ParsedLogLine[] {
  return rawLines.map((raw) =>
    parseLogLine('info', raw, { endpointOverride: endpointName }),
  );
}

/**
 * Merge the historical seed with the live-filtered tail, suppressing
 * duplicate rows that may appear in both lists when the desktop subscribes
 * to the event stream while the relay's in-memory ring still buffers the
 * same lines. Dedup key is the original `raw` string — cheap, stable, and
 * matches the spec's "Set check on raw" semantics.
 *
 * The first occurrence wins so the historical lines keep their position at
 * the top of the merged view.
 */
export function mergeDeduped(
  historical: readonly ParsedLogLine[],
  live: readonly ParsedLogLine[],
): ParsedLogLine[] {
  const seen = new Set<string>();
  const out: ParsedLogLine[] = [];
  for (const line of historical) {
    if (seen.has(line.raw)) continue;
    seen.add(line.raw);
    out.push(line);
  }
  for (const line of live) {
    if (seen.has(line.raw)) continue;
    seen.add(line.raw);
    out.push(line);
  }
  return out;
}

/**
 * Filter the global relay log stream down to lines belonging to a specific
 * endpoint. Defined here (instead of inlined in LogsTab.svelte) so the
 * live-streaming behaviour can be unit tested without mounting Svelte.
 */
export function filterLinesForEndpoint(
  lines: readonly ParsedLogLine[],
  endpointName: string,
): ParsedLogLine[] {
  return lines.filter((line) => line.endpoint === endpointName);
}
