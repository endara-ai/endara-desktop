<!--
  One stacked group card. Mirrors the prototype `GroupCard`
  (toast-feed.jsx lines 314–414):
    - row 1: server icon, tool name, state indicator (spinner / counts / duration)
    - row 2: server-type · server-name · profile (· "N calls · Mms avg" when stacked & resolved)
    - row 3: hint pills derived from `group.annotations`
    - dismiss progress bar pinned to `dismissStartedAt`
    - ghost "stacked" peek cards behind when more than one request

  Click invokes `focusLogForRequest(latest.jsonrpcId)`; if the latest request
  has no jsonrpc_id the card is rendered non-clickable (cursor: default) and
  the click is a soft no-op.
-->
<script lang="ts">
  import type { ToolCallGroup } from './toastStore';
  import {
    averageDurationMs,
    canFocusLog,
    groupVisualState,
    hintsForAnnotations,
    isDestructive,
    isStacked,
  } from './overlay-helpers';
  import { serverIconFor } from './icons';
  import { cardClick } from './overlay-actions';
  import HintPill from './HintPill.svelte';
  import StateIcon from './StateIcon.svelte';

  type Props = {
    group: ToolCallGroup;
    dismissMs: number;
    showProfile?: boolean;
  };
  let { group, dismissMs, showProfile = true }: Props = $props();

  const state = $derived(groupVisualState(group));
  const stacked = $derived(isStacked(group));
  const destructive = $derived(isDestructive(group));
  const hints = $derived(hintsForAnnotations(group.annotations));
  const avgMs = $derived(averageDurationMs(group));
  const showDuration = $derived(state !== 'inflight' && avgMs != null);
  const clickable = $derived(canFocusLog(group));
  const stateColor = $derived(
    state === 'inflight'
      ? 'var(--accent)'
      : state === 'success'
        ? 'var(--healthy)'
        : 'var(--offline)',
  );
  const iconSvg = $derived(serverIconFor(group.serverType));

  async function onClick() {
    await cardClick(group);
  }
</script>

<div class="tf-card-wrap" data-state={state} data-testid="overlay-card">
  {#if stacked}
    <div class="tf-card tf-card-ghost tf-card-ghost-2" aria-hidden="true"></div>
    {#if group.requests.length > 2}
      <div class="tf-card tf-card-ghost tf-card-ghost-3" aria-hidden="true"></div>
    {/if}
  {/if}

  <button
    type="button"
    class="tf-card tf-card-front"
    data-state={state}
    data-destructive={destructive ? 'true' : 'false'}
    data-clickable={clickable ? 'true' : 'false'}
    data-stacked={stacked ? 'true' : 'false'}
    onclick={onClick}
  >
    {#if destructive}
      <div class="tf-accent-bar"></div>
    {/if}

    <div class="tf-card-body">
      <div class="tf-row-1">
        <div class="tf-icon">
          <svg width="16" height="16" viewBox="0 0 20 20" style="display:block;flex-shrink:0;">
            {@html iconSvg}
          </svg>
        </div>
        <span class="tf-tool">{group.tool}</span>
        <div class="tf-row-1-end">
          {#if stacked}
            <div class="tf-counts">
              {#if group.inflight > 0}
                <span class="tf-chip" data-kind="inflight" style:color="var(--accent)">
                  <StateIcon state="inflight" color="var(--accent)" size={9} />
                  {group.inflight}
                </span>
              {/if}
              {#if group.success > 0}
                <span class="tf-chip" data-kind="success" style:color="var(--healthy)">
                  <StateIcon state="success" color="var(--healthy)" size={9} />
                  {group.success}
                </span>
              {/if}
              {#if group.error > 0}
                <span class="tf-chip" data-kind="fail" style:color="var(--offline)">
                  <StateIcon state="fail" color="var(--offline)" size={9} />
                  {group.error}
                </span>
              {/if}
            </div>
          {:else if showDuration}
            <span class="tf-dur">{avgMs}ms</span>
            <StateIcon {state} color={stateColor} size={12} />
          {:else}
            <StateIcon {state} color={stateColor} size={13} />
          {/if}
        </div>
      </div>

      <div class="tf-row-2">
        <span class="tf-server-type">{group.serverType ?? 'unknown'}</span>
        <span class="tf-sep">·</span>
        <span class="tf-server-name">{group.serverName ?? '—'}</span>
        {#if showProfile && group.profile}
          <span class="tf-sep">·</span>
          <span class="tf-profile">{group.profile}</span>
        {/if}
        {#if stacked && showDuration}
          <span class="tf-sep">·</span>
          <span class="tf-sub">{group.requests.length} calls · {avgMs}ms avg</span>
        {/if}
      </div>

      {#if hints.length > 0}
        <div class="tf-hints">
          {#each hints as h (h.kind)}
            <HintPill hint={h} />
          {/each}
        </div>
      {/if}
    </div>

    {#if group.dismissStartedAt != null}
      {#key group.dismissStartedAt}
        <div class="tf-dismiss-bar" data-testid="dismiss-bar">
          <div class="tf-dismiss-fill" style:animation-duration="{dismissMs}ms" style:background={stateColor}></div>
        </div>
      {/key}
    {/if}
  </button>
</div>
