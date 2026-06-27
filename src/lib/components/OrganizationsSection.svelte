<script lang="ts">
  import { onMount } from 'svelte';
  import {
    deleteOrganization,
    reauthenticateOrganization,
  } from '$lib/api';
  import { organizations, refreshOrganizations } from '$lib/stores/organizations';
  import { orgStatusLabel, reauthenticateOrg } from './onboarding-helpers';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { toast } from 'svelte-sonner';
  import ConfirmModal from './ConfirmModal.svelte';
  import ConnectOrgModal from './ConnectOrgModal.svelte';

  let loading = $state(true);
  let error = $state('');
  let busy: string | null = $state(null);
  let pendingRemove: string | null = $state(null);
  // Org name being re-detected (opens ConnectOrgModal in re-detect mode).
  let redetectOrg: string | null = $state(null);

  async function loadOrgs() {
    loading = true;
    try {
      await refreshOrganizations();
      error = '';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(loadOrgs);

  async function handleReauth(name: string) {
    busy = name;
    try {
      await reauthenticateOrg(name, { reauthenticateOrganization, openUrl });
      await refreshOrganizations();
      toast.success(`Browser opened to re-authenticate ${name}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      busy = null;
    }
  }

  async function handleRemove(name: string) {
    pendingRemove = null;
    busy = name;
    try {
      await deleteOrganization(name);
      toast.success(`Removed ${name}`);
      await refreshOrganizations();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      busy = null;
    }
  }
</script>

<div class="pt-4 mt-4 border-t border-(--border)">
  <div class="text-xs font-medium text-(--fg2) uppercase tracking-wide mb-3">Organizations</div>

  {#if loading}
    <p class="text-xs text-(--fg2)">Loading organizations…</p>
  {:else if error}
    <div class="p-2 rounded bg-yellow-500/10 border border-yellow-500/20">
      <p class="text-xs text-yellow-600 dark:text-yellow-400">Couldn't load organizations: {error}</p>
    </div>
  {:else if $organizations.length === 0}
    <p class="text-xs text-(--fg2)">
      No organizations connected yet. Use “Connect an organization” from the Add Server dialog to
      sign in and detect granted MCP servers.
    </p>
  {:else}
    <div class="space-y-2">
      {#each $organizations as org (org.name)}
        <div class="rounded-lg border border-(--border) p-3">
          <div class="flex items-center justify-between gap-2">
            <div class="min-w-0">
              <div class="text-sm font-medium text-(--fg1) truncate">{org.name}</div>
              <div class="text-[11px] text-(--fg2) truncate">{org.provider} · {org.idp}</div>
            </div>
            <span
              class="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium {org.authenticated
                ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                : 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400'}"
            >
              {orgStatusLabel(org)}
            </span>
          </div>
          <div class="flex items-center gap-2 mt-2">
            <button
              class="px-2.5 py-1 text-xs rounded-lg border border-(--border) hover:bg-(--surface-hover) transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              onclick={() => (redetectOrg = org.name)}
              disabled={busy === org.name || !org.authenticated}
              title={org.authenticated ? 'Re-run detection for this organization' : 'Sign in first to detect servers'}
            >
              Detect servers
            </button>
            <button
              class="px-2.5 py-1 text-xs rounded-lg border border-(--border) hover:bg-(--surface-hover) transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              onclick={() => handleReauth(org.name)}
              disabled={busy === org.name}
            >
              Re-authenticate
            </button>
            <button
              class="px-2.5 py-1 text-xs rounded-lg border border-(--border) text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              onclick={() => (pendingRemove = org.name)}
              disabled={busy === org.name}
            >
              Remove
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if redetectOrg}
  <ConnectOrgModal redetectOrg={redetectOrg} onclose={() => { redetectOrg = null; }} />
{/if}

{#if pendingRemove}
  <ConfirmModal
    title="Remove organization?"
    message={`Removing "${pendingRemove}" purges its stored credentials. Endpoints bound to it will stop working.`}
    confirmLabel="Remove"
    onconfirm={() => { if (pendingRemove) void handleRemove(pendingRemove); }}
    oncancel={() => { pendingRemove = null; }}
  />
{/if}
