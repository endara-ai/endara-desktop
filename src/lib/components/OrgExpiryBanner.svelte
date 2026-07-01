<script lang="ts">
  import { onDestroy } from 'svelte';
  import { listOrganizations, reauthenticateOrganization } from '$lib/api';
  import { organizations, refreshOrganizations } from '$lib/stores/organizations';
  import { activeTopLevelTab } from '$lib/stores';
  import {
    orgExpiryBannerMessage,
    pollForOrgAuth,
    reauthenticateOrg,
    unauthenticatedOrgs,
  } from './onboarding-helpers';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { toast } from 'svelte-sonner';

  // Global banner — appears at the very top of the app whenever one or more
  // orgs report `authenticated: false` (the relay computes this from the
  // stored ID token's expiry). Auto-dismisses once the store flips back to
  // authenticated after a successful re-auth. The app-wide poll in
  // `+layout.svelte` keeps the store fresh regardless of which screen is
  // open, so users don't have to open Settings to notice an expiry.
  const stale = $derived(unauthenticatedOrgs($organizations));
  const message = $derived(orgExpiryBannerMessage($organizations));
  const single = $derived(stale.length === 1 ? stale[0] : null);

  let busy = $state<string | null>(null);

  // Background re-auth polls keyed by org name — mirrors OrganizationsSection.
  // A repeat click cancels the prior poll for that org, and `onDestroy`
  // cancels all outstanding polls so no timers leak past unmount.
  const activeReauthPolls = new Map<string, { cancelled: boolean }>();

  function cancelReauthPoll(name: string) {
    const token = activeReauthPolls.get(name);
    if (token) {
      token.cancelled = true;
      activeReauthPolls.delete(name);
    }
  }

  onDestroy(() => {
    for (const token of activeReauthPolls.values()) token.cancelled = true;
    activeReauthPolls.clear();
  });

  async function handleReauth(name: string) {
    busy = name;
    try {
      await reauthenticateOrg(name, { reauthenticateOrganization, openUrl });
      toast.success(`Browser opened to re-authenticate ${name}`);
      cancelReauthPoll(name);
      const token = { cancelled: false };
      activeReauthPolls.set(name, token);
      void (async () => {
        const outcome = await pollForOrgAuth(
          name,
          { listOrganizations },
          { shouldCancel: () => token.cancelled },
        );
        if (activeReauthPolls.get(name) === token) activeReauthPolls.delete(name);
        if (outcome.status === 'authenticated') {
          try {
            await refreshOrganizations();
          } catch {
            // Non-fatal; the layout poll reconciles later.
          }
        }
      })();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      busy = null;
    }
  }

  function goToSettings() {
    activeTopLevelTab.set('settings');
  }
</script>

{#if message}
  <div
    role="alert"
    class="fixed top-0 left-0 right-0 z-50 border-b border-(--degraded) bg-(--degraded)/10 text-(--fg1) px-4 py-2 flex items-center gap-3"
  >
    <span
      class="shrink-0 w-2 h-2 rounded-full bg-(--degraded)"
      aria-hidden="true"
    ></span>
    <span class="text-xs font-medium truncate">{message}</span>
    <div class="ml-auto shrink-0">
      {#if single}
        <button
          class="px-2.5 py-1 text-xs rounded-lg border border-(--degraded) text-(--fg1) hover:bg-(--degraded)/20 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          onclick={() => handleReauth(single.name)}
          disabled={busy === single.name}
        >
          Re-authenticate
        </button>
      {:else}
        <button
          class="px-2.5 py-1 text-xs rounded-lg border border-(--degraded) text-(--fg1) hover:bg-(--degraded)/20 transition-colors"
          onclick={goToSettings}
        >
          Open Settings
        </button>
      {/if}
    </div>
  </div>
{/if}
