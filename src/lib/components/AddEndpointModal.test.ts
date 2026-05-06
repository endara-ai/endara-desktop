import { describe, it, expect, vi } from 'vitest';
import { sanitizeName } from '$lib/utils';
import { CATALOG_SERVERS, type CatalogServer } from '$lib/catalog';
import { oauthCatalog, type OAuthCatalogEntry } from '$lib/data/oauth-catalog';
import { buildScopesPayload, shouldShowManualOAuthStar } from './add-endpoint-helpers';

describe('sanitizeName', () => {
  it('handles basic lowercase name', () => {
    expect(sanitizeName('echo-mcp')).toBe('echo-mcp');
  });

  it('converts spaces to underscores', () => {
    expect(sanitizeName('My MCP Server')).toBe('my_mcp_server');
  });

  it('strips special characters', () => {
    expect(sanitizeName('server@v2.0!')).toBe('serverv20');
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

  it('strips unicode characters', () => {
    expect(sanitizeName('café')).toBe('caf');
    expect(sanitizeName('日本語')).toBe('');
  });

  it('handles mixed input', () => {
    expect(sanitizeName('My Server - v2.0 (beta)')).toBe('my_server_-_v20_beta');
  });

  it('preserves hyphens and underscores', () => {
    expect(sanitizeName('my-server_name')).toBe('my-server_name');
  });

  it('preserves digits', () => {
    expect(sanitizeName('server123')).toBe('server123');
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



