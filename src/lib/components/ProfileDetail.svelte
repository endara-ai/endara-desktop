<script lang="ts">
  import type { ProfileDetail, ProfileSummary } from '$lib/api';
  import { getProfile, listProfiles, updateProfile, deleteProfile } from '$lib/api';
  import { endpoints, relayPort } from '$lib/stores';
  import { registerDirtyChecker } from '$lib/stores/unsavedChangesGuard';
  import { toast } from 'svelte-sonner';
  import ConfirmModal from './ConfirmModal.svelte';
  import TransportBadge from './TransportBadge.svelte';
  import { validateProfileName, validateProfilePath } from './create-profile-helpers';
  import {
    buildUpdateProfileParams,
    computeProfileIsDirty,
    formFromDetail,
    runDeleteProfile,
    runSaveProfile,
    toggleStagedEndpoint,
    type ProfileEditForm,
  } from './profile-detail-helpers';

  let {
    selectedPath,
    onprofilesreload,
    onselect,
  }: {
    selectedPath: string | null;
    onprofilesreload: (profiles: ProfileSummary[]) => void;
    onselect: (path: string | null) => void;
  } = $props();

  let detail = $state<ProfileDetail | null>(null);
  let form = $state<ProfileEditForm | null>(null);
  let loading = $state(false);
  let saving = $state(false);
  let deleting = $state(false);
  let loadError = $state('');
  let showDeleteConfirm = $state(false);

  // Load detail when the selected path changes. Cleared when nothing is
  // selected so the empty-state placeholder renders.
  $effect(() => {
    const path = selectedPath;
    if (!path) {
      detail = null;
      form = null;
      loadError = '';
      return;
    }
    loading = true;
    loadError = '';
    getProfile(path)
      .then((d) => {
        // Bail if the user moved on while we were loading.
        if (selectedPath !== path) return;
        detail = d;
        form = formFromDetail(d);
      })
      .catch(() => {
        if (selectedPath !== path) return;
        detail = null;
        form = null;
        loadError = `Failed to load profile "${path}"`;
      })
      .finally(() => {
        if (selectedPath === path) loading = false;
      });
  });

  let nameError = $derived(form ? validateProfileName(form.name) : null);
  let pathError = $derived(form ? validateProfilePath(form.path) : null);
  let isDirty = $derived(
    detail && form ? computeProfileIsDirty(detail, form) : false,
  );
  let canSave = $derived(
    !!form && !nameError && !pathError && isDirty && !saving && !deleting,
  );

  // Register a dirty-checker with the shared navigation guard so that any nav
  // site wrapped with `requestNavigation` (top-level tabs, sidebar profile
  // rows, etc.) prompts before discarding unsaved edits. The closure reads the
  // live `isDirty` derived value, and the cleanup returned from
  // registerDirtyChecker tears the entry down on unmount so a stale checker
  // from a previously-selected profile can't fire.
  $effect(() => {
    return registerDirtyChecker(() => isDirty);
  });

  function toggleEndpoint(name: string) {
    if (!form) return;
    form.endpoints = toggleStagedEndpoint(form.endpoints, name);
  }

  async function handleSave() {
    if (!detail || !form || !canSave) return;
    saving = true;
    await runSaveProfile({
      originalPath: detail.path,
      params: buildUpdateProfileParams(form),
      updateProfile,
      listProfiles,
      setProfiles: (data) => onprofilesreload(data),
      setSelectedPath: (path) => onselect(path),
      applyDetail: (summary) => {
        // Rebase detail/form on the saved-summary shape so isDirty resets.
        // `tools` is preserved from the prior detail (the relay returns the
        // summary shape on PUT; the catalog refresh comes on the next load).
        if (detail) {
          detail = {
            ...detail,
            name: summary.name,
            path: summary.path,
            endpoints: summary.endpoints,
            js_execution: summary.js_execution,
            toon_output: summary.toon_output,
            endpoint_count: summary.endpoint_count,
            tool_count: summary.tool_count,
          };
          form = formFromDetail(detail);
        }
      },
      toastSuccess: toast.success,
      toastError: toast.error,
    });
    saving = false;
  }

  async function handleDelete() {
    if (!detail) {
      showDeleteConfirm = false;
      return;
    }
    deleting = true;
    showDeleteConfirm = false;
    await runDeleteProfile({
      path: detail.path,
      name: detail.name,
      deleteProfile,
      listProfiles,
      setProfiles: (data) => onprofilesreload(data),
      clearSelection: () => onselect(null),
      toastSuccess: toast.success,
      toastError: toast.error,
    });
    deleting = false;
  }

  function handleRevert() {
    if (detail) form = formFromDetail(detail);
  }

  // Connect-your-MCP-client snippet. Derived from the live relay port and the
  // saved profile path so renaming the path (and saving) or changing the port
  // in Settings updates both the URL and the JSON snippet immediately.
  const profileMcpUrl = $derived(
    detail ? `http://localhost:${$relayPort}/mcp/${detail.path}` : '',
  );
  const claudeConfigSnippet = $derived(
    detail
      ? `{
  "mcpServers": {
    "endara-${detail.path}": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://localhost:${$relayPort}/mcp/${detail.path}"
      ]
    }
  }
}`
      : '',
  );

  // Independent copy-button state so the URL and JSON buttons don't flicker
  // each other's checkmark when one is clicked.
  let urlCopied = $state(false);
  let jsonCopied = $state(false);
  function copyUrl() {
    navigator.clipboard.writeText(profileMcpUrl);
    urlCopied = true;
    setTimeout(() => (urlCopied = false), 2000);
  }
  function copyJson() {
    navigator.clipboard.writeText(claudeConfigSnippet);
    jsonCopied = true;
    setTimeout(() => (jsonCopied = false), 2000);
  }
