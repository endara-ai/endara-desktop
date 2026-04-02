<script lang="ts">
  import { addEndpoint, getEndpoints, testConnection, startOAuth, getOAuthStatus, type AddEndpointParams, type TestConnectionParams } from '$lib/api';
  import { endpoints, selectedEndpoint } from '$lib/stores';
  import { toast } from 'svelte-sonner';
  import { CATALOG_SERVERS, type CatalogServer } from '$lib/catalog';
  import { sanitizeName } from '$lib/utils';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { open as dialogOpen } from '@tauri-apps/plugin-dialog';

  type TransportType = 'stdio' | 'sse' | 'http' | 'oauth';
  type Step = 'browse' | 'configure';

  let { onclose }: { onclose: () => void } = $props();

  let step: Step = $state('browse');
  let selectedCatalog: CatalogServer | null = $state(null);
  let search = $state('');

  // Configure step fields
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
  let catalogEnvValues: Record<string, string> = $state({});
  let userArgValues: string[] = $state([]);
  let submitting = $state(false);
  let error = $state('');
  let testing = $state(false);
  let testResult: { success: boolean; toolCount?: number; error?: string } | null = $state(null);
  let oauthServerUrl = $state('');
  let clientId = $state('');
  let clientSecret = $state('');
  let scopes = $state('');

  let prefixPreview = $derived(prefix ? `${prefix}__tool` : 'prefix__tool');

  $effect(() => {
    if (!prefixCustom) {
      prefix = sanitizeName(name);
    }
  });

  const CATEGORY_LABELS: Record<string, string> = {
    developer: 'Developer',
    search: 'Search',
    productivity: 'Productivity',
    data: 'Data',
  };

  let filteredServers = $derived(
    search.trim()
      ? CATALOG_SERVERS.filter((s) => {
          const q = search.toLowerCase();
          return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
        })
      : CATALOG_SERVERS,
  );

  function selectCatalog(server: CatalogServer) {
    selectedCatalog = server;
    name = server.name;
    prefixCustom = false;
    prefix = sanitizeName(server.name);
    description = server.description;
    transport = server.transport;
    command = server.command;
    args = server.args.join(' ');
    catalogEnvValues = {};
    userArgValues = server.userArgs ? server.userArgs.map(() => '') : [];
    envVars = [];
    headerVars = [];
    oauthServerUrl = '';
    clientId = '';
    clientSecret = '';
    scopes = '';
    error = '';
    step = 'configure';
  }

  function selectCustom() {
    selectedCatalog = null;
    name = '';
    prefixCustom = false;
    prefix = '';
    description = '';
    transport = 'stdio';
    command = '';
    args = '';
    url = '';
    envVars = [];
    headerVars = [];
    catalogEnvValues = {};
    userArgValues = [];
    oauthServerUrl = '';
    clientId = '';
    clientSecret = '';
    scopes = '';
    error = '';
    step = 'configure';
  }

  function goBack() {
    step = 'browse';
    error = '';
    testResult = null;
  }

  function handlePrefixInput(value: string) {
    prefixCustom = true;
    prefix = sanitizeName(value);
  }

  function resetPrefix() {
    prefixCustom = false;
    prefix = sanitizeName(name);
  }

  function buildConnectionParams(): TestConnectionParams {
    const params: TestConnectionParams = { transport };

    if (transport === 'stdio') {
      params.command = command.trim();
      let finalArgs: string[] = [];
      if (args.trim()) finalArgs = args.trim().split(/\s+/);
      if (selectedCatalog?.userArgs) {
        for (const val of userArgValues) {
          if (val.trim()) finalArgs.push(val.trim());
        }
      }
      if (finalArgs.length > 0) params.args = finalArgs;
    } else {
      params.url = url.trim();
    }

    // Build env
    const env: Record<string, string> = {};
    if (selectedCatalog) {
      for (const ev of selectedCatalog.envVars) {
        const val = catalogEnvValues[ev.name] ?? '';
        if (val.trim()) env[ev.name] = val.trim();
      }
    }
    for (const e of envVars.filter((e) => e.key.trim())) {
      env[e.key.trim()] = e.value;
    }
    if (Object.keys(env).length > 0) params.env = env;

    // Build headers
    if (transport !== 'stdio') {
      const headers: Record<string, string> = {};
      for (const h of headerVars.filter((h) => h.key.trim())) {
        headers[h.key.trim()] = h.value;
      }
      if (Object.keys(headers).length > 0) params.headers = headers;
    }

    return params;
  }

  async function handleTestConnection() {
    testResult = null;
    error = '';

    if (transport === 'stdio' && !command.trim()) {
      error = 'Command is required for stdio';
      return;
    }
    if (transport !== 'stdio' && !url.trim()) {
      error = 'URL is required';
      return;
    }

    testing = true;
    try {
      const result = await testConnection(buildConnectionParams());
      if (result.success) {
        testResult = { success: true, toolCount: result.tool_count };
      } else {
        testResult = { success: false, error: result.error ?? 'Unknown error' };
      }
    } catch (e) {
      testResult = { success: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      testing = false;
    }
  }

  async function handleSubmit() {
    error = '';
    if (!name.trim()) { error = 'Name is required'; return; }
    const trimmedName = name.trim();
    const defaultPrefix = sanitizeName(trimmedName);

    const params: AddEndpointParams = {
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

      // Build args: base args + userArgs values
      let finalArgs: string[] = [];
      if (args.trim()) {
        finalArgs = args.trim().split(/\s+/);
      }
      if (selectedCatalog?.userArgs) {
        for (const val of userArgValues) {
          if (val.trim()) finalArgs.push(val.trim());
        }
      }
      if (finalArgs.length > 0) {
        params.args = finalArgs;
      }
    } else if (transport === 'oauth') {
      if (!url.trim()) { error = 'Server URL is required'; return; }
      if (!oauthServerUrl.trim()) { error = 'OAuth Server URL is required'; return; }
      if (!clientId.trim()) { error = 'Client ID is required'; return; }
      params.url = url.trim();
      params.oauth_server_url = oauthServerUrl.trim();
      params.client_id = clientId.trim();
      if (clientSecret.trim()) params.client_secret = clientSecret.trim();
      if (scopes.trim()) params.scopes = scopes.trim();
    } else {
      if (!url.trim()) { error = 'URL is required'; return; }
      params.url = url.trim();
    }

    // Build env: catalog env vars + custom env vars
    const env: Record<string, string> = {};
    if (selectedCatalog) {
      for (const ev of selectedCatalog.envVars) {
        const val = catalogEnvValues[ev.name] ?? '';
        if (val.trim()) env[ev.name] = val.trim();
      }
    }
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
      toast.success(`Server "${name.trim()}" added`);
      onclose();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      submitting = false;
    }
  }

  async function handleOAuthSubmit() {
    // First save the endpoint via normal handleSubmit logic but don't close
    error = '';
    if (!name.trim()) { error = 'Name is required'; return; }
    if (!url.trim()) { error = 'Server URL is required'; return; }
    if (!oauthServerUrl.trim()) { error = 'OAuth Server URL is required'; return; }
    if (!clientId.trim()) { error = 'Client ID is required'; return; }

    const trimmedName = name.trim();
    const defaultPrefix = sanitizeName(trimmedName);

    const params: AddEndpointParams = {
      name: trimmedName,
      transport,
    };

    if (prefixCustom && prefix !== defaultPrefix) {
      params.tool_prefix = prefix;
    }
    if (description.trim()) {
      params.description = description.trim();
    }

    params.url = url.trim();
    params.oauth_server_url = oauthServerUrl.trim();
    params.client_id = clientId.trim();
    if (clientSecret.trim()) params.client_secret = clientSecret.trim();
    if (scopes.trim()) params.scopes = scopes.trim();

    // Build env
    const env: Record<string, string> = {};
    const filteredEnv = envVars.filter((e) => e.key.trim());
    for (const e of filteredEnv) {
      env[e.key.trim()] = e.value;
    }
    if (Object.keys(env).length > 0) {
      params.env = env;
    }

    submitting = true;
    try {
      await addEndpoint(params);

      // Start OAuth flow
      const { authorize_url } = await startOAuth(trimmedName);

      // Open browser for authorization
      await openUrl(authorize_url);

      // Poll for OAuth completion (every 1s, up to 2 minutes)
      const maxAttempts = 120;
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          const oauthResult = await getOAuthStatus(trimmedName);
          if ((oauthResult.status as string) === 'authorized' || (oauthResult.status as string) === 'complete' || oauthResult.status === 'authenticated') {
            // Success — refresh and close
            try {
              const data = await getEndpoints();
              endpoints.set(data);
            } catch {
              // Will be picked up by the next poll cycle
            }
            selectedEndpoint.set(trimmedName);
            onclose();
            return;
          }
          if ((oauthResult.status as string) === 'error' || oauthResult.status === 'connection_failed') {
            error = 'OAuth authorization failed';
            return;
          }
        } catch {
          // Polling error, continue
        }
      }
      error = 'OAuth authorization timed out. Please try again.';
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

