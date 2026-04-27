<script lang="ts">
  import { addEndpoint, getEndpoints, testConnection, oauthSetup, oauthSetupStatus, oauthSetupCredentials, oauthSetupCommit, oauthSetupCancel, reloadConfig, type AddEndpointParams, type TestConnectionParams, type OAuthSetupParams } from '$lib/api';
  import { endpoints, selectedEndpoint } from '$lib/stores';
  import { toast } from 'svelte-sonner';
  import { CATALOG_SERVERS, type CatalogServer } from '$lib/catalog';
  import { oauthCatalog, type OAuthCatalogEntry } from '$lib/data/oauth-catalog';
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
  let selectedOAuthEntry: OAuthCatalogEntry | null = $state(null);
  let showingDcrFallback = $state(false);
  let dcrFallbackData: { authorization_endpoint?: string } = $state({});
  let dcrClientId = $state('');
  let dcrClientSecret = $state('');
  let pendingSetupSessionId: string | null = $state(null);

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

  let filteredOAuthServers = $derived(
    search.trim()
      ? oauthCatalog.filter((s) => {
          const q = search.toLowerCase();
          return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
        })
      : oauthCatalog,
  );

  // Filter toggles for unified browse list
  let showOAuth = $state(true);
  let showLocal = $state(true);

  type UnifiedEntry =
    | { type: 'oauth'; entry: OAuthCatalogEntry }
    | { type: 'local'; entry: CatalogServer };

  let unifiedServers: UnifiedEntry[] = $derived.by(() => {
    let items: UnifiedEntry[] = [];
    if (showOAuth) {
      items.push(...filteredOAuthServers.map((e) => ({ type: 'oauth' as const, entry: e })));
    }
    if (showLocal) {
      items.push(...filteredServers.map((e) => ({ type: 'local' as const, entry: e })));
    }
    return items.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
  });

  function selectOAuthService(service: OAuthCatalogEntry) {
    selectedCatalog = null;
    selectedOAuthEntry = service;
    name = service.name;
    prefixCustom = false;
    prefix = sanitizeName(service.name);
    description = service.description;
    transport = 'oauth';
    url = service.url;
    oauthServerUrl = service.oauthServerUrl || '';
    clientId = '';
    clientSecret = '';
    scopes = service.defaultScopes.join(' ');
    envVars = [];
    headerVars = [];
    catalogEnvValues = {};
    userArgValues = [];
    showingDcrFallback = false;
    dcrClientId = '';
    dcrClientSecret = '';
    error = '';
    step = 'configure';
  }

  function selectCatalog(server: CatalogServer) {
    selectedCatalog = server;
    selectedOAuthEntry = null;
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
    showingDcrFallback = false;
    error = '';
    step = 'configure';
  }

  function selectCustom() {
    selectedCatalog = null;
    selectedOAuthEntry = null;
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
    showingDcrFallback = false;
    error = '';
    step = 'configure';
  }

  function goBack() {
    step = 'browse';
    error = '';
    testResult = null;
    showingDcrFallback = false;
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
      params.url = url.trim();
      if (oauthServerUrl.trim()) params.oauth_server_url = oauthServerUrl.trim();
      if (clientId.trim()) params.client_id = clientId.trim();
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
    error = '';
    if (!name.trim()) { error = 'Name is required'; return; }
    if (!url.trim()) { error = 'Server URL is required'; return; }

    const trimmedName = name.trim();
    const defaultPrefix = sanitizeName(trimmedName);

    const setupParams: OAuthSetupParams = {
      name: trimmedName,
      url: url.trim(),
    };
    if (prefixCustom && prefix !== defaultPrefix) {
      setupParams.tool_prefix = prefix;
    }
    if (scopes.trim()) {
      setupParams.scopes = scopes.trim().split(/\s+/);
    }

    submitting = true;
    try {
      const result = await oauthSetup(setupParams);
      pendingSetupSessionId = result.session_id;

      if (result.status === 'awaiting_credentials' && result.dcr_error) {
        // DCR failed — show manual credentials form
        showingDcrFallback = true;
        dcrFallbackData = {
          authorization_endpoint: result.discovery?.auth_server,
        };
        dcrClientId = '';
        dcrClientSecret = '';
        submitting = false;
        return;
      }

      if (result.authorize_url) {
        // Open browser for authorization
        await openUrl(result.authorize_url);

        // Poll for setup session completion (every 1s, up to 2 minutes)
        await pollForSetupAuth(result.session_id, trimmedName);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      // Clean up the setup session on failure
      if (pendingSetupSessionId) {
        try { await oauthSetupCancel(pendingSetupSessionId); } catch { /* best effort */ }
        pendingSetupSessionId = null;
      }
    } finally {
      submitting = false;
    }
  }

  async function pollForSetupAuth(sessionId: string, endpointName: string) {
    const maxAttempts = 120;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const statusResult = await oauthSetupStatus(sessionId);
        if (statusResult.status === 'authorized') {
          // Authorization complete — commit the endpoint to config.toml
          try {
            await oauthSetupCommit(sessionId);
          } catch (e) {
            error = `Failed to save endpoint: ${e instanceof Error ? e.message : String(e)}`;
            pendingSetupSessionId = null;
            return;
          }
          pendingSetupSessionId = null;

          // Wait for config watcher to pick up the new endpoint
          await new Promise((r) => setTimeout(r, 500));
          try {
            const data = await getEndpoints();
            endpoints.set(data);
          } catch {
            // Will be picked up by the next poll cycle
          }
          selectedEndpoint.set(endpointName);
          toast.success(`Connected to "${endpointName}"`);
          onclose();
          return;
        }
      } catch {
        // Polling error, continue
      }
    }
    error = 'OAuth authorization timed out. Please try again.';
    // Clean up on timeout — no config was ever written
    if (pendingSetupSessionId) {
      try { await oauthSetupCancel(pendingSetupSessionId); } catch { /* best effort */ }
      pendingSetupSessionId = null;
    }
  }

  async function handleDcrFallbackSubmit() {
    error = '';
    if (!dcrClientId.trim()) { error = 'Client ID is required'; return; }
    if (!pendingSetupSessionId) { error = 'No active setup session'; return; }

    const trimmedName = name.trim();
    submitting = true;
    try {
      const result = await oauthSetupCredentials(
        pendingSetupSessionId,
        dcrClientId.trim(),
        dcrClientSecret.trim() || undefined,
      );

      if (result.authorize_url) {
        showingDcrFallback = false;
        await openUrl(result.authorize_url);
        await pollForSetupAuth(pendingSetupSessionId, trimmedName);
      } else {
        error = 'OAuth flow failed after credential submission. Please try again.';
        if (pendingSetupSessionId) {
          try { await oauthSetupCancel(pendingSetupSessionId); } catch { /* best effort */ }
          pendingSetupSessionId = null;
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      if (pendingSetupSessionId) {
        try { await oauthSetupCancel(pendingSetupSessionId); } catch { /* best effort */ }
        pendingSetupSessionId = null;
      }
    } finally {
      submitting = false;
    }
  }

  async function handleCancel() {
    // Cancel pending setup session if user cancels — no config cleanup needed
    if (pendingSetupSessionId) {
      try { await oauthSetupCancel(pendingSetupSessionId); } catch { /* best effort */ }
      pendingSetupSessionId = null;
    }
    onclose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') handleCancel();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="presentation" onclick={handleCancel} onkeydown={handleKeydown}>
  <div
    class="bg-(--surface) rounded-xl shadow-xl border border-(--border) p-6 w-[36rem] max-w-[90vw] max-h-[90vh] overflow-y-auto"
    role="dialog"
    aria-modal="true"
    aria-label="Add Server"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
  >
    {#if step === 'browse'}
      <!-- Step 1: Browse Catalog -->
      <h3 class="text-base font-semibold mb-4 text-(--fg1)">Add Server</h3>

      <input
        type="text"
        bind:value={search}
        placeholder="Search servers…"
        class="w-full text-sm px-3 py-2 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent) mb-4"
      />

      <!-- Filter toggles -->
      <div class="flex gap-2 mb-4">
        <button
          class="px-3 py-1 text-xs rounded-full border transition-colors {showOAuth
            ? 'border-(--accent) bg-(--accent)/10 text-(--accent)'
            : 'border-(--border) text-(--fg2) hover:bg-(--surface-hover)'}"
          onclick={() => showOAuth = !showOAuth}
        >
          OAuth
        </button>
        <button
          class="px-3 py-1 text-xs rounded-full border transition-colors {showLocal
            ? 'border-(--accent) bg-(--accent)/10 text-(--accent)'
            : 'border-(--border) text-(--fg2) hover:bg-(--surface-hover)'}"
          onclick={() => showLocal = !showLocal}
        >
          Local
        </button>
      </div>

      <!-- Unified server list -->
      <div class="flex flex-col gap-2 mb-3">
        {#each unifiedServers as item (item.type + '-' + item.entry.id)}
          {#if item.type === 'oauth'}
            {@const service = item.entry as OAuthCatalogEntry}
            <button
              class="w-full text-left p-3 rounded-lg border border-(--border) hover:border-(--accent) hover:bg-(--surface-hover) transition-colors flex items-center gap-3"
              onclick={() => selectOAuthService(service)}
            >
              <span class="w-5 h-5 flex-shrink-0 text-(--fg2)">{@html service.icon}</span>
              <span class="text-sm font-medium text-(--fg1) flex-shrink-0">{service.name}</span>
              <p class="text-xs text-(--fg2) line-clamp-1 flex-1 min-w-0">{service.description}</p>
              <div class="flex items-center gap-1.5 flex-shrink-0">
                <span class="inline-block text-[10px] px-1.5 py-0.5 rounded-full bg-(--accent)/10 text-(--accent) font-medium">
                  {CATEGORY_LABELS[service.category] ?? service.category}
                </span>
                <span class="inline-block text-[10px] px-1.5 py-0.5 rounded-full bg-(--hint-read-bg) text-(--hint-read-fg) font-medium">
                  OAuth
                </span>
              </div>
            </button>
          {:else}
            {@const server = item.entry as CatalogServer}
            <button
              class="w-full text-left p-3 rounded-lg border border-(--border) hover:border-(--accent) hover:bg-(--surface-hover) transition-colors flex items-center gap-3"
              onclick={() => selectCatalog(server)}
            >
              <span class="w-5 h-5 flex-shrink-0 text-(--fg2)">{@html server.icon}</span>
              <span class="text-sm font-medium text-(--fg1) flex-shrink-0">{server.name}</span>
              <p class="text-xs text-(--fg2) line-clamp-1 flex-1 min-w-0">{server.description}</p>
              <div class="flex items-center gap-1.5 flex-shrink-0">
                <span class="inline-block text-[10px] px-1.5 py-0.5 rounded-full bg-(--accent)/10 text-(--accent) font-medium">
                  {CATEGORY_LABELS[server.category] ?? server.category}
                </span>
                {#if server.envVars.some(e => e.required)}
                  <span class="inline-block text-[10px] px-1.5 py-0.5 rounded-full bg-(--trans-oauth-bg) text-(--trans-oauth-fg) font-medium">
                    API Key
                  </span>
                {/if}
              </div>
            </button>
          {/if}
        {/each}
      </div>

      <button
        class="w-full text-left p-3 rounded-lg border border-dashed border-(--border) hover:border-(--accent) hover:bg-(--surface-hover) transition-colors"
        onclick={selectCustom}
      >
        <span class="text-sm font-medium text-(--fg2)">Custom Server</span>
        <p class="text-xs text-(--fg2)/70">Configure a server manually with any transport</p>
      </button>

      <div class="flex justify-end pt-4">
        <button
          class="px-3 py-1.5 text-sm rounded-lg border border-(--border) hover:bg-(--surface-hover) transition-colors"
          onclick={handleCancel}
        >
          Cancel
        </button>
      </div>
    {:else}
      <!-- Step 2: Configure -->
      <div class="flex items-center gap-2 mb-4">
        <button
          class="p-1 rounded-md hover:bg-(--surface-hover) transition-colors text-(--fg2)"
          onclick={goBack}
          title="Back to catalog"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h3 class="text-base font-semibold text-(--fg1)">
          {selectedCatalog ? `Configure ${selectedCatalog.name}` : selectedOAuthEntry ? `Connect ${selectedOAuthEntry.name}` : 'Custom Server'}
        </h3>
      </div>

      <div class="space-y-3">
        {#if !selectedCatalog && !selectedOAuthEntry}
          <!-- Custom: transport selector -->
          <fieldset class="border-none p-0 m-0 mb-1">
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
        {/if}

        <div>
          <label for="modal-ep-name" class="block text-xs font-medium mb-1 text-(--fg2)">Name</label>
          <input id="modal-ep-name" type="text" bind:value={name} placeholder="my-server"
            class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)" />
        </div>

        <div>
          <div class="flex items-center justify-between mb-1 gap-2">
            <label for="modal-ep-prefix" class="block text-xs font-medium text-(--fg2)">Tool Prefix</label>
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
            id="modal-ep-prefix"
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
          <label for="modal-ep-desc" class="block text-xs font-medium mb-1 text-(--fg2)">Description <span class="text-(--fg2)/50">(optional)</span></label>
          <input id="modal-ep-desc" type="text" bind:value={description} placeholder="Brief description of this server"
            class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)" />
        </div>

        {#if transport === 'stdio'}
          <div>
            <label for="modal-ep-cmd" class="block text-xs font-medium mb-1 text-(--fg2)">Command</label>
            <input id="modal-ep-cmd" type="text" bind:value={command} placeholder="npx"
              class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)" />
          </div>
          <div>
            <label for="modal-ep-args" class="block text-xs font-medium mb-1 text-(--fg2)">Arguments <span class="text-(--fg2)/50">(space-separated)</span></label>
            <input id="modal-ep-args" type="text" bind:value={args} placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
              class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)" />
          </div>
        {:else if transport === 'oauth'}
          <div>
            <label for="modal-ep-url" class="block text-xs font-medium mb-1 text-(--fg2)">Server URL</label>
            <input id="modal-ep-url" type="text" bind:value={url} placeholder="https://mcp.linear.app/sse"
              class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)" />
          </div>

          <!-- Collapsible Advanced section — collapsed by default for all OAuth flows -->
          <details class="border border-(--border) rounded-lg">
            <summary class="px-3 py-2 text-xs font-medium text-(--fg2) cursor-pointer hover:bg-(--surface-hover) rounded-lg select-none">
              Advanced
            </summary>
            <div class="px-3 pb-3 space-y-3">
              <div>
                <label for="modal-ep-scopes" class="block text-xs font-medium mb-1 text-(--fg2)">Scopes <span class="text-(--fg2)/50">(optional, space-separated)</span></label>
                <input id="modal-ep-scopes" type="text" bind:value={scopes} placeholder="read write"
                  class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)" />
                <p class="text-[11px] text-(--fg2) mt-0.5">Space-separated. Leave blank for server defaults.</p>
              </div>
              <div>
                <label for="modal-ep-oauth-url" class="block text-xs font-medium mb-1 text-(--fg2)">OAuth Server URL</label>
                <input id="modal-ep-oauth-url" type="text" bind:value={oauthServerUrl} placeholder="Auto-discovered"
                  class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)" />
                <p class="text-[11px] text-(--fg2) mt-0.5">Leave blank to auto-discover via RFC 9728</p>
              </div>
              <div>
                <label for="modal-ep-client-id" class="block text-xs font-medium mb-1 text-(--fg2)">Client ID</label>
                <input id="modal-ep-client-id" type="text" bind:value={clientId} placeholder="Auto-registered"
                  class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)" />
                <p class="text-[11px] text-(--fg2) mt-0.5">Leave blank to use Dynamic Client Registration</p>
              </div>
              <div>
                <label for="modal-ep-client-secret" class="block text-xs font-medium mb-1 text-(--fg2)">Client Secret <span class="text-(--fg2)/50">(optional)</span></label>
                <input id="modal-ep-client-secret" type="password" bind:value={clientSecret} placeholder="Optional"
                  class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)" />
              </div>
            </div>
          </details>
        {:else}
          <div>
            <label for="modal-ep-url" class="block text-xs font-medium mb-1 text-(--fg2)">URL</label>
            <input id="modal-ep-url" type="text" bind:value={url} placeholder={transport === 'sse' ? 'http://localhost:3000/sse' : 'http://localhost:3000/mcp'}
              class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)" />
          </div>
        {/if}

        <!-- Catalog: user args (appended to args) -->
        {#if selectedCatalog?.userArgs}
          {#each selectedCatalog.userArgs as ua, i}
            <div>
              <label for="modal-ua-{i}" class="block text-xs font-medium mb-1 text-(--fg2)">{ua.label}</label>
              <div class="flex gap-2">
                <input id="modal-ua-{i}" type="text" bind:value={userArgValues[i]} placeholder={ua.placeholder}
                  class="flex-1 text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)" />
                {#if ua.type === 'directory' || ua.type === 'file'}
                  <button
                    type="button"
                    class="px-3 py-1.5 text-xs rounded-lg border border-(--border) hover:bg-(--surface-hover) text-(--fg2) transition-colors flex-shrink-0"
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
            <span class="block text-xs font-medium mb-1 text-(--fg2)">Configuration</span>
            {#each selectedCatalog.envVars as ev}
              <div class="mb-2">
                <label for="modal-env-{ev.name}" class="block text-[11px] mb-0.5 text-(--fg2)">
                  {ev.label}
                  {#if ev.required}<span class="text-(--offline)">*</span>{/if}
                  {#if ev.helpUrl}
                    <button type="button" class="text-(--accent) hover:underline ml-1 inline cursor-pointer bg-transparent border-none p-0 text-[11px]" onclick={() => openUrl(ev.helpUrl!)}>↗</button>
                  {/if}
                </label>
                <input
                  id="modal-env-{ev.name}"
                  type={ev.secret ? 'password' : 'text'}
                  bind:value={catalogEnvValues[ev.name]}
                  placeholder={ev.secret ? '••••••••' : ev.name}
                  class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent) font-mono"
                />
              </div>
            {/each}
          </div>
        {/if}

        <!-- Custom env var key-value editor -->
        <div>
          <div class="flex items-center justify-between mb-1">
            <span class="block text-xs font-medium text-(--fg2)">
              {selectedCatalog ? 'Additional Environment Variables' : 'Environment Variables'}
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

        <!-- Custom HTTP headers (SSE/HTTP only) -->
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

        <!-- Test Connection (not shown for OAuth) -->
        {#if transport !== 'oauth'}
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="px-3 py-1.5 text-xs rounded-lg border border-(--border) hover:bg-(--surface-hover) transition-colors disabled:opacity-50"
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
                <span class="text-xs text-(--offline)">{testResult.error}</span>
              {/if}
            {/if}
          </div>
        {/if}

        <!-- DCR Fallback Form -->
        {#if showingDcrFallback}
          <div class="border rounded-lg p-4 space-y-3" style="border-color: color-mix(in oklab, var(--trans-oauth-fg) 30%, transparent); background: color-mix(in oklab, var(--trans-oauth-fg) 6%, transparent);">
            <div>
              <p class="text-sm text-(--fg1)">
                <strong>{name}</strong> requires manual client registration.
                Register an OAuth app with the service, then enter your credentials below.
              </p>
              {#if dcrFallbackData.authorization_endpoint}
                <p class="text-[11px] text-(--fg2) mt-1">
                  Auth server: <code class="bg-(--surface-hover) px-1 py-0.5 rounded text-[11px]">{dcrFallbackData.authorization_endpoint}</code>
                </p>
              {/if}
            </div>

            <div>
              <label for="modal-dcr-client-id" class="block text-xs font-medium mb-1 text-(--fg2)">
                Client ID <span class="text-(--offline)">*</span>
              </label>
              <input id="modal-dcr-client-id" type="text" bind:value={dcrClientId} placeholder="Your registered client ID"
                class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)" />
            </div>

            <div>
              <label for="modal-dcr-client-secret" class="block text-xs font-medium mb-1 text-(--fg2)">
                Client Secret <span class="text-(--fg2)/50">(optional for public clients)</span>
              </label>
              <input id="modal-dcr-client-secret" type="password" bind:value={dcrClientSecret} placeholder="Optional"
                class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)" />
            </div>

            <button
              class="w-full px-3 py-1.5 text-sm rounded-lg bg-(--accent) text-white hover:bg-(--accent-hover) transition-colors disabled:opacity-50"
              onclick={handleDcrFallbackSubmit}
              disabled={submitting}
            >
              {#if submitting}
                Connecting…
              {:else}
                Save Credentials & Connect
              {/if}
            </button>
          </div>
        {/if}

        {#if error}
          <p class="text-xs text-(--offline)">{error}</p>
        {/if}

        {#if !showingDcrFallback}
          <div class="flex justify-end gap-2 pt-2">
            <button
              class="px-3 py-1.5 text-sm rounded-lg border border-(--border) hover:bg-(--surface-hover) transition-colors"
              onclick={handleCancel}
            >
              Cancel
            </button>
            <button
              class="px-3 py-1.5 text-sm rounded-lg bg-(--accent) text-white hover:bg-(--accent-hover) transition-colors disabled:opacity-50"
              onclick={transport === 'oauth' ? handleOAuthSubmit : handleSubmit}
              disabled={submitting}
            >
              {#if submitting}
                {transport === 'oauth' ? 'Connecting…' : 'Adding…'}
              {:else if selectedOAuthEntry}
                Connect with {selectedOAuthEntry.name}
              {:else if transport === 'oauth'}
                Save & Connect
              {:else}
                Add Server
              {/if}
            </button>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

