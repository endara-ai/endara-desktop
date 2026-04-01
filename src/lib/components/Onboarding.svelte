<script lang="ts">
  import { addEndpoint, getEndpoints, type AddEndpointParams } from '$lib/api';
  import { onboardingDismissed, endpoints, relayPort, selectedEndpoint } from '$lib/stores';
  import { sanitizeName, isValidToolPrefix } from '$lib/utils';

  type TransportType = 'stdio' | 'sse' | 'http';

  let transport: TransportType = $state('stdio');
  let name = $state('');
  let command = $state('');
  let args = $state('');
  let url = $state('');
  let envVars: { key: string; value: string }[] = $state([]);
  let submitting = $state(false);
  let error = $state('');

  // Tool prefix fields
  let toolPrefix = $state('');
  let toolPrefixManual = $state(false);

  let autoToolPrefix: string | null = $derived(sanitizeName(name.trim()));

  let effectiveToolPrefix: string | null = $derived.by(() => {
    if (toolPrefixManual && toolPrefix.trim()) return toolPrefix.trim();
    return autoToolPrefix;
  });

  let toolPrefixError: string = $derived.by(() => {
    if (toolPrefixManual && toolPrefix.trim() && !isValidToolPrefix(toolPrefix.trim())) {
      return 'Must start with a lowercase letter or digit, and contain only lowercase letters, digits, hyphens, or underscores.';
    }
    if (name.trim() && !effectiveToolPrefix) {
      return 'Name produces an empty tool prefix. Please set a tool prefix manually.';
    }
    return '';
  });

  const RELAY_MCP_URL = $derived(`http://localhost:${$relayPort}/mcp`);
  const RELAY_SSE_URL = $derived(`http://localhost:${$relayPort}/mcp/sse`);

  async function handleSubmit() {
    error = '';
    if (!name.trim()) { error = 'Name is required'; return; }
    if (toolPrefixError) { error = toolPrefixError; return; }
    if (!effectiveToolPrefix) { error = 'Tool prefix cannot be empty'; return; }

    const params: AddEndpointParams = {
      name: name.trim(),
      transport,
    };

    // Only pass tool_prefix when it differs from auto-sanitized name
    if (toolPrefixManual && toolPrefix.trim() && toolPrefix.trim() !== autoToolPrefix) {
      params.toolPrefix = toolPrefix.trim();
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

    const filteredEnv = envVars.filter((e) => e.key.trim());
    if (filteredEnv.length > 0) {
      params.env = Object.fromEntries(filteredEnv.map((e) => [e.key.trim(), e.value]));
    }

    submitting = true;
    try {
      await addEndpoint(params);
      onboardingDismissed.set(true);
      // Immediately poll for new endpoints
      try {
        const data = await getEndpoints();
        endpoints.set(data);
      } catch {
        // Will be picked up by the next poll cycle
      }
      selectedEndpoint.set(name.trim());
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      submitting = false;
    }
  }

  async function addExample() {
    submitting = true;
    error = '';
    try {
      await addEndpoint({
        name: 'filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      });
      onboardingDismissed.set(true);
      // Immediately poll for new endpoints
      try {
        const data = await getEndpoints();
        endpoints.set(data);
      } catch {
        // Will be picked up by the next poll cycle
      }
      selectedEndpoint.set('filesystem');
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      submitting = false;
    }
  }

  let copied = $state(false);
  function copyUrl(text: string) {
    navigator.clipboard.writeText(text);
    copied = true;
    setTimeout(() => copied = false, 2000);
  }
</script>

<div class="h-full overflow-y-auto p-8">
  <div class="max-w-lg mx-auto space-y-6">
    <div class="text-center space-y-2">
      <h1 class="text-2xl font-bold text-(--color-text)">Welcome to Endara</h1>
      <p class="text-sm text-(--color-text-secondary)">
        Endara relays MCP servers to your AI tools. Add your first server below to get started.
      </p>
    </div>

    <!-- Relay URL info -->
    <div class="rounded-lg border border-(--color-border) bg-(--color-surface-alt) p-4 space-y-2">
      <h3 class="text-sm font-semibold text-(--color-text)">Connect your AI client</h3>
      <p class="text-xs text-(--color-text-secondary)">
        Point Claude Desktop or other MCP clients to the Endara relay:
      </p>
      <div class="flex items-center gap-2">
        <code class="flex-1 text-xs font-mono bg-(--color-surface) border border-(--color-border) rounded px-2 py-1.5 text-(--color-accent)">
          {RELAY_MCP_URL}
        </code>
        <button
          class="text-xs px-2 py-1.5 rounded border border-(--color-border) hover:bg-(--color-surface-hover) transition-colors"
          onclick={() => copyUrl(RELAY_MCP_URL)}
        >
          {copied ? '✓' : 'Copy'}
        </button>
      </div>
      <p class="text-xs text-(--color-text-secondary)">
        SSE endpoint: <code class="font-mono text-(--color-accent)">{RELAY_SSE_URL}</code>
      </p>
    </div>

    <!-- Quick start example -->
    <div class="rounded-lg border border-(--color-border) bg-(--color-surface-alt) p-4 space-y-2">
      <h3 class="text-sm font-semibold text-(--color-text)">Quick start</h3>
      <p class="text-xs text-(--color-text-secondary)">
        Try the MCP filesystem server — gives your AI access to read files from /tmp.
      </p>
      <button
        class="w-full px-3 py-2 text-sm rounded-lg bg-(--color-accent) text-white hover:bg-(--color-accent-hover) transition-colors disabled:opacity-50"
        onclick={addExample}
        disabled={submitting}
      >
        Add Filesystem Server (one click)
      </button>
    </div>

    <!-- Add endpoint form -->
    <div class="rounded-lg border border-(--color-border) bg-(--color-surface-alt) p-4 space-y-4">
      <h3 class="text-sm font-semibold text-(--color-text)">Add a server manually</h3>

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
        <label for="ep-name" class="block text-xs font-medium mb-1 text-(--color-text-secondary)">Name</label>
        <input id="ep-name" type="text" bind:value={name} placeholder="My Cool Server"
          class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent)" />
      </div>

      <div>
        <label for="ep-tool-prefix" class="block text-xs font-medium mb-1 text-(--color-text-secondary)">Tool Prefix</label>
        <input id="ep-tool-prefix" type="text" bind:value={toolPrefix} placeholder={autoToolPrefix ?? ''}
          oninput={() => { toolPrefixManual = true; }}
          class="w-full text-sm px-3 py-1.5 rounded-lg border {toolPrefixError ? 'border-(--color-offline)' : 'border-(--color-border)'} bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent) font-mono" />
        {#if toolPrefixError}
          <p class="text-[11px] text-(--color-offline) mt-0.5">{toolPrefixError}</p>
        {:else}
          <p class="text-[11px] text-(--color-text-secondary)/60 mt-0.5">Used for tool naming. Auto-generated from name.</p>
        {/if}
      </div>

      {#if transport === 'stdio'}
        <div>
          <label for="ep-cmd" class="block text-xs font-medium mb-1 text-(--color-text-secondary)">Command</label>
          <input id="ep-cmd" type="text" bind:value={command} placeholder="npx"
            class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent)" />
        </div>
        <div>
          <label for="ep-args" class="block text-xs font-medium mb-1 text-(--color-text-secondary)">Arguments <span class="text-(--color-text-secondary)/50">(space-separated)</span></label>
          <input id="ep-args" type="text" bind:value={args} placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
            class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent)" />
        </div>
      {:else}
        <div>
          <label for="ep-url" class="block text-xs font-medium mb-1 text-(--color-text-secondary)">URL</label>
          <input id="ep-url" type="text" bind:value={url} placeholder={transport === 'sse' ? 'http://localhost:3000/sse' : 'http://localhost:3000/mcp'}
            class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary)/50 focus:outline-none focus:border-(--color-accent)" />
        </div>
      {/if}

      <div>
        <div class="flex items-center justify-between mb-1">
          <span class="block text-xs font-medium text-(--color-text-secondary)">Environment Variables <span class="text-(--color-text-secondary)/50">(optional)</span></span>
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

      {#if error}
        <p class="text-xs text-(--color-offline)">{error}</p>
      {/if}

      <button
        class="w-full px-3 py-2 text-sm rounded-lg bg-(--color-accent) text-white hover:bg-(--color-accent-hover) transition-colors disabled:opacity-50"
        onclick={handleSubmit}
        disabled={submitting}
      >
        {submitting ? 'Adding…' : 'Add Server'}
      </button>
    </div>
  </div>
</div>

