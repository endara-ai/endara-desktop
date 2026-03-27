<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import DetailPanel from '$lib/components/DetailPanel.svelte';
  import MiniPlayer from '$lib/components/MiniPlayer.svelte';
  import Settings from '$lib/components/Settings.svelte';
  import { endpoints, isSettingsOpen, miniPlayerMode } from '$lib/stores';
  import { getEndpoints } from '$lib/api';
  import { mockEndpoints } from '$lib/mock';

  let pollInterval: ReturnType<typeof setInterval> | undefined;
  let sidebar: Sidebar | undefined = $state();

  async function pollEndpoints() {
    try {
      const data = await getEndpoints();
      endpoints.set(data);
    } catch {
      // Use mock data if relay isn't running
      endpoints.update((current) => current.length === 0 ? mockEndpoints : current);
    }
  }

  onMount(() => {
    pollEndpoints();
    pollInterval = setInterval(pollEndpoints, 2000);
  });

  onDestroy(() => {
    if (pollInterval) clearInterval(pollInterval);
  });

  function handleGlobalKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === ',') {
      e.preventDefault();
      isSettingsOpen.update((v) => !v);
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      sidebar?.focusSearch();
    }
  }
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

{#if $miniPlayerMode}
  <MiniPlayer />
{:else}
  <div class="flex h-screen w-screen overflow-hidden">
    <Sidebar bind:this={sidebar} />
    <DetailPanel />
  </div>
{/if}

{#if $isSettingsOpen}
  <Settings />
{/if}
