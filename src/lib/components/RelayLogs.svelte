<script lang="ts">
  import { tick } from 'svelte';
  import { relayLogLines, activeTopLevelTab } from '$lib/stores';
  import type { LogLevel } from '$lib/logParser';
  import { isAtBottom } from '$lib/scrollUtils';
  import LogFilterBar from './LogFilterBar.svelte';
  import LogRow from './LogRow.svelte';
  import { toggleEndpointFilter } from './relay-logs-helpers';

  type Props = {
    ongotoendpoint?: (name: string) => void;
  };
  let { ongotoendpoint }: Props = $props();

  let scrollContainer: HTMLDivElement | undefined = $state();
  let autoScroll = $state(true);
  let isTabSwitching = $state(false);

  // Right-click "Go to endpoint" context menu state. `null` = no menu open.
  let contextMenu = $state<{ x: number; y: number; endpoint: string } | null>(null);

  // Filter state — local, not persisted (engineering spec §2.2).
  let activeLevels = $state<Set<LogLevel>>(new Set(['error', 'warn', 'info', 'debug', 'trace']));
  let selectedEndpoints = $state<Set<string>>(new Set());
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
    return $relayLogLines.filter((line) => {
      if (!activeLevels.has(line.level)) return false;
      if (toolCallsOnly && !line.isToolCall) return false;
      if (hasEndpointFilter) {
        if (!line.endpoint || !selectedEndpoints.has(line.endpoint)) return false;
      }
      if (q.length > 0 && !line.raw.toLowerCase().includes(q)) return false;
      return true;
    });
  });

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

  function clearLogs() {
    relayLogLines.set([]);
  }

  // Auto-scroll when new lines arrive (subscribe to filtered list so toggling
  // a level back on also pins us to bottom).
  $effect(() => {
    filteredLines;
    scrollToBottom();
  });

  // Force scroll when switching back to the relay-logs tab.
  $effect(() => {
    const tab = $activeTopLevelTab;
    if (tab === 'relay-logs' && autoScroll && scrollContainer) {
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
    bind:searchText
    bind:toolCallsOnly
    onclear={clearLogs}
  />
  <div class="px-4 py-1 border-b border-(--border) bg-(--hd-bg) flex items-center justify-end">
    {#if !autoScroll}
      <button class="btn-sec btn-sm" onclick={goToEnd}>Go to end</button>
    {/if}
  </div>
  <div
    bind:this={scrollContainer}
    onscroll={handleScroll}
    class="flex-1 overflow-y-auto t-mono-log bg-(--surface-sunken)"
  >
    {#if $relayLogLines.length === 0}
      <div class="text-(--fg3) text-center py-6">
        No relay logs yet. Logs will appear here when the relay sidecar produces output.
      </div>
    {:else if filteredLines.length === 0}
      <div class="text-(--fg3) text-center py-6">
        No lines match the current filters.
      </div>
    {:else}
      {#each filteredLines as line (line)}
        {@const isActive = !!line.endpoint && selectedEndpoints.size === 1 && selectedEndpoints.has(line.endpoint)}
        <LogRow
          {line}
          isActiveEndpoint={isActive}
          searchQuery={trimmedSearch}
          nowMs={now}
          onEndpointClick={onEndpointClick}
          onEndpointContextMenu={onEndpointContextMenu}
        />
      {/each}
    {/if}
  </div>

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
