import { describe, it, expect, vi } from 'vitest';
import addEndpointModalSource from './AddEndpointModal.svelte?raw';
import { sanitizeName } from '$lib/utils';
import { CATALOG_SERVERS, type CatalogServer } from '$lib/catalog';
import { oauthCatalog, type OAuthCatalogEntry } from '$lib/data/oauth-catalog';
import {
  buildScopesPayload,
  shouldShowManualOAuthStar,
  nextPollDelayMs,
  nextPollOrTimeout,
  OAUTH_SETUP_POLL_BUDGET_MS,
  validateAddEndpointForm,
  firstAddEndpointFieldError,
  computeAddEndpointIsDirty,
  resolveIsolation,
  isolationEnabledFromConfig,
  parseMountRows,
  serializeMountRows,
  mountRowError,
  hasMountRowErrors,
  buildMountExample,
  buildOrgBoundEndpointParams,
  orgBindingApplies,
  buildCatalogEnvAndHeaders,
  MOUNT_EXAMPLE_FALLBACK_HOST,
  type AddEndpointFieldErrors,
  type AddEndpointFormSnapshot,
  type MountRow,
} from './add-endpoint-helpers';

// `sanitizeName` mirrors the relay's `sanitize_server_name`
// (`packages/relay/src/adapter/server_name.rs`). The cases below stay in
// lockstep with that Rust unit test table so the two ends agree on what a
// freshly-typed override will produce.
describe('sanitizeName', () => {
  it('handles basic lowercase name', () => {
    expect(sanitizeName('echo-mcp')).toBe('echo-mcp');
  });

  it('converts spaces to dashes (matching relay semantics)', () => {
    expect(sanitizeName('My MCP Server')).toBe('my-mcp-server');
  });

  it('replaces special characters with collapsed dashes', () => {
    expect(sanitizeName('server@v2.0!')).toBe('server-v2-0');
  });

  it('converts uppercase to lowercase', () => {
    expect(sanitizeName('MyServer')).toBe('myserver');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeName('')).toBe('');
  });

  it('returns empty string for only special characters', () => {
    expect(sanitizeName('@#$%^&*')).toBe('');
  });

  it('replaces unicode with dashes (trimmed at edges)', () => {
    expect(sanitizeName('café')).toBe('caf');
    expect(sanitizeName('日本語')).toBe('');
  });

  it('handles mixed input', () => {
    expect(sanitizeName('My Server - v2.0 (beta)')).toBe('my-server-v2-0-beta');
  });

  it('preserves hyphens and underscores', () => {
    expect(sanitizeName('my-server_name')).toBe('my-server_name');
  });

  it('preserves digits', () => {
    expect(sanitizeName('server123')).toBe('server123');
  });

  // ── Additional coverage for relay parity (Wave DT.3) ──

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeName('  spaces  ')).toBe('spaces');
  });

  it('collapses internal whitespace runs to a single dash', () => {
    expect(sanitizeName('Linear   MCP\tServer')).toBe('linear-mcp-server');
  });

  it('collapses runs of dots/slashes/colons to a single dash', () => {
    expect(sanitizeName('a..b//c::d')).toBe('a-b-c-d');
  });

  it('trims leading and trailing dashes after replacement', () => {
    expect(sanitizeName('---Gmail---')).toBe('gmail');
  });

  it('truncates to 64 characters', () => {
    const input = 'a'.repeat(100);
    const out = sanitizeName(input);
    expect(out.length).toBe(64);
    expect(out).toBe('a'.repeat(64));
  });

  it('passes already-canonical lowercase names through unchanged', () => {
    expect(sanitizeName('gmail')).toBe('gmail');
    expect(sanitizeName('google-drive')).toBe('google-drive');
    expect(sanitizeName('google-calendar')).toBe('google-calendar');
  });

  it('is idempotent for canonical inputs', () => {
    const cases = ['gmail', 'my-server-v2', 'a_b-c', 'server123'];
    for (const c of cases) {
      expect(sanitizeName(sanitizeName(c))).toBe(sanitizeName(c));
    }
  });
});

// ── Helpers that mirror the component's inline logic ──

type UnifiedEntry =
  | { type: 'oauth'; entry: OAuthCatalogEntry }
  | { type: 'local'; entry: CatalogServer };

