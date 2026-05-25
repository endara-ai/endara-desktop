<script lang="ts">
  import type { ProfileSummary } from '$lib/api';
  import ProfileSidebarRow from './ProfileSidebarRow.svelte';
  import CreateProfileModal from './CreateProfileModal.svelte';
  import { sortProfilesByName } from './profile-detail-helpers';

  let {
    profiles,
    selectedPath,
    loading,
    onselect,
    oncreated,
  }: {
    profiles: ProfileSummary[];
    selectedPath: string | null;
    loading: boolean;
    onselect: (path: string) => void;
    oncreated: (profile: ProfileSummary) => void;
  } = $props();

  let showCreateModal = $state(false);

  let sorted = $derived(sortProfilesByName(profiles));
</script>

<aside class="w-60 h-full flex flex-col border-r border-(--border) bg-(--side-bg)">
  <div class="p-3 border-b border-(--border)">
    <button
      class="w-full btn-pri btn-sm flex items-center justify-center gap-1.5"
      onclick={() => (showCreateModal = true)}
    >
      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
      </svg>
      <span>Create Profile</span>
    </button>
  </div>

  <div class="flex-1 overflow-y-auto p-2">
    {#if loading}
      <div class="space-y-0.5" aria-hidden="true" data-testid="profile-sidebar-skeleton">
        {#each [0, 1, 2] as i (i)}
          <div class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg animate-pulse">
            <div class="flex-1 min-w-0 space-y-1.5">
              <div class="h-3 rounded bg-(--border) w-3/4"></div>
              <div class="h-2 rounded bg-(--border) w-1/2"></div>
            </div>
          </div>
        {/each}
      </div>
    {:else if sorted.length === 0}
      <div class="p-3 text-center text-[12px] text-(--fg3) leading-relaxed">
        No profiles yet. Create one to namespace your servers by project.
      </div>
    {:else}
      <div class="space-y-0.5">
        {#each sorted as profile (profile.path)}
          <ProfileSidebarRow
            {profile}
            selected={profile.path === selectedPath}
            {onselect}
          />
        {/each}
      </div>
    {/if}
  </div>

  {#if showCreateModal}
    <CreateProfileModal
      onclose={() => (showCreateModal = false)}
      oncreated={(p) => oncreated(p)}
    />
  {/if}
</aside>
