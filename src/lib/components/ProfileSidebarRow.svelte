<script lang="ts">
  import type { ProfileSummary } from '$lib/api';
  import { requestNavigation } from '$lib/stores/unsavedChangesGuard';

  let {
    profile,
    selected,
    onselect,
  }: {
    profile: ProfileSummary;
    selected: boolean;
    onselect: (path: string) => void;
  } = $props();

  function select() {
    // Same row that's already selected → no-op so we don't show the
    // discard-changes prompt for a navigation that wouldn't move anywhere.
    if (selected) return;
    requestNavigation(() => onselect(profile.path));
  }
</script>

<button
  class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-left transition-colors
    hover:bg-(--hover-bg)
    {selected ? 'bg-(--hover-bg)' : ''}"
  onclick={select}
  aria-current={selected ? 'true' : undefined}
>
  <div class="flex-1 min-w-0">
    <div class="text-[13px] font-medium truncate text-(--fg1)">{profile.name}</div>
    <div class="flex items-baseline gap-1.5 mt-px">
      <span
        class="text-[11px] text-(--accent) truncate"
        style="font-family: var(--font-mono);"
      >/mcp/{profile.path}</span>
      <span class="text-[11px] text-(--fg3)" style="font-family: var(--font-mono);">
        {profile.endpoint_count} server{profile.endpoint_count === 1 ? '' : 's'}
      </span>
    </div>
  </div>
</button>
