<script lang="ts">
  import { tick } from 'svelte';
  import { selectedEndpoint, relayLogLines, activeTab } from '$lib/stores';
  import { getEndpointLogs } from '$lib/api';
  import { isAtBottom } from '$lib/scrollUtils';
  import type { ParsedLogLine } from '$lib/logParser';
  import LogRow from './LogRow.svelte';
  import {
    parseHistoricalSeed,
    mergeDeduped,
    filterLinesForEndpoint,
  } from './logs-tab-helpers';

  // Live-streaming per-endpoint log view (engineering spec §2.3, Slice D.2).
  // Seeds with a one-shot fetch of the relay's in-memory ring for pre-mount
  // history, then appends every matching `relay-log` event in real time.
  // Display = historical ++ live, deduped by `raw` so an overlap doesn't
  // double up.

  let historical: ParsedLogLine[] = $state([]);
  let loading = $state(true);
  let scrollContainer: HTMLDivElement | undefined = $state();
  let autoScroll = $state(true);
  let isTabSwitching = $state(false);
  let now = $state(Date.now());

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
        requestAnimationFrame(() => {
          if (scrollContainer) {
            scrollContainer.scrollTop = scrollContainer.scrollHeight;
          }
        });
      });
  });

  const liveLines = $derived.by(() => {
    const name = $selectedEndpoint;
    if (!name) return [] as ParsedLogLine[];
    return filterLinesForEndpoint($relayLogLines, name);
  });

  const displayLines = $derived(mergeDeduped(historical, liveLines));

  function handleScroll() {
    if (!scrollContainer || isTabSwitching) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
    autoScroll = isAtBottom(scrollTop, scrollHeight, clientHeight);
  }

  async function scrollToBottom() {
    if (!autoScroll) return;
    await tick();
    requestAnimationFrame(() => {
      if (scrollContainer && autoScroll) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }
    });
  }

  function goToEnd() {
    autoScroll = true;
    tick().then(() => {
      requestAnimationFrame(() => {
        if (scrollContainer) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
      });
    });
  }

  // Clear empties the historical seed; live events keep streaming in for as
  // long as this endpoint stays selected (matches the spec wording — the
  // live filter "keeps appending").
  function clearLogs() {
    historical = [];
  }

  // Auto-scroll when new lines arrive.
  $effect(() => {
    displayLines;
    scrollToBottom();
  });

  // Force scroll when the user re-opens the Logs tab.
  $effect(() => {
    const tab = $activeTab;
    if (tab === 'logs' && autoScroll && scrollContainer) {
      isTabSwitching = true;
      const timer = setTimeout(() => {
        if (scrollContainer) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
        requestAnimationFrame(() => {
          isTabSwitching = false;
        });
      }, 50);
      return () => {
        clearTimeout(timer);
        isTabSwitching = false;
      };
    }
  });
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
  <div
    bind:this={scrollContainer}
    onscroll={handleScroll}
    class="flex-1 overflow-y-auto t-mono-log bg-(--surface-sunken)"
  >
    {#if loading}
      <div class="space-y-1 p-4">
        {#each [1, 2, 3, 4, 5] as _}
          <div class="h-4 w-3/4 rounded bg-(--surface-hover) animate-pulse"></div>
        {/each}
      </div>
    {:else if displayLines.length === 0}
      <div class="text-(--fg3) text-center py-6">No logs available</div>
    {:else}
      {#each displayLines as line (line)}
        <LogRow {line} nowMs={now} />
      {/each}
    {/if}
  </div>
</div>
