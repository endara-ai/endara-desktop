<script lang="ts">
  import type { LogLevel, ParsedLogLine } from '$lib/logParser';
  import { endpointStripeStyle } from '$lib/endpointColor';
  import ToolCallRow from './ToolCallRow.svelte';

  // Pure presentation row shared by RelayLogs.svelte and LogsTab.svelte
  // (engineering spec §2.3 — extract once both consumers exist). Visual
  // output must stay byte-identical to the inlined row that previously
  // lived in RelayLogs.svelte.

  type Props = {
    line: ParsedLogLine;
    /** When set, the endpoint button reflects "this row is the active filter". */
    isActiveEndpoint?: boolean;
    /** Search query for substring highlighting inside the message column. */
    searchQuery?: string;
    /** Tick value (ms) for the hover tooltip's "Ns ago" relative time. */
    nowMs?: number;
    /** Click handler for the endpoint name. Omit to render a non-interactive label. */
    onEndpointClick?: (name: string) => void;
    /** Right-click handler for the endpoint name (context menu). */
    onEndpointContextMenu?: (event: MouseEvent, name: string) => void;
  };

  let {
    line,
    isActiveEndpoint = false,
    searchQuery = '',
    nowMs,
    onEndpointClick,
    onEndpointContextMenu,
  }: Props = $props();

  const trimmedQuery = $derived(searchQuery.trim());

  function formatHMS(d: Date): string {
    return d.toLocaleTimeString(undefined, { hour12: false });
  }

  function formatRelative(d: Date, ms: number): string {
    const diff = Math.max(0, Math.floor((ms - d.getTime()) / 1000));
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  }

  function levelPillClass(level: LogLevel): string {
    switch (level) {
      case 'error': return 'bg-(--offline)/10 text-(--offline)';
      case 'warn': return 'bg-(--degraded)/10 text-(--degraded)';
      case 'info': return 'bg-(--healthy)/10 text-(--healthy)';
      case 'debug': return 'bg-(--accent)/10 text-(--accent)';
      case 'trace': return 'text-(--fg3)';
    }
  }

  // Split the message around the search term so the matching substring can be
  // highlighted in the rendered row (case-insensitive, first occurrence only).
  function highlightSegments(text: string, query: string): Array<{ text: string; match: boolean }> {
    if (!query) return [{ text, match: false }];
    const lower = text.toLowerCase();
    const q = query.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx === -1) return [{ text, match: false }];
    return [
      { text: text.slice(0, idx), match: false },
      { text: text.slice(idx, idx + q.length), match: true },
      { text: text.slice(idx + q.length), match: false },
    ];
  }

  const segments = $derived(highlightSegments(line.message || line.raw, trimmedQuery));
  const timestampTitle = $derived(
    nowMs !== undefined
      ? `${line.timestamp.toISOString()} · ${formatRelative(line.timestamp, nowMs)}`
      : line.timestamp.toISOString(),
  );
</script>

<div
  class="grid grid-cols-[auto_4rem_8rem_1fr] gap-3 pl-2 pr-3 py-0.5 hover:bg-(--surface-hover) items-baseline"
  style={endpointStripeStyle(line.endpoint)}
  data-testid="log-row"
>
  <span
    class="text-(--fg3) select-none tabular-nums"
    title={timestampTitle}
  >{formatHMS(line.timestamp)}</span>
  <span class="pill {levelPillClass(line.level)}">{line.level.toUpperCase()}</span>
  {#if line.endpoint}
    {#if onEndpointClick || onEndpointContextMenu}
      <button
        type="button"
        class="truncate text-left text-(--fg2) hover:text-(--accent) hover:underline cursor-pointer {isActiveEndpoint ? 'text-(--accent) font-medium' : ''}"
        title={`${line.endpoint} — click to filter, right-click for actions`}
        aria-pressed={isActiveEndpoint}
        onclick={() => onEndpointClick?.(line.endpoint!)}
        oncontextmenu={(e) => onEndpointContextMenu?.(e, line.endpoint!)}
      >{line.endpoint}</button>
    {:else}
      <span class="truncate text-(--fg2)" title={line.endpoint}>{line.endpoint}</span>
    {/if}
  {:else}
    <span class="truncate text-(--fg3)" title="Relay-level event">──</span>
  {/if}
  {#if line.isToolCall}
    <ToolCallRow {line} />
  {:else}
    <span class="whitespace-pre-wrap break-all">
      {#each segments as seg}
        {#if seg.match}<mark class="bg-(--accent)/20 text-(--fg1)">{seg.text}</mark>{:else}{seg.text}{/if}
      {/each}
    </span>
  {/if}
</div>
