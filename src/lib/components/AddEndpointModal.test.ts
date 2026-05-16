import { describe, it, expect, vi } from 'vitest';
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
  type AddEndpointFieldErrors,
  type AddEndpointFormSnapshot,
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
      serverTypeOverride: '',
      ...overrides,
    };
  }

  it('returns false when current matches snapshot exactly', () => {
    const snap = makeSnapshot();
    expect(computeAddEndpointIsDirty(snap, makeSnapshot())).toBe(false);
  });

  it('returns false against a catalog-prefilled baseline that is unchanged', () => {
    const snap = makeSnapshot({
      name: 'GitHub',
      command: 'npx',
      args: '-y @modelcontextprotocol/server-github',
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
});



