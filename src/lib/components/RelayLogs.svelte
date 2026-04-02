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
      case 'error': return 'text-red-400';
      case 'warn': return 'text-yellow-400';
      default: return 'text-(--color-text)';
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
  <div class="px-4 py-2 border-b border-(--color-border) flex items-center justify-between">
    <span class="text-xs text-(--color-text-secondary)">{$relayLogLines.length} lines</span>
    <div class="flex items-center gap-2">
      {#if !autoScroll}
        <button
          class="px-2.5 py-1 text-xs rounded-lg border border-(--color-border) hover:bg-(--color-surface-hover) transition-colors"
          onclick={goToEnd}
        >Go to end</button>
      {/if}
      <button
        class="px-2.5 py-1 text-xs rounded-lg border border-(--color-border) hover:bg-(--color-surface-hover) transition-colors"
        onclick={clearLogs}
      >Clear</button>
    </div>
  </div>
  <div
    bind:this={scrollContainer}
    onscroll={handleScroll}
    class="flex-1 overflow-y-auto p-4 font-mono text-xs leading-5 bg-(--color-surface-alt)"
  >
    {#if $relayLogLines.length === 0}
      <div class="text-(--color-text-secondary) text-center py-6">
        No relay logs yet. Logs will appear here when the relay sidecar produces output.
      </div>
    {:else}
      {#each $relayLogLines as line, i}
        <div class="hover:bg-(--color-surface-hover) px-1 rounded whitespace-pre-wrap break-all {levelColor(line.level)}">
          <span class="text-(--color-text-secondary) select-none">{line.timestamp}</span>
          {' '}{line.message}
        </div>
      {/each}
    {/if}
  </div>
</div>

