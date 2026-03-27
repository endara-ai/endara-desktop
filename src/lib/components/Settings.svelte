<script lang="ts">
  import { theme, jsExecutionMode, isSettingsOpen } from '$lib/stores';
  import type { Theme } from '$lib/types';
  import { invoke } from '@tauri-apps/api/core';
  import { onMount } from 'svelte';

  interface BuildInfo {
    version: string;
    monorepo_commit: string;
    relay_commit: string;
    desktop_commit: string;
    build_date: string;
  }

  let buildInfo: BuildInfo | null = $state(null);

  function close() {
    isSettingsOpen.set(false);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
  }

  function setTheme(t: Theme) {
    theme.set(t);
  }

  onMount(async () => {
    try {
      buildInfo = await invoke<BuildInfo>('get_build_info');
    } catch (e) {
      console.error('Failed to get build info:', e);
    }
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onclick={close}>
  <div
    class="bg-(--color-surface) rounded-xl shadow-xl border border-(--color-border) p-6 w-96 max-w-[90vw]"
    onclick={(e) => e.stopPropagation()}
  >
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-lg font-semibold">Settings</h2>
      <button class="text-(--color-text-secondary) hover:text-(--color-text)" onclick={close}>
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>

    <div class="space-y-4">
      <div>
        <label class="block text-sm font-medium mb-1.5">Theme</label>
        <div class="flex gap-2">
          {#each ['light', 'dark', 'system'] as t}
            <button
              class="px-3 py-1.5 text-sm rounded-lg border transition-colors
                {$theme === t ? 'border-(--color-accent) bg-(--color-accent)/10 text-(--color-accent)' : 'border-(--color-border) hover:bg-(--color-surface-hover)'}"
              onclick={() => setTheme(t as Theme)}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          {/each}
        </div>
      </div>

      <div class="flex items-center justify-between">
        <div>
          <div class="text-sm font-medium">JS Execution Mode</div>
          <div class="text-xs text-(--color-text-secondary)">Allow JavaScript tool execution</div>
        </div>
        <button
          class="relative w-10 h-5 rounded-full transition-colors {$jsExecutionMode ? 'bg-(--color-accent)' : 'bg-(--color-border)'}"
          onclick={() => jsExecutionMode.update((v) => !v)}
        >
          <span class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform {$jsExecutionMode ? 'translate-x-5' : ''}"></span>
        </button>
      </div>
      {#if buildInfo}
        <div class="pt-4 mt-4 border-t border-(--color-border)">
          <div class="text-xs font-medium text-(--color-text-secondary) uppercase tracking-wide mb-2">About</div>
          <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <span class="text-(--color-text-secondary)">Version</span>
            <span>{buildInfo.version}</span>
            <span class="text-(--color-text-secondary)">Build Date</span>
            <span>{buildInfo.build_date}</span>
            <span class="text-(--color-text-secondary)">Desktop</span>
            <span class="font-mono text-[0.6875rem]">{buildInfo.desktop_commit}</span>
            <span class="text-(--color-text-secondary)">Relay</span>
            <span class="font-mono text-[0.6875rem]">{buildInfo.relay_commit}</span>
            <span class="text-(--color-text-secondary)">Monorepo</span>
            <span class="font-mono text-[0.6875rem]">{buildInfo.monorepo_commit}</span>
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>