</script>

<div class="flex-1 h-full flex flex-col bg-(--surface) min-w-0 overflow-hidden">
  {#if !selectedPath}
    <div class="flex-1 flex items-center justify-center text-(--fg3)">
      <div class="text-center">
        <div class="text-sm">Select a profile to view details</div>
        <div class="text-xs mt-1">or create a new one with the button on the left</div>
      </div>
    </div>
  {:else if loading && !detail}
    <div class="flex-1 flex items-center justify-center text-(--fg3)">
      <div class="flex flex-col items-center gap-3">
        <div
          class="h-6 w-6 animate-spin rounded-full border-2 border-(--border) border-t-(--accent)"
          role="status"
          aria-label="Loading profile"
        ></div>
        <p class="text-sm">Loading profile…</p>
      </div>
    </div>
  {:else if loadError}
    <div class="flex-1 flex items-center justify-center text-(--offline) text-sm">
      {loadError}
    </div>
  {:else if detail && form}
    <div class="dhdr flex items-center justify-between">
      <div class="min-w-0">
        <h2 class="dhdr-name truncate">{detail.name}</h2>
        <div class="flex items-center gap-2 mt-0.5">
          <span class="text-[11px] text-(--accent)" style="font-family: var(--font-mono);"
            >/mcp/{detail.path}</span
          >
          <span class="text-[11px] text-(--fg3)"
            >{detail.endpoint_count} server{detail.endpoint_count === 1 ? '' : 's'} ·
            {detail.tool_count} tool{detail.tool_count === 1 ? '' : 's'}</span
          >
          {#if isDirty}
            <span
              class="text-[10px] uppercase tracking-wide text-(--accent) font-semibold"
              data-testid="profile-dirty-indicator"
              title="Unsaved changes"
            >• Unsaved</span>
          {/if}
        </div>
      </div>
      <div class="flex items-center gap-1.5 flex-shrink-0">
        {#if isDirty}
          <button
            class="btn-sec btn-sm"
            onclick={handleRevert}
            disabled={saving || deleting}
          >Revert</button>
        {/if}
        <button
          class="btn-pri btn-sm"
          onclick={handleSave}
          disabled={!canSave}
          aria-label="Save profile"
        >{saving ? 'Saving…' : 'Save'}</button>
        <button
          class="btn-sec btn-sm btn-danger"
          onclick={() => (showDeleteConfirm = true)}
          disabled={saving || deleting}
        >Delete</button>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto p-5 space-y-5">
      <div class="space-y-3">
        <div>
          <label for="profile-detail-name" class="block text-xs font-medium mb-1 text-(--fg2)"
            >Name</label
          >
          <input
            id="profile-detail-name"
            type="text"
            bind:value={form.name}
            class="w-full px-2.5 py-1.5 text-sm rounded-lg border bg-(--surface) text-(--fg1) border-(--border) focus:outline-none focus:border-(--accent) {nameError
              ? 'border-(--offline)'
              : ''}"
            aria-invalid={!!nameError}
          />
          {#if nameError}
            <div class="text-[11px] text-(--offline) mt-1">{nameError}</div>
          {/if}
        </div>

        <div>
          <label for="profile-detail-path" class="block text-xs font-medium mb-1 text-(--fg2)"
            >Path</label
          >
          <div class="flex items-center gap-1.5">
            <span
              class="text-[12px] text-(--fg3)"
              style="font-family: var(--font-mono);">/mcp/</span
            >
            <input
              id="profile-detail-path"
              type="text"
              bind:value={form.path}
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
              autocomplete="off"
              class="flex-1 px-2.5 py-1.5 text-sm rounded-lg border bg-(--surface) text-(--fg1) border-(--border) focus:outline-none focus:border-(--accent) {pathError
                ? 'border-(--offline)'
                : ''}"
              style="font-family: var(--font-mono);"
              aria-invalid={!!pathError}
            />
          </div>
          {#if pathError}
            <div class="text-[11px] text-(--offline) mt-1">{pathError}</div>
          {/if}
        </div>

        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="text-xs font-medium text-(--fg2)">JS Execution</div>
            <div class="text-[11px] text-(--fg3)">
              {form.jsExecution
                ? 'execute_tools sandbox enabled'
                : 'Direct tool calls only'}
            </div>
          </div>
          <button
            type="button"
            class="shrink-0 relative w-10 h-5 rounded-full transition-colors {form.jsExecution ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}"
            onclick={() => { if (form) form.jsExecution = !form.jsExecution; }}
            role="switch"
            aria-checked={form.jsExecution}
            aria-label="Toggle JS execution mode for this profile"
          >
            <span class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform {form.jsExecution ? 'translate-x-5' : ''}"></span>
          </button>
        </div>

        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="text-xs font-medium text-(--fg2)">TOON Output</div>
            <div class="text-[11px] text-(--fg3)">
              {form.toonOutput
                ? 'Tool responses encoded as TOON'
                : 'Tool responses as raw JSON'}
            </div>
          </div>
          <button
            type="button"
            class="shrink-0 relative w-10 h-5 rounded-full transition-colors {form.toonOutput ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}"
            onclick={() => { if (form) form.toonOutput = !form.toonOutput; }}
            role="switch"
            aria-checked={form.toonOutput}
            aria-label="Toggle TOON output for this profile"
          >
            <span class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform {form.toonOutput ? 'translate-x-5' : ''}"></span>
          </button>
        </div>
      </div>

      <div>
        <div class="text-xs font-medium text-(--fg2) mb-2">
          Servers ({form.endpoints.size} of {$endpoints.length})
        </div>
        {#if $endpoints.length === 0}
          <div class="text-[11px] text-(--fg3) p-3 border border-dashed border-(--border) rounded-lg">
            No servers configured. Add servers from the Servers tab first.
          </div>
        {:else}
          <div class="space-y-0.5 border border-(--border) rounded-lg overflow-hidden">
            {#each $endpoints as ep (ep.name)}
              <label
                class="flex items-center gap-2.5 px-3 py-1.5 hover:bg-(--hover-bg) cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={form.endpoints.has(ep.name)}
                  onchange={() => toggleEndpoint(ep.name)}
                  aria-label={`Include ${ep.name} in profile`}
                />
                <div class="flex-1 min-w-0">
                  <div class="text-[13px] truncate text-(--fg1)">{ep.name}</div>
                </div>
                <TransportBadge transport={ep.transport} />
                <span class="text-[11px] text-(--fg3) w-16 text-right" style="font-family: var(--font-mono);"
                  >{ep.tool_count} tool{ep.tool_count === 1 ? '' : 's'}</span
                >
              </label>
            {/each}
          </div>
        {/if}
      </div>

      <div class="rounded-lg border border-(--border) bg-(--surface-alt) p-4 space-y-2">
        <h3 class="text-sm font-semibold text-(--fg1)">Connect your MCP client</h3>
        <p class="text-xs text-(--fg2)">
          Point Claude Desktop or other MCP clients to this profile:
        </p>
        <div class="flex items-center gap-2">
          <code class="flex-1 text-xs font-mono bg-(--surface) border border-(--border) rounded px-2 py-1.5 text-(--accent) truncate">
            {profileMcpUrl}
          </code>
          <button
            class="text-xs px-2 py-1.5 rounded border border-(--border) hover:bg-(--surface-hover) transition-colors"
            onclick={copyUrl}
          >
            {urlCopied ? '✓' : 'Copy'}
          </button>
        </div>
        <div class="flex items-start gap-2">
          <pre class="flex-1 text-xs font-mono bg-(--surface) border border-(--border) rounded px-2 py-1.5 text-(--accent) overflow-x-auto whitespace-pre m-0"><code>{claudeConfigSnippet}</code></pre>
          <button
            class="text-xs px-2 py-1.5 rounded border border-(--border) hover:bg-(--surface-hover) transition-colors flex-shrink-0"
            onclick={copyJson}
          >
            {jsonCopied ? '✓' : 'Copy'}
          </button>
        </div>
        <p class="text-xs text-(--fg2)">
          Drop this into <code class="font-mono text-(--accent)">claude_desktop_config.json</code>. For Cursor/HTTP-capable clients, paste the URL above directly.
        </p>
      </div>
    </div>

    {#if showDeleteConfirm}
      <ConfirmModal
        title="Delete Profile"
        message="Are you sure you want to delete '{detail.name}'? This removes the /mcp/{detail.path} route."
        confirmLabel="Delete"
        onconfirm={handleDelete}
        oncancel={() => (showDeleteConfirm = false)}
      />
    {/if}
  {/if}
</div>

<style>
  .dhdr {
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--hd-bg);
  }
  .dhdr-name {
    font-size: 15px;
    font-weight: 600;
    color: var(--fg1);
    line-height: 1.2;
  }
</style>