<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="presentation" onclick={onclose} onkeydown={handleKeydown}>
  <div
    class="bg-(--color-surface) rounded-xl shadow-xl border border-(--color-border) p-6 w-[36rem] max-w-[90vw] max-h-[90vh] overflow-y-auto"
    role="dialog"
    aria-modal="true"
    aria-label="Add Server"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
  >
    {#if step === 'browse'}
      <!-- Step 1: Browse Catalog -->
      <h3 class="text-base font-semibold mb-4 text-(--color-text)">Add Server</h3>

      <input
        type="text"
        bind:value={search}
        placeholder="Search servers…"
        class="w-full text-sm px-3 py-2 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent) mb-4"
      />

      <div class="grid grid-cols-2 gap-2 mb-3">
        {#each filteredServers as server (server.id)}
          <button
            class="text-left p-3 rounded-lg border border-(--color-border) hover:border-(--color-accent) hover:bg-(--color-surface-hover) transition-colors"
            onclick={() => selectCatalog(server)}
          >
            <div class="flex items-center gap-2 mb-1">
              <span class="w-5 h-5 flex-shrink-0 text-(--color-text-secondary)">{@html server.icon}</span>
              <span class="text-sm font-medium text-(--color-text)">{server.name}</span>
            </div>
            <p class="text-xs text-(--color-text-secondary) line-clamp-2 mb-1.5">{server.description}</p>
            <div class="flex items-center gap-1.5">
              <span class="inline-block text-[10px] px-1.5 py-0.5 rounded-full bg-(--color-accent)/10 text-(--color-accent) font-medium">
                {CATEGORY_LABELS[server.category] ?? server.category}
              </span>
              {#if server.envVars.some(e => e.required)}
                <span class="inline-block text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium">
                  API Key Required
                </span>
              {/if}
            </div>
          </button>
        {/each}
      </div>

      <button
        class="w-full text-left p-3 rounded-lg border border-dashed border-(--color-border) hover:border-(--color-accent) hover:bg-(--color-surface-hover) transition-colors"
        onclick={selectCustom}
      >
        <span class="text-sm font-medium text-(--color-text-secondary)">Custom Server</span>
        <p class="text-xs text-(--color-text-secondary)/70">Configure a server manually with any transport</p>
      </button>

      <div class="flex justify-end pt-4">
        <button
          class="px-3 py-1.5 text-sm rounded-lg border border-(--color-border) hover:bg-(--color-surface-hover) transition-colors"
          onclick={onclose}
        >
          Cancel
        </button>
      </div>
    {:else}
      <!-- Step 2: Configure -->
      <div class="flex items-center gap-2 mb-4">
        <button
          class="p-1 rounded-md hover:bg-(--color-surface-hover) transition-colors text-(--color-text-secondary)"
          onclick={goBack}
          title="Back to catalog"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h3 class="text-base font-semibold text-(--color-text)">
          {selectedCatalog ? `Configure ${selectedCatalog.name}` : 'Custom Server'}
        </h3>
      </div>

      <div class="space-y-3">
        {#if !selectedCatalog}
          <!-- Custom: transport selector -->
          <fieldset class="border-none p-0 m-0 mb-1">
            <legend class="block text-xs font-medium mb-1 text-(--color-text-secondary)">Transport</legend>
            <div class="flex gap-2">
              {#each ['stdio', 'sse', 'http', 'oauth'] as t}
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
        {/if}

        <div>
          <label for="modal-ep-name" class="block text-xs font-medium mb-1 text-(--color-text-secondary)">Name</label>
          <input id="modal-ep-name" type="text" bind:value={name} placeholder="my-server"
            class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent)" />
        </div>

        <div>
          <div class="flex items-center justify-between mb-1 gap-2">
            <label for="modal-ep-prefix" class="block text-xs font-medium text-(--color-text-secondary)">Tool Prefix</label>
            {#if prefixCustom}
              <button
                type="button"
                class="text-[11px] text-(--color-accent) hover:text-(--color-accent-hover)"
                onclick={resetPrefix}
              >
                Reset
              </button>
            {/if}
          </div>
          <input
            id="modal-ep-prefix"
            type="text"
            value={prefix}
            oninput={(event) => handlePrefixInput((event.currentTarget as HTMLInputElement).value)}
            placeholder="my_server"
            class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent)"
          />
          <p class="text-[11px] text-(--color-text-secondary) mt-0.5">
            Auto-generated from the name. Tools will be named like {prefixPreview}.
          </p>
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
        {:else if transport === 'oauth'}
          <div>
            <label for="modal-ep-url" class="block text-xs font-medium mb-1 text-(--color-text-secondary)">Server URL</label>
            <input id="modal-ep-url" type="text" bind:value={url} placeholder="http://localhost:3000/mcp"
              class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent)" />
          </div>
          <div>
            <label for="modal-ep-oauth-url" class="block text-xs font-medium mb-1 text-(--color-text-secondary)">OAuth Server URL</label>
            <input id="modal-ep-oauth-url" type="text" bind:value={oauthServerUrl} placeholder="https://auth.example.com"
              class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent)" />
          </div>
          <div>
            <label for="modal-ep-client-id" class="block text-xs font-medium mb-1 text-(--color-text-secondary)">Client ID</label>
            <input id="modal-ep-client-id" type="text" bind:value={clientId} placeholder="your-client-id"
              class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent)" />
          </div>
          <div>
            <label for="modal-ep-client-secret" class="block text-xs font-medium mb-1 text-(--color-text-secondary)">Client Secret <span class="text-(--color-text-secondary)/50">(optional)</span></label>
            <input id="modal-ep-client-secret" type="password" bind:value={clientSecret} placeholder="••••••••"
              class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent)" />
          </div>
          <div>
            <label for="modal-ep-scopes" class="block text-xs font-medium mb-1 text-(--color-text-secondary)">Scopes <span class="text-(--color-text-secondary)/50">(optional, space-separated)</span></label>
            <input id="modal-ep-scopes" type="text" bind:value={scopes} placeholder="read write"
              class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent)" />
          </div>
        {:else}
          <div>
            <label for="modal-ep-url" class="block text-xs font-medium mb-1 text-(--color-text-secondary)">URL</label>
            <input id="modal-ep-url" type="text" bind:value={url} placeholder={transport === 'sse' ? 'http://localhost:3000/sse' : 'http://localhost:3000/mcp'}
              class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent)" />
          </div>
        {/if}

        <!-- Catalog: user args (appended to args) -->
        {#if selectedCatalog?.userArgs}
          {#each selectedCatalog.userArgs as ua, i}
            <div>
              <label for="modal-ua-{i}" class="block text-xs font-medium mb-1 text-(--color-text-secondary)">{ua.label}</label>
              <div class="flex gap-2">
                <input id="modal-ua-{i}" type="text" bind:value={userArgValues[i]} placeholder={ua.placeholder}
                  class="flex-1 text-sm px-3 py-1.5 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent)" />
                {#if ua.type === 'directory' || ua.type === 'file'}
                  <button
                    type="button"
                    class="px-3 py-1.5 text-xs rounded-lg border border-(--color-border) hover:bg-(--color-surface-hover) text-(--color-text-secondary) transition-colors flex-shrink-0"
                    onclick={async () => {
                      const selected = await dialogOpen({
                        directory: ua.type === 'directory',
                        multiple: false,
                        title: ua.label,
                      });
                      if (selected && typeof selected === 'string') {
                        userArgValues[i] = selected;
                      }
                    }}
                  >
                    Browse…
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        {/if}

        <!-- Catalog: labeled env var inputs -->
        {#if selectedCatalog && selectedCatalog.envVars.length > 0}
          <div>
            <span class="block text-xs font-medium mb-1 text-(--color-text-secondary)">Configuration</span>
            {#each selectedCatalog.envVars as ev}
              <div class="mb-2">
                <label for="modal-env-{ev.name}" class="block text-[11px] mb-0.5 text-(--color-text-secondary)">
                  {ev.label}
                  {#if ev.required}<span class="text-(--color-offline)">*</span>{/if}
                  {#if ev.helpUrl}
                    <button type="button" class="text-(--color-accent) hover:underline ml-1 inline cursor-pointer bg-transparent border-none p-0 text-[11px]" onclick={() => openUrl(ev.helpUrl!)}>↗</button>
                  {/if}
                </label>
                <input
                  id="modal-env-{ev.name}"
                  type={ev.secret ? 'password' : 'text'}
                  bind:value={catalogEnvValues[ev.name]}
                  placeholder={ev.secret ? '••••••••' : ev.name}
                  class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent) font-mono"
                />
              </div>
            {/each}
          </div>
        {/if}

        <!-- Custom env var key-value editor -->
        <div>
          <div class="flex items-center justify-between mb-1">
            <span class="block text-xs font-medium text-(--color-text-secondary)">
              {selectedCatalog ? 'Additional Environment Variables' : 'Environment Variables'}
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

        <!-- Custom HTTP headers (SSE/HTTP only) -->
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

        <!-- Test Connection (not shown for OAuth) -->
        {#if transport !== 'oauth'}
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="px-3 py-1.5 text-xs rounded-lg border border-(--color-border) hover:bg-(--color-surface-hover) transition-colors disabled:opacity-50"
              onclick={handleTestConnection}
              disabled={testing || submitting}
            >
              {#if testing}
                <span class="inline-flex items-center gap-1.5">
                  <svg class="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" class="opacity-25" />
                    <path fill="currentColor" class="opacity-75" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                  Testing…
                </span>
              {:else}
                Test Connection
              {/if}
            </button>
            {#if testResult}
              {#if testResult.success}
                <span class="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                  <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                  </svg>
                  Connected — {testResult.toolCount} {testResult.toolCount === 1 ? 'tool' : 'tools'} found
                </span>
              {:else}
                <span class="text-xs text-(--color-offline)">{testResult.error}</span>
              {/if}
            {/if}
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
            onclick={transport === 'oauth' ? handleOAuthSubmit : handleSubmit}
            disabled={submitting}
          >
            {#if submitting}
              {transport === 'oauth' ? 'Connecting…' : 'Adding…'}
            {:else}
              {transport === 'oauth' ? 'Save & Connect' : 'Add Server'}
            {/if}
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>

