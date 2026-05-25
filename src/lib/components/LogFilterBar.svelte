<script lang="ts">
  import type { LogLevel, ParsedLogLine } from '$lib/logParser';

  // Level toggles render in this fixed display order so the bar layout
  // doesn't reshuffle as logs arrive.
  const LEVEL_ORDER: LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace'];

  type Props = {
    lines: ParsedLogLine[];
    filteredCount: number;
    activeLevels: Set<LogLevel>;
    selectedEndpoints: Set<string>;
    selectedProfiles: Set<string>;
    searchText: string;
    toolCallsOnly: boolean;
    onclear: () => void;
  };

  let {
    lines,
    filteredCount,
    activeLevels = $bindable(),
    selectedEndpoints = $bindable(),
    selectedProfiles = $bindable(),
    searchText = $bindable(),
    toolCallsOnly = $bindable(),
    onclear,
  }: Props = $props();

  // Search input is bound locally and the debounced value is published into
  // the bindable `searchText` prop. 150ms matches the engineering spec.
  let searchInput = $state(searchText);
  let endpointMenuOpen = $state(false);
  let profileMenuOpen = $state(false);

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const value = searchInput;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      searchText = value;
    }, 150);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  });

  const levelCounts = $derived.by(() => {
    const counts: Record<LogLevel, number> = { error: 0, warn: 0, info: 0, debug: 0, trace: 0 };
    for (const line of lines) counts[line.level]++;
    return counts;
  });

  const allEndpoints = $derived.by(() => {
    const set = new Set<string>();
    for (const line of lines) if (line.endpoint) set.add(line.endpoint);
    return Array.from(set).sort();
  });

  const allProfiles = $derived.by(() => {
    const set = new Set<string>();
    for (const line of lines) if (line.profile) set.add(line.profile);
    return Array.from(set).sort();
  });

  const toolCallCount = $derived.by(() => {
    let n = 0;
    for (const line of lines) if (line.isToolCall) n++;
    return n;
  });

  function toggleLevel(level: LogLevel) {
    const next = new Set(activeLevels);
    if (next.has(level)) next.delete(level);
    else next.add(level);
    activeLevels = next;
  }

  function toggleEndpoint(name: string) {
    const next = new Set(selectedEndpoints);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    selectedEndpoints = next;
  }

  function selectAllEndpoints() {
    selectedEndpoints = new Set();
  }

  function toggleProfile(name: string) {
    const next = new Set(selectedProfiles);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    selectedProfiles = next;
  }

  function selectAllProfiles() {
    selectedProfiles = new Set();
  }

  function levelPillClass(level: LogLevel, active: boolean): string {
    if (!active) return 'border-(--border) text-(--fg3) bg-transparent';
    switch (level) {
      case 'error': return 'border-(--offline) bg-(--offline)/10 text-(--offline)';
      case 'warn': return 'border-(--degraded) bg-(--degraded)/10 text-(--degraded)';
      case 'info': return 'border-(--healthy) bg-(--healthy)/10 text-(--healthy)';
      case 'debug': return 'border-(--accent) bg-(--accent)/10 text-(--accent)';
      case 'trace': return 'border-(--fg3) bg-(--fg3)/15 text-(--fg2)';
    }
  }
</script>

