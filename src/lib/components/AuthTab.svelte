<script lang="ts">
  import type { OAuthStatus, OAuthStatusValue } from '$lib/types';
  import { selectedEndpoint, oauthStatuses } from '$lib/stores';
  import { getOAuthStatus, refreshOAuth, revokeOAuth, startOAuth } from '$lib/api';
  import { toast } from 'svelte-sonner';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import ConfirmModal from './ConfirmModal.svelte';

  let status = $state<OAuthStatus | null>(null);
  let loading = $state(true);
  let error = $state('');
  let showDisconnectConfirm = $state(false);
  let actionInProgress = $state(false);

  const statusColors: Record<OAuthStatusValue, string> = {
    authenticated: 'bg-green-500',
    needs_login: 'bg-yellow-500',
    refreshing: 'bg-blue-500',
    auth_required: 'bg-orange-500',
    disconnected: 'bg-gray-400',
    connection_failed: 'bg-red-500',
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

  async function handleReconnect() {
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

  async function handleDisconnect() {
    const name = $selectedEndpoint;
    if (!name) return;
    actionInProgress = true;
    try {
      await revokeOAuth(name);
      toast.success('OAuth disconnected');
      await fetchStatus(name);
    } catch {
      toast.error('Failed to disconnect OAuth');
    }
    actionInProgress = false;
    showDisconnectConfirm = false;
  }

  let canRefresh = $derived(status !== null && status.has_refresh_token && ['authenticated', 'auth_required'].includes(status.status));
  let canReconnect = $derived(status !== null && ['disconnected', 'auth_required', 'needs_login'].includes(status.status));
  let canDisconnect = $derived(status !== null && ['authenticated', 'refreshing', 'auth_required'].includes(status.status));
</script>

<div class="h-full overflow-y-auto p-4 space-y-4">
  {#if loading}
    <div class="space-y-3">
      {#each [1, 2, 3] as _}
        <div class="h-12 rounded-lg bg-(--color-surface-hover) animate-pulse"></div>
      {/each}
    </div>
  {:else if error}
    <div class="text-sm text-(--color-offline)">{error}</div>
  {:else if status}
    <!-- Status -->
    <div class="p-4 rounded-lg border border-(--color-border)">
      <div class="text-xs font-medium text-(--color-text-secondary) mb-2">Status</div>
      <div class="flex items-center gap-2">
        <span class="inline-block w-2.5 h-2.5 rounded-full {statusColors[status.status]}"></span>
        <span class="text-sm font-medium">{statusLabels[status.status]}</span>
      </div>
    </div>

    <!-- Token Details -->
    <div class="p-4 rounded-lg border border-(--color-border) space-y-3">
      <div class="text-xs font-medium text-(--color-text-secondary) mb-1">Token Details</div>
      <div class="grid grid-cols-2 gap-3 text-sm">
        <div>
          <div class="text-xs text-(--color-text-secondary)">Access Token</div>
          <div class="font-medium">{status.has_access_token ? '✓ Present' : '✗ None'}</div>
        </div>
        <div>
          <div class="text-xs text-(--color-text-secondary)">Refresh Token</div>
          <div class="font-medium">{status.has_refresh_token ? '✓ Present' : '✗ None'}</div>
        </div>
      </div>
    </div>

    <!-- Timing -->
    <div class="p-4 rounded-lg border border-(--color-border) space-y-3">
      <div class="text-xs font-medium text-(--color-text-secondary) mb-1">Timing</div>
      <div class="grid grid-cols-2 gap-3 text-sm">
        <div>
          <div class="text-xs text-(--color-text-secondary)">Expires In</div>
          <div class="font-medium">{formatCountdown(status.expires_in_seconds)}</div>
        </div>
        <div>
          <div class="text-xs text-(--color-text-secondary)">Expires At</div>
          <div class="font-medium">{formatTime(status.expires_at)}</div>
        </div>
        <div>
          <div class="text-xs text-(--color-text-secondary)">Last Refreshed</div>
          <div class="font-medium">{formatTime(status.last_refreshed_at)}</div>
        </div>
        <div>
          <div class="text-xs text-(--color-text-secondary)">Next Refresh</div>
          <div class="font-medium">{status.has_refresh_token ? formatTime(status.next_refresh_at) : '—'}</div>
        </div>
      </div>
    </div>

    <!-- Actions -->
    <div class="flex gap-2">
      {#if canRefresh}
        <button
          class="px-3 py-1.5 text-sm rounded-lg border border-(--color-border) hover:bg-(--color-surface-hover) transition-colors disabled:opacity-50"
          onclick={handleRefresh}
          disabled={actionInProgress}
        >Refresh Now</button>
      {/if}
      {#if canReconnect}
        <button
          class="px-3 py-1.5 text-sm rounded-lg bg-(--color-accent) text-white hover:bg-(--color-accent-hover) transition-colors disabled:opacity-50"
          onclick={handleReconnect}
          disabled={actionInProgress}
        >Reconnect</button>
      {/if}
      {#if canDisconnect}
        <button
          class="px-3 py-1.5 text-sm rounded-lg border border-(--color-offline)/30 text-(--color-offline) hover:bg-(--color-offline)/10 transition-colors disabled:opacity-50"
          onclick={() => showDisconnectConfirm = true}
          disabled={actionInProgress}
        >Disconnect</button>
      {/if}
    </div>

    {#if showDisconnectConfirm}
      <ConfirmModal
        title="Disconnect OAuth"
        message="Are you sure you want to disconnect? This will revoke the OAuth tokens and you'll need to re-authorize."
        confirmLabel="Disconnect"
        onconfirm={handleDisconnect}
        oncancel={() => showDisconnectConfirm = false}
      />
    {/if}
  {/if}
</div>

