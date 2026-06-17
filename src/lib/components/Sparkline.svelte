<script lang="ts">
  import { combinedDomain, sparklinePoints, nearestIndex, formatTime } from './observability-helpers';

  // Reusable hand-rolled SVG sparkline with a pointer hover readout (F5).
  // Extracted from the inline `spark` snippet in Observability.svelte because
  // Svelte 5 snippets can't own the per-chart hover state. Static visuals are
  // preserved exactly; hover adds a vertical guide, per-series marker dots, and
  // a tooltip with the bucket time + each series value.

  type Series = { values: number[]; stroke: string; label: string };

  type Props = {
    series: Series[];
    /** Bucket start (epoch ms) per index, aligned with each series' values. */
    times: number[];
    title: string;
    summary?: string;
    /** Formats a series value for the tooltip (counts → String, latency → formatDuration). */
    valueFormat?: (n: number) => string;
  };

  let { series, times, title, summary, valueFormat = String }: Props = $props();

  const SPARK_W = 168;
  const SPARK_H = 38;
  const PADDING = 3;

  const domain = $derived(combinedDomain(series.map((s) => s.values)));
  const isEmpty = $derived(series.every((s) => s.values.length === 0));
  const pointCount = $derived(Math.max(times.length, ...series.map((s) => s.values.length), 0));

  let hoverIdx = $state<number | null>(null);

  // Clamp away stale hover state if the underlying data shrank between renders.
  const activeIdx = $derived(
    hoverIdx !== null && hoverIdx < pointCount ? hoverIdx : null,
  );

  // x/y mapping mirrors `sparklinePoints` (same padding) so markers and the
  // guide line line up exactly with the rendered polylines.
  function pointX(idx: number): number {
    if (pointCount <= 1) return SPARK_W / 2;
    const innerW = SPARK_W - PADDING * 2;
    return PADDING + idx * (innerW / (pointCount - 1));
  }

  function pointY(value: number): number {
    if (pointCount <= 1) return SPARK_H / 2;
    const range = domain.max - domain.min || 1;
    const innerH = SPARK_H - PADDING * 2;
    return PADDING + innerH - ((value - domain.min) / range) * innerH;
  }

  const markerX = $derived(activeIdx === null ? 0 : pointX(activeIdx));

  // Horizontal position of the floating tooltip as a fraction of the plot width
  // (the svg stretches to `w-full`, so SVG x maps linearly to container x).
  const markerFrac = $derived(markerX / SPARK_W);

  function handlePointerMove(event: PointerEvent) {
    const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
    if (rect.width === 0) return;
    hoverIdx = nearestIndex((event.clientX - rect.left) / rect.width, pointCount);
  }

  function handlePointerLeave() {
    hoverIdx = null;
  }
</script>

<div class="rounded-lg border border-(--border) bg-(--surface) p-3">
  <p class="mb-1 text-[11px] font-medium text-(--fg2)">{title}</p>
  {#if isEmpty}
    <p class="text-[11px] text-(--fg3)">No data in window</p>
  {:else}
    <div class="relative">
      <svg
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        width={SPARK_W}
        height={SPARK_H}
        class="block w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={title}
        onpointermove={handlePointerMove}
        onpointerleave={handlePointerLeave}
      >
        {#each series as s}
          <polyline
            points={sparklinePoints(s.values, {
              width: SPARK_W,
              height: SPARK_H,
              padding: PADDING,
              min: domain.min,
              max: domain.max,
            })}
            fill="none"
            stroke={s.stroke}
            stroke-width="1"
            stroke-linejoin="round"
            stroke-linecap="round"
          />
        {/each}
        {#if activeIdx !== null}
          <line
            x1={markerX}
            x2={markerX}
            y1={PADDING}
            y2={SPARK_H - PADDING}
            stroke="var(--border-strong)"
            stroke-width="1"
            pointer-events="none"
          />
          {#each series as s}
            {#if activeIdx < s.values.length}
              <circle
                cx={markerX}
                cy={pointY(s.values[activeIdx])}
                r="2"
                fill={s.stroke}
                pointer-events="none"
              />
            {/if}
          {/each}
        {/if}
      </svg>
      <!-- Floating hover readout. Only rendered while hovering so it occupies no
           layout space — the card collapses to plot + legend on pointer leave.
           `pointer-events: none` keeps it from stealing the hover; alignment
           flips at the midpoint so it never clips past the card edges. -->
      {#if activeIdx !== null}
        <div
          class="pointer-events-none absolute top-0 z-10 rounded-md border border-(--border) bg-(--surface) px-2 py-1 text-[11px] shadow-md"
          style={`left: ${markerFrac * 100}%; transform: translateX(${markerFrac > 0.5 ? 'calc(-100% - 6px)' : '6px'});`}
          aria-hidden="true"
        >
          <p class="mb-0.5 font-medium text-(--fg1) whitespace-nowrap">
            {formatTime(times[activeIdx])}
          </p>
          {#each series as s}
            <div class="flex items-center gap-1.5 whitespace-nowrap text-(--fg2)">
              <span class="inline-block h-2 w-2 shrink-0 rounded-full" style={`background-color: ${s.stroke}`}></span>
              <span>{s.label}</span>
              <span class="ml-auto pl-2 text-(--fg1) tabular-nums">
                {activeIdx >= s.values.length ? '\u00a0' : valueFormat(s.values[activeIdx])}
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
  <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-(--fg3)">
    {#each series as s}
      <span class="inline-flex items-center gap-1">
        <span
          class="inline-block h-2 w-2 shrink-0 rounded-full"
          style={`background-color: ${s.stroke}`}
        ></span>
        {s.label}
      </span>
    {/each}
    {#if summary}<span>·</span><span>{summary}</span>{/if}
  </div>
</div>
