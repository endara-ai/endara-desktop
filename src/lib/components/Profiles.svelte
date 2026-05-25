<script lang="ts">
  import { onMount } from 'svelte';
  import { listProfiles, type ProfileSummary } from '$lib/api';
  import { requestNavigation } from '$lib/stores/unsavedChangesGuard';
  import ProfileSidebar from './ProfileSidebar.svelte';
  import ProfileDetail from './ProfileDetail.svelte';
  import CreateProfileModal from './CreateProfileModal.svelte';

  let profiles: ProfileSummary[] = $state([]);
  let selectedPath: string | null = $state(null);
  let loading = $state(true);
  let loadError = $state('');
  let showCreateModal = $state(false);

  async function load() {
    try {
      const data = await listProfiles();
      profiles = data;
      loadError = '';
    } catch {
      profiles = [];
      loadError = 'Failed to load profiles';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    load();
  });

  function handleSelect(path: string | null) {
    selectedPath = path;
  }

  function handleCreated(profile: ProfileSummary) {
    // Insert (or update) the created profile in the local list immediately so
    // the sidebar shows it before the next refresh, then select it. Wrapped
    // in requestNavigation in case the detail pane is dirty.
    requestNavigation(() => {
      const existing = profiles.findIndex((p) => p.path === profile.path);
      if (existing >= 0) {
        profiles = profiles.map((p, i) => (i === existing ? profile : p));
      } else {
        profiles = [...profiles, profile];
      }
      selectedPath = profile.path;
    });
    // Best-effort full refresh so endpoint/tool counts stay accurate.
    void load();
  }

  function handleProfilesReload(data: ProfileSummary[]) {
    profiles = data;
  }
</script>

<div class="h-full flex flex-col">
  {#if loadError && profiles.length === 0}
    <div class="flex-1 flex items-center justify-center text-(--offline) text-sm">
      {loadError}
    </div>
  {:else if !loading && profiles.length === 0}
    <div
      class="flex-1 flex items-center justify-center p-8"
      data-testid="profiles-empty-state"
    >
      <div class="text-center max-w-sm">
        <h2 class="text-base font-semibold text-(--fg1) mb-1">No profiles yet</h2>
        <p class="text-sm text-(--fg2) mb-4 leading-relaxed">
          Create one to namespace your servers by project.
        </p>
        <button
          class="btn-pri btn-sm inline-flex items-center justify-center gap-1.5"
          onclick={() => (showCreateModal = true)}
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
          </svg>
          <span>Create Profile</span>
        </button>
      </div>
    </div>
    {#if showCreateModal}
      <CreateProfileModal
        onclose={() => (showCreateModal = false)}
        oncreated={(p) => handleCreated(p)}
      />
    {/if}
  {:else}
    <div class="flex-1 flex overflow-hidden">
      <ProfileSidebar
        {profiles}
        {selectedPath}
        {loading}
        onselect={handleSelect}
        oncreated={handleCreated}
      />
      <ProfileDetail
        {selectedPath}
        onprofilesreload={handleProfilesReload}
        onselect={handleSelect}
      />
    </div>
  {/if}
</div>
