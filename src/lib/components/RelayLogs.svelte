<script lang="ts">
  import { relayLogLines, activeTopLevelTab } from '$lib/stores';
  import type { LogLevel, ParsedLogLine } from '$lib/logParser';
  import LogFilterBar from './LogFilterBar.svelte';
  import LogRow from './LogRow.svelte';
  import VirtualLogList from './VirtualLogList.svelte';
  import { lineKey, toggleEndpointFilter } from './relay-logs-helpers';

  type Props = {
    ongotoendpoint?: (name: string) => void;
  };
  let { ongotoendpoint }: Props = $props();

  // Rows render through the shared VirtualLogList; `list` exposes its
  // scrollToBottom API and `autoScroll` mirrors its pinned state.
  let list: VirtualLogList<ParsedLogLine> | undefined = $state();
  let autoScroll = $state(true);

  // Right-click "Go to endpoint" context menu state. `null` = no menu open.
  let contextMenu = $state<{ x: number; y: number; endpoint: string } | null>(null);

  // Filter state — local, not persisted (engineering spec §2.2).
  let activeLevels = $state<Set<LogLevel>>(new Set(['error', 'warn', 'info', 'debug', 'trace']));
  let selectedEndpoints = $state<Set<string>>(new Set());
  let selectedProfiles = $state<Set<string>>(new Set());
  let searchText = $state('');
  let toolCallsOnly = $state(false);

  // Hover tooltip clock — ticks every second only while this tab is visible
  // so we don't keep firing $effect updates in the background (spec §2.6).
  let now = $state(Date.now());
  $effect(() => {
    if ($activeTopLevelTab !== 'relay-logs') return;
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });

  const filteredLines = $derived.by(() => {
    const q = searchText.trim().toLowerCase();
    const hasEndpointFilter = selectedEndpoints.size > 0;
    const hasProfileFilter = selectedProfiles.size > 0;
    return $relayLogLines.filter((line) => {
      if (!activeLevels.has(line.level)) return false;
      if (toolCallsOnly && !line.isToolCall) return false;
      if (hasEndpointFilter) {
        if (!line.endpoint || !selectedEndpoints.has(line.endpoint)) return false;
      }
      if (hasProfileFilter) {
        if (!line.profile || !selectedProfiles.has(line.profile)) return false;
      }
      if (q.length > 0 && !line.raw.toLowerCase().includes(q)) return false;
      return true;
    });
  });

  // Auto-scroll while pinned, tail-follow when new lines arrive, and re-pin
  // when this tab flips from display:none back to visible are all handled
  // inside VirtualLogList; it reports pinned-state flips here so the
  // "Go to end" button can react.
  function onScrollState(pinned: boolean) {
    autoScroll = pinned;
  }

  // Re-pin and scroll to the last row via the component API — no
  // scrollHeight/scrollTop work against the full list.
  function goToEnd() {
    list?.scrollToBottom();
  }

  function clearLogs() {
    relayLogLines.set([]);
  }

  const trimmedSearch = $derived(searchText.trim());

  function onEndpointClick(name: string) {
    selectedEndpoints = toggleEndpointFilter(selectedEndpoints, name);
  }

  function onEndpointContextMenu(event: MouseEvent, name: string) {
    event.preventDefault();
    contextMenu = { x: event.clientX, y: event.clientY, endpoint: name };
  }

  function closeContextMenu() {
    contextMenu = null;
  }

  function onGoToEndpoint(name: string) {
    closeContextMenu();
    ongotoendpoint?.(name);
  }

  // Close the context menu on any outside click or Escape.
  $effect(() => {
    if (!contextMenu) return;
    const onDown = () => closeContextMenu();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeContextMenu();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  });

</script>

<div class="h-full flex flex-col">
  <LogFilterBar
    lines={$relayLogLines}
    filteredCount={filteredLines.length}
    bind:activeLevels
    bind:selectedEndpoints
    bind:selectedProfiles
    bind:searchText
    bind:toolCallsOnly
    onclear={clearLogs}
  />
  <div class="px-4 py-1 border-b border-(--border) bg-(--hd-bg) flex items-center justify-end">
    {#if !autoScroll}
      <button class="btn-sec btn-sm" onclick={goToEnd}>Go to end</button>
    {/if}
  </div>
  {#if $relayLogLines.length === 0}
    <div class="flex-1 overflow-y-auto t-mono-log bg-(--surface-sunken)">
      <div class="text-(--fg3) text-center py-6">
        No relay logs yet. Logs will appear here when the relay sidecar produces output.
      </div>
    </div>
  {:else if filteredLines.length === 0}
    <div class="flex-1 overflow-y-auto t-mono-log bg-(--surface-sunken)">
      <div class="text-(--fg3) text-center py-6">
        No lines match the current filters.
      </div>
    </div>
  {:else}
    <VirtualLogList
      bind:this={list}
      items={filteredLines}
      getKey={lineKey}
      class="flex-1 t-mono-log bg-(--surface-sunken)"
      onscrollstate={onScrollState}
    >
      {#snippet row(line: ParsedLogLine)}
        {@const isActive = !!line.endpoint && selectedEndpoints.size === 1 && selectedEndpoints.has(line.endpoint)}
        <LogRow
          {line}
          isActiveEndpoint={isActive}
          searchQuery={trimmedSearch}
          nowMs={now}
          onEndpointClick={onEndpointClick}
          onEndpointContextMenu={onEndpointContextMenu}
        />
      {/snippet}
    </VirtualLogList>
  {/if}

  {#if contextMenu}
    <ul
      role="menu"
      class="fixed z-20 min-w-[10rem] rounded-md border border-(--border) bg-(--surface) shadow-lg text-sm py-1"
      style:left="{contextMenu.x}px"
      style:top="{contextMenu.y}px"
    >
      <li role="none">
        <button
          type="button"
          role="menuitem"
          class="w-full text-left px-3 py-1.5 hover:bg-(--surface-hover)"
          onclick={() => onGoToEndpoint(contextMenu!.endpoint)}
        >
          Go to endpoint
        </button>
      </li>
    </ul>
  {/if}
</div>
