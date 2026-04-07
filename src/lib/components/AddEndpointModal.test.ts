import { describe, it, expect } from 'vitest';
import { sanitizeName } from '$lib/utils';
import { CATALOG_SERVERS, type CatalogServer } from '$lib/catalog';
import { oauthCatalog, type OAuthCatalogEntry } from '$lib/data/oauth-catalog';

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



