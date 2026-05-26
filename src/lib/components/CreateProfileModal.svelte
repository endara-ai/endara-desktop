<script lang="ts">
  import { createProfile, type ProfileSummary } from '$lib/api';
  import { focusTrap } from '$lib/actions/focusTrap';
  import { jsExecutionMode, toonOutput as toonOutputStore } from '$lib/stores';
  import { get } from 'svelte/store';
  import { toast } from 'svelte-sonner';
  import {
    buildCreateProfilePayload,
    isCreateProfileFormValid,
    validateProfileName,
    validateProfilePath,
  } from './create-profile-helpers';

  let { onclose, oncreated }: {
    onclose: () => void;
    oncreated?: (profile: ProfileSummary) => void;
  } = $props();

  let name = $state('');
  let path = $state('');
  // Copy-on-write from the current global relay defaults, snapshotted once at
  // modal open. If the user changes the global setting elsewhere while the
  // modal is open, the toggles here don't shift under them.
  let jsExecution = $state(get(jsExecutionMode));
  let toonOutput = $state(get(toonOutputStore));

  let nameTouched = $state(false);
  let pathTouched = $state(false);
  let submitting = $state(false);
  let submitError = $state('');

  let nameError = $derived(nameTouched ? validateProfileName(name) : null);
  let pathError = $derived(pathTouched ? validateProfilePath(path) : null);
  let formValid = $derived(isCreateProfileFormValid(name, path));

  async function handleCreate() {
    nameTouched = true;
    pathTouched = true;
    submitError = '';
    if (!isCreateProfileFormValid(name, path)) return;

    submitting = true;
    try {
      const created = await createProfile(
        buildCreateProfilePayload({ name, path, jsExecution, toonOutput }),
      );
      toast.success(`Profile "${created.name}" created`);
      oncreated?.(created);
      onclose();
    } catch (e) {
      submitError = e instanceof Error ? e.message : String(e);
      toast.error(`Failed to create "${name.trim()}"`);
    } finally {
      submitting = false;
    }
  }

  function handleCancel() {
    if (submitting) return;
    onclose();
  }
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="presentation" onclick={handleCancel}>
  <div
    class="bg-(--surface) rounded-xl shadow-xl border border-(--border) p-6 w-[28rem] max-w-[90vw] max-h-[90vh] overflow-y-auto"
    role="dialog"
    aria-modal="true"
    aria-label="Create Profile"
    tabindex="-1"
    use:focusTrap={{ onEscape: handleCancel }}
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
  >
    <h3 class="text-base font-semibold mb-4 text-(--fg1)">Create Profile</h3>

    <div class="space-y-3">
      <div>
        <label for="create-profile-name" class="block text-xs font-medium mb-1 text-(--fg2)">Name</label>
        <input
          id="create-profile-name"
          type="text"
          bind:value={name}
          onblur={() => { nameTouched = true; }}
          placeholder="Work"
          aria-invalid={!!nameError}
          class="w-full text-sm px-3 py-1.5 rounded-lg border bg-(--surface) text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none focus:border-(--accent) {nameError ? 'border-(--offline)' : 'border-(--border)'}"
        />
        {#if nameError}
          <p class="text-[11px] text-(--offline) mt-0.5">{nameError}</p>
        {/if}
      </div>

      <div>
        <label for="create-profile-path" class="block text-xs font-medium mb-1 text-(--fg2)">Path</label>
        <div class="flex items-stretch rounded-lg border {pathError ? 'border-(--offline)' : 'border-(--border)'} bg-(--surface) overflow-hidden focus-within:border-(--accent)">
          <span class="flex items-center px-2 text-xs text-(--fg2) bg-(--surface-hover) border-r border-(--border) select-none">/mcp/</span>
          <input
            id="create-profile-path"
            type="text"
            bind:value={path}
            oninput={() => { pathTouched = true; }}
            onblur={() => { pathTouched = true; }}
            placeholder="work"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            autocomplete="off"
            aria-invalid={!!pathError}
            class="flex-1 text-sm px-3 py-1.5 bg-transparent text-(--fg1) placeholder:text-(--fg2)/50 focus:outline-none"
          />
        </div>
        {#if pathError}
          <p class="text-[11px] text-(--offline) mt-0.5">{pathError}</p>
        {:else}
          <p class="text-[11px] text-(--fg2) mt-0.5">Letters, numbers, _ or - only. Served at <code>/mcp/{path || 'work'}</code>.</p>
        {/if}
      </div>

      <div class="flex items-start justify-between gap-4 pt-1">
        <div>
          <div class="text-sm font-medium">JS Execution Mode</div>
          <div class="text-xs text-(--fg2) mt-0.5">When on, this profile exposes only the three meta-tools (list_tools, search_tools, execute_tools).</div>
        </div>
        <button
          type="button"
          class="shrink-0 relative w-10 h-5 rounded-full transition-colors {jsExecution ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}"
          onclick={() => { jsExecution = !jsExecution; }}
          role="switch"
          aria-checked={jsExecution}
          aria-label="Toggle JS execution mode for this profile"
        >
          <span class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform {jsExecution ? 'translate-x-5' : ''}"></span>
        </button>
      </div>

      <div class="flex items-start justify-between gap-4">
        <div>
          <div class="text-sm font-medium">TOON Output</div>
          <div class="text-xs text-(--fg2) mt-0.5">When on, tool responses for this profile are TOON-encoded.</div>
        </div>
        <button
          type="button"
          class="shrink-0 relative w-10 h-5 rounded-full transition-colors {toonOutput ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}"
          onclick={() => { toonOutput = !toonOutput; }}
          role="switch"
          aria-checked={toonOutput}
          aria-label="Toggle TOON output for this profile"
        >
          <span class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform {toonOutput ? 'translate-x-5' : ''}"></span>
        </button>
      </div>

      {#if submitError}
        <p class="text-xs text-(--offline)">{submitError}</p>
      {/if}

      <div class="flex justify-end gap-2 pt-2">
        <button
          type="button"
          class="px-3 py-1.5 text-sm rounded-lg border border-(--border) hover:bg-(--surface-hover) transition-colors disabled:opacity-50"
          onclick={handleCancel}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          type="button"
          class="px-3 py-1.5 text-sm rounded-lg bg-(--accent) text-white hover:bg-(--accent-hover) transition-colors disabled:opacity-50"
          onclick={handleCreate}
          disabled={!formValid || submitting}
        >
          {submitting ? 'Creating…' : 'Create'}
        </button>
      </div>
    </div>
  </div>
</div>