function filterBySearch<T extends { name: string; description: string }>(
  items: T[],
  search: string,
): T[] {
  if (!search.trim()) return items;
  const q = search.toLowerCase();
  return items.filter(
    (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
  );
}

function buildUnifiedList(opts: {
  showOAuth: boolean;
  showLocal: boolean;
  search: string;
}): UnifiedEntry[] {
  const filteredLocal = filterBySearch(CATALOG_SERVERS, opts.search);
  const filteredOAuth = filterBySearch(oauthCatalog, opts.search);
  const items: UnifiedEntry[] = [];
  if (opts.showOAuth) {
    items.push(...filteredOAuth.map((e) => ({ type: 'oauth' as const, entry: e })));
  }
  if (opts.showLocal) {
    items.push(...filteredLocal.map((e) => ({ type: 'local' as const, entry: e })));
  }
  return items.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
}

// ── Filter toggle tests ──

describe('AddEndpointModal unified browse list', () => {
  describe('filter toggles', () => {
    it('shows both OAuth and Local entries by default', () => {
      const list = buildUnifiedList({ showOAuth: true, showLocal: true, search: '' });
      const oauthCount = list.filter((e) => e.type === 'oauth').length;
      const localCount = list.filter((e) => e.type === 'local').length;
      expect(oauthCount).toBe(oauthCatalog.length);
      expect(localCount).toBe(CATALOG_SERVERS.length);
      expect(list.length).toBe(oauthCatalog.length + CATALOG_SERVERS.length);
    });

    it('toggling OAuth off hides OAuth entries, shows only Local', () => {
      const list = buildUnifiedList({ showOAuth: false, showLocal: true, search: '' });
      expect(list.every((e) => e.type === 'local')).toBe(true);
      expect(list.length).toBe(CATALOG_SERVERS.length);
    });

    it('toggling Local off hides Local entries, shows only OAuth', () => {
      const list = buildUnifiedList({ showOAuth: true, showLocal: false, search: '' });
      expect(list.every((e) => e.type === 'oauth')).toBe(true);
      expect(list.length).toBe(oauthCatalog.length);
    });

    it('both off shows empty list', () => {
      const list = buildUnifiedList({ showOAuth: false, showLocal: false, search: '' });
      expect(list).toHaveLength(0);
    });

    it('toggling back on restores entries', () => {
      const listOff = buildUnifiedList({ showOAuth: false, showLocal: false, search: '' });
      expect(listOff).toHaveLength(0);
      const listOn = buildUnifiedList({ showOAuth: true, showLocal: true, search: '' });
      expect(listOn.length).toBe(oauthCatalog.length + CATALOG_SERVERS.length);
    });
  });

  describe('unified list sorting', () => {
    it('entries are sorted alphabetically by name', () => {
      const list = buildUnifiedList({ showOAuth: true, showLocal: true, search: '' });
      const names = list.map((e) => e.entry.name);
      const sorted = [...names].sort((a, b) => a.localeCompare(b));
      expect(names).toEqual(sorted);
    });

    it('OAuth and Local entries are interleaved correctly', () => {
      const list = buildUnifiedList({ showOAuth: true, showLocal: true, search: '' });
      const types = list.map((e) => e.type);
      let hasInterleaving = false;
      for (let i = 1; i < types.length; i++) {
        if (types[i] !== types[i - 1]) {
          hasInterleaving = true;
          break;
        }
      }
      expect(hasInterleaving).toBe(true);
    });
  });

  describe('search + filter interaction', () => {
    it('search narrows results across both types', () => {
      const list = buildUnifiedList({ showOAuth: true, showLocal: true, search: 'slack' });
      expect(list.length).toBeGreaterThanOrEqual(2);
      expect(list.some((e) => e.type === 'oauth')).toBe(true);
      expect(list.some((e) => e.type === 'local')).toBe(true);
      expect(list.every((e) => e.entry.name.toLowerCase().includes('slack'))).toBe(true);
    });

    it('search + filter toggle work together', () => {
      const list = buildUnifiedList({ showOAuth: true, showLocal: false, search: 'git' });
      expect(list.every((e) => e.type === 'oauth')).toBe(true);
      const github = list.find((e) => e.entry.name === 'GitHub');
      expect(github).toBeDefined();
      expect(list.some((e) => e.type === 'local')).toBe(false);
    });

    it('search with no matches returns empty list', () => {
      const list = buildUnifiedList({
        showOAuth: true,
        showLocal: true,
        search: 'zzz_nonexistent_zzz',
      });
      expect(list).toHaveLength(0);
    });

    it('search matches on description too', () => {
      const list = buildUnifiedList({ showOAuth: true, showLocal: true, search: 'issue tracking' });
      expect(list.length).toBeGreaterThanOrEqual(1);
      expect(list.some((e) => e.entry.id === 'linear')).toBe(true);
    });
  });

  describe('DCR fallback dialog cancel logic', () => {
    // Mirror of handleDcrCancel in AddEndpointModal.svelte. Cancels the in-flight
    // relay setup session, dismisses only the inner DCR dialog, preserves all
    // outer form state, and surfaces a neutral hint above the form fields.
    interface ModalState {
      // Outer form (must be preserved across DCR cancel)
      name: string;
      url: string;
      prefix: string;
      scopes: string;
      clientId: string;
      clientSecret: string;
      oauthServerUrl: string;
      // DCR dialog + in-flight session (reset on cancel)
      showingDcrFallback: boolean;
      dcrFallbackData: { authorization_endpoint?: string };
      dcrClientId: string;
      dcrClientSecret: string;
      pendingSetupSessionId: string | null;
      submitting: boolean;
      setupAuthCancelled: boolean;
      error: string;
      cancelHint: string;
    }

    async function applyDcrCancel(
      state: ModalState,
      cancelApi: (sessionId: string) => Promise<void>,
    ): Promise<void> {
      state.setupAuthCancelled = true;
      if (state.pendingSetupSessionId) {
        try { await cancelApi(state.pendingSetupSessionId); } catch { /* best effort */ }
        state.pendingSetupSessionId = null;
      }
      state.showingDcrFallback = false;
      state.dcrFallbackData = {};
      state.submitting = false;
      state.error = '';
      state.cancelHint = 'OAuth setup cancelled — adjust your settings and try again.';
    }

    function makeState(overrides: Partial<ModalState> = {}): ModalState {
      return {
        name: 'Linear',
        url: 'https://mcp.linear.app/sse',
        prefix: 'linear',
        scopes: 'read write',
        clientId: 'preserved-client-id',
        clientSecret: 'preserved-client-secret',
        oauthServerUrl: 'https://linear.app/oauth',
        showingDcrFallback: true,
        dcrFallbackData: { authorization_endpoint: 'https://linear.app/oauth/authorize' },
        dcrClientId: 'typed-client-id',
        dcrClientSecret: 'typed-client-secret',
        pendingSetupSessionId: 'session-abc-123',
        submitting: true,
        setupAuthCancelled: false,
        error: '',
        cancelHint: '',
        ...overrides,
      };
    }

    it('cancel calls oauthSetupCancel with the active session id and clears it', async () => {
      const cancelApi = vi.fn(async (_sessionId: string) => {});
      const state = makeState();
      await applyDcrCancel(state, cancelApi);
      expect(cancelApi).toHaveBeenCalledTimes(1);
      expect(cancelApi).toHaveBeenCalledWith('session-abc-123');
      expect(state.pendingSetupSessionId).toBeNull();
    });

    it('cancel resets DCR dialog state and shows the neutral hint', async () => {
      const state = makeState();
      await applyDcrCancel(state, async () => {});
      expect(state.showingDcrFallback).toBe(false);
      expect(state.dcrFallbackData).toEqual({});
      expect(state.submitting).toBe(false);
      expect(state.setupAuthCancelled).toBe(true);
      expect(state.error).toBe('');
      expect(state.cancelHint).toBe('OAuth setup cancelled — adjust your settings and try again.');
    });

    it('cancel preserves all outer form state', async () => {
      const state = makeState();
      const before = {
        name: state.name, url: state.url, prefix: state.prefix, scopes: state.scopes,
        clientId: state.clientId, clientSecret: state.clientSecret, oauthServerUrl: state.oauthServerUrl,
      };
      await applyDcrCancel(state, async () => {});
      expect(state.name).toBe(before.name);
      expect(state.url).toBe(before.url);
      expect(state.prefix).toBe(before.prefix);
      expect(state.scopes).toBe(before.scopes);
      expect(state.clientId).toBe(before.clientId);
      expect(state.clientSecret).toBe(before.clientSecret);
      expect(state.oauthServerUrl).toBe(before.oauthServerUrl);
    });

    it('cancel is a best-effort call: API rejection still resets state', async () => {
      const cancelApi = vi.fn(async () => { throw new Error('relay unreachable'); });
      const state = makeState();
      await applyDcrCancel(state, cancelApi);
      expect(cancelApi).toHaveBeenCalledTimes(1);
      expect(state.pendingSetupSessionId).toBeNull();
      expect(state.showingDcrFallback).toBe(false);
      expect(state.cancelHint).toContain('OAuth setup cancelled');
    });

    it('cancel without an active session id skips the API call', async () => {
      const cancelApi = vi.fn(async () => {});
      const state = makeState({ pendingSetupSessionId: null });
      await applyDcrCancel(state, cancelApi);
      expect(cancelApi).not.toHaveBeenCalled();
      expect(state.showingDcrFallback).toBe(false);
    });
  });

  describe('DCR fallback dialog ESC routing', () => {
    // Mirror of handleKeydown in AddEndpointModal.svelte: ESC routes to the inner
    // dialog cancel when the DCR dialog is open, otherwise falls through to the
    // outer modal cancel.
    function routeEscape(opts: { showingDcrFallback: boolean }): 'dcr-cancel' | 'outer-cancel' {
      return opts.showingDcrFallback ? 'dcr-cancel' : 'outer-cancel';
    }

    it('routes ESC to the inner cancel handler when DCR dialog is open', () => {
      expect(routeEscape({ showingDcrFallback: true })).toBe('dcr-cancel');
    });

    it('routes ESC to the outer cancel handler when DCR dialog is closed', () => {
      expect(routeEscape({ showingDcrFallback: false })).toBe('outer-cancel');
    });
  });

  describe('OAuth service selection', () => {
    it('selectOAuthService populates correct fields from catalog entry', () => {
      const service = oauthCatalog.find((e) => e.id === 'github')!;
      expect(service).toBeDefined();

      const name = service.name;
      const prefix = sanitizeName(service.name);
      const description = service.description;
      const transport = 'oauth';
      const url = service.url;
      const oauthServerUrl = service.oauthServerUrl || '';
      const scopeStr = service.defaultScopes.join(' ');

      expect(name).toBe('GitHub');
      expect(prefix).toBe('github');
      expect(description).toBe('Code hosting and collaboration');
      expect(transport).toBe('oauth');
      expect(url).toBe('https://api.githubcopilot.com/mcp/');
      expect(oauthServerUrl).toBe('https://github.com/login/oauth');
      expect(scopeStr).toBe('repo read:user');
    });
  });
});

describe('Scope handling', () => {
  describe('buildScopesPayload — free-text mode', () => {
    it('collapses internal whitespace and trims for the string form', () => {
      const out = buildScopesPayload('free', '  read   write  ');
      expect(out.string).toBe('read write');
    });

    it('splits on whitespace for the array form', () => {
      const out = buildScopesPayload('free', '  read   write  ');
      expect(out.array).toEqual(['read', 'write']);
    });

    it('returns undefined for empty input', () => {
      expect(buildScopesPayload('free', '')).toEqual({ string: undefined, array: undefined });
    });

    it('returns undefined for whitespace-only input', () => {
      expect(buildScopesPayload('free', '   \t  ')).toEqual({ string: undefined, array: undefined });
    });

    it('handles a single token', () => {
      expect(buildScopesPayload('free', 'read')).toEqual({ string: 'read', array: ['read'] });
    });
  });

  describe('buildScopesPayload — checkbox mode', () => {
    it('joins Set members with single spaces in insertion order', () => {
      // Order rule: the array follows Set insertion order; the modal seeds
      // the Set from defaultScopes so the on-the-wire order matches the
      // catalog entry.
      const out = buildScopesPayload('checkbox', new Set(['a', 'b']));
      expect(out.string).toBe('a b');
      expect(out.array).toEqual(['a', 'b']);
    });

    it('preserves insertion order for arbitrary scope strings', () => {
      const out = buildScopesPayload(
        'checkbox',
        new Set([
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/gmail.compose',
        ]),
      );
      expect(out.array).toEqual([
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.compose',
      ]);
      expect(out.string).toBe(
        'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose',
      );
    });

    it('returns undefined for an empty Set', () => {
      expect(buildScopesPayload('checkbox', new Set())).toEqual({
        string: undefined,
        array: undefined,
      });
    });
  });
});

describe('OAuth manual-registration flag', () => {
  it('shouldShowManualOAuthStar returns true exactly for entries with supportsDcr === false', () => {
    for (const entry of oauthCatalog) {
      expect(shouldShowManualOAuthStar(entry)).toBe(entry.supportsDcr === false);
    }
  });

  it('flags every catalog entry that lacks DCR support', () => {
    const flagged = oauthCatalog.filter(shouldShowManualOAuthStar).map((e) => e.id);
    const expected = oauthCatalog.filter((e) => e.supportsDcr === false).map((e) => e.id);
    expect(flagged).toEqual(expected);
  });

  it('does not flag DCR-supporting entries', () => {
    for (const entry of oauthCatalog) {
      if (entry.supportsDcr === true) {
        expect(shouldShowManualOAuthStar(entry)).toBe(false);
      }
    }
  });
});

describe('Scope option shape', () => {
  it('every availableScopes option appears in defaultScopes for the same entry', () => {
    const entriesWithScopes = oauthCatalog.filter(
      (e) => e.availableScopes && e.availableScopes.length > 0,
    );
    expect(entriesWithScopes.length).toBeGreaterThan(0);
    for (const entry of entriesWithScopes) {
      for (const opt of entry.availableScopes!) {
        expect(entry.defaultScopes).toContain(opt.scope);
      }
    }
  });

  it('every availableScopes option has non-empty name and description', () => {
    for (const entry of oauthCatalog) {
      if (!entry.availableScopes) continue;
      for (const opt of entry.availableScopes) {
        expect(opt.scope.trim().length).toBeGreaterThan(0);
        expect(opt.name.trim().length).toBeGreaterThan(0);
        expect(opt.description.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

// Slice A row 3 — exponential backoff schedule (1s → 2s → 4s → 5s cap).
describe('nextPollDelayMs', () => {
  it('returns 1s, 2s, 4s, then caps at 5s for subsequent attempts', () => {
    expect(nextPollDelayMs(0)).toBe(1000);
    expect(nextPollDelayMs(1)).toBe(2000);
    expect(nextPollDelayMs(2)).toBe(4000);
    expect(nextPollDelayMs(3)).toBe(5000);
    expect(nextPollDelayMs(4)).toBe(5000);
    expect(nextPollDelayMs(10)).toBe(5000);
    expect(nextPollDelayMs(100)).toBe(5000);
  });

  it('clamps negative inputs to the initial 1s delay', () => {
    expect(nextPollDelayMs(-1)).toBe(1000);
  });
});

// Slice A row 4 — cumulative-budget guard: polling stops once the next wait
// would push us past the 120s window so `pollForSetupAuth` can surface a
// timeout message instead of overshooting.
describe('nextPollOrTimeout', () => {
  it('returns the next delay while inside the budget', () => {
    expect(nextPollOrTimeout(0, 0)).toBe(1000);
    expect(nextPollOrTimeout(1, 1_000)).toBe(2000);
    expect(nextPollOrTimeout(2, 3_000)).toBe(4000);
    expect(nextPollOrTimeout(3, 7_000)).toBe(5000);
  });

  it('returns null when the next wait would exceed the 120s budget', () => {
    expect(nextPollOrTimeout(99, OAUTH_SETUP_POLL_BUDGET_MS)).toBeNull();
    expect(nextPollOrTimeout(99, OAUTH_SETUP_POLL_BUDGET_MS - 4_999)).toBeNull();
    // Exactly fits — still allowed.
    expect(nextPollOrTimeout(99, OAUTH_SETUP_POLL_BUDGET_MS - 5_000)).toBe(5000);
  });

  it('runs a bounded number of polls and stops within the 120s budget', () => {
    // Simulates the loop in `pollForSetupAuth` and verifies it terminates
    // with a timeout rather than overshooting the wall-clock budget.
    let attempt = 0;
    let elapsed = 0;
    const delays: number[] = [];
    while (true) {
      const next = nextPollOrTimeout(attempt, elapsed);
      if (next === null) break;
      delays.push(next);
      elapsed += next;
      attempt += 1;
      // Guard against an accidental infinite loop in the test.
      if (attempt > 1000) throw new Error('schedule did not terminate');
    }
    expect(delays.slice(0, 4)).toEqual([1000, 2000, 4000, 5000]);
    expect(elapsed).toBeLessThanOrEqual(OAUTH_SETUP_POLL_BUDGET_MS);
    // 1+2+4+5 = 12s, then 5s steps → 12 + 5*N ≤ 120  →  N ≤ 21  →  25 polls total.
    expect(delays.length).toBe(25);
    // The very next attempt after the loop terminates must be flagged as a timeout.
    expect(nextPollOrTimeout(attempt, elapsed)).toBeNull();
  });
});

// Slice C row 13 — per-field validation in AddEndpointModal: required fields
// flag `aria-invalid` on submit and clear back to false once the user edits
// the offending input. The pure helpers below back the in-component logic;
// the on-edit clear is mirrored by `clearFieldError` in the modal.
describe('validateAddEndpointForm', () => {
  it('flags only `name` when stdio command is filled but name is empty', () => {
    const errs = validateAddEndpointForm({
      transport: 'stdio',
      name: '   ',
      command: 'npx',
      url: '',
    });
    expect(errs).toEqual({ name: 'Name is required' });
  });

  it('flags only `command` for stdio when name is filled but command is empty', () => {
    const errs = validateAddEndpointForm({
      transport: 'stdio',
      name: 'my-server',
      command: '',
      url: '',
    });
    expect(errs).toEqual({ command: 'Command is required for stdio' });
  });

  it('flags both `name` and `command` for stdio when both are blank', () => {
    const errs = validateAddEndpointForm({
      transport: 'stdio',
      name: '',
      command: '',
      url: '',
    });
    expect(errs).toEqual({
      name: 'Name is required',
      command: 'Command is required for stdio',
    });
  });

  it('flags `url` with the OAuth-specific message for the oauth transport', () => {
    const errs = validateAddEndpointForm({
      transport: 'oauth',
      name: 'linear',
      command: '',
      url: '',
    });
    expect(errs).toEqual({ url: 'Server URL is required' });
  });

  it('flags `url` with the generic message for sse/http transports', () => {
    for (const t of ['sse', 'http'] as const) {
      const errs = validateAddEndpointForm({ transport: t, name: 'srv', command: '', url: '' });
      expect(errs).toEqual({ url: 'URL is required' });
    }
  });

  it('does not require a command for non-stdio transports', () => {
    const errs = validateAddEndpointForm({
      transport: 'sse',
      name: 'srv',
      command: '',
      url: 'http://localhost:3000/sse',
    });
    expect(errs).toEqual({});
  });

  it('returns an empty object for a fully valid stdio form', () => {
    const errs = validateAddEndpointForm({
      transport: 'stdio',
      name: 'echo',
      command: 'npx',
      url: '',
    });
    expect(errs).toEqual({});
  });

  it('treats whitespace-only inputs as missing for required fields', () => {
    const errs = validateAddEndpointForm({
      transport: 'oauth',
      name: '   \t  ',
      command: '',
      url: '   ',
    });
    expect(errs).toEqual({
      name: 'Name is required',
      url: 'Server URL is required',
    });
    // `command` only appears when explicitly set; ensure it isn't a real key.
    expect(Object.prototype.hasOwnProperty.call(errs, 'command')).toBe(false);
  });
});

describe('firstAddEndpointFieldError', () => {
  it('returns the empty string when the map is empty', () => {
    expect(firstAddEndpointFieldError({})).toBe('');
  });

  it('prefers `name` over `command` over `url`', () => {
    expect(
      firstAddEndpointFieldError({ name: 'a', command: 'b', url: 'c' }),
    ).toBe('a');
    expect(firstAddEndpointFieldError({ command: 'b', url: 'c' })).toBe('b');
    expect(firstAddEndpointFieldError({ url: 'c' })).toBe('c');
  });
});

describe('per-field clear-on-edit (mirror of clearFieldError)', () => {
  // Same contract as `clearFieldError` in AddEndpointModal.svelte: dropping a
  // single key from `fieldErrors` is what flips `aria-invalid` on the
  // matching input back to `false` while leaving the rest of the map intact.
  function clearFieldError(
    state: { fieldErrors: AddEndpointFieldErrors },
    field: keyof AddEndpointFieldErrors,
  ) {
    if (state.fieldErrors[field]) {
      const { [field]: _removed, ...rest } = state.fieldErrors;
      state.fieldErrors = rest;
    }
  }

  it('removes only the edited field and leaves the rest intact', () => {
    const state = {
      fieldErrors: {
        name: 'Name is required',
        command: 'Command is required for stdio',
      } as AddEndpointFieldErrors,
    };
    clearFieldError(state, 'name');
    expect(state.fieldErrors).toEqual({ command: 'Command is required for stdio' });
    expect(Object.prototype.hasOwnProperty.call(state.fieldErrors, 'name')).toBe(false);
  });

  it('is a no-op when the field was not flagged', () => {
    const state = {
      fieldErrors: { url: 'URL is required' } as AddEndpointFieldErrors,
    };
    const before = state.fieldErrors;
    clearFieldError(state, 'name');
    expect(state.fieldErrors).toBe(before);
  });

  it('clearing the only flagged field empties the map (aria-invalid → false)', () => {
    const state = { fieldErrors: { url: 'URL is required' } as AddEndpointFieldErrors };
    clearFieldError(state, 'url');
    expect(state.fieldErrors).toEqual({});
  });
});

// Slice D1 — `computeAddEndpointIsDirty` drives the "Discard changes?"
// prompt in AddEndpointModal. The snapshot is captured at the moment
// `step` transitions to `'configure'` (catalog pre-fills included), so
// the dirty check is purely a deep-equal of the snapshot vs the current
// editable fields. The tests below pin every comparison branch.
describe('computeAddEndpointIsDirty', () => {
  function makeSnapshot(overrides: Partial<AddEndpointFormSnapshot> = {}): AddEndpointFormSnapshot {
    return {
      name: '',
      command: '',
      args: '',
      url: '',
      prefixCustom: false,
      description: '',
      envVars: [],
      headerVars: [],
      catalogEnvValues: {},
      userArgValues: [],
      oauthServerUrl: '',
      clientId: '',
      clientSecret: '',
      scopes: '',
      orgBoundScopes: '',
      resourceClientId: '',
      resourceClientSecret: '',
      serverTypeOverride: '',
      isolationEnabled: true,
      mounts: [],
      ...overrides,
    };
  }

  it('returns false when current matches snapshot exactly', () => {
    const snap = makeSnapshot();
    expect(computeAddEndpointIsDirty(snap, makeSnapshot())).toBe(false);
  });

  it('returns false against a catalog-prefilled baseline that is unchanged', () => {
    // Mirrors the http GitHub catalog entry: URL prefilled, no command/args.
    const snap = makeSnapshot({
      name: 'GitHub',
      command: '',
      args: '',
      url: 'https://api.githubcopilot.com/mcp/',
      description: 'Code hosting and collaboration',
    });
    expect(computeAddEndpointIsDirty(snap, { ...snap })).toBe(false);
  });

  it('flags each top-level string field independently', () => {
    const snap = makeSnapshot();
    const cases: (keyof AddEndpointFormSnapshot)[] = [
      'name',
      'command',
      'args',
      'url',
      'description',
      'oauthServerUrl',
      'clientId',
      'clientSecret',
      'scopes',
      'orgBoundScopes',
      'resourceClientId',
      'resourceClientSecret',
      'serverTypeOverride',
    ];
    for (const key of cases) {
      const current = { ...snap, [key]: 'x' } as AddEndpointFormSnapshot;
      expect(computeAddEndpointIsDirty(snap, current)).toBe(true);
    }
  });

  it('flags prefixCustom toggling from false to true', () => {
    const snap = makeSnapshot();
    expect(computeAddEndpointIsDirty(snap, makeSnapshot({ prefixCustom: true }))).toBe(true);
  });

  it('flags envVars/headerVars when entries are added, even with empty key/value', () => {
    const snap = makeSnapshot();
    expect(
      computeAddEndpointIsDirty(snap, makeSnapshot({ envVars: [{ key: '', value: '' }] })),
    ).toBe(true);
    expect(
      computeAddEndpointIsDirty(snap, makeSnapshot({ headerVars: [{ key: '', value: '' }] })),
    ).toBe(true);
  });

  it('flags envVars/headerVars when an existing entry is edited', () => {
    const snap = makeSnapshot({ envVars: [{ key: 'TOKEN', value: '' }] });
    const current = makeSnapshot({ envVars: [{ key: 'TOKEN', value: 'ghp_123' }] });
    expect(computeAddEndpointIsDirty(snap, current)).toBe(true);
  });

  it('returns false when envVars match element-for-element', () => {
    const snap = makeSnapshot({
      envVars: [{ key: 'A', value: '1' }, { key: 'B', value: '2' }],
    });
    const current = makeSnapshot({
      envVars: [{ key: 'A', value: '1' }, { key: 'B', value: '2' }],
    });
    expect(computeAddEndpointIsDirty(snap, current)).toBe(false);
  });

  it('flags catalogEnvValues when the user fills a prefilled key', () => {
    // Catalog seeds the form with `catalogEnvValues: {}`; the GITHUB_TOKEN
    // input writes back into the same record via two-way binding.
    const snap = makeSnapshot();
    const current = makeSnapshot({ catalogEnvValues: { GITHUB_TOKEN: 'ghp_123' } });
    expect(computeAddEndpointIsDirty(snap, current)).toBe(true);
  });

  it('flags userArgValues when an entry is edited', () => {
    // Catalog seeds `userArgValues` with empty strings — one per declared
    // userArg slot — and the Browse… button writes the chosen path back.
    const snap = makeSnapshot({ userArgValues: ['', ''] });
    const current = makeSnapshot({ userArgValues: ['/tmp/path', ''] });
    expect(computeAddEndpointIsDirty(snap, current)).toBe(true);
  });

  it('returns false when userArgValues match element-for-element', () => {
    const snap = makeSnapshot({ userArgValues: ['/tmp', '/var'] });
    const current = makeSnapshot({ userArgValues: ['/tmp', '/var'] });
    expect(computeAddEndpointIsDirty(snap, current)).toBe(false);
  });

  it('flags userArgValues when the length differs', () => {
    const snap = makeSnapshot({ userArgValues: [''] });
    const current = makeSnapshot({ userArgValues: ['', ''] });
    expect(computeAddEndpointIsDirty(snap, current)).toBe(true);
  });

  it('flags the isolation toggle when flipped away from the snapshot', () => {
    const snap = makeSnapshot();
    expect(computeAddEndpointIsDirty(snap, makeSnapshot({ isolationEnabled: false }))).toBe(true);
    expect(computeAddEndpointIsDirty(snap, makeSnapshot({ isolationEnabled: true }))).toBe(false);
  });

  it('flags mount rows when added, edited, or removed', () => {
    const snap = makeSnapshot();
    expect(
      computeAddEndpointIsDirty(snap, makeSnapshot({ mounts: [{ host: '', container: '' }] })),
    ).toBe(true);
    const withMount = makeSnapshot({ mounts: [{ host: '/a', container: '/b' }] });
    expect(
      computeAddEndpointIsDirty(withMount, makeSnapshot({ mounts: [{ host: '/a', container: '/c' }] })),
    ).toBe(true);
    expect(computeAddEndpointIsDirty(withMount, makeSnapshot({ mounts: [] }))).toBe(true);
  });

  it('returns false when mount rows match element-for-element', () => {
    const snap = makeSnapshot({ mounts: [{ host: '/a', container: '/b' }] });
    const current = makeSnapshot({ mounts: [{ host: '/a', container: '/b' }] });
    expect(computeAddEndpointIsDirty(snap, current)).toBe(false);
  });
});

// Volume-mount editor helpers — parse stored `mounts: string[]` into rows,
// validate the two-input host/container pairs, and serialize back to the
// relay's `host:container` array form.
describe('mount row helpers', () => {
  it('parseMountRows splits each entry on its first colon and trims', () => {
    expect(parseMountRows(['~/.gmail-mcp:/home/node/.gmail-mcp'])).toEqual([
      { host: '~/.gmail-mcp', container: '/home/node/.gmail-mcp' },
    ]);
    expect(parseMountRows(['  /host  :  /container  '])).toEqual([
      { host: '/host', container: '/container' },
    ]);
  });

  it('parseMountRows yields a host-only row for an entry with no colon', () => {
    expect(parseMountRows(['/host-only'])).toEqual([{ host: '/host-only', container: '' }]);
  });

  it('parseMountRows treats only the first colon as the separator', () => {
    expect(parseMountRows(['/a:/b:/c'])).toEqual([{ host: '/a', container: '/b:/c' }]);
  });

  it('parseMountRows returns [] for undefined/empty input', () => {
    expect(parseMountRows(undefined)).toEqual([]);
    expect(parseMountRows([])).toEqual([]);
  });

  it('mountRowError accepts a valid pair and a fully-empty row', () => {
    expect(mountRowError({ host: '/a', container: '/b' })).toBeNull();
    expect(mountRowError({ host: '  ', container: '' })).toBeNull();
  });

  it('mountRowError flags a missing host or container', () => {
    expect(mountRowError({ host: '', container: '/b' })).toBe('Host path is required');
    expect(mountRowError({ host: '/a', container: '' })).toBe('Container path is required');
  });

  it('mountRowError rejects a colon inside either half', () => {
    expect(mountRowError({ host: '/a:/x', container: '/b' })).toBe('Paths must not contain ":"');
    expect(mountRowError({ host: '/a', container: '/b:ro' })).toBe('Paths must not contain ":"');
  });

  it('hasMountRowErrors is true when any row is malformed', () => {
    expect(hasMountRowErrors([{ host: '/a', container: '/b' }, { host: '', container: '' }])).toBe(false);
    expect(hasMountRowErrors([{ host: '/a', container: '' }])).toBe(true);
  });

  it('serializeMountRows trims, skips empty rows, and joins with a colon', () => {
    const rows: MountRow[] = [
      { host: '  /host  ', container: '  /container  ' },
      { host: '', container: '' },
      { host: '~/.gmail-mcp', container: '/home/node/.gmail-mcp' },
    ];
    expect(serializeMountRows(rows)).toEqual([
      '/host:/container',
      '~/.gmail-mcp:/home/node/.gmail-mcp',
    ]);
  });

  it('serializeMountRows round-trips through parseMountRows', () => {
    const serialized = ['~/.gmail-mcp:/home/node/.gmail-mcp', '/data:/srv/data'];
    expect(serializeMountRows(parseMountRows(serialized))).toEqual(serialized);
  });
});

// buildMountExample — the host side must be a valid absolute docker arg
// (docker rejects `~/...`); the container side is always the generic
// `/home/node/example`, and a failed home-dir lookup falls back to an
// absolute placeholder path.
describe('buildMountExample', () => {
  it('uses the resolved home directory on the host side', () => {
    expect(buildMountExample('/Users/alex')).toBe('/Users/alex/example:/home/node/example');
  });

  it('strips a trailing slash from the home directory', () => {
    expect(buildMountExample('/home/alex/')).toBe('/home/alex/example:/home/node/example');
  });

  it('falls back to an absolute placeholder when home is null/blank', () => {
    expect(buildMountExample(null)).toBe(`${MOUNT_EXAMPLE_FALLBACK_HOST}:/home/node/example`);
    expect(buildMountExample(undefined)).toBe(`${MOUNT_EXAMPLE_FALLBACK_HOST}:/home/node/example`);
    expect(buildMountExample('   ')).toBe(`${MOUNT_EXAMPLE_FALLBACK_HOST}:/home/node/example`);
  });

  it('never produces a `~`-prefixed or product-specific example', () => {
    const example = buildMountExample('/Users/alex');
    expect(example).not.toContain('~');
    expect(example.toLowerCase()).not.toContain('gmail');
    expect(MOUNT_EXAMPLE_FALLBACK_HOST.startsWith('/')).toBe(true);
  });
});

// Isolation defaults — stdio endpoints always send an explicit value
// ("container"/"none", never omitted) because the relay treats an absent
// field as direct spawn. Flagged catalog entries force "none".
describe('resolveIsolation', () => {
  it('returns "container" for stdio when containerizable and toggle is on (default)', () => {
    expect(resolveIsolation('stdio', true, true)).toBe('container');
  });

  it('returns "none" for stdio when the user turns the toggle off', () => {
    expect(resolveIsolation('stdio', true, false)).toBe('none');
  });

  it('returns "none" for flagged catalog entries regardless of the toggle', () => {
    expect(resolveIsolation('stdio', false, true)).toBe('none');
    expect(resolveIsolation('stdio', false, false)).toBe('none');
  });

  it('returns undefined for non-stdio transports', () => {
    for (const t of ['sse', 'http', 'oauth'] as const) {
      expect(resolveIsolation(t, true, true)).toBeUndefined();
      expect(resolveIsolation(t, false, false)).toBeUndefined();
    }
  });
});

// Config-tab seeding — maps the stored isolation value to the toggle state.
// Only an explicit "container" reads ON; "none"/empty/absent all mean direct
// spawn (the relay's default for an omitted field).
describe('isolationEnabledFromConfig', () => {
  it('returns true only for an explicit "container"', () => {
    expect(isolationEnabledFromConfig('container')).toBe(true);
  });

  it('returns false for "none"', () => {
    expect(isolationEnabledFromConfig('none')).toBe(false);
  });

  it('returns false for empty/absent values (direct-spawn default)', () => {
    expect(isolationEnabledFromConfig('')).toBe(false);
    expect(isolationEnabledFromConfig(undefined)).toBe(false);
  });

  it('returns false for unrecognized values', () => {
    expect(isolationEnabledFromConfig('CONTAINER')).toBe(false);
    expect(isolationEnabledFromConfig('docker')).toBe(false);
  });
});

describe('catalog containerizable flags', () => {
  it('exactly Filesystem, Puppeteer, and Memory are flagged not-containerizable', () => {
    const flagged = CATALOG_SERVERS.filter((s) => s.containerizable === false)
      .map((s) => s.id)
      .sort();
    expect(flagged).toEqual(['filesystem', 'memory', 'puppeteer']);
  });

  it('every flagged entry carries a non-empty containerNote reason', () => {
    for (const s of CATALOG_SERVERS) {
      if (s.containerizable === false) {
        expect(s.containerNote, `${s.id}: missing containerNote`).toBeTruthy();
        expect(s.containerNote!.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe('buildCatalogEnvAndHeaders', () => {
  const plainVar = { name: 'API_KEY', label: 'API Key', required: true, secret: true };
  const headerVar = {
    name: 'PAT',
    label: 'Personal Access Token',
    required: true,
    secret: true,
    header: { name: 'Authorization', valuePrefix: 'Bearer ' },
  };

  it('routes a header-typed var to headers with its prefix', () => {
    const out = buildCatalogEnvAndHeaders({ envVars: [headerVar] }, { PAT: 'ghp_abc' });
    expect(out.headers).toEqual({ Authorization: 'Bearer ghp_abc' });
    expect(out.env).toEqual({});
  });

  it('routes a plain var to env', () => {
    const out = buildCatalogEnvAndHeaders({ envVars: [plainVar] }, { API_KEY: 'k123' });
    expect(out.env).toEqual({ API_KEY: 'k123' });
    expect(out.headers).toEqual({});
  });

  it('trims values and skips empty ones', () => {
    const out = buildCatalogEnvAndHeaders(
      { envVars: [plainVar, headerVar] },
      { API_KEY: '  k123  ', PAT: '   ' },
    );
    expect(out.env).toEqual({ API_KEY: 'k123' });
    expect(out.headers).toEqual({});
  });

  it('skips vars with no entered value', () => {
    const out = buildCatalogEnvAndHeaders({ envVars: [plainVar, headerVar] }, {});
    expect(out).toEqual({ env: {}, headers: {} });
  });

  it('uses an empty prefix when valuePrefix is absent', () => {
    const out = buildCatalogEnvAndHeaders(
      { envVars: [{ ...headerVar, header: { name: 'X-Api-Key' } }] },
      { PAT: 'raw' },
    );
    expect(out.headers).toEqual({ 'X-Api-Key': 'raw' });
  });

  it('splits a mixed set into env and headers', () => {
    const out = buildCatalogEnvAndHeaders(
      { envVars: [plainVar, headerVar] },
      { API_KEY: 'k123', PAT: 'ghp_abc' },
    );
    expect(out).toEqual({
      env: { API_KEY: 'k123' },
      headers: { Authorization: 'Bearer ghp_abc' },
    });
  });

  it('maps the catalog GitHub entry PAT to an Authorization bearer header', () => {
    const github = CATALOG_SERVERS.find((s) => s.id === 'github')!;
    const out = buildCatalogEnvAndHeaders(github, { [github.envVars[0].name]: 'ghp_xyz' });
    expect(out).toEqual({ env: {}, headers: { Authorization: 'Bearer ghp_xyz' } });
  });

  it('produces no GITHUB_PERSONAL_ACCESS_TOKEN env var for the GitHub entry', () => {
    const github = CATALOG_SERVERS.find((s) => s.id === 'github')!;
    const out = buildCatalogEnvAndHeaders(github, { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_xyz' });
    expect(out.env).not.toHaveProperty('GITHUB_PERSONAL_ACCESS_TOKEN');
    expect(out.headers.Authorization).toBe('Bearer ghp_xyz');
  });
});

// The modal builds its env/headers from `buildCatalogEnvAndHeaders` in both
// the Test Connection (`buildConnectionParams`) and Add (`handleSubmit`)
// paths, so header-typed catalog vars (GitHub PAT) reach `params.headers`.
// Test environment is node (not jsdom), so the assertions are on the Svelte
// source — mirrors the static-source style used elsewhere in this suite.
describe('AddEndpointModal — catalog env/header wiring', () => {
  it('prefills the URL from the catalog entry in selectCatalog', () => {
    const selectCatalogBlock = addEndpointModalSource.match(
      /function selectCatalog\(server: CatalogServer\) \{[\s\S]*?step = 'configure';/,
    );
    expect(selectCatalogBlock, 'expected the selectCatalog body').not.toBeNull();
    expect(selectCatalogBlock![0]).toMatch(/url = server\.url \?\? '';/);
    expect(selectCatalogBlock![0]).toMatch(/command = server\.command \?\? '';/);
    expect(selectCatalogBlock![0]).toMatch(/args = \(server\.args \?\? \[\]\)\.join\(' '\);/);
  });

  it('routes catalog values through buildCatalogEnvAndHeaders in both Test Connection and Add', () => {
    const calls = addEndpointModalSource.match(
      /buildCatalogEnvAndHeaders\(selectedCatalog, catalogEnvValues\)/g,
    ) ?? [];
    expect(calls.length).toBe(2);
    // No inline catalog env loop remains — the helper is the single source of truth.
    expect(addEndpointModalSource).not.toMatch(/for \(const ev of selectedCatalog\.envVars\)/);
  });

  it('seeds env and headers from the helper output, with custom rows applied afterwards', () => {
    // Catalog-derived values seed the maps; the user's custom env/header rows
    // are spread in afterwards so a custom row wins on key collision.
    const envSeeds = addEndpointModalSource.match(
      /const env: Record<string, string> = \{ \.\.\.catalogValues\.env \};/g,
    ) ?? [];
    const headerSeeds = addEndpointModalSource.match(
      /const headers: Record<string, string> = \{ \.\.\.catalogValues\.headers \};/g,
    ) ?? [];
    expect(envSeeds.length).toBe(2);
    expect(headerSeeds.length).toBe(2);
    expect(addEndpointModalSource).toMatch(
      /const headers: Record<string, string> = \{ \.\.\.catalogValues\.headers \};[\s\S]*?headers\[h\.key\.trim\(\)\] = h\.value;/,
    );
  });

  it('keeps the container toggle and volume mounts gated on the stdio transport', () => {
    // http catalog entries (GitHub) must not show Command/Arguments or the
    // isolation controls; both live under the stdio branch.
    expect(addEndpointModalSource).toMatch(
      /\{#if transport === 'stdio'\}[\s\S]*?id="modal-ep-cmd"[\s\S]*?id="modal-ep-args"[\s\S]*?id="modal-ep-isolation"[\s\S]*?\{:else if transport === 'oauth'\}/,
    );
    expect(addEndpointModalSource).toMatch(
      /let showMounts = \$derived\(transport === 'stdio' && isolationEnabled && !catalogNotContainerizable\);/,
    );
  });

  it('still shows the API Key chip for the GitHub catalog entry', () => {
    const github = CATALOG_SERVERS.find((s) => s.id === 'github')!;
    expect(github.envVars.some((e) => e.required)).toBe(true);
    expect(addEndpointModalSource).toMatch(
      /\{#if server\.envVars\.some\(e => e\.required\)\}[\s\S]*?API Key/,
    );
  });
});

describe('orgBindingApplies', () => {
  // The relay only accepts EMA on http/oauth (watcher.rs:
  // "EMA endpoint requires transport http or oauth"), and
  // `buildOrgBoundEndpointParams` always emits an http EMA endpoint regardless
  // of the chosen transport — so the Organization selector is safe to surface
  // for both. sse carries no per-request headers (EMA can't inject Authorization)
  // and stdio has no remote auth surface at all, so both stay excluded.
  it('is true for the http and oauth transports', () => {
    expect(orgBindingApplies('http')).toBe(true);
    expect(orgBindingApplies('oauth')).toBe(true);
  });

  it('is false for sse and stdio', () => {
    for (const t of ['sse', 'stdio'] as const) {
      expect(orgBindingApplies(t)).toBe(false);
    }
  });
});

describe('buildOrgBoundEndpointParams', () => {
  it('returns null when no organization is selected (None)', () => {
    expect(
      buildOrgBoundEndpointParams('', { name: 'My Server', url: 'https://mcp.example.com/mcp' }),
    ).toBeNull();
  });

  it('returns null for a whitespace-only organization', () => {
    expect(
      buildOrgBoundEndpointParams('   ', { name: 'My Server', url: 'https://mcp.example.com/mcp' }),
    ).toBeNull();
  });

  it('builds an http endpoint with an auth.type="ema" block bound to the org', () => {
    const params = buildOrgBoundEndpointParams('Acme', {
      name: 'My Server',
      url: 'https://mcp.example.com/mcp',
    });
    expect(params).toEqual({
      name: 'My Server',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      auth: { type: 'ema', organization: 'Acme', resource: 'https://mcp.example.com/mcp' },
    });
  });

  it('uses the URL as the EMA resource and trims surrounding whitespace', () => {
    const params = buildOrgBoundEndpointParams('  Acme  ', {
      name: '  My Server  ',
      url: '  https://mcp.example.com/mcp  ',
    });
    expect(params?.auth).toEqual({
      type: 'ema',
      organization: 'Acme',
      resource: 'https://mcp.example.com/mcp',
    });
    expect(params?.name).toBe('My Server');
    expect(params?.url).toBe('https://mcp.example.com/mcp');
  });

  it('includes a trimmed description when provided and omits a blank one', () => {
    const withDesc = buildOrgBoundEndpointParams('Acme', {
      name: 'My Server',
      url: 'https://mcp.example.com/mcp',
      description: '  notes  ',
    });
    expect(withDesc?.description).toBe('notes');

    const blankDesc = buildOrgBoundEndpointParams('Acme', {
      name: 'My Server',
      url: 'https://mcp.example.com/mcp',
      description: '   ',
    });
    expect(blankDesc && 'description' in blankDesc).toBe(false);
  });

  // D3 — optional EMA scopes + resource pair (R3), settable at add-time.
  // `scopes` stays on the POST `/endpoints` body (config.toml); the resource
  // pair is stripped by `addEndpoint()` and POSTed to `/credentials` (DCR
  // file). Blank/whitespace input omits each field entirely.
  it('omits scopes / resource_client_id / resource_client_secret when no extras are supplied', () => {
    const params = buildOrgBoundEndpointParams('Acme', {
      name: 'My Server',
      url: 'https://mcp.example.com/mcp',
    });
    expect(params && 'scopes' in params).toBe(false);
    expect(params && 'resource_client_id' in params).toBe(false);
    expect(params && 'resource_client_secret' in params).toBe(false);
  });

  it('includes scopes / resource_client_id / resource_client_secret when non-empty (trimmed)', () => {
    const params = buildOrgBoundEndpointParams('Acme', {
      name: 'My Server',
      url: 'https://mcp.example.com/mcp',
      scopes: '  todos.read   mcp.access  ',
      resourceClientId: '  mas-client-abc  ',
      resourceClientSecret: '  super-secret  ',
    });
    expect(params?.scopes).toBe('todos.read mcp.access');
    expect(params?.resource_client_id).toBe('mas-client-abc');
    expect(params?.resource_client_secret).toBe('super-secret');
  });

  it('omits each extra field independently when blank or whitespace-only', () => {
    const params = buildOrgBoundEndpointParams('Acme', {
      name: 'My Server',
      url: 'https://mcp.example.com/mcp',
      scopes: '   ',
      resourceClientId: '',
      resourceClientSecret: '\t\n  ',
    });
    expect(params && 'scopes' in params).toBe(false);
    expect(params && 'resource_client_id' in params).toBe(false);
    expect(params && 'resource_client_secret' in params).toBe(false);
  });

  it('still returns null when no organization is selected, even with extras supplied', () => {
    expect(
      buildOrgBoundEndpointParams('', {
        name: 'My Server',
        url: 'https://mcp.example.com/mcp',
        scopes: 'todos.read',
        resourceClientId: 'mas-client-abc',
        resourceClientSecret: 'super-secret',
      }),
    ).toBeNull();
  });

  it('treats a partial extras set independently (scopes only, resource pair only)', () => {
    const scopesOnly = buildOrgBoundEndpointParams('Acme', {
      name: 'My Server',
      url: 'https://mcp.example.com/mcp',
      scopes: 'todos.read',
    });
    expect(scopesOnly?.scopes).toBe('todos.read');
    expect(scopesOnly && 'resource_client_id' in scopesOnly).toBe(false);
    expect(scopesOnly && 'resource_client_secret' in scopesOnly).toBe(false);

    const resourceOnly = buildOrgBoundEndpointParams('Acme', {
      name: 'My Server',
      url: 'https://mcp.example.com/mcp',
      resourceClientId: 'mas-client-abc',
      resourceClientSecret: 'super-secret',
    });
    expect(resourceOnly && 'scopes' in resourceOnly).toBe(false);
    expect(resourceOnly?.resource_client_id).toBe('mas-client-abc');
    expect(resourceOnly?.resource_client_secret).toBe('super-secret');
  });
});

// ── Test Connection suppression when org-bound ──
//
// When an org is selected, the EMA add-time path can't be exercised by a raw
// transport+url probe — the access token only exists once the org's IdP chain
// runs at add-time. Showing "Test Connection" would just return a misleading
// 401, so it's hidden and replaced with a short post-add verification note.
// Test environment is node (not jsdom), so the assertion is on the Svelte
// source — mirrors the static-source style used elsewhere in this suite.
describe('AddEndpointModal — Test Connection gating when org-bound', () => {
  it('gates the Test Connection block on `transport !== "oauth" && !orgBound`', () => {
    // The button only shows for non-oauth transports AND when no org is bound.
    // The combined guard is what restores today's behavior when org is "None"
    // (orgBound=false → the `!orgBound` branch passes → button visible).
    expect(addEndpointModalSource).toMatch(/\{#if transport !== 'oauth' && !orgBound\}/);
  });

  it('replaces Test Connection with a post-add verification note when org-bound', () => {
    // The `:else if orgBound` branch handles the http+orgBound case (oauth is
    // already excluded by the outer guard) and explains the test is unavailable
    // because verification happens via the org's shared credentials at add-time.
    const replacementBlock = addEndpointModalSource.match(
      /\{:else if orgBound\}[\s\S]*?Connection is verified via[\s\S]*?\{selectedOrganization\}[\s\S]*?after you add the server[\s\S]*?\{\/if\}/,
    );
    expect(replacementBlock, 'expected the org-bound replacement note for Test Connection').not.toBeNull();
  });

  it('renders the EMA outcome notice under an `{#if orgBound}` guard naming the selected org', () => {
    // Shared notice rendered right after the org selector for both http and
    // oauth selections, so the user sees the EMA endpoint outcome explicitly
    // before submitting.
    const noticeBlock = addEndpointModalSource.match(
      /\{#if orgBound\}[\s\S]*?organization-managed \(EMA\) endpoint[\s\S]*?\{selectedOrganization\}[\s\S]*?shared credentials instead of its own OAuth[\s\S]*?\{\/if\}/,
    );
    expect(noticeBlock, 'expected the EMA outcome notice block').not.toBeNull();
  });

  // D3/D4 — The optional EMA Scopes + Resource Client ID/Secret inputs live
  // inside the single consolidated Advanced <details>, gated on
  // `{#if orgBound}` so they only appear once an org is actually selected.
  // Each input is bound to its own local `$state` and threaded into
  // `buildOrgBoundEndpointParams` on submit.
  it('renders Scopes + Resource Client ID/Secret inputs guarded by `{#if orgBound}` inside the Advanced section', () => {
    expect(addEndpointModalSource).toMatch(/id="modal-ep-orgbound-scopes"[\s\S]*?bind:value=\{orgBoundScopes\}/);
    expect(addEndpointModalSource).toMatch(
      /id="modal-ep-orgbound-resource-client-id"[\s\S]*?bind:value=\{resourceClientId\}/,
    );
    expect(addEndpointModalSource).toMatch(
      /id="modal-ep-orgbound-resource-client-secret"[\s\S]*?type="password"[\s\S]*?bind:value=\{resourceClientSecret\}/,
    );
    // The EMA field group is nested inside the shared Advanced <details>
    // gated on `{#if orgBound || transport !== 'oauth'}`.
    expect(addEndpointModalSource).toMatch(
      /\{#if orgBound \|\| transport !== 'oauth'\}[\s\S]*?<summary[^>]*>\s*Advanced\s*<\/summary>[\s\S]*?\{#if orgBound\}[\s\S]*?id="modal-ep-orgbound-scopes"/,
    );
  });

  // D4 — After the org-bound EMA fields were folded into the pre-existing
  // Server-type-override Advanced <details>, the http/stdio branch of the
  // modal must have exactly ONE Advanced section, and the D3 duplicate
  // Advanced <details> that used to live directly inside `{#if orgBound}`
  // (sandwiching the URL/Env/Headers fields with a second Advanced summary)
  // must no longer exist. The remaining Advanced <summary> occurrences in
  // source are: (1) the per-server OAuth branch's Advanced (gated on
  // `transport === 'oauth'` + `{#if !orgBound}` — never renders in the
  // org-bound flow), and (2) the single consolidated Advanced gated on
  // `{#if orgBound || transport !== 'oauth'}` that this task establishes.
  it('no longer renders a duplicate Advanced <details> directly inside `{#if orgBound}` (D3 sandwich fix)', () => {
    // The D3 layout put a full `<details>...Advanced...</details>` block
    // directly under the `{#if orgBound}` guard, above the URL field. D4
    // moves those fields into the consolidated Advanced further down, so
    // no Advanced <summary> should appear between `{#if orgBound}` and the
    // closing `{/if}` that ends the org-bound guarded block.
    const orgBoundInnerBlock = addEndpointModalSource.match(
      /\{#if orgBound\}\s*<!--\s*EMA outcome notice[\s\S]*?\{\/if\}/,
    );
    expect(orgBoundInnerBlock, 'expected the org-bound EMA notice block').not.toBeNull();
    expect(orgBoundInnerBlock![0]).not.toMatch(/<summary[^>]*>\s*Advanced\s*<\/summary>/);
  });

  // D4 — Total Advanced <summary> occurrences in source are exactly 2:
  // the per-server OAuth branch's Advanced (mutually exclusive with the
  // org-bound branch via `{#if !orgBound}`) and the single consolidated
  // Advanced. No third one may exist.
  it('renders exactly two Advanced <summary> occurrences in source (per-server OAuth + consolidated)', () => {
    const matches = addEndpointModalSource.match(/<summary[^>]*>\s*Advanced\s*<\/summary>/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it('keeps per-server OAuth fields under a `{#if !orgBound}` guard on the oauth transport', () => {
    // The per-server OAuth fields (scopes, client ID/secret, etc.) are
    // unused on the EMA path, so they're hidden when an org is bound. The
    // outer oauth-transport branch wraps them in `{#if !orgBound}`.
    expect(addEndpointModalSource).toMatch(/\{#if !orgBound\}[\s\S]*?Per-server OAuth fields are dropped/);
  });

  it('routes the submit button to handleSubmit (EMA path) when org-bound, bypassing handleOAuthSubmit', () => {
    // Even on the oauth transport, an org-bound submit must go through
    // `handleSubmit` → `buildOrgBoundEndpointParams` → plain EMA add.
    expect(addEndpointModalSource).toMatch(
      /onclick=\{transport === 'oauth' && !orgBound \? handleOAuthSubmit : \(\) => handleSubmit\(\)\}/,
    );
  });
});



