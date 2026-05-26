<script lang="ts">
  import { selectedEndpoint } from '$lib/stores';
  import {
    listProfiles,
    getEndpointProfiles,
    updateProfile,
    type ProfileSummary,
  } from '$lib/api';
  import { toast } from 'svelte-sonner';
  import {
    buildEndpointProfileRows,
    buildToggleUpdatePayload,
  } from './endpoint-profiles-helpers';

  let allProfiles = $state<ProfileSummary[]>([]);
  let memberPaths = $state<string[]>([]);
  let loading = $state(true);
  let error = $state('');
  let togglingPath: string | null = $state(null);

  let rows = $derived(buildEndpointProfileRows(allProfiles, memberPaths));

  async function load(name: string) {
    loading = true;
    error = '';
    try {
      const [profiles, membership] = await Promise.all([
        listProfiles(),
        getEndpointProfiles(name),
      ]);
      allProfiles = profiles;
      memberPaths = membership.profiles;
    } catch {
      error = 'Failed to load profiles';
      allProfiles = [];
      memberPaths = [];
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    const name = $selectedEndpoint;
    if (!name) return;
    load(name);
  });

  async function handleToggle(profile: ProfileSummary, nextMember: boolean) {
    const name = $selectedEndpoint;
    if (!name || togglingPath) return;
    togglingPath = profile.path;
    try {
      await updateProfile(profile.path, buildToggleUpdatePayload(profile, name, nextMember));
      try {
        const membership = await getEndpointProfiles(name);
        memberPaths = membership.profiles;
      } catch {
        // Mutation already succeeded — silent on purpose; next reload reconciles.
      }
    } catch {
      toast.error(`Failed to update profile "${profile.name}"`);
    }
    togglingPath = null;
  }
</script>

<div class="dbody">
  {#if loading}
    <div class="space-y-2">
      {#each [1, 2, 3] as _}
        <div class="h-10 rounded-lg bg-(--surface-hover) animate-pulse"></div>
      {/each}
    </div>
  {:else if error}
    <div class="text-sm text-(--offline)">{error}</div>
  {:else if rows.length === 0}
    <div class="text-sm text-(--fg3) text-center py-6">
      No profiles yet — create one in the Profiles tab to namespace your servers.
    </div>
  {:else}
    <p class="profile-description">
      Enable this server in a profile to include its tools at <span class="mono">/mcp/{'{'}path{'}'}</span>. Disable to keep its tools out of that profile's endpoint.
    </p>
    {#each rows as row (row.path)}
      {@const profile = allProfiles.find((p) => p.path === row.path)!}
      <label class="profile-row {togglingPath === row.path ? 'opacity-50' : ''}">
        <input
          type="checkbox"
          checked={row.member}
          disabled={togglingPath !== null}
          onchange={(e) => handleToggle(profile, (e.currentTarget as HTMLInputElement).checked)}
          aria-label="{row.member ? 'Remove from' : 'Add to'} profile {row.name}"
        />
        <div class="min-w-0 flex-1">
          <div class="profile-name">{row.name}</div>
          <div class="profile-path">/mcp/{row.path}</div>
        </div>
      </label>
    {/each}
  {/if}
</div>

<style>
  .dbody {
    height: 100%;
    overflow-y: auto;
    padding: 16px 20px;
  }

  .profile-description {
    font-size: 12px;
    color: var(--fg2);
    margin-bottom: 12px;
    line-height: 1.4;
  }
  .profile-description .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .profile-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    cursor: pointer;
    margin-bottom: 8px;
    transition: background-color 120ms var(--ease);
  }
  .profile-row:hover {
    background: var(--surface-hover);
  }
  .profile-row input[type='checkbox'] {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    cursor: pointer;
    accent-color: var(--accent);
  }
  .profile-row input[type='checkbox']:disabled {
    cursor: not-allowed;
  }

  .profile-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--fg1);
    line-height: 1.2;
  }
  .profile-path {
    font-size: 11px;
    color: var(--fg3);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    margin-top: 2px;
  }
</style>
