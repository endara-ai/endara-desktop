<!--
  One stacked group card. Mirrors the prototype `GroupCard`
  (toast-feed.jsx lines 314–414):
    - row 1: server icon, tool name, state indicator (spinner / counts / duration)
    - row 2: server-type · server-name · profile (· "N calls · Mms avg" when stacked & resolved)
    - row 3: hint pills derived from `group.annotations`

  Per-card dismiss timer: each card owns its own countdown driven by
  `group.dismissTick` and `group.inflight`/`group.success`/`group.error`.
  The bar appears only after the group has settled (`inflight === 0` and
  at least one resolved request). Its colour is green when no errors
  were observed and red as soon as any error landed. The bar's CSS
  keyframe runs to completion in `dismissDurationMs` and the
  `toastStore`'s matching per-group `setTimeout` removes the card at the
  same offset — no hover-pause, no pause/resume binding on the keyframe.

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
  import { fade } from 'svelte/transition';

  type Props = {
    group: ToolCallGroup;
    showProfile?: boolean;
    // Duration of the per-card dismiss bar's CSS keyframe. The
    // matching `setTimeout` in `toastStore` fires at the same offset
    // so the bar reaches 100% just as the card is removed. Defaults
    // to 6000ms; `ToastFeed` pipes `store.getOpts().dismissMs`.
    dismissDurationMs?: number;
  };
  let { group, showProfile = true, dismissDurationMs = 6000 }: Props = $props();

  const state = $derived(groupVisualState(group));
  const stacked = $derived(isStacked(group));
  const destructive = $derived(isDestructive(group));
  const hints = $derived(hintsForAnnotations(group.annotations));
  const avgMs = $derived(averageDurationMs(group));
  const showDuration = $derived(state !== 'inflight' && avgMs != null);
  const hasSettled = $derived(group.success > 0 || group.error > 0);
  const clickable = $derived(canFocusLog(group));
  // Per-card dismiss bar visibility: rendered only after the group
  // has settled (no in-flight requests AND at least one resolved
  // request). A new started event for the same group flips
  // `group.inflight` back above 0 and hides the bar again.
  const showBar = $derived(
    group.inflight === 0 && (group.success > 0 || group.error > 0),
  );
  // Red as soon as any error landed, otherwise green. Mirrors the
  // visual state colour rule but ignores in-flight (we never render
  // the bar while in-flight).
  const barColor = $derived(
    group.error > 0 ? 'var(--offline)' : 'var(--healthy)',
  );
  // Key the bar element on this so each (re)arm re-mounts the
  // `tfDismissFill` keyframe from 0%.
  const barTick = $derived(group.dismissTick);
  // Collapse row 2's duplicate label when serverType and serverName are the
  // same (e.g. `gmail · gmail · <profile>` → `gmail · <profile>`). Falls back
  // to the unchanged two-label layout whenever either side is null or differs.
  const sameServer = $derived(
    group.serverType != null &&
      group.serverName != null &&
      group.serverType === group.serverName,
  );
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

<div
  class="tf-card-wrap"
  data-state={state}
  data-testid="overlay-card"
>
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
          <!--
            Decorative server-type glyph; the adjacent `tf-tool` and `tf-server-type`
            text content already labels the card for assistive tech.
          -->
          <svg width="16" height="16" viewBox="0 0 20 20" style="display:block;flex-shrink:0;" aria-hidden="true">
            {@html iconSvg}
          </svg>
        </div>
        <span class="tf-tool">{group.tool}</span>
        <div class="tf-row-1-end">
          {#if stacked}
            <div class="tf-counts">
              {#if group.inflight > 0}
                <span class="tf-chip" data-kind="inflight" style:color="var(--accent)" out:fade={{ duration: 150 }}>
                  <StateIcon state="inflight" color="var(--accent)" size={9} />
                  {group.inflight}
                </span>
              {/if}
              {#if group.success > 0}
                <span class="tf-chip" data-kind="success" style:color="var(--healthy)" out:fade={{ duration: 150 }}>
                  <StateIcon state="success" color="var(--healthy)" size={9} />
                  {group.success}
                </span>
              {/if}
              {#if group.error > 0}
                <span class="tf-chip" data-kind="fail" style:color="var(--offline)" out:fade={{ duration: 150 }}>
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
        {#if !sameServer}
          <span class="tf-sep">·</span>
          <span class="tf-server-name">{group.serverName ?? '—'}</span>
        {/if}
        {#if showProfile && group.profile}
          <span class="tf-sep">·</span>
          <span class="tf-profile">{group.profile}</span>
        {/if}
        {#if stacked && hasSettled && avgMs != null}
          <span class="tf-sep">·</span>
          <span class="tf-sub" out:fade={{ duration: 150 }}
            >{group.requests.length} calls · {avgMs}ms avg</span
          >
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

    {#if showBar}
      {#key barTick}
        <div class="tf-dismiss-bar" data-testid="dismiss-bar">
          <div
            class="tf-dismiss-fill"
            data-testid="dismiss-fill"
            style:background={barColor}
            style:animation-duration="{dismissDurationMs}ms"
          ></div>
        </div>
      {/key}
    {/if}
  </button>
</div>
