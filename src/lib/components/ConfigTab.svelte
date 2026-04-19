<script lang="ts">
  import { getEndpointConfig, updateEndpoint, getEndpoints, type UpdateEndpointParams } from '$lib/api';
  import { selectedEndpoint, endpoints } from '$lib/stores';
  import { sanitizeName } from '$lib/utils';

  type TransportType = 'stdio' | 'sse' | 'http' | 'oauth';

  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let success = $state('');
  let originalName = $state('');

  // Form fields
  let transport: TransportType = $state('stdio');
  let name = $state('');
  let prefix = $state('');
  let prefixCustom = $state(false);
  let description = $state('');
  let command = $state('');
  let args = $state('');
  let url = $state('');
  let envVars: { key: string; value: string }[] = $state([]);
  let headerVars: { key: string; value: string }[] = $state([]);
  let oauthServerUrl = $state('');
  let clientId = $state('');
  let clientSecret = $state('');
  let scopes = $state('');

  // Original value snapshots for dirty-state tracking
  let originalTransport: TransportType = $state('stdio');
  let originalPrefix = $state('');
  let originalPrefixCustom = $state(false);
  let originalDescription = $state('');
  let originalCommand = $state('');
  let originalArgs = $state('');
  let originalUrl = $state('');
  let originalEnvVars = $state('[]');
  let originalHeaderVars = $state('[]');
  let originalOauthServerUrl = $state('');
  let originalClientId = $state('');
  let originalClientSecret = $state('');
  let originalScopes = $state('');

  function snapshotOriginals() {
    originalTransport = transport;
    originalPrefix = prefix;
    originalPrefixCustom = prefixCustom;
    originalDescription = description;
    originalCommand = command;
    originalArgs = args;
    originalUrl = url;
    originalEnvVars = JSON.stringify(envVars);
    originalHeaderVars = JSON.stringify(headerVars);
    originalOauthServerUrl = oauthServerUrl;
    originalClientId = clientId;
    originalClientSecret = clientSecret;
    originalScopes = scopes;
  }

  let prefixPreview = $derived(prefix ? `${prefix}__tool` : 'prefix__tool');

  let isDirty = $derived(
    name !== originalName ||
    transport !== originalTransport ||
    prefix !== originalPrefix ||
    prefixCustom !== originalPrefixCustom ||
    description !== originalDescription ||
    command !== originalCommand ||
    args !== originalArgs ||
    url !== originalUrl ||
    JSON.stringify(envVars) !== originalEnvVars ||
    JSON.stringify(headerVars) !== originalHeaderVars ||
    oauthServerUrl !== originalOauthServerUrl ||
    clientId !== originalClientId ||
    clientSecret !== originalClientSecret ||
    scopes !== originalScopes
  );

  $effect(() => {
    if (!prefixCustom) {
      prefix = sanitizeName(name);
    }
  });

  // Clear stale success message when user makes a new change
  $effect(() => {
    if (isDirty && success) {
      success = '';
    }
  });

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
        if (config.tool_prefix !== undefined) {
          prefixCustom = true;
          prefix = config.tool_prefix;
        } else {
          prefixCustom = false;
          prefix = sanitizeName(config.name);
        }
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
        oauthServerUrl = config.oauth_server_url ?? '';
        clientId = config.client_id ?? '';
        clientSecret = config.client_secret ?? '';
        scopes = config.scopes ?? '';
        snapshotOriginals();
      })
      .catch(() => {
        error = 'Unable to load endpoint configuration';
      })
      .finally(() => { loading = false; });
  });

  function handlePrefixInput(value: string) {
    prefixCustom = true;
    prefix = sanitizeName(value);
  }

  function resetPrefix() {
    prefixCustom = false;
    prefix = sanitizeName(name);
  }

  async function handleSave() {
    error = '';
    success = '';
    if (!name.trim()) { error = 'Name is required'; return; }
    const trimmedName = name.trim();
    const defaultPrefix = sanitizeName(trimmedName);

    const params: UpdateEndpointParams = {
      original_name: originalName,
      name: trimmedName,
      transport,
    };

    if (prefixCustom && prefix !== defaultPrefix) {
      params.tool_prefix = prefix;
    }

    if (description.trim()) {
      params.description = description.trim();
    }

    if (transport === 'stdio') {
      if (!command.trim()) { error = 'Command is required for stdio'; return; }
      params.command = command.trim();
      if (args.trim()) {
        params.args = args.trim().split(/\s+/);
      }
    } else if (transport === 'oauth') {
      if (!url.trim()) { error = 'Server URL is required'; return; }
      params.url = url.trim();
      if (oauthServerUrl.trim()) params.oauth_server_url = oauthServerUrl.trim();
      if (clientId.trim()) params.client_id = clientId.trim();
      if (clientSecret.trim()) params.client_secret = clientSecret.trim();
      if (scopes.trim()) params.scopes = scopes.trim();
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
      snapshotOriginals();
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
  <div class="px-4 py-2 border-b border-(--border) bg-(--hd-bg)">
    <span class="text-xs text-(--fg3)">Endpoint Configuration</span>
  </div>
  <div class="flex-1 overflow-y-auto p-4">
    {#if loading}
      <div class="space-y-3">
        {#each [1, 2, 3, 4] as _}
          <div class="space-y-1">
            <div class="h-3 w-16 rounded bg-(--surface-hover) animate-pulse"></div>
            <div class="h-8 w-full rounded bg-(--surface-hover) animate-pulse"></div>
          </div>
        {/each}
      </div>
    {:else}
      <div class="cfg-form space-y-3 max-w-lg">
        <!-- Transport selector -->
        <fieldset class="border-none p-0 m-0">
          <legend class="block text-xs font-medium mb-1 text-(--fg2)">Transport</legend>
          <div class="flex gap-2">
            {#each ['stdio', 'sse', 'http', 'oauth'] as t}
              <button
                class="px-3 py-1.5 text-xs rounded-lg border transition-colors
                  {transport === t
                    ? 'border-(--accent) bg-(--accent)/10 text-(--accent)'
                    : 'border-(--border) hover:bg-(--surface-hover) text-(--fg2)'}"
                onclick={() => transport = t as TransportType}
              >
                {t.toUpperCase()}
              </button>
            {/each}
          </div>
        </fieldset>

        <div>
          <label for="config-ep-name" class="block text-xs font-medium mb-1 text-(--fg2)">Name</label>
          <input id="config-ep-name" type="text" bind:value={name} placeholder="my-server"
            class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)" />
        </div>

        <div>
          <div class="flex items-center justify-between mb-1 gap-2">
            <label for="config-ep-prefix" class="block text-xs font-medium text-(--fg2)">Tool Prefix</label>
            {#if prefixCustom}
              <button
                type="button"
                class="text-[11px] text-(--accent) hover:text-(--accent-hover)"
                onclick={resetPrefix}
              >
                Reset
              </button>
            {/if}
          </div>
          <input
            id="config-ep-prefix"
            type="text"
            value={prefix}
            oninput={(event) => handlePrefixInput((event.currentTarget as HTMLInputElement).value)}
            placeholder={sanitizeName(name) || 'tool_prefix'}
            class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)"
          />
          <p class="text-[11px] text-(--fg2) mt-0.5">
            Auto-generated from the name. Tools will be named like {prefixPreview}.
          </p>
        </div>

        <div>
          <label for="config-ep-desc" class="block text-xs font-medium mb-1 text-(--fg2)">Description <span class="text-(--fg2)/50">(optional)</span></label>
          <input id="config-ep-desc" type="text" bind:value={description} placeholder="Brief description of this server"
            class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)" />
        </div>

        {#if transport === 'stdio'}
          <div>
            <label for="config-ep-cmd" class="block text-xs font-medium mb-1 text-(--fg2)">Command</label>
            <input id="config-ep-cmd" type="text" bind:value={command} placeholder="npx"
              class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)" />
          </div>
          <div>
            <label for="config-ep-args" class="block text-xs font-medium mb-1 text-(--fg2)">Arguments <span class="text-(--fg2)/50">(space-separated)</span></label>
            <input id="config-ep-args" type="text" bind:value={args} placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
              class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)" />
          </div>
        {:else if transport === 'oauth'}
          <div>
            <label for="config-ep-url" class="block text-xs font-medium mb-1 text-(--fg2)">Server URL</label>
            <input id="config-ep-url" type="text" bind:value={url} placeholder="https://api.githubcopilot.com/mcp/"
              class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)" />
          </div>
          <details class="border border-(--border) rounded-lg">
            <summary class="px-3 py-2 text-xs font-medium text-(--fg2) cursor-pointer hover:bg-(--surface-hover) rounded-lg select-none">Advanced</summary>
            <div class="px-3 pb-3 space-y-3">
              <div>
                <label for="config-ep-oauth-server" class="block text-xs font-medium mb-1 text-(--fg2)">OAuth Server URL</label>
                <input id="config-ep-oauth-server" type="text" bind:value={oauthServerUrl} placeholder="Auto-discovered"
                  class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)" />
                <p class="text-[11px] text-(--fg2) mt-0.5">Leave blank to auto-discover via RFC 9728</p>
              </div>
              <div>
                <label for="config-ep-client-id" class="block text-xs font-medium mb-1 text-(--fg2)">Client ID</label>
                <input id="config-ep-client-id" type="text" bind:value={clientId} placeholder="Auto via Dynamic Client Registration"
                  class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)" />
              </div>
              <div>
                <label for="config-ep-client-secret" class="block text-xs font-medium mb-1 text-(--fg2)">Client Secret <span class="text-(--fg2)/50">(optional)</span></label>
                <input id="config-ep-client-secret" type="text" bind:value={clientSecret} placeholder=""
                  class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)" />
              </div>
              <div>
                <label for="config-ep-scopes" class="block text-xs font-medium mb-1 text-(--fg2)">Scopes <span class="text-(--fg2)/50">(space-separated)</span></label>
                <input id="config-ep-scopes" type="text" bind:value={scopes} placeholder="repo read:user"
                  class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)" />
              </div>
            </div>
          </details>
        {:else}
          <div>
            <label for="config-ep-url" class="block text-xs font-medium mb-1 text-(--fg2)">URL</label>
            <input id="config-ep-url" type="text" bind:value={url} placeholder={transport === 'sse' ? 'http://localhost:3000/sse' : 'http://localhost:3000/mcp'}
              class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)" />
          </div>
        {/if}

        <!-- Environment Variables -->
        <div>
          <div class="flex items-center justify-between mb-1">
            <span class="block text-xs font-medium text-(--fg2)">
              Environment Variables
              <span class="text-(--fg2)/50">(optional)</span>
            </span>
            <button
              type="button"
              class="text-xs text-(--accent) hover:text-(--accent-hover)"
              onclick={() => envVars = [...envVars, { key: '', value: '' }]}
            >
              + Add
            </button>
          </div>
          {#each envVars as envVar, i}
            <div class="flex gap-1 mb-1">
              <input type="text" bind:value={envVar.key} placeholder="KEY"
                class="flex-1 text-sm px-2 py-1 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent) font-mono" />
              <input type="text" bind:value={envVar.value} placeholder="value or $ENV_VAR"
                class="flex-1 text-sm px-2 py-1 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent) font-mono" />
              <button
                type="button"
                class="text-xs px-1.5 text-(--fg2) hover:text-(--offline)"
                onclick={() => envVars = envVars.filter((_, idx) => idx !== i)}
              >✕</button>
            </div>
          {/each}
        </div>

        <!-- HTTP Headers (SSE/HTTP only) -->
        {#if transport !== 'stdio'}
          <div>
            <div class="flex items-center justify-between mb-1">
              <span class="block text-xs font-medium text-(--fg2)">
                HTTP Headers
                <span class="text-(--fg2)/50">(optional)</span>
              </span>
              <button
                type="button"
                class="text-xs text-(--accent) hover:text-(--accent-hover)"
                onclick={() => headerVars = [...headerVars, { key: '', value: '' }]}
              >
                + Add
              </button>
            </div>
            {#each headerVars as header, i}
              <div class="flex gap-1 mb-1">
                <input type="text" bind:value={header.key} placeholder="Header-Name"
                  class="flex-1 text-sm px-2 py-1 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent) font-mono" />
                <input type="text" bind:value={header.value} placeholder="value or $ENV_VAR"
                  class="flex-1 text-sm px-2 py-1 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent) font-mono" />
                <button
                  type="button"
                  class="text-xs px-1.5 text-(--fg2) hover:text-(--offline)"
                  onclick={() => headerVars = headerVars.filter((_, idx) => idx !== i)}
                >✕</button>
              </div>
            {/each}
          </div>
        {/if}

        {#if error}
          <p class="text-xs text-(--offline)">{error}</p>
        {/if}

        {#if success}
          <p class="text-xs text-green-600 dark:text-green-400">{success}</p>
        {/if}

        <div class="flex justify-end pt-2">
          <button
            class="px-3 py-1.5 text-sm rounded-lg bg-(--accent) text-white hover:bg-(--accent-hover) transition-colors disabled:opacity-50"
            onclick={handleSave}
            disabled={!isDirty || saving}
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>


<style>
  /* Kit-styled inputs scoped to the endpoint configuration form. */
  .cfg-form :global(input[type="text"]) {
    font-size: 13px;
    padding: 8px 10px;
    border-radius: 6px;
    border-color: var(--border);
    background: var(--surface);
    color: var(--fg1);
    transition: border-color 150ms var(--ease), box-shadow 150ms var(--ease);
  }
  .cfg-form :global(input[type="text"]::placeholder) {
    color: var(--fg3);
  }
  .cfg-form :global(input[type="text"]:focus) {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-tint);
    outline: none;
  }
  /* Labels and legends */
  .cfg-form :global(label),
  .cfg-form :global(legend) {
    font-size: 12px;
    font-weight: 500;
    color: var(--fg2);
  }
</style>
