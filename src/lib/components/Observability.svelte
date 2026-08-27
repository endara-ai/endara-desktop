<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { toast } from 'svelte-sonner';
  import { activeTopLevelTab } from '$lib/stores';
  import {
    getObservabilityCalls,
    getObservabilityCall,
    getObservabilityAggregates,
    purgeObservability,
    getObservabilityConfig,
  } from '$lib/api';
  import ConfirmModal from './ConfirmModal.svelte';
  import type {
    ObservabilitySummary,
    AggregateBucketDto,
    CallSummaryDto,
    CallDetail,
  } from '$lib/types';
  import type { ToolCallEvent } from '$lib/overlay/types';
  import {
    buildCallsFilter,
    formatTime,
    formatDuration,
    formatBytes,
    callStatus,
    globalBuckets,
    bucketSeries,
    debounce,
    isTerminalEvent,
    mergeCalls,
    distinctValues,
    prettyJson,
    parseJsonTree,
    type CallsFilterUi,
    type StatusFilter,
  } from './observability-helpers';
  import Sparkline from './Sparkline.svelte';
  import VirtualLogList from './VirtualLogList.svelte';
  import { JsonView, defaultStyles } from '@humanspeak/svelte-json-view-lite';
  import { focusTrap } from '$lib/actions/focusTrap';

  // D2: the full Observability tab — browsable call list, hand-rolled SVG
  // sparklines, payload drill-through, and live refresh wired to the relay's
  // `tool-call-event` window stream. D1 supplied the API layer + types; this
  // component consumes them and owns all view state.

  type LoadState = 'loading' | 'ready' | 'unavailable';

  const PAGE_SIZE = 100;

  let loadState = $state<LoadState>('loading');
  let errorMessage = $state<string | null>(null);
  let summary = $state<ObservabilitySummary | null>(null);
  let buckets = $state<AggregateBucketDto[]>([]);
  let calls = $state<CallSummaryDto[]>([]);
  // Opaque keyset cursor for the next page of `/observability/calls`, returned
  // by the relay as `nextCursor`. `undefined` once the list is on its last
  // page or has been reset; "Load more" is enabled iff this is non-null.
  let nextCursor = $state<string | undefined>(undefined);
  let loadingMore = $state(false);

  // Filter UI state. `serverName`/`tool` empty = no constraint.
  let serverName = $state('');
  let tool = $state('');
  let status = $state<StatusFilter>('all');
  let windowMinutes = $state(60);
  // Removable UUID search pill. Empty = no constraint; set via the
  // `overlay:focus-call` handler (or cleared by the pill's ✕).
  let uidFilter = $state('');

  // Drill-through.
  let selectedUid = $state<string | null>(null);
  let detail = $state<CallDetail | null>(null);
  let detailLoading = $state(false);
  let detailError = $state<string | null>(null);

  // Pop-out: which payload (if any) is expanded into the full-screen modal.
  let expandedPayload = $state<'request' | 'response' | null>(null);

  // Global purge: confirm dialog visibility + in-flight guard.
  let showPurgeConfirm = $state(false);
  let purging = $state(false);

  // Configured payload-retention window (minutes), loaded best-effort so the
  // "payloads expired" notice reflects the real config instead of a hard-coded
  // number. Stays null until loaded (or if the config fetch fails).
  let payloadWindowMinutes = $state<number | null>(null);

  function currentFilterUi(cursor?: string): CallsFilterUi {
    return {
      serverName,
      tool,
      status,
      windowMinutes,
      requestUid: uidFilter,
      limit: PAGE_SIZE,
      cursor,
    };
  }

  const globalSeries = $derived(globalBuckets(buckets));
  const serverOptions = $derived(distinctValues(calls, 'serverName'));

  // Shared column template for the virtualized call list. Header + rows are
  // separate CSS grids (absolutely-positioned virtual rows can't live in a
  // <tbody>), so they align by using the exact same template. Widths mirror
  // the old table: Time w-20, Server w-28, Tool flexible, Status w-24,
  // Duration w-20, Bytes w-28.
  const callListGrid = 'grid grid-cols-[5rem_7rem_minmax(0,1fr)_6rem_5rem_7rem]';

  async function loadAggregates() {
    const since = windowMinutes > 0 ? Date.now() - windowMinutes * 60_000 : undefined;
    const res = await getObservabilityAggregates({ bucket_seconds: 60, since });
    summary = res.summary;
    buckets = res.buckets;
  }

  async function loadCalls() {
    const res = await getObservabilityCalls(buildCallsFilter(currentFilterUi()));
    calls = mergeCalls([], res.calls);
    nextCursor = res.nextCursor;
  }

  async function loadAll() {
    loadState = 'loading';
    errorMessage = null;
    try {
      await Promise.all([loadAggregates(), loadCalls()]);
      loadState = 'ready';
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      loadState = 'unavailable';
    }
  }

  async function loadMore() {
    if (loadingMore || !nextCursor) return;
    loadingMore = true;
    try {
      const res = await getObservabilityCalls(buildCallsFilter(currentFilterUi(nextCursor)));
      calls = mergeCalls(calls, res.calls);
      nextCursor = res.nextCursor;
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    } finally {
      loadingMore = false;
    }
  }

  // Non-destructive refresh for filter changes: re-run aggregates + the first
  // page and swap the data IN PLACE while `loadState` stays `'ready'`, so the
  // filter inputs are never unmounted and keep focus while typing. On error we
  // surface `errorMessage` inline and keep the previous rows — we do NOT tear
  // the panel down into the loading/unavailable full-screen state.
  async function refreshList() {
    errorMessage = null;
    try {
      const [aggRes, callsRes] = await Promise.all([
        getObservabilityAggregates({
          bucket_seconds: 60,
          since: windowMinutes > 0 ? Date.now() - windowMinutes * 60_000 : undefined,
        }),
        getObservabilityCalls(buildCallsFilter(currentFilterUi())),
      ]);
      summary = aggRes.summary;
      buckets = aggRes.buckets;
      calls = mergeCalls([], callsRes.calls);
      nextCursor = callsRes.nextCursor;
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }
  }

  // Search-as-you-type: text inputs (server/tool) reset paging and reload the
  // list + metrics together, debounced so typing doesn't trigger a reload per
  // keystroke. Status/Window selects refresh immediately. All of these use the
  // non-destructive `refreshList` so focus stays in the field while typing.
  const debouncedReload = debounce(() => refreshList(), 120);

  async function openDetail(uid: string) {
    selectedUid = uid;
    detail = null;
    detailError = null;
    detailLoading = true;
    try {
      const res = await getObservabilityCall(uid);
      // Guard against a stale response: if another row was clicked while this
      // fetch was in flight, `selectedUid` has moved on — drop this result so
      // it never lands in the wrong selection.
      if (selectedUid !== uid) return;
      if (res === null) {
        detailError = 'Call not found (it may have been purged or evicted).';
      } else {
        detail = res;
      }
    } catch (err) {
      if (selectedUid !== uid) return;
      detailError = err instanceof Error ? err.message : String(err);
    } finally {
      if (selectedUid === uid) detailLoading = false;
    }
  }

  function closeDetail() {
    selectedUid = null;
    detail = null;
    detailError = null;
    expandedPayload = null;
  }

  // Clear the UUID search pill: drop the constraint, close the drill-through
  // panel, and reload the (now unfiltered) list.
  async function clearUidFilter() {
    uidFilter = '';
    closeDetail();
    await refreshList();
  }

  // Handle an `overlay:focus-call` request (emitted when an overlay card is
  // clicked): switch to this tab, reset every other filter so the row is
  // guaranteed to show, apply the UUID pill, reload, then select + scroll the
  // matching row into view.
  async function focusCall(requestUid: string) {
    if (!requestUid) return;
    activeTopLevelTab.set('observability');
    serverName = '';
    tool = '';
    status = 'all';
    windowMinutes = 0;
    uidFilter = requestUid;
    await refreshList();
    await openDetail(requestUid);
    await tick();
    document
      .querySelector(`[data-request-uid="${CSS.escape(requestUid)}"]`)
      ?.scrollIntoView({ block: 'center' });
  }

  function expandPayload(which: 'request' | 'response') {
    expandedPayload = which;
  }

  // Global purge: clears all stored call history + buffered payloads on the
  // relay, then resets local view state and reloads so the empty state shows.
  async function confirmPurge() {
    if (purging) return;
    purging = true;
    try {
      await purgeObservability();
    } catch (err) {
      // The purge itself failed — surface that accurately and stop here.
      toast.error(err instanceof Error ? err.message : String(err));
      purging = false;
      return;
    }
    // Purge succeeded: report it now, independent of the reload outcome.
    closeDetail();
    calls = [];
    nextCursor = undefined;
    showPurgeConfirm = false;
    toast.success('Tool call records purged');
    try {
      await loadAll();
    } catch (err) {
      // A reload failure after a successful purge is a separate, lesser issue.
      toast.error(`Records purged, but reload failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      purging = false;
    }
  }

  function closeExpanded() {
    expandedPayload = null;
  }

  // ----- Live refresh -------------------------------------------------------
  // The relay's tool-call SSE is forwarded to the WebView as the Tauri window
  // event `tool-call-event` (see overlay/eventBridge.ts). On a terminal event
  // (completed/failed) a new metadata row exists, so we refetch the first page
  // and merge it in (deduped by requestUid). Debounced to coalesce bursts.
  let unlisten: UnlistenFn | null = null;
  let unlistenFocusCall: UnlistenFn | null = null;
  let liveTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleLiveRefresh() {
    if (liveTimer) return;
    liveTimer = setTimeout(async () => {
      liveTimer = null;
      if (loadState !== 'ready') return;
      try {
        const [aggRes, callsRes] = await Promise.all([
          getObservabilityAggregates({
            bucket_seconds: 60,
            since: windowMinutes > 0 ? Date.now() - windowMinutes * 60_000 : undefined,
          }),
          getObservabilityCalls(buildCallsFilter(currentFilterUi())),
        ]);
        summary = aggRes.summary;
        buckets = aggRes.buckets;
        // Live merge: incoming first-page rows win for any UID we already
        // have, but the cursor for "Load more" is anchored to the original
        // first-page tail — fresh terminal events don't reset it.
        calls = mergeCalls(calls, callsRes.calls);
      } catch {
        // Transient relay hiccup — keep the current view, next event retries.
      }
    }, 600);
  }

  onMount(() => {
    loadAll();
    // Best-effort: drives the configured-window text on the expiry notice.
    getObservabilityConfig()
      .then((cfg) => {
        payloadWindowMinutes = cfg.payload_window_minutes;
      })
      .catch(() => {});
    listen<ToolCallEvent>('tool-call-event', (event) => {
      if (isTerminalEvent(event.payload)) scheduleLiveRefresh();
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((e) => console.error('[observability] listen failed:', e));
    listen<{ requestUid: string }>('overlay:focus-call', (event) => {
      focusCall(event.payload?.requestUid).catch((e) =>
        console.error('[observability] focus-call failed:', e),
      );
    })
      .then((fn) => {
        unlistenFocusCall = fn;
      })
      .catch((e) => console.error('[observability] focus-call listen failed:', e));
    invoke('subscribe_tool_call_events').catch((e) =>
      console.error('[observability] subscribe failed:', e),
    );
  });

  onDestroy(() => {
    debouncedReload.cancel();
    if (liveTimer) clearTimeout(liveTimer);
    if (unlisten) {
      try {
        unlisten();
      } catch (e) {
        console.warn('[observability] unlisten threw:', e);
      }
      unlisten = null;
    }
    if (unlistenFocusCall) {
      try {
        unlistenFocusCall();
      } catch (e) {
        console.warn('[observability] focus-call unlisten threw:', e);
      }
      unlistenFocusCall = null;
    }
    invoke('unsubscribe_tool_call_events').catch(() => {});
  });

  const reqPretty = $derived(detail?.payloads ? prettyJson(detail.payloads.request) : null);
  const respPretty = $derived(detail?.payloads ? prettyJson(detail.payloads.response) : null);
  // Prefer the collapsible JSON tree when the payload parses as a JSON
  // object/array within the size guard; otherwise fall back to the raw <pre>.
  const reqTree = $derived(detail?.payloads ? parseJsonTree(detail.payloads.request) : { ok: false } as const);
  const respTree = $derived(detail?.payloads ? parseJsonTree(detail.payloads.response) : { ok: false } as const);

  // Parameterize the single pop-out modal by which side is open. Falls back to
  // the response values when nothing is expanded (the modal block is guarded so
  // these are never read in that case).
  const expandedLabel = $derived(expandedPayload === 'request' ? 'Request' : 'Response');
  const expandedTree = $derived(expandedPayload === 'request' ? reqTree : respTree);
  const expandedPretty = $derived(expandedPayload === 'request' ? reqPretty : respPretty);
  const expandedTruncated = $derived(
    expandedPayload === 'request'
      ? detail?.payloads?.request_truncated
      : detail?.payloads?.response_truncated,
  );
  // Raw source for whichever payload the modal currently shows, used by the
  // modal's copy button so the clipboard receives the complete JSON.
  const expandedRaw = $derived(
    expandedPayload === 'request'
      ? (detail?.payloads?.request ?? '')
      : (detail?.payloads?.response ?? ''),
  );

  // Expiry notice text: reflect the configured payload window when known,
  // otherwise a neutral wording that doesn't assert a specific number.
  const payloadExpiredText = $derived(
    payloadWindowMinutes != null
      ? `Payloads expired (${payloadWindowMinutes}-min window).`
      : 'Payloads expired (retention window elapsed).',
  );

  // ----- Copy payload to clipboard -----------------------------------------
  // Independent per-button state so the inline request/response and modal
  // checkmarks never cross-trigger each other (mirrors ProfileDetail's
  // urlCopied/jsonCopied split).
  let reqCopied = $state(false);
  let respCopied = $state(false);
  let expandedCopied = $state(false);

  // Always copy the FULL, pretty-printed payload — the on-screen views cap the
  // rendered size, but the clipboard should get the complete JSON. Re-pretty
  // the raw source with an effectively unlimited size guard.
  async function copyPayload(raw: string, mark: (v: boolean) => void) {
    if (!raw) return;
    try {
      await navigator.clipboard.writeText(prettyJson(raw, Number.MAX_SAFE_INTEGER).text);
      mark(true);
      setTimeout(() => mark(false), 1500);
    } catch (err) {
      toast.error(`Copy failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
</script>

<div class="flex h-full flex-col">
  <header class="flex items-center justify-between border-b border-(--border) bg-(--hd-bg) px-4 py-2">
    <div>
      <h1 class="text-sm font-semibold text-(--fg1)">Observability</h1>
      <p class="text-[12px] text-(--fg3)">Proxied call history, metrics, and payload drill-through.</p>
    </div>
    <div class="flex items-center gap-2">
      <button class="btn-sec btn-sm" onclick={loadAll}>Refresh</button>
      <button
        class="btn-sec btn-sm text-(--offline)"
        onclick={() => (showPurgeConfirm = true)}
        disabled={purging}
        aria-label="Purge all observability data"
      >
        {purging ? 'Purging…' : 'Purge all'}
      </button>
    </div>
  </header>

  {#if loadState === 'loading'}
    <div class="flex-1 space-y-2 p-4">
      {#each [1, 2, 3, 4, 5] as _}
        <div class="h-6 w-full animate-pulse rounded bg-(--surface-hover)"></div>
      {/each}
    </div>
  {:else if loadState === 'unavailable'}
    <div class="p-4">
      <div class="rounded-lg border border-(--border) bg-(--surface) p-4">
        <p class="text-[13px] font-medium text-(--fg1)">Observability unavailable</p>
        <p class="mt-1 text-[12px] text-(--fg3)">{errorMessage}</p>
        <button class="btn-sec btn-sm mt-3" onclick={loadAll}>Try again</button>
      </div>
    </div>
  {:else}
    <div class="flex min-h-0 flex-1">
      <!-- Main column: metrics + filters + call list -->
      <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-4">
        {#if summary && !summary.enabled}
          <div class="mb-3 shrink-0 rounded-lg border border-(--border) bg-(--surface) p-3">
            <p class="text-[12px] text-(--fg3)">Observability is disabled. Enable it in Settings.</p>
          </div>
        {/if}

        {#if summary}
          <div class="mb-3 grid shrink-0 grid-cols-2 gap-2 lg:grid-cols-3">
            <Sparkline
              series={[
                { values: bucketSeries(globalSeries, 'count'), stroke: 'var(--accent)', label: 'Calls' },
                { values: bucketSeries(globalSeries, 'errorCount'), stroke: 'var(--offline)', label: 'Errors' },
              ]}
              times={globalSeries.map((b) => b.bucketStart)}
              title="Throughput / errors (per min)"
              summary={`${globalSeries.reduce((n, b) => n + b.count, 0)} calls · ${globalSeries.reduce((n, b) => n + b.errorCount, 0)} errors`}
              valueFormat={(n) => String(n)}
            />
            <Sparkline
              series={[
                { values: bucketSeries(globalSeries, 'p50Ms'), stroke: 'var(--accent)', label: 'p50' },
                { values: bucketSeries(globalSeries, 'p95Ms'), stroke: 'var(--degraded)', label: 'p95' },
              ]}
              times={globalSeries.map((b) => b.bucketStart)}
              title="Latency p50 / p95 (ms)"
              valueFormat={formatDuration}
            />
            <div class="rounded-lg border border-(--border) bg-(--surface) p-3">
              <p class="mb-1 text-[11px] font-medium text-(--fg2)">Pipeline</p>
              <dl class="space-y-0.5 text-[11px] text-(--fg3)">
                <div class="flex justify-between gap-2">
                  <dt>Payloads</dt>
                  <dd class="text-(--fg1)">{summary.storePayloads ? 'on' : 'off'}</dd>
                </div>
                <div class="flex justify-between gap-2">
                  <dt>Dropped</dt>
                  <dd class="text-(--fg1)">{summary.dropped}</dd>
                </div>
                <div class="flex justify-between gap-2">
                  <dt>Buffer</dt>
                  <dd class="text-(--fg1)">{summary.payloadBufferLen} · {formatBytes(summary.payloadBufferBytes)}</dd>
                </div>
              </dl>
            </div>
          </div>
        {/if}

        <!-- Filters -->
        <div class="mb-3 flex shrink-0 flex-wrap items-end gap-2">
          <label class="flex flex-col gap-0.5">
            <span class="text-[11px] font-medium text-(--fg2)">Server</span>
            <input
              list="obs-server-options"
              type="text"
              bind:value={serverName}
              oninput={debouncedReload}
              placeholder="All servers"
              class="w-40 rounded-lg border border-(--border) bg-(--surface) px-2 py-1 text-[12px] text-(--fg1) placeholder:text-(--fg2)/50 focus:border-(--accent) focus:outline-none"
            />
            <datalist id="obs-server-options">
              {#each serverOptions as s}
                <option value={s}></option>
              {/each}
            </datalist>
          </label>
          <label class="flex flex-col gap-0.5">
            <span class="text-[11px] font-medium text-(--fg2)">Tool</span>
            <input
              type="text"
              bind:value={tool}
              oninput={debouncedReload}
              placeholder="All tools"
              class="w-36 rounded-lg border border-(--border) bg-(--surface) px-2 py-1 text-[12px] text-(--fg1) placeholder:text-(--fg2)/50 focus:border-(--accent) focus:outline-none"
            />
          </label>
          <label class="flex flex-col gap-0.5">
            <span class="text-[11px] font-medium text-(--fg2)">Status</span>
            <select
              bind:value={status}
              onchange={refreshList}
              class="rounded-lg border border-(--border) bg-(--surface) px-2 py-1 text-[12px] text-(--fg1) focus:border-(--accent) focus:outline-none"
            >
              <option value="all">All</option>
              <option value="success">Success only</option>
              <option value="errors">Errors only</option>
            </select>
          </label>
          <label class="flex flex-col gap-0.5">
            <span class="text-[11px] font-medium text-(--fg2)">Window</span>
            <select
              bind:value={windowMinutes}
              onchange={refreshList}
              class="rounded-lg border border-(--border) bg-(--surface) px-2 py-1 text-[12px] text-(--fg1) focus:border-(--accent) focus:outline-none"
            >
              <option value={15}>Last 15 min</option>
              <option value={60}>Last 1 hour</option>
              <option value={360}>Last 6 hours</option>
              <option value={1440}>Last 24 hours</option>
              <option value={0}>All time</option>
            </select>
          </label>
          {#if uidFilter}
            <div class="flex flex-col gap-0.5">
              <span class="text-[11px] font-medium text-(--fg2)">Request UID</span>
              <button
                type="button"
                class="flex items-center gap-1 rounded-lg border border-(--accent) bg-(--accent-tint) px-2 py-1 text-[12px] text-(--fg1) hover:bg-(--surface-hover) focus:border-(--accent) focus:outline-none"
                title="Clear request UID filter"
                aria-label="Clear request UID filter"
                onclick={clearUidFilter}
              >
                <span aria-hidden="true">✕</span>
                <span class="max-w-40 truncate font-mono">{uidFilter}</span>
              </button>
            </div>
          {/if}
        </div>

        {#if errorMessage}
          <div class="mb-3 shrink-0 rounded-lg border border-(--offline)/40 bg-(--surface) p-2">
            <p class="text-[12px] text-(--offline)">{errorMessage}</p>
          </div>
        {/if}

        <!-- Call list (bounded scroll region so all loaded rows are reachable) -->
        <div class="flex min-h-0 flex-1 flex-col">
        {#if calls.length === 0}
          <div class="rounded-lg border border-(--border) bg-(--surface) p-6 text-center">
            <p class="text-[13px] text-(--fg3)">No calls match the current filters.</p>
          </div>
        {:else}
          <!-- Virtualized rows (top-anchored): only the visible window
               (+ overscan) is mounted. The header row lives OUTSIDE the
               scrolling container so it stays fixed above the rows. -->
          <div
            role="table"
            aria-label="Proxied tool calls"
            aria-rowcount={calls.length + 1}
            class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-(--border) text-[12px]"
          >
            <div role="rowgroup" class="shrink-0">
              <div role="row" class="{callListGrid} bg-(--hd-bg) text-(--fg2)">
                <div role="columnheader" class="px-2 py-1.5 text-left font-medium">Time</div>
                <div role="columnheader" class="px-2 py-1.5 text-left font-medium">Server</div>
                <div role="columnheader" class="px-2 py-1.5 text-left font-medium">Tool</div>
                <div role="columnheader" class="px-2 py-1.5 text-left font-medium">Status</div>
                <div role="columnheader" class="px-2 py-1.5 text-right font-medium">Duration</div>
                <div role="columnheader" class="px-2 py-1.5 text-right font-medium">Bytes (in/out)</div>
              </div>
            </div>
            <VirtualLogList
              items={calls}
              getKey={(c) => c.requestUid}
              followTail={false}
              class="min-h-0 flex-1"
            >
              {#snippet row(c, _index)}
                {@const st = callStatus(c)}
                <div
                  role="row"
                  tabindex="0"
                  data-request-uid={c.requestUid}
                  class="{callListGrid} cursor-pointer border-t border-(--border) hover:bg-(--surface-hover) {selectedUid === c.requestUid ? 'bg-(--accent-tint)' : ''}"
                  onclick={() => openDetail(c.requestUid)}
                  onkeydown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openDetail(c.requestUid);
                    }
                  }}
                >
                  <div role="cell" class="truncate px-2 py-1.5 text-(--fg2)">{formatTime(c.tsStart)}</div>
                  <div role="cell" class="truncate px-2 py-1.5 text-(--fg1)" title={c.serverName}>{c.serverName}</div>
                  <div role="cell" class="truncate px-2 py-1.5 font-mono text-(--fg1)" title={c.tool}>{c.tool}</div>
                  <div role="cell" class="px-2 py-1.5">
                    <span
                      class="block max-w-full truncate {st.ok ? 'text-(--healthy)' : 'text-(--offline)'}"
                      title={c.errorMessage ?? st.label}>{st.label}</span>
                  </div>
                  <div role="cell" class="px-2 py-1.5 text-right text-(--fg2)">{formatDuration(c.durationMs)}</div>
                  <div role="cell" class="truncate px-2 py-1.5 text-right text-(--fg3)">
                    {formatBytes(c.requestBytes)} / {formatBytes(c.responseBytes)}
                  </div>
                </div>
              {/snippet}
            </VirtualLogList>
          </div>
          {#if nextCursor}
            <div class="mt-2 flex justify-center">
              <button class="btn-sec btn-sm" onclick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          {/if}
          <p class="mt-2 text-[11px] text-(--fg3)">{calls.length} calls shown</p>
        {/if}
        </div>
      </div>

      <!-- Drill-through panel -->
      {#if selectedUid}
        <aside class="flex w-96 min-w-96 flex-col overflow-y-auto border-l border-(--border) bg-(--surface)">
          <div class="flex items-center justify-between border-b border-(--border) bg-(--hd-bg) px-3 py-2">
            <span class="text-[12px] font-medium text-(--fg1)">Call detail</span>
            <button class="text-(--fg2) hover:text-(--fg1)" onclick={closeDetail} aria-label="Close">✕</button>
          </div>
          <div class="flex-1 space-y-3 p-3">
            {#if detailLoading}
              <p class="text-[12px] text-(--fg3)">Loading…</p>
            {:else if detailError}
              <p class="text-[12px] text-(--offline)">{detailError}</p>
            {:else if detail}
              {@const st = callStatus(detail.record)}
              <dl class="space-y-1 text-[11px]">
                {#each [
                  ['Tool', detail.record.tool],
                  ['Server', detail.record.serverName],
                  ['Endpoint', detail.record.endpoint],
                  ['Transport', detail.record.transport],
                  ['Profile', detail.record.profile],
                  ['Client', detail.record.clientName],
                  ['Request UID', detail.record.requestUid],
                  ['Started', formatTime(detail.record.tsStart)],
                  ['Duration', formatDuration(detail.record.durationMs)],
                  ['Request bytes', formatBytes(detail.record.requestBytes)],
                  ['Response bytes', formatBytes(detail.record.responseBytes)],
                ] as [k, v]}
                  {#if v !== undefined && v !== null && v !== ''}
                    <div class="flex justify-between gap-2">
                      <dt class="text-(--fg3)">{k}</dt>
                      <dd class="truncate text-right font-mono text-(--fg1)" title={String(v)}>{v}</dd>
                    </div>
                  {/if}
                {/each}
                <div class="flex justify-between gap-2">
                  <dt class="text-(--fg3)">Status</dt>
                  <dd class="text-right {st.ok ? 'text-(--healthy)' : 'text-(--offline)'}">
                    {st.ok ? st.label : (detail.record.errorMessage ?? st.label)}
                  </dd>
                </div>
                {#if detail.record.streamed}
                  <div class="flex justify-between gap-2">
                    <dt class="text-(--fg3)">Streamed</dt>
                    <dd class="text-right text-(--fg1)">yes</dd>
                  </div>
                {/if}
              </dl>

              {#if detail.payloadStatus === 'disabled'}
                <p class="rounded border border-(--border) bg-(--surface-sunken) p-2 text-[11px] text-(--fg3)">
                  Payload capture disabled.
                </p>
              {:else if detail.payloadStatus === 'expired'}
                <p class="rounded border border-(--border) bg-(--surface-sunken) p-2 text-[11px] text-(--fg3)">
                  {payloadExpiredText}
                </p>
              {:else if detail.payloads}
                <div>
                  <div class="mb-1 flex items-center justify-between gap-2">
                    <p class="text-[11px] font-medium text-(--fg2)">
                      Request{detail.payloads.request_truncated ? ' (truncated)' : ''}
                    </p>
                    <div class="flex items-center gap-1">
                      {#if detail.payloads.request}
                        <button
                          type="button"
                          class="text-(--fg3) hover:text-(--fg1)"
                          aria-label="Copy request JSON"
                          title="Copy request JSON"
                          onclick={() => copyPayload(detail!.payloads!.request, (v) => (reqCopied = v))}
                        >
                          {#if reqCopied}
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              width="13"
                              height="13"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              aria-hidden="true"
                            >
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          {:else}
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              width="13"
                              height="13"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              aria-hidden="true"
                            >
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          {/if}
                        </button>
                      {/if}
                      <button
                        type="button"
                        class="text-(--fg3) hover:text-(--fg1)"
                        aria-label="Expand request payload"
                        title="Expand request payload"
                        onclick={() => expandPayload('request')}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M15 3h6v6" />
                          <path d="M9 21H3v-6" />
                          <path d="M21 3l-7 7" />
                          <path d="M3 21l7-7" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  {#if reqTree.ok}
                    <div class="json-tree max-h-64 overflow-auto rounded border border-(--border) bg-(--surface-sunken) p-2 text-[11px]">
                      <JsonView data={reqTree.value} style={defaultStyles} />
                    </div>
                  {:else}
                    <pre class="max-h-64 overflow-auto rounded border border-(--border) bg-(--surface-sunken) p-2 font-mono text-[11px] whitespace-pre-wrap break-words text-(--fg1)">{reqPretty?.text}{reqPretty?.truncated ? '\n… (display truncated)' : ''}</pre>
                  {/if}
                </div>
                <div>
                  <div class="mb-1 flex items-center justify-between gap-2">
                    <p class="text-[11px] font-medium text-(--fg2)">
                      Response{detail.payloads.response_truncated ? ' (truncated)' : ''}
                    </p>
                    <div class="flex items-center gap-1">
                      {#if detail.payloads.response}
                        <button
                          type="button"
                          class="text-(--fg3) hover:text-(--fg1)"
                          aria-label="Copy response JSON"
                          title="Copy response JSON"
                          onclick={() => copyPayload(detail!.payloads!.response, (v) => (respCopied = v))}
                        >
                          {#if respCopied}
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              width="13"
                              height="13"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              aria-hidden="true"
                            >
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          {:else}
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              width="13"
                              height="13"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              aria-hidden="true"
                            >
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          {/if}
                        </button>
                      {/if}
                      <button
                        type="button"
                        class="text-(--fg3) hover:text-(--fg1)"
                        aria-label="Expand response payload"
                        title="Expand response payload"
                        onclick={() => expandPayload('response')}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M15 3h6v6" />
                          <path d="M9 21H3v-6" />
                          <path d="M21 3l-7 7" />
                          <path d="M3 21l7-7" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  {#if respTree.ok}
                    <div class="json-tree max-h-64 overflow-auto rounded border border-(--border) bg-(--surface-sunken) p-2 text-[11px]">
                      <JsonView data={respTree.value} style={defaultStyles} />
                    </div>
                  {:else}
                    <pre class="max-h-64 overflow-auto rounded border border-(--border) bg-(--surface-sunken) p-2 font-mono text-[11px] whitespace-pre-wrap break-words text-(--fg1)">{respPretty?.text}{respPretty?.truncated ? '\n… (display truncated)' : ''}</pre>
                  {/if}
                </div>
              {/if}
            {/if}
          </div>
        </aside>
      {/if}
    </div>
  {/if}
</div>

<!-- Pop-out: full-screen modal showing one payload at full size (no max-h-64
     clamp). Reuses the ConfirmModal pattern: backdrop click + Escape close. -->
{#if expandedPayload && detail?.payloads}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    role="presentation"
    onclick={closeExpanded}
  >
    <div
      class="flex max-h-[90vh] w-[80rem] max-w-[90vw] flex-col rounded-xl border border-(--border) bg-(--surface) shadow-xl"
      role="dialog"
      aria-modal="true"
      aria-label="{expandedLabel} payload"
      tabindex="-1"
      use:focusTrap={{ onEscape: closeExpanded }}
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <div class="flex items-center justify-between border-b border-(--border) px-4 py-3">
        <span class="text-[13px] font-medium text-(--fg1)">
          {expandedLabel}{expandedTruncated ? ' (truncated)' : ''}
        </span>
        <div class="flex items-center gap-2">
          {#if expandedRaw}
            <button
              type="button"
              class="inline-flex h-[18px] w-[18px] items-center justify-center text-(--fg3) hover:text-(--fg1)"
              aria-label="Copy {expandedLabel} JSON"
              title="Copy {expandedLabel} JSON"
              onclick={() => copyPayload(expandedRaw, (v) => (expandedCopied = v))}
            >
              {#if expandedCopied}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              {:else}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              {/if}
            </button>
          {/if}
          <button
            type="button"
            class="inline-flex h-[18px] w-[18px] items-center justify-center text-(--fg3) hover:text-(--fg1)"
            onclick={closeExpanded}
            aria-label="Close"
            title="Close"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
      <div class="min-h-0 flex-1 overflow-auto p-4">
        {#if expandedTree.ok}
          <div class="json-tree text-[12px]">
            <JsonView data={expandedTree.value} style={defaultStyles} />
          </div>
        {:else}
          <pre class="font-mono text-[12px] whitespace-pre-wrap break-words text-(--fg1)">{expandedPretty?.text}{expandedPretty?.truncated ? '\n… (display truncated)' : ''}</pre>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if showPurgeConfirm}
  <ConfirmModal
    title="Purge observability data"
    message="This permanently deletes ALL stored call history and buffered payloads. This cannot be undone."
    confirmLabel="Purge"
    onconfirm={confirmPurge}
    oncancel={() => (showPurgeConfirm = false)}
  />
{/if}

<style>
  /* Map the JSON tree viewer's --sjv-* palette onto the app's theme tokens so
     it follows [data-theme="dark"]/.dark automatically (no theme prop juggling). */
  .json-tree :global(div[role='tree']) {
    --sjv-background: transparent;
    --sjv-label: var(--fg1);
    --sjv-punctuation: var(--fg3);
    --sjv-string: var(--healthy);
    --sjv-number: var(--accent);
    --sjv-boolean: var(--degraded);
    --sjv-null: var(--offline);
    --sjv-undefined: var(--offline);
    --sjv-other: var(--fg2);
    --sjv-expander: var(--fg3);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
  }
</style>
