<script lang="ts">
  import { addEndpoint, getEndpoints, type AddEndpointParams } from '$lib/api';
  import { endpoints, selectedEndpoint } from '$lib/stores';

  type TransportType = 'stdio' | 'sse' | 'http';

  let { onclose }: { onclose: () => void } = $props();

  let transport: TransportType = $state('stdio');
  let name = $state('');
  let description = $state('');
  let command = $state('');
  let args = $state('');
  let url = $state('');
  let submitting = $state(false);
  let error = $state('');

  async function handleSubmit() {
    error = '';
    if (!name.trim()) { error = 'Name is required'; return; }

    const params: AddEndpointParams = {
      name: name.trim(),
      transport,
    };

    if (description.trim()) {
      params.description = description.trim();
    }

    if (transport === 'stdio') {
      if (!command.trim()) { error = 'Command is required for stdio'; return; }
      params.command = command.trim();
      if (args.trim()) {
        params.args = args.trim().split(/\s+/);
      }
    } else {
      if (!url.trim()) { error = 'URL is required'; return; }
      params.url = url.trim();
    }

    submitting = true;
    try {
      await addEndpoint(params);
      try {
        const data = await getEndpoints();
        endpoints.set(data);
      } catch {
        // Will be picked up by the next poll cycle
      }
      selectedEndpoint.set(name.trim());
      onclose();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      submitting = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onclick={onclose} onkeydown={handleKeydown}>
  <div
    class="bg-(--color-surface) rounded-xl shadow-xl border border-(--color-border) p-6 w-96 max-w-[90vw] max-h-[90vh] overflow-y-auto"
    role="dialog"
    aria-modal="true"
    aria-label="Add Server"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
  >
    <h3 class="text-base font-semibold mb-4 text-(--color-text)">Add Server</h3>

    <div class="space-y-3">
      <fieldset class="border-none p-0 m-0">
        <legend class="block text-xs font-medium mb-1 text-(--color-text-secondary)">Transport</legend>
        <div class="flex gap-2">
          {#each ['stdio', 'sse', 'http'] as t}
            <button
              class="px-3 py-1.5 text-xs rounded-lg border transition-colors
                {transport === t
                  ? 'border-(--color-accent) bg-(--color-accent)/10 text-(--color-accent)'
                  : 'border-(--color-border) hover:bg-(--color-surface-hover) text-(--color-text-secondary)'}"
              onclick={() => transport = t as TransportType}
            >
              {t.toUpperCase()}
            </button>
          {/each}
        </div>
      </fieldset>

      <div>
        <label for="modal-ep-name" class="block text-xs font-medium mb-1 text-(--color-text-secondary)">Name</label>
        <input id="modal-ep-name" type="text" bind:value={name} placeholder="my-server"
          class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent)" />
      </div>

      <div>
        <label for="modal-ep-desc" class="block text-xs font-medium mb-1 text-(--color-text-secondary)">Description <span class="text-(--color-text-secondary)/50">(optional)</span></label>
        <input id="modal-ep-desc" type="text" bind:value={description} placeholder="Brief description of this server"
          class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent)" />
      </div>

      {#if transport === 'stdio'}
        <div>
          <label for="modal-ep-cmd" class="block text-xs font-medium mb-1 text-(--color-text-secondary)">Command</label>
          <input id="modal-ep-cmd" type="text" bind:value={command} placeholder="npx"
            class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent)" />
        </div>
        <div>
          <label for="modal-ep-args" class="block text-xs font-medium mb-1 text-(--color-text-secondary)">Arguments <span class="text-(--color-text-secondary)/50">(space-separated)</span></label>
          <input id="modal-ep-args" type="text" bind:value={args} placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
            class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent)" />
        </div>
      {:else}
        <div>
          <label for="modal-ep-url" class="block text-xs font-medium mb-1 text-(--color-text-secondary)">URL</label>
          <input id="modal-ep-url" type="text" bind:value={url} placeholder={transport === 'sse' ? 'http://localhost:3000/sse' : 'http://localhost:3000/mcp'}
            class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent)" />
        </div>
      {/if}

      {#if error}
        <p class="text-xs text-(--color-offline)">{error}</p>
      {/if}

      <div class="flex justify-end gap-2 pt-2">
        <button
          class="px-3 py-1.5 text-sm rounded-lg border border-(--color-border) hover:bg-(--color-surface-hover) transition-colors"
          onclick={onclose}
        >
          Cancel
        </button>
        <button
          class="px-3 py-1.5 text-sm rounded-lg bg-(--color-accent) text-white hover:bg-(--color-accent-hover) transition-colors disabled:opacity-50"
          onclick={handleSubmit}
          disabled={submitting}
        >
          {submitting ? 'Adding…' : 'Add Server'}
        </button>
      </div>
    </div>
  </div>
</div>

