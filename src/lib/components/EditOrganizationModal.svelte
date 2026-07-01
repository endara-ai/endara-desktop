<script lang="ts">
  import {
    getIdpProviders,
    updateOrganization,
    updateRequiresReauth,
    type UpdateOrganizationParams,
  } from '$lib/api';
  import type { IdpProvider, Organization } from '$lib/types';
  import { isCustomProvider, providerNeedsSlug } from './onboarding-helpers';
  import { focusTrap } from '$lib/actions/focusTrap';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { refreshOrganizations } from '$lib/stores/organizations';
  import { toast } from 'svelte-sonner';

  let { org, onclose }: { org: Organization; onclose: () => void } = $props();

  let providers: IdpProvider[] = $state([]);
  let providersError = $state('');
  // The modal is mounted per-edit so `org` is the desired initial snapshot;
  // we don't want to re-derive when the parent's store row updates.
  // svelte-ignore state_referenced_locally
  let providerId = $state(org.provider);
  // svelte-ignore state_referenced_locally
  let name = $state(org.name);
  // For templated providers the relay stores the FULL issuer (we can't reverse
  // a slug). Leave the slug field blank — submitting blank preserves the
  // current issuer; entering a new slug rebuilds it on the relay.
  let slugOrUrl = $state('');
  // The relay's org listing does not expose `client_id`, so this field starts
  // blank. Blank = preserve current; toggling `clearClientId` sends `""` so the
  // relay drops the persisted id (next resolution falls back to CIMD/DCR).
  let clientId = $state('');
  let clearClientId = $state(false);
  // Write-only. Blank = preserve current; "clearSecret" toggle = delete.
  let clientSecret = $state('');
  let clearSecret = $state(false);
  let error = $state('');
  let submitting = $state(false);

  let selectedProvider = $derived(providers.find((p) => p.id === providerId) ?? null);
  let needsField = $derived(
    !!selectedProvider &&
      (isCustomProvider(selectedProvider) || providerNeedsSlug(selectedProvider)),
  );

  getIdpProviders()
    .then((p) => {
      providers = p;
    })
    .catch(() => {
      providersError = 'Failed to load providers';
    });

  function buildParams(): UpdateOrganizationParams {
    const params: UpdateOrganizationParams = {};
    const trimmedName = name.trim();
    if (trimmedName && trimmedName !== org.name) params.name = trimmedName;
    if (providerId && providerId !== org.provider) params.provider = providerId;
    const trimmedField = slugOrUrl.trim();
    if (trimmedField && selectedProvider) {
      if (isCustomProvider(selectedProvider)) params.idp = trimmedField;
      else if (providerNeedsSlug(selectedProvider)) params.slug = trimmedField;
    }
    // Client id: clearClientId wins ("" → drop). Otherwise blank preserves
    // the current value; a non-empty trimmed value sets a new id.
    if (clearClientId) params.client_id = '';
    else {
      const trimmedClientId = clientId.trim();
      if (trimmedClientId) params.client_id = trimmedClientId;
    }
    // Client secret: clearSecret wins ("" → delete); blank preserves the
    // current value; a non-empty trimmed value sets a new secret.
    if (clearSecret) params.client_secret = '';
    else {
      const trimmedSecret = clientSecret.trim();
      if (trimmedSecret) params.client_secret = trimmedSecret;
    }
    return params;
  }

  async function handleSave() {
    error = '';
    const trimmedName = name.trim();
    if (!trimmedName) {
      error = 'Enter an organization name.';
      return;
    }
    if (selectedProvider && isCustomProvider(selectedProvider) && providerId !== org.provider) {
      if (!slugOrUrl.trim()) {
        error = 'Enter the issuer URL for the new provider.';
        return;
      }
    }
    // Switching between two templated providers (e.g. okta → ping) needs a
    // fresh slug — the relay stores the FULL issuer and can't reverse a slug
    // from the previous provider's URL. Without this guard we'd send
    // `provider` alone and the relay would rebuild an issuer using an empty
    // slug. Mirrors the create-flow requirement in `buildCreateOrgParams`.
    if (
      selectedProvider &&
      providerNeedsSlug(selectedProvider) &&
      providerId !== org.provider &&
      !slugOrUrl.trim()
    ) {
      error = 'Enter the organization slug for the new provider.';
      return;
    }
    submitting = true;
    try {
      const res = await updateOrganization(org.name, buildParams());
      try {
        await refreshOrganizations();
      } catch {
        // Settings mount poll reconciles later.
      }
      if (updateRequiresReauth(res)) {
        await openUrl(res.authorize_url);
        toast.success(`Browser opened to re-authenticate ${res.name}`);
      } else {
        toast.success(`Updated ${res.name}`);
      }
      onclose();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      submitting = false;
    }
  }

  function handleCancel() {
    onclose();
  }
