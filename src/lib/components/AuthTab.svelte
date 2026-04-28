<script lang="ts">
  import type { OAuthStatus, OAuthStatusValue } from '$lib/types';
  import { selectedEndpoint, oauthStatuses } from '$lib/stores';
  import { getOAuthStatus, refreshOAuth, startOAuth } from '$lib/api';
  import { toast } from 'svelte-sonner';
  import { openUrl } from '@tauri-apps/plugin-opener';

  let status = $state<OAuthStatus | null>(null);
  let loading = $state(true);
  let error = $state('');
  let actionInProgress = $state(false);

  const statusColors: Record<OAuthStatusValue, string> = {
    authenticated: 'bg-(--healthy)',
    needs_login: 'bg-(--degraded)',
    refreshing: 'bg-(--accent)',
    auth_required: 'bg-(--degraded)',
    disconnected: 'bg-(--fg3)',
    connection_failed: 'bg-(--offline)',
  };

  const statusLabels: Record<OAuthStatusValue, string> = {
    authenticated: 'Authenticated',
    needs_login: 'Needs Login',
    refreshing: 'Refreshing',
    auth_required: 'Auth Required',
    disconnected: 'Disconnected',
    connection_failed: 'Connection Failed',
  };

  function formatTime(unixSeconds: number | null): string {
    if (unixSeconds === null || unixSeconds === undefined) return '—';
    const d = new Date(unixSeconds * 1000);
    return d.toLocaleString();
  }

  function formatCountdown(seconds: number | null): string {
    if (seconds === null || seconds === undefined) return '—';
    if (seconds <= 0) return 'Expired';
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    if (m > 60) {
      const h = Math.floor(m / 60);
      return `${h}h ${m % 60}m`;
    }
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  async function fetchStatus(name: string) {
    try {
      status = await getOAuthStatus(name);
      // Update global store
      oauthStatuses.update(m => { m.set(name, status!); return new Map(m); });
      error = '';
    } catch {
      error = 'Failed to load OAuth status';
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    const name = $selectedEndpoint;
    if (!name) return;
    loading = true;
    fetchStatus(name);

    const interval = setInterval(() => {
      if (name) fetchStatus(name);
    }, 5000);

    return () => clearInterval(interval);
  });

  async function handleRefresh() {
    const name = $selectedEndpoint;
    if (!name || actionInProgress) return;
    actionInProgress = true;
    try {
      await refreshOAuth(name);
      toast.success('Token refresh initiated');
      await fetchStatus(name);
    } catch {
      toast.error('Failed to refresh token');
    }
    actionInProgress = false;
  }

  async function handleReauthorize() {
    const name = $selectedEndpoint;
    if (!name || actionInProgress) return;
    actionInProgress = true;
    try {
      const result = await startOAuth(name);
      if ('authorize_url' in result) {
        await openUrl(result.authorize_url);
        toast.success('Browser opened for authorization');
      } else if ('error' in result && result.error === 'discovery_failed') {
        toast.error('OAuth discovery failed. Go to Settings to configure OAuth server URL manually.');
      } else if ('error' in result && result.error === 'dcr_unsupported') {
        toast.error('This server requires manual OAuth app registration. Go to Settings to enter your Client ID.');
      } else {
        toast.error('Failed to start OAuth flow');
      }
    } catch {
      toast.error('Failed to start OAuth flow');
    }
    actionInProgress = false;
  }

  let canRefresh = $derived(status !== null && status.has_refresh_token && ['authenticated', 'auth_required'].includes(status.status));
  let canReauthorize = $derived(status !== null && ['disconnected', 'auth_required', 'needs_login'].includes(status.status));
</script>

<div class="h-full overflow-y-auto p-4 space-y-4">
  {#if loading}
    <div class="space-y-3">
      {#each [1, 2, 3] as _}
        <div class="h-12 rounded-lg bg-(--surface-hover) animate-pulse"></div>
      {/each}
    </div>
  {:else if error}
    <div class="text-sm text-(--offline)">{error}</div>
  {:else if status}
    <!-- Status -->
    <div class="p-4 rounded-lg border border-(--border) bg-(--surface)">
      <div class="text-xs font-medium text-(--fg2) mb-2">Status</div>
      <div class="flex items-center gap-2">
        <span class="inline-block w-2.5 h-2.5 rounded-full {statusColors[status.status]}"></span>
        <span class="t-body font-medium text-(--fg1)">{statusLabels[status.status]}</span>
      </div>
    </div>

    <!-- Token Details -->
    <div class="p-4 rounded-lg border border-(--border) bg-(--surface) space-y-3">
      <div class="text-xs font-medium text-(--fg2) mb-1">Token Details</div>
      <div class="grid grid-cols-2 gap-3 text-sm">
        <div>
          <div class="text-xs text-(--fg3)">Access Token</div>
          <div class="font-medium text-(--fg1)">{status.has_access_token ? '✓ Present' : '✗ None'}</div>
        </div>
        <div>
          <div class="text-xs text-(--fg3)">Refresh Token</div>
          <div class="font-medium text-(--fg1)">{status.has_refresh_token ? '✓ Present' : '✗ None'}</div>
        </div>
      </div>
    </div>

    <!-- Timing -->
    <div class="p-4 rounded-lg border border-(--border) bg-(--surface) space-y-3">
      <div class="text-xs font-medium text-(--fg2) mb-1">Timing</div>
      <div class="grid grid-cols-2 gap-3 text-sm">
        <div>
          <div class="text-xs text-(--fg3)">Expires In</div>
          <div class="font-medium text-(--fg1)">{formatCountdown(status.expires_in_seconds)}</div>
        </div>
        <div>
          <div class="text-xs text-(--fg3)">Expires At</div>
          <div class="font-medium text-(--fg1)">{formatTime(status.expires_at)}</div>
        </div>
        <div>
          <div class="text-xs text-(--fg3)">Last Refreshed</div>
          <div class="font-medium text-(--fg1)">{formatTime(status.last_refreshed_at)}</div>
        </div>
        <div>
          <div class="text-xs text-(--fg3)">Next Refresh</div>
          <div class="font-medium text-(--fg1)">{status.has_refresh_token ? formatTime(status.next_refresh_at) : '—'}</div>
        </div>
      </div>
    </div>

    <!-- Actions -->
    <div class="flex gap-2">
      {#if canRefresh}
        <button
          class="btn-sec"
          onclick={handleRefresh}
          disabled={actionInProgress}
        >Refresh Now</button>
      {/if}
      {#if canReauthorize}
        <button
          class="btn-accent"
          onclick={handleReauthorize}
          disabled={actionInProgress}
          title="Open the browser to sign in again"
          aria-label="Re-authorize"
        >Re-authorize</button>
      {/if}
    </div>
  {/if}
</div>


<style>
  .btn-sec {
    padding: 6px 12px;
    font-size: 13px;
    line-height: 1.4;
    font-weight: 500;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: transparent;
    color: var(--fg1);
    cursor: pointer;
    font-family: inherit;
    transition: background-color 150ms var(--ease), color 150ms var(--ease);
  }
  .btn-sec:hover:not(:disabled) {
    background: var(--hover-bg);
  }
  .btn-sec:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .btn-danger {
    border-color: color-mix(in oklab, var(--offline) 35%, transparent);
    color: var(--offline);
  }
  .btn-danger:hover:not(:disabled) {
    background: color-mix(in oklab, var(--offline) 8%, transparent);
  }
  .btn-accent {
    padding: 6px 12px;
    font-size: 13px;
    line-height: 1.4;
    font-weight: 500;
    border: 1px solid var(--accent);
    border-radius: 8px;
    background: var(--accent);
    color: var(--accent-fg, #fff);
    cursor: pointer;
    font-family: inherit;
    transition: background-color 150ms var(--ease);
  }
  .btn-accent:hover:not(:disabled) {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }
  .btn-accent:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