<div class="px-3 py-2 border-b border-(--border) bg-(--hd-bg) flex flex-col gap-2">
  <div class="flex items-center gap-2 flex-wrap">
    {#each LEVEL_ORDER as level (level)}
      <button
        type="button"
        class="pill border transition-colors {levelPillClass(level, activeLevels.has(level))}"
        aria-pressed={activeLevels.has(level)}
        onclick={() => toggleLevel(level)}
      >
        {level.toUpperCase()} ({levelCounts[level]})
      </button>
    {/each}

    <button
      type="button"
      class="pill border transition-colors {toolCallsOnly
        ? 'border-(--accent) bg-(--accent)/10 text-(--accent)'
        : 'border-(--border) text-(--fg3) bg-transparent'}"
      aria-pressed={toolCallsOnly}
      title="Show only tool-call events"
      onclick={() => (toolCallsOnly = !toolCallsOnly)}
    >
      ⚡ Tool calls only ({toolCallCount})
    </button>

    <div class="ml-auto relative">
      <button
        type="button"
        class="btn-sec btn-sm"
        aria-haspopup="listbox"
        aria-expanded={endpointMenuOpen}
        onclick={() => (endpointMenuOpen = !endpointMenuOpen)}
      >
        Endpoint: {selectedEndpoints.size === 0
          ? 'All'
          : selectedEndpoints.size === 1
            ? Array.from(selectedEndpoints)[0]
            : `${selectedEndpoints.size} selected`} ▾
      </button>
      {#if endpointMenuOpen}
        <ul
          role="listbox"
          aria-multiselectable="true"
          class="absolute right-0 mt-1 z-10 min-w-[12rem] max-h-64 overflow-y-auto rounded-md border border-(--border) bg-(--surface) shadow-lg text-sm"
        >
          <li>
            <button type="button" class="w-full text-left px-3 py-1.5 hover:bg-(--surface-hover)" onclick={selectAllEndpoints}>
              {selectedEndpoints.size === 0 ? '✓ ' : '  '}All
            </button>
          </li>
          {#each allEndpoints as ep (ep)}
            <li>
              <button type="button" class="w-full text-left px-3 py-1.5 hover:bg-(--surface-hover) font-mono" onclick={() => toggleEndpoint(ep)}>
                {selectedEndpoints.has(ep) ? '✓ ' : '  '}{ep}
              </button>
            </li>
          {:else}
            <li class="px-3 py-1.5 text-(--fg3) italic">No endpoints yet</li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="relative">
      <button
        type="button"
        class="btn-sec btn-sm"
        aria-haspopup="listbox"
        aria-expanded={profileMenuOpen}
        onclick={() => (profileMenuOpen = !profileMenuOpen)}
      >
        Profile: {selectedProfiles.size === 0
          ? 'All'
          : selectedProfiles.size === 1
            ? Array.from(selectedProfiles)[0]
            : `${selectedProfiles.size} selected`} ▾
      </button>
      {#if profileMenuOpen}
        <ul
          role="listbox"
          aria-multiselectable="true"
          class="absolute right-0 mt-1 z-10 min-w-[12rem] max-h-64 overflow-y-auto rounded-md border border-(--border) bg-(--surface) shadow-lg text-sm"
        >
          <li>
            <button type="button" class="w-full text-left px-3 py-1.5 hover:bg-(--surface-hover)" onclick={selectAllProfiles}>
              {selectedProfiles.size === 0 ? '✓ ' : '  '}All
            </button>
          </li>
          {#each allProfiles as pr (pr)}
            <li>
              <button type="button" class="w-full text-left px-3 py-1.5 hover:bg-(--surface-hover) font-mono" onclick={() => toggleProfile(pr)}>
                {selectedProfiles.has(pr) ? '✓ ' : '  '}{pr}
              </button>
            </li>
          {:else}
            <li class="px-3 py-1.5 text-(--fg3) italic">No profiles yet</li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>

  <div class="flex items-center gap-2">
    <div class="relative flex-1">
      <svg class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-(--fg3)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8" />
        <path d="M21 21l-4.3-4.3" stroke-linecap="round" />
      </svg>
      <input
        type="text"
        placeholder="Search logs…"
        bind:value={searchInput}
        class="w-full pl-7 pr-2 py-[5px] text-[13px] rounded-lg border border-(--border) bg-(--surface) text-(--fg1) focus:outline-none focus:border-(--accent) focus:shadow-[0_0_0_3px_var(--accent-tint)] transition-shadow"
      />
    </div>
    <span class="text-xs text-(--fg3) whitespace-nowrap">{filteredCount} / {lines.length} lines</span>
    <button type="button" class="btn-sec btn-sm" onclick={onclear}>Clear</button>
  </div>
</div>
