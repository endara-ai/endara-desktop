import { describe, it, expect } from 'vitest';
import { CATALOG_SERVERS } from './catalog';

// Use import.meta.env or a try/catch to avoid direct `process` reference
// which fails svelte-check (no @types/node in this project)
let RUN_LIVE_TESTS = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RUN_LIVE_TESTS = !!(globalThis as any).process?.env?.RUN_LIVE_TESTS;
} catch {
  // not in Node
}

// --- Fast tests (no network, always run) ---

describe('CATALOG_SERVERS validation', () => {
  it('all entries have required fields', () => {
    for (const entry of CATALOG_SERVERS) {
      expect(entry.id, `entry missing id`).toBeTruthy();
      expect(entry.name, `${entry.id}: missing name`).toBeTruthy();
      expect(entry.description, `${entry.id}: missing description`).toBeTruthy();
      expect(entry.icon, `${entry.id}: missing icon`).toBeTruthy();
    }
  });

  it('stdio entries have a command and a non-empty args array', () => {
    for (const entry of CATALOG_SERVERS.filter((e) => e.transport === 'stdio')) {
      expect(entry.command, `${entry.id}: missing command`).toBeTruthy();
      expect(entry.args, `${entry.id}: args should be an array`).toBeInstanceOf(Array);
      expect(entry.args!.length, `${entry.id}: args should not be empty`).toBeGreaterThan(0);
    }
  });

  it('stdio entries declare no header-targeted config vars', () => {
    // `CatalogEnvVar.header` is only meaningful for http/sse; a header-typed
    // var on a stdio entry would be silently dropped (stdio sends no headers).
    for (const entry of CATALOG_SERVERS.filter((e) => e.transport === 'stdio')) {
      for (const ev of entry.envVars) {
        expect(ev.header, `${entry.id}: ${ev.name} declares a header target on a stdio entry`).toBeUndefined();
      }
    }
  });

  it('http/sse entries have a non-empty url', () => {
    for (const entry of CATALOG_SERVERS.filter((e) => e.transport !== 'stdio')) {
      expect(entry.url, `${entry.id}: missing url`).toBeTruthy();
      expect(entry.url!.trim().length, `${entry.id}: url should not be blank`).toBeGreaterThan(0);
    }
  });

  it('no entry references the deprecated stdio GitHub server', () => {
    for (const entry of CATALOG_SERVERS) {
      expect(entry.args ?? [], `${entry.id}: references @modelcontextprotocol/server-github`).not.toContain(
        '@modelcontextprotocol/server-github'
      );
    }
  });

  it('GitHub entry is the remote HTTP server with a bearer-header PAT', () => {
    const github = CATALOG_SERVERS.find((e) => e.id === 'github');
    expect(github).toBeDefined();
    expect(github!.transport).toBe('http');
    expect(github!.url).toBe('https://api.githubcopilot.com/mcp/');
    expect(github!.command).toBeUndefined();
    expect(github!.args).toBeUndefined();
    expect(github!.envVars).toHaveLength(1);
    const pat = github!.envVars[0];
    expect(pat.label).toBe('Personal Access Token');
    expect(pat.required).toBe(true);
    expect(pat.secret).toBe(true);
    expect(pat.helpUrl).toBe('https://github.com/settings/tokens');
    expect(pat.header).toEqual({ name: 'Authorization', valuePrefix: 'Bearer ' });
  });

  it('no duplicate IDs', () => {
    const ids = CATALOG_SERVERS.map((e) => e.id);
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
    // Show which IDs are duplicated if the test fails
    if (ids.length !== unique.size) {
      const seen = new Set<string>();
      for (const id of ids) {
        if (seen.has(id)) {
          throw new Error(`Duplicate catalog ID: ${id}`);
        }
        seen.add(id);
      }
    }
  });

  it('all entries have valid transport', () => {
    const validTransports = ['stdio', 'sse', 'http'];
    for (const entry of CATALOG_SERVERS) {
      expect(
        validTransports,
        `${entry.id}: invalid transport '${entry.transport}'`
      ).toContain(entry.transport);
    }
  });

});

// --- Slow tests (network, run on demand with RUN_LIVE_TESTS=1) ---

const RUN_LIVE = RUN_LIVE_TESTS;

const npxEntries = CATALOG_SERVERS.filter((e) => e.command === 'npx');
const uvxEntries = CATALOG_SERVERS.filter((e) => e.command === 'uvx');

// Extract npm package name from args (the argument after '-y')
function extractNpmPackage(args: string[]): string | null {
  const yIdx = args.indexOf('-y');
  if (yIdx >= 0 && yIdx + 1 < args.length) {
    return args[yIdx + 1];
  }
  return null;
}

// Extract PyPI package name from args (first arg for uvx)
function extractPypiPackage(args: string[]): string | null {
  return args.length > 0 ? args[0] : null;
}

// Collect all helpUrls from envVars
function collectHelpUrls(): { id: string; url: string }[] {
  const urls: { id: string; url: string }[] = [];
  for (const entry of CATALOG_SERVERS) {
    for (const envVar of entry.envVars) {
      if (envVar.helpUrl) {
        urls.push({ id: entry.id, url: envVar.helpUrl });
      }
    }
  }
  return urls;
}

describe.skipIf(!RUN_LIVE)('live package validation', () => {
  it.each(npxEntries.map((e) => [e.id, extractNpmPackage(e.args ?? [])]))(
    'npm package for %s (%s) exists',
    async (_id, pkg) => {
      expect(pkg).toBeTruthy();
      const resp = await fetch(`https://registry.npmjs.org/${pkg}`);
      expect(resp.status, `npm package ${pkg} not found`).toBe(200);
    },
    15_000
  );

  it.each(uvxEntries.map((e) => [e.id, extractPypiPackage(e.args ?? [])]))(
    'pypi package for %s (%s) exists',
    async (_id, pkg) => {
      expect(pkg).toBeTruthy();
      const resp = await fetch(`https://pypi.org/pypi/${pkg}/json`);
      expect(resp.status, `PyPI package ${pkg} not found`).toBe(200);
    },
    15_000
  );

  const helpUrls = collectHelpUrls();
  if (helpUrls.length > 0) {
    it.each(helpUrls.map((h) => [h.id, h.url]))(
      'help URL for %s (%s) is reachable',
      async (_id, url) => {
        const resp = await fetch(url, { redirect: 'manual' });
        const status = resp.status;
        expect(
          status < 400 || status === 403,
          `Help URL ${url} returned ${status}`
        ).toBe(true);
      },
      15_000
    );
  }
});

