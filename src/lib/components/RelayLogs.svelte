<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { relayLogLines, activeTopLevelTab } from '$lib/stores';
  import type { LogLevel } from '$lib/logParser';
  import { isAtBottom } from '$lib/scrollUtils';
  import LogFilterBar from './LogFilterBar.svelte';
  import LogRow from './LogRow.svelte';
  import {
    resolvePendingHighlight,
    toggleEndpointFilter,
    waitForVisibleContainer,
  } from './relay-logs-helpers';

  /** Resolve after the browser has scheduled a paint (one animation frame). */
  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  /** Duration the matched row stays highlighted after an overlay:focus-log event. */
  const HIGHLIGHT_DURATION_MS = 2000;

  type Props = {
    ongotoendpoint?: (name: string) => void;
  };
  let { ongotoendpoint }: Props = $props();

  let scrollContainer: HTMLDivElement | undefined = $state();
  let autoScroll = $state(true);
  let isTabSwitching = $state(false);

  // Right-click "Go to endpoint" context menu state. `null` = no menu open.
  let contextMenu = $state<{ x: number; y: number; endpoint: string } | null>(null);

  // JSON-RPC id of the row currently painted with the fade-out highlight.
  // Set by the overlay:focus-log handler; cleared after HIGHLIGHT_DURATION_MS.
  let highlightedRequestId = $state<string | null>(null);
  let highlightTimer: ReturnType<typeof setTimeout> | null = null;
  // Cancels any in-flight pending-highlight poll (overlay click before the
  // target row has rendered). Replaced on each new click, cleared on destroy.
  let cancelPendingHighlight: (() => void) | null = null;
  // Bumped on every overlay:focus-log click so a stale visibility wait from an
  // earlier click bails instead of highlighting after a newer click superseded it.
  let highlightGeneration = 0;

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

  // Scroll the row at `idx` (within filteredLines) into view and paint the
  // fade-out highlight. The DOM query falls back to the last matching row if
  // the :nth-of-type selector did not resolve.
  function highlightRow(jsonrpcId: string, idx: number) {
    const container = scrollContainer;
    if (!container) return;
    const row = container.querySelector<HTMLElement>(
      `[data-request-id="${CSS.escape(jsonrpcId)}"]:nth-of-type(${idx + 1})`,
    );
    const rows = container.querySelectorAll<HTMLElement>(
      `[data-request-id="${CSS.escape(jsonrpcId)}"]`,
    );
    const target = row ?? rows[rows.length - 1];
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    highlightedRequestId = jsonrpcId;
    if (highlightTimer) clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => {
      highlightedRequestId = null;
      highlightTimer = null;
    }, HIGHLIGHT_DURATION_MS);
  }

  // Handle the overlay:focus-log window event. The host (Rust) emits this
  // from `focus_main_window_on_log` after focusing the main window. We:
  //   1. switch to the relay-logs tab,
  //   2. wait one tick so the scroll container is mounted + visible,
  //   3. find the latest row whose `requestId === logId`,
  //   4. scroll it into view (centered) and paint the fade-out highlight.
  //
  // The window may have just been brought back from a hidden/closed state, so
  // the target row can take a moment to mount/populate. When it is not found
  // synchronously we hold a short-lived pending highlight and poll until the
  // row appears or a ~2s budget elapses, instead of giving up after one pass.
  //
  // The relay-logs tab is rendered with `style:display:none` until activated,
  // so when the click arrives from another tab the container has no layout yet.
  // We await two animation frames (a layout + paint pass) and then poll its
  // dimensions before highlighting, otherwise the `forwards` CSS animation
  // finishes while the tab is hidden and the pulse is never seen.
  onMount(() => {
    let unlisten: UnlistenFn | undefined;
    listen<{ logId: string }>('overlay:focus-log', async (event) => {
      const { logId } = event.payload;
      if (!logId) return;
      const generation = ++highlightGeneration;
      activeTopLevelTab.set('relay-logs');
      // Disable auto-scroll so scrollIntoView is not immediately undone by
      // the bottom-pin effect when new log lines arrive mid-flight.
      autoScroll = false;
      // A newer click supersedes any unresolved pending highlight.
      cancelPendingHighlight?.();
      cancelPendingHighlight = null;
      await tick();
      // Two animation frames so the just-toggled tab gets a display:none→block
      // layout pass and a paint before we check its dimensions.
      await nextFrame();
      await nextFrame();
      if (generation !== highlightGeneration) return;
      const visible = await waitForVisibleContainer(() => scrollContainer, HIGHLIGHT_DURATION_MS);
      if (generation !== highlightGeneration) return;
      if (!visible) {
        console.warn(`[overlay] relay-logs tab never became visible for logId=${logId}`);
        return;
      }
      cancelPendingHighlight = resolvePendingHighlight({
        jsonrpcId: logId,
        getLines: () => filteredLines,
        onFound: (idx) => {
          // Wait one tick in case the row mounted on the same store update
          // that satisfied the poll, then scroll + highlight. Re-check the
          // generation after the tick so a newer click that arrived in the
          // meantime is not clobbered by this now-stale highlight.
          tick().then(() => {
            if (generation !== highlightGeneration) return;
            highlightRow(logId, idx);
          });
        },
        onTimeout: () => {
          console.warn(`[overlay] no log row found for logId=${logId}`);
        },
        budgetMs: HIGHLIGHT_DURATION_MS,
      });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
      cancelPendingHighlight?.();
      cancelPendingHighlight = null;
      if (highlightTimer) clearTimeout(highlightTimer);
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
          highlighted={highlightedRequestId !== null && line.requestId === highlightedRequestId}
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
