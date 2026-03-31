<script lang="ts">
  import { getEndpointConfig, updateEndpoint, getEndpoints, type UpdateEndpointParams } from '$lib/api';
  import { selectedEndpoint, endpoints } from '$lib/stores';

  type TransportType = 'stdio' | 'sse' | 'http';

  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let success = $state('');
  let originalName = $state('');

  // Form fields
  let transport: TransportType = $state('stdio');
  let name = $state('');
  let description = $state('');
  let command = $state('');
  let args = $state('');
  let url = $state('');
  let envVars: { key: string; value: string }[] = $state([]);
  let headerVars: { key: string; value: string }[] = $state([]);

  $effect(() => {
    const epName = $selectedEndpoint;
    if (!epName) return;
    loading = true;
    error = '';
    success = '';
    getEndpointConfig(epName)
      .then((config) => {
        originalName = config.name;
        name = config.name;
        transport = config.transport as TransportType;
        description = config.description ?? '';
        command = config.command ?? '';
        args = config.args ? config.args.join(' ') : '';
        url = config.url ?? '';
        envVars = config.env
          ? Object.entries(config.env).map(([key, value]) => ({ key, value }))
          : [];
        headerVars = config.headers
          ? Object.entries(config.headers).map(([key, value]) => ({ key, value }))
          : [];
      })
      .catch(() => {
        error = 'Unable to load endpoint configuration';
      })
      .finally(() => { loading = false; });
  });

  async function handleSave() {
    error = '';
    success = '';
    if (!name.trim()) { error = 'Name is required'; return; }

    const params: UpdateEndpointParams = {
      originalName,
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

    // Build env from key-value pairs
    const env: Record<string, string> = {};
    const filteredEnv = envVars.filter((e) => e.key.trim());
    for (const e of filteredEnv) {
      env[e.key.trim()] = e.value;
    }
    if (Object.keys(env).length > 0) {
      params.env = env;
    }

    // Build headers from key-value pairs
    if (transport !== 'stdio') {
      const headers: Record<string, string> = {};
      const filteredHeaders = headerVars.filter((h) => h.key.trim());
      for (const h of filteredHeaders) {
        headers[h.key.trim()] = h.value;
      }
      if (Object.keys(headers).length > 0) {
        params.headers = headers;
      }
    }

    saving = true;
    try {
      await updateEndpoint(params);
      originalName = params.name;
      // Refresh endpoint list
      try {
        const data = await getEndpoints();
        endpoints.set(data);
      } catch {
        // Will be picked up by next poll
      }
      // If name changed, update selected endpoint
      if (params.name !== $selectedEndpoint) {
        selectedEndpoint.set(params.name);
      }
      success = 'Configuration saved';
      setTimeout(() => { success = ''; }, 3000);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }
</script>

<div class="h-full flex flex-col">
  <div class="px-4 py-2 border-b border-(--color-border)">
    <span class="text-xs text-(--color-text-secondary)">Endpoint Configuration</span>
  </div>
  <div class="flex-1 overflow-y-auto p-4">
    {#if loading}
      <div class="space-y-3">
        {#each [1, 2, 3, 4] as _}
          <div class="space-y-1">
            <div class="h-3 w-16 rounded bg-(--color-surface-hover) animate-pulse"></div>
            <div class="h-8 w-full rounded bg-(--color-surface-hover) animate-pulse"></div>
          </div>
        {/each}
      </div>
    {:else}
      <div class="space-y-3 max-w-lg">
        <!-- Transport selector -->
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
          <label for="config-ep-name" class="block text-xs font-medium mb-1 text-(--color-text-secondary)">Name</label>
          <input id="config-ep-name" type="text" bind:value={name} placeholder="my-server"
            class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent)" />
        </div>

        <div>
          <label for="config-ep-desc" class="block text-xs font-medium mb-1 text-(--color-text-secondary)">Description <span class="text-(--color-text-secondary)/50">(optional)</span></label>
          <input id="config-ep-desc" type="text" bind:value={description} placeholder="Brief description of this server"
            class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent)" />
        </div>

        {#if transport === 'stdio'}
          <div>
            <label for="config-ep-cmd" class="block text-xs font-medium mb-1 text-(--color-text-secondary)">Command</label>
            <input id="config-ep-cmd" type="text" bind:value={command} placeholder="npx"
              class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent)" />
          </div>
          <div>
            <label for="config-ep-args" class="block text-xs font-medium mb-1 text-(--color-text-secondary)">Arguments <span class="text-(--color-text-secondary)/50">(space-separated)</span></label>
            <input id="config-ep-args" type="text" bind:value={args} placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
              class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent)" />
          </div>
        {:else}
          <div>
            <label for="config-ep-url" class="block text-xs font-medium mb-1 text-(--color-text-secondary)">URL</label>
            <input id="config-ep-url" type="text" bind:value={url} placeholder={transport === 'sse' ? 'http://localhost:3000/sse' : 'http://localhost:3000/mcp'}
              class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent)" />
          </div>
        {/if}

        <!-- Environment Variables -->
        <div>
          <div class="flex items-center justify-between mb-1">
            <span class="block text-xs font-medium text-(--color-text-secondary)">
              Environment Variables
              <span class="text-(--color-text-secondary)/50">(optional)</span>
            </span>
            <button
              type="button"
              class="text-xs text-(--color-accent) hover:text-(--color-accent-hover)"
              onclick={() => envVars = [...envVars, { key: '', value: '' }]}
            >
              + Add
            </button>
          </div>
          {#each envVars as envVar, i}
            <div class="flex gap-1 mb-1">
              <input type="text" bind:value={envVar.key} placeholder="KEY"
                class="flex-1 text-sm px-2 py-1 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent) font-mono" />
              <input type="text" bind:value={envVar.value} placeholder="value or $ENV_VAR"
                class="flex-1 text-sm px-2 py-1 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent) font-mono" />
              <button
                type="button"
                class="text-xs px-1.5 text-(--color-text-secondary) hover:text-(--color-offline)"
                onclick={() => envVars = envVars.filter((_, idx) => idx !== i)}
              >✕</button>
            </div>
          {/each}
        </div>

        <!-- HTTP Headers (SSE/HTTP only) -->
        {#if transport !== 'stdio'}
          <div>
            <div class="flex items-center justify-between mb-1">
              <span class="block text-xs font-medium text-(--color-text-secondary)">
                HTTP Headers
                <span class="text-(--color-text-secondary)/50">(optional)</span>
              </span>
              <button
                type="button"
                class="text-xs text-(--color-accent) hover:text-(--color-accent-hover)"
                onclick={() => headerVars = [...headerVars, { key: '', value: '' }]}
              >
                + Add
              </button>
            </div>
            {#each headerVars as header, i}
              <div class="flex gap-1 mb-1">
                <input type="text" bind:value={header.key} placeholder="Header-Name"
                  class="flex-1 text-sm px-2 py-1 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent) font-mono" />
                <input type="text" bind:value={header.value} placeholder="value or $ENV_VAR"
                  class="flex-1 text-sm px-2 py-1 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent) font-mono" />
                <button
                  type="button"
                  class="text-xs px-1.5 text-(--color-text-secondary) hover:text-(--color-offline)"
                  onclick={() => headerVars = headerVars.filter((_, idx) => idx !== i)}
                >✕</button>
              </div>
            {/each}
          </div>
        {/if}

        {#if error}
          <p class="text-xs text-(--color-offline)">{error}</p>
        {/if}

        {#if success}
          <p class="text-xs text-green-600 dark:text-green-400">{success}</p>
        {/if}

        <div class="flex justify-end pt-2">
          <button
            class="px-3 py-1.5 text-sm rounded-lg bg-(--color-accent) text-white hover:bg-(--color-accent-hover) transition-colors disabled:opacity-50"
            onclick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>
