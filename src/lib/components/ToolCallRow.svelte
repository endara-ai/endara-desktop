<script lang="ts">
  import type { ParsedLogLine } from '$lib/logParser';
  import {
    callerSuffix,
    durationColorClass,
    statusIcon,
    statusIconClass,
    toolCallErrorSuffix,
    formatDurationMs,
  } from './tool-call-row-helpers';

  type Props = {
    line: ParsedLogLine;
  };
  let { line }: Props = $props();

  const durationClass = $derived(durationColorClass(line.durationMs));
  const durationLabel = $derived(formatDurationMs(line.durationMs));
  const icon = $derived(statusIcon(line.status));
  const iconClass = $derived(statusIconClass(line.status));
  const errSuffix = $derived(toolCallErrorSuffix(line));
  const caller = $derived(callerSuffix(line.clientName, line.clientVersion));
</script>

<span class="inline-flex items-baseline gap-2 min-w-0 w-full" data-testid="tool-call-row">
  <span class="select-none" aria-hidden="true">⚡</span>
  <span class="font-mono font-semibold text-(--fg1) truncate" data-testid="tool-name">
    {line.tool ?? ''}
  </span>
  {#if caller}
    <span class="text-(--fg2) truncate" data-testid="tool-caller">({caller})</span>
  {/if}
  {#if durationLabel}
    <span
      class="ml-auto tabular-nums {durationClass}"
      data-testid="tool-duration"
      data-duration-bucket={(line.durationMs ?? 0) < 200
        ? 'normal'
        : (line.durationMs ?? 0) <= 1000
          ? 'degraded'
          : 'offline'}
    >{durationLabel}</span>
  {/if}
  <span class={iconClass} data-testid="tool-status" aria-label={line.status === 'ok' ? 'ok' : 'error'}>
    {icon}
  </span>
  {#if errSuffix}
    <span
      class="text-(--fg3) truncate"
      data-testid="tool-error-suffix"
      title={line.raw}
    >{errSuffix}</span>
  {/if}
</span>
