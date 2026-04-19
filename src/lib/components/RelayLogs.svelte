<script lang="ts">
  import { tick } from 'svelte';
  import { relayLogLines, activeTopLevelTab } from '$lib/stores';
  import type { RelayLogLine } from '$lib/stores';
  import { isAtBottom } from '$lib/scrollUtils';

  let scrollContainer: HTMLDivElement | undefined = $state();
  let autoScroll = $state(true);
  let isTabSwitching = $state(false);

  function handleScroll() {
    if (!scrollContainer || isTabSwitching) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
    autoScroll = isAtBottom(scrollTop, scrollHeight, clientHeight);
  }

  async function scrollToBottom() {
    if (!autoScroll) return;
    await tick(); // wait for Svelte to flush DOM updates
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

  function levelColor(level: string): string {
    switch (level) {
      case 'error': return 'text-(--offline)';
      case 'warn': return 'text-(--degraded)';
      default: return 'text-(--fg1)';
    }
  }

  // Auto-scroll when new lines arrive
  $effect(() => {
    $relayLogLines;  // subscribe to log changes
    scrollToBottom();
  });

  // Force scroll when switching back to relay-logs tab
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
</script>

<div class="h-full flex flex-col">
  <div class="px-4 py-2 border-b border-(--border) flex items-center justify-between bg-(--hd-bg)">
    <span class="text-xs text-(--fg3)">{$relayLogLines.length} lines</span>
    <div class="flex items-center gap-1.5">
      {#if !autoScroll}
        <button
          class="btn-sec"
          onclick={goToEnd}
        >Go to end</button>
      {/if}
      <button
        class="btn-sec"
        onclick={clearLogs}
      >Clear</button>
    </div>
  </div>
  <div
    bind:this={scrollContainer}
    onscroll={handleScroll}
    class="flex-1 overflow-y-auto p-4 t-mono-log bg-(--surface-sunken)"
  >
    {#if $relayLogLines.length === 0}
      <div class="text-(--fg3) text-center py-6">
        No relay logs yet. Logs will appear here when the relay sidecar produces output.
      </div>
    {:else}
      {#each $relayLogLines as line, i}
        <div class="hover:bg-(--surface-hover) px-1 rounded whitespace-pre-wrap break-all {levelColor(line.level)}">
          <span class="text-(--fg3) select-none">{line.timestamp}</span>
          {' '}{line.message}
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .btn-sec {
    padding: 4px 10px;
    font-size: 11px;
    line-height: 1.4;
    font-weight: 500;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: transparent;
    color: var(--fg1);
    cursor: pointer;
    font-family: inherit;
    transition: background-color 150ms var(--ease), color 150ms var(--ease);
  }
  .btn-sec:hover {
    background: var(--hover-bg);
  }
</style>