</script>

<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
  role="presentation"
  onclick={handleCancel}
>
  <div
    class="bg-(--surface) rounded-xl shadow-xl border border-(--border) p-6 w-[34rem] max-w-[90vw] max-h-[90vh] overflow-y-auto"
    role="dialog"
    aria-modal="true"
    aria-label="Edit organization"
    tabindex="-1"
    use:focusTrap={{ onEscape: handleCancel }}
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
  >
    <h3 class="text-base font-semibold mb-1 text-(--fg1)">Edit organization</h3>
    <p class="text-xs text-(--fg2) mb-4">
      Changing the name, provider, issuer, or client ID requires re-authenticating with the IdP.
    </p>

    {#if providersError}
      <p class="text-xs text-(--offline) mb-3">{providersError}</p>
    {/if}

    <div class="space-y-3">
      <div>
        <label for="edit-org-name" class="block text-xs font-medium mb-1 text-(--fg2)">
          Organization name
        </label>
        <input
          id="edit-org-name"
          type="text"
          bind:value={name}
          class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)"
        />
      </div>

      <div>
        <label for="edit-org-provider" class="block text-xs font-medium mb-1 text-(--fg2)">
          Provider
        </label>
        <select
          id="edit-org-provider"
          bind:value={providerId}
          class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) focus:outline-none focus:border-(--accent)"
        >
          {#each providers as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
        </select>
      </div>


      {#if needsField && selectedProvider}
        <div>
          <label for="edit-org-slug" class="block text-xs font-medium mb-1 text-(--fg2)">
            {isCustomProvider(selectedProvider) ? 'Issuer URL' : 'Organization slug'}
            <span class="text-(--fg2)/60">(leave blank to keep current)</span>
          </label>
          <input
            id="edit-org-slug"
            type="text"
            bind:value={slugOrUrl}
            placeholder={isCustomProvider(selectedProvider) ? org.idp : selectedProvider.slug_hint ?? 'your-org'}
            class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)"
          />
          <p class="text-[11px] text-(--fg2) mt-0.5">
            Current issuer: <code>{org.idp}</code>
          </p>
        </div>
      {/if}

      <div>
        <label for="edit-org-client-id" class="block text-xs font-medium mb-1 text-(--fg2)">
          Client ID <span class="text-(--fg2)/60">(leave blank to keep current)</span>
        </label>
        <input
          id="edit-org-client-id"
          type="text"
          bind:value={clientId}
          placeholder="Pre-registered IdP client ID"
          disabled={clearClientId}
          class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent) disabled:opacity-50"
        />
        <label class="flex items-center gap-1.5 text-[11px] text-(--fg2) mt-1 cursor-pointer">
          <input type="checkbox" class="accent-(--accent)" bind:checked={clearClientId} />
          Clear stored client ID
        </label>
      </div>

      <div>
        <label for="edit-org-client-secret" class="block text-xs font-medium mb-1 text-(--fg2)">
          Client Secret <span class="text-(--fg2)/60">(leave blank to keep current)</span>
        </label>
        <input
          id="edit-org-client-secret"
          type="password"
          autocomplete="new-password"
          bind:value={clientSecret}
          placeholder={org.client_secret_set ? 'A secret is stored — type to replace' : 'Pre-registered IdP client secret'}
          disabled={clearSecret}
          class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent) disabled:opacity-50"
        />
        <label class="flex items-center gap-1.5 text-[11px] text-(--fg2) mt-1 cursor-pointer">
          <input type="checkbox" class="accent-(--accent)" bind:checked={clearSecret} />
          Clear stored client secret
        </label>
        <p class="text-[11px] text-(--fg2) mt-0.5">
          Required for confidential Okta/Entra/custom IdP apps that issue a secret. Stored in
          owner-scoped credential directory, separate from <code>config.toml</code>.
        </p>
      </div>
    </div>

    {#if error}
      <p class="text-xs text-(--offline) mt-3">{error}</p>
    {/if}

    <div class="flex justify-end gap-2 pt-4">
      <button
        class="px-3 py-1.5 text-sm rounded-lg border border-(--border) hover:bg-(--surface-hover) transition-colors"
        onclick={handleCancel}
      >
        Cancel
      </button>
      <button
        class="px-3 py-1.5 text-sm rounded-lg bg-(--accent) text-white hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-not-allowed"
        onclick={handleSave}
        disabled={submitting}
      >
        {submitting ? 'Saving…' : 'Save'}
      </button>
    </div>
  </div>
</div>
