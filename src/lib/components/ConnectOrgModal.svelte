<script lang="ts">
  import {
    getIdpProviders,
    listOrganizations,
    probeOrganization,
    addEndpoint,
    getEndpoints,
    createOrganization,
  } from '$lib/api';
  import type { IdpProvider, OrgProbeResult } from '$lib/types';
  import {
    isCustomProvider,
    providerNeedsSlug,
    buildIssuerPreview,
    buildCreateOrgParams,
    emaCandidateResources,
    buildOnboardingCandidates,
    defaultSelectedResources,
    buildSelectedEmaEndpoints,
    addEndpointsWithRefresh,
    startOrgConnection,
    isAlreadyInstalled,
    pollForOrgAuth,
    type OnboardingCandidate,
  } from './onboarding-helpers';
  import { endpoints, relayPort } from '$lib/stores';
  import { refreshOrganizations } from '$lib/stores/organizations';
  import { focusTrap } from '$lib/actions/focusTrap';
  import { toast } from 'svelte-sonner';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { onMount } from 'svelte';

  // `redetectOrg` re-runs detection for an already-connected, authenticated org:
  // skip provider pick + SSO and jump straight to the probe → review steps.
  let { onclose, redetectOrg }: { onclose: () => void; redetectOrg?: string } = $props();

  type Step = 'provider' | 'connecting' | 'detecting' | 'review';

  let step: Step = $state('provider');
  let providers: IdpProvider[] = $state([]);
  let providersError = $state('');
  let selectedProvider: IdpProvider | null = $state(null);
  let orgName = $state('');
  let slugOrUrl = $state('');
  let clientId = $state('');
  // Write-only; never echoed back. Cleared on cancel/submit failure.
  let clientSecret = $state('');
  let error = $state('');
  let submitting = $state(false);

  // Connecting / SSO polling
  let connectedOrgName = $state('');
  let pollCancelled = $state(false);

  // Detecting / review
  let candidates: OnboardingCandidate[] = $state([]);
  let selected: Set<string> = $state(new Set());
  let showUnreachable = $state(false);

  let accessibleCandidates = $derived(
    candidates.filter((c) => c.result.status === 'accessible'),
  );
  let deniedCandidates = $derived(candidates.filter((c) => c.result.status === 'denied'));
  let unreachableCandidates = $derived(
    candidates.filter((c) => c.result.status === 'unreachable'),
  );

  // The slug/url field only shows for custom (raw URL) or slug-templated
  // providers; placeholder-free providers (Google) need no field.
  let needsField = $derived(
    !!selectedProvider && (isCustomProvider(selectedProvider) || providerNeedsSlug(selectedProvider)),
  );
  let issuerPreview = $derived(
    selectedProvider && !isCustomProvider(selectedProvider)
      ? buildIssuerPreview(selectedProvider, slugOrUrl)
      : '',
  );

  getIdpProviders()
    .then((p) => {
      providers = p;
    })
    .catch(() => {
      providersError = 'Failed to load providers';
    });

  // Re-detect mode: the org is already connected, so bypass provider/SSO and
  // probe immediately, landing on the review & select step.
  onMount(() => {
    if (redetectOrg) {
      connectedOrgName = redetectOrg;
      void runProbe(redetectOrg);
    }
  });

  function labelFor(result: OrgProbeResult): string {
    const match = candidates.find((c) => c.result.resource === result.resource);
    return match?.entry?.name ?? result.resource;
  }

  function pickProvider(provider: IdpProvider) {
    selectedProvider = provider;
    slugOrUrl = '';
    orgName = '';
    error = '';
  }

  async function handleConnect() {
    error = '';
    if (!selectedProvider) {
      error = 'Pick a provider first.';
      return;
    }
    const name = orgName.trim();
    if (!name) {
      error = 'Enter an organization name.';
      return;
    }
    if (needsField && !slugOrUrl.trim()) {
      error = isCustomProvider(selectedProvider)
        ? 'Enter the issuer URL.'
        : 'Enter your organization slug.';
      return;
    }

    const params = buildCreateOrgParams(
      selectedProvider,
      name,
      slugOrUrl,
      clientId,
      clientSecret,
    );
    submitting = true;
    try {
      const res = await startOrgConnection(params, { createOrganization, openUrl });
      connectedOrgName = res.name;
      // The org is now persisted (still pending sign-in). Surface it in
      // Settings → Organizations immediately as "Sign-in required".
      try {
        await refreshOrganizations();
      } catch {
        // Creation already succeeded; the Settings mount poll reconciles later.
      }
      step = 'connecting';
      void pollForAuth(res.name);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      submitting = false;
    }
  }

  // Wait for the relay to report the org as authenticated (IdP callback
  // landed) via the shared `pollForOrgAuth` helper, then republish the org
  // list and advance to detection. Timeout drops back to the provider step.
  async function pollForAuth(name: string) {
    pollCancelled = false;
    const outcome = await pollForOrgAuth(
      name,
      { listOrganizations },
      { shouldCancel: () => pollCancelled },
    );
    if (outcome.status === 'cancelled') return;
    if (outcome.status === 'timeout') {
      error = 'Sign-in timed out. Please try again.';
      step = 'provider';
      return;
    }
    // Sign-in landed: republish so Settings flips the org to "Connected".
    try {
      await refreshOrganizations();
    } catch {
      // Non-fatal; the Settings mount poll reconciles later.
    }
    await runProbe(name);
  }

  async function runProbe(name: string) {
    step = 'detecting';
    error = '';
    try {
      const res = await probeOrganization(name, emaCandidateResources());
      candidates = buildOnboardingCandidates(res.results);
      selected = defaultSelectedResources(res.results, name, $endpoints);
      step = 'review';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      step = 'review';
    }
  }

  function toggleSelected(resource: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(resource);
    else next.delete(resource);
    selected = next;
  }

  async function handleConfirm() {
    error = '';
    const toCreate = buildSelectedEmaEndpoints(connectedOrgName, candidates, selected, $endpoints);
    if (toCreate.length === 0) {
      onclose();
      return;
    }
    submitting = true;
    try {
      // `addEndpointsWithRefresh` refreshes `$endpoints` even when an add throws
      // partway, so a retry from this modal sees already-created endpoints as
      // 'Already added' instead of attempting duplicates.
      await addEndpointsWithRefresh(toCreate, {
        addEndpoint,
        getEndpoints,
        setEndpoints: (list) => endpoints.set(list),
      });
      toast.success(
        `Added ${toCreate.length} server${toCreate.length === 1 ? '' : 's'} from ${connectedOrgName}`,
      );
      onclose();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      submitting = false;
    }
  }

  function handleCancel() {
    pollCancelled = true;
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
    aria-label="Connect organization"
    tabindex="-1"
    use:focusTrap={{ onEscape: handleCancel }}
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
  >
    {#if step === 'provider'}
      <h3 class="text-base font-semibold mb-1 text-(--fg1)">Connect an organization</h3>
      <p class="text-xs text-(--fg2) mb-4">
        Sign in once and Endara detects the MCP servers your organization grants — no URLs to type.
      </p>

      {#if providersError}
        <p class="text-xs text-(--offline) mb-3">{providersError}</p>
      {/if}

      <div class="grid grid-cols-2 gap-2 mb-4">
        {#each providers as provider (provider.id)}
          <button
            class="text-left p-3 rounded-lg border transition-colors
              {selectedProvider?.id === provider.id
                ? 'border-(--accent) bg-(--accent)/10'
                : 'border-(--border) hover:bg-(--surface-hover)'}"
            onclick={() => pickProvider(provider)}
          >
            <span class="text-sm font-medium text-(--fg1)">{provider.name}</span>
          </button>
        {/each}
      </div>

      {#if selectedProvider}
        <div class="space-y-3">
          <div>
            <label for="org-name" class="block text-xs font-medium mb-1 text-(--fg2)">
              Organization name
            </label>
            <input
              id="org-name"
              type="text"
              bind:value={orgName}
              placeholder="Acme Corp"
              class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)"
            />
          </div>

          {#if needsField}
            <div>
              <label for="org-slug" class="block text-xs font-medium mb-1 text-(--fg2)">
                {isCustomProvider(selectedProvider) ? 'Issuer URL' : 'Organization slug'}
              </label>
              <input
                id="org-slug"
                type="text"
                bind:value={slugOrUrl}
                placeholder={isCustomProvider(selectedProvider)
                  ? 'https://id.example.com'
                  : selectedProvider.slug_hint ?? 'your-org'}
                class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)"
              />
              {#if selectedProvider.slug_hint && !isCustomProvider(selectedProvider)}
                <p class="text-[11px] text-(--fg2) mt-0.5">{selectedProvider.slug_hint}</p>
              {/if}
              {#if issuerPreview && slugOrUrl.trim()}
                <p class="text-[11px] text-(--fg2) mt-0.5">
                  Issuer: <code>{issuerPreview}</code>
                </p>
              {/if}
            </div>
          {/if}

          <div>
            <label for="org-client-id" class="block text-xs font-medium mb-1 text-(--fg2)">
              Client ID <span class="text-(--fg2)/60">(optional)</span>
            </label>
            <input
              id="org-client-id"
              type="text"
              bind:value={clientId}
              placeholder="Pre-registered IdP client ID"
              class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)"
            />
            <p class="text-[11px] text-(--fg2) mt-0.5">
              Required for Okta/Entra. The IdP app must whitelist
              <code>http://127.0.0.1:{$relayPort}/oauth/callback</code>.
            </p>
          </div>

          <div>
            <label for="org-client-secret" class="block text-xs font-medium mb-1 text-(--fg2)">
              Client Secret <span class="text-(--fg2)/60">(optional)</span>
            </label>
            <input
              id="org-client-secret"
              type="password"
              autocomplete="new-password"
              bind:value={clientSecret}
              placeholder="Pre-registered IdP client secret"
              class="w-full text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent)"
            />
            <p class="text-[11px] text-(--fg2) mt-0.5">
              Required for confidential Okta/Entra/custom IdP apps that issue a secret. Stored in
              owner-scoped credential directory, separate from <code>config.toml</code>.
            </p>
          </div>
        </div>
      {/if}

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
          onclick={handleConnect}
          disabled={submitting || !selectedProvider}
        >
          {submitting ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    {:else if step === 'connecting'}
      <h3 class="text-base font-semibold mb-2 text-(--fg1)">Waiting for sign-in…</h3>
      <p class="text-xs text-(--fg2) mb-4">
        A browser window opened for <span class="font-medium">{connectedOrgName}</span>. Complete the
        sign-in there — this will continue automatically.
      </p>
      <div class="flex items-center gap-2 text-xs text-(--fg2)">
        <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
        </svg>
        Listening for the sign-in callback…
      </div>
      {#if error}
        <p class="text-xs text-(--offline) mt-3">{error}</p>
      {/if}
      <div class="flex justify-end pt-4">
        <button
          class="px-3 py-1.5 text-sm rounded-lg border border-(--border) hover:bg-(--surface-hover) transition-colors"
          onclick={handleCancel}
        >
          Cancel
        </button>
      </div>
    {:else if step === 'detecting'}
      <h3 class="text-base font-semibold mb-2 text-(--fg1)">Detecting available MCP servers…</h3>
      <p class="text-xs text-(--fg2) mb-4">
        Checking which servers <span class="font-medium">{connectedOrgName}</span> grants you.
      </p>
      <div class="flex items-center gap-2 text-xs text-(--fg2)">
        <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
        </svg>
        Probing {emaCandidateResources().length} servers…
      </div>
    {:else if step === 'review'}
      <h3 class="text-base font-semibold mb-1 text-(--fg1)">Review &amp; select</h3>
      <p class="text-xs text-(--fg2) mb-4">
        These servers were detected for <span class="font-medium">{connectedOrgName}</span>. Pick the
        ones to add.
      </p>

      {#if error}
        <p class="text-xs text-(--offline) mb-3">{error}</p>
      {/if}

      {#if accessibleCandidates.length === 0 && deniedCandidates.length === 0}
        <p class="text-sm text-(--fg2) py-4">
          No servers were detected for this organization.
        </p>
      {/if}

      {#if accessibleCandidates.length > 0}
        <div class="space-y-1.5 mb-3">
          {#each accessibleCandidates as c (c.result.resource)}
            {#if isAlreadyInstalled(c, connectedOrgName, $endpoints)}
              <div class="flex items-center gap-2.5 p-2.5 rounded-lg border border-(--border) opacity-50">
                <input type="checkbox" checked disabled class="accent-(--accent)" />
                <span class="text-sm font-medium text-(--fg2) flex-1">{labelFor(c.result)}</span>
                <span
                  class="text-[10px] px-1.5 py-0.5 rounded-full bg-(--surface-hover) text-(--fg2) border border-(--border) font-medium"
                  title="Already added to this organization"
                >
                  Already added
                </span>
              </div>
            {:else}
              <label class="flex items-center gap-2.5 p-2.5 rounded-lg border border-(--border) cursor-pointer hover:bg-(--surface-hover)">
                <input
                  type="checkbox"
                  class="accent-(--accent)"
                  checked={selected.has(c.result.resource)}
                  onchange={(e) => toggleSelected(c.result.resource, (e.currentTarget as HTMLInputElement).checked)}
                />
                <span class="text-sm font-medium text-(--fg1) flex-1">{labelFor(c.result)}</span>
                <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 font-medium">
                  Available
                </span>
              </label>
            {/if}
          {/each}
        </div>
      {/if}

      {#if deniedCandidates.length > 0}
        <div class="space-y-1.5 mb-3">
          {#each deniedCandidates as c (c.result.resource)}
            <div class="flex items-center gap-2.5 p-2.5 rounded-lg border border-(--border) opacity-50">
              <input type="checkbox" disabled class="accent-(--accent)" />
              <span class="text-sm font-medium text-(--fg2) flex-1">{labelFor(c.result)}</span>
              <span
                class="text-[10px] px-1.5 py-0.5 rounded-full bg-(--surface-hover) text-(--fg2) border border-(--border) font-medium"
                title="Not granted by your organization"
              >
                Not granted
              </span>
            </div>
          {/each}
        </div>
      {/if}

      {#if unreachableCandidates.length > 0}
        <button
          class="text-[11px] text-(--fg2) hover:text-(--fg1) mb-3"
          onclick={() => (showUnreachable = !showUnreachable)}
        >
          {showUnreachable ? 'Hide' : 'Show'} {unreachableCandidates.length} unreachable
        </button>
        {#if showUnreachable}
          <div class="space-y-1.5 mb-3">
            {#each unreachableCandidates as c (c.result.resource)}
              <div class="flex items-center gap-2.5 p-2.5 rounded-lg border border-dashed border-(--border) opacity-50">
                <span class="text-sm text-(--fg2) flex-1">{labelFor(c.result)}</span>
                <span class="text-[10px] text-(--fg2)">unreachable</span>
              </div>
            {/each}
          </div>
        {/if}
      {/if}

      <div class="flex justify-end gap-2 pt-2">
        <button
          class="px-3 py-1.5 text-sm rounded-lg border border-(--border) hover:bg-(--surface-hover) transition-colors"
          onclick={handleCancel}
        >
          Cancel
        </button>
        <button
          class="px-3 py-1.5 text-sm rounded-lg bg-(--accent) text-white hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-not-allowed"
          onclick={handleConfirm}
          disabled={submitting}
        >
          {submitting ? 'Adding…' : `Add ${selected.size} server${selected.size === 1 ? '' : 's'}`}
        </button>
      </div>
    {/if}
  </div>
</div>
