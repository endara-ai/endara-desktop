<script lang="ts">
  import { selectedEndpoint, relayLogLines, activeTab } from '$lib/stores';
  import { getEndpointLogs } from '$lib/api';
  import type { ParsedLogLine } from '$lib/logParser';
  import LogRow from './LogRow.svelte';
  import VirtualLogList from './VirtualLogList.svelte';
  import {
    parseHistoricalSeed,
    mergeDeduped,
    filterLinesForEndpoint,
    logLineKey,
  } from './logs-tab-helpers';

  // Live-streaming per-endpoint log view (engineering spec §2.3, Slice D.2).
  // Seeds with a one-shot fetch of the relay's in-memory ring for pre-mount
  // history, then appends every matching `relay-log` event in real time.
  // Display = historical ++ live, deduped by `raw` so an overlap doesn't
  // double up. Rows are rendered through VirtualLogList so only the visible
  // window (+ overscan) of LogRows is mounted, keyed by `raw` so a re-seed
  // doesn't tear down every row. The list starts pinned to the bottom and
  // handles auto-scroll / re-pinning internally.

  let historical: ParsedLogLine[] = $state([]);
  let loading = $state(true);
  let autoScroll = $state(true);
  let now = $state(Date.now());
  let list: VirtualLogList<ParsedLogLine> | undefined = $state();

  // Hover-tooltip clock — same pattern as RelayLogs.svelte; only ticks while
  // this tab is the active detail-panel tab to avoid background work.
  $effect(() => {
    if ($activeTab !== 'logs') return;
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });

  // (Re)seed historical lines whenever the selected endpoint changes. The
  // dependency on `$selectedEndpoint` is what re-runs this effect.
  $effect(() => {
    const name = $selectedEndpoint;
    if (!name) {
      historical = [];
      loading = false;
      return;
    }
    loading = true;
    getEndpointLogs(name)
      .then((data) => {
        historical = parseHistoricalSeed(data.lines ?? [], name);
      })
      .catch(() => {
        historical = [];
      })
      .finally(() => {
        loading = false;
      });
  });

  const liveLines = $derived.by(() => {
    const name = $selectedEndpoint;
    if (!name) return [] as ParsedLogLine[];
    return filterLinesForEndpoint($relayLogLines, name);
  });

  const displayLines = $derived(mergeDeduped(historical, liveLines));

  function goToEnd() {
    autoScroll = true;
    list?.scrollToBottom();
  }

  // Clear empties the historical seed; live events keep streaming in for as
  // long as this endpoint stays selected (matches the spec wording — the
  // live filter "keeps appending").
  function clearLogs() {
    historical = [];
  }
</script>

<div class="h-full flex flex-col">
  <div class="px-4 py-2 border-b border-(--border) flex items-center justify-between bg-(--hd-bg)">
    <span class="text-xs text-(--fg3)">{displayLines.length} lines</span>
    <div class="flex items-center gap-2">
      {#if !autoScroll}
        <button class="btn-sec btn-sm" onclick={goToEnd}>Go to end</button>
      {/if}
      <button
        class="btn-sec btn-sm"
        onclick={clearLogs}
        disabled={historical.length === 0}
      >Clear</button>
    </div>
  </div>
  {#if loading}
    <div class="flex-1 overflow-y-auto t-mono-log bg-(--surface-sunken)">
      <div class="space-y-1 p-4">
        {#each [1, 2, 3, 4, 5] as _}
          <div class="h-4 w-3/4 rounded bg-(--surface-hover) animate-pulse"></div>
        {/each}
      </div>
    </div>
  {:else if displayLines.length === 0}
    <div class="flex-1 overflow-y-auto t-mono-log bg-(--surface-sunken)">
      <div class="text-(--fg3) text-center py-6">No logs available</div>
    </div>
  {:else}
    <VirtualLogList
      bind:this={list}
      items={displayLines}
      getKey={logLineKey}
      class="flex-1 t-mono-log bg-(--surface-sunken)"
      onscrollstate={(pinned) => (autoScroll = pinned)}
    >
      {#snippet row(line, _index)}
        <LogRow {line} nowMs={now} />
      {/snippet}
    </VirtualLogList>
  {/if}
</div>
