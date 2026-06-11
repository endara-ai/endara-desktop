import { describe, it, expect } from 'vitest';
import { oauthCatalog, type OAuthCatalogEntry } from './oauth-catalog';

// Use a try/catch to avoid direct `process` reference which fails
// svelte-check (no @types/node in this project)
let RUN_LIVE_TESTS = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RUN_LIVE_TESTS = !!(globalThis as any).process?.env?.RUN_LIVE_TESTS;
} catch {
  // not in Node
}

const LIVE_TIMEOUT = 20_000;

// Mirrors the redirect_uri the relay registers and sends:
// `http://127.0.0.1:{relay_port}/oauth/callback` (management.rs).
const REDIRECT_URI = 'http://127.0.0.1:9400/oauth/callback';

// client_id used to build authorize URLs for entries where DCR is unavailable.
const PLACEHOLDER_CLIENT_ID = 'endara-ci-placeholder';

/** Protected Resource Metadata per RFC 9728 (fields we assert on). */
interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
}

/** Authorization Server Metadata per RFC 8414 (fields we assert on). */
interface AuthorizationServerMetadata {
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
}

// --- Well-known URL helpers mirroring packages/relay/src/oauth/discovery.rs ---

/** RFC 5785/8414 well-known URL: `.well-known` inserted between host and path. */
function buildWellKnownUrl(baseUrl: string, suffix: string): string {
  const parsed = new URL(baseUrl);
  const path = parsed.pathname.replace(/^\/+|\/+$/g, '');
  return path
    ? `${parsed.origin}/.well-known/${suffix}/${path}`
    : `${parsed.origin}/.well-known/${suffix}`;
}

/** Root-only well-known URL (no path suffix), used as the 404 fallback. */
function buildWellKnownUrlRoot(baseUrl: string, suffix: string): string {
  return `${new URL(baseUrl).origin}/.well-known/${suffix}`;
}

function hasPath(baseUrl: string): boolean {
  return new URL(baseUrl).pathname.replace(/^\/+|\/+$/g, '') !== '';
}

/**
 * Fetch a well-known document with the relay's fallback order: path-based
 * URL first, then root-only URL when the path-based one 404s and the base
 * URL has a path component. discovery.rs implements no other fallback
 * (no openid-configuration probe), so neither does this helper.
 */
async function fetchWellKnown<T>(baseUrl: string, suffix: string): Promise<T> {
  const pathUrl = buildWellKnownUrl(baseUrl, suffix);
  let resp = await fetch(pathUrl, { headers: { accept: 'application/json' } });
  if (resp.status === 404 && hasPath(baseUrl)) {
    const rootUrl = buildWellKnownUrlRoot(baseUrl, suffix);
    resp = await fetch(rootUrl, { headers: { accept: 'application/json' } });
  }
  expect(
    resp.ok,
    `${suffix} metadata fetch for ${baseUrl} returned ${resp.status}`
  ).toBe(true);
  return (await resp.json()) as T;
}

// --- PKCE helpers mirroring packages/relay/src/oauth/mod.rs ---

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** BASE64URL(SHA256(verifier)) from a 32-byte random verifier (S256). */
async function generatePkceChallenge(): Promise<string> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64UrlEncode(verifierBytes);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** 22-char URL-safe base64 state from 16 random bytes. */
function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

// --- Authorize URL construction mirroring management.rs ---

/** Mirrors `url::form_urlencoded::byte_serialize` (space → '+', `*-._` kept). */
function formUrlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = '';
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9*\-._]/.test(c)) out += c;
    else if (c === ' ') out += '+';
    else out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

function buildAuthorizeUrl(
  authorizationEndpoint: string,
  clientId: string,
  state: string,
  codeChallenge: string,
  scopes: string[]
): string {
  let url =
    `${authorizationEndpoint}?response_type=code` +
    `&client_id=${formUrlEncode(clientId)}` +
    `&redirect_uri=${formUrlEncode(REDIRECT_URI)}` +
    `&state=${formUrlEncode(state)}` +
    `&code_challenge=${formUrlEncode(codeChallenge)}` +
    `&code_challenge_method=S256`;
  if (scopes.length > 0) {
    url += `&scope=${formUrlEncode(scopes.join(' '))}`;
  }
  return url;
}

/** Build the authorize URL as the relay does and assert it is well-formed. */
async function assertAuthorizeUrl(
  entry: OAuthCatalogEntry,
  authorizationEndpoint: string,
  clientId: string
): Promise<void> {
  const state = generateState();
  const codeChallenge = await generatePkceChallenge();
  const authorizeUrl = buildAuthorizeUrl(
    authorizationEndpoint,
    clientId,
    state,
    codeChallenge,
    entry.defaultScopes
  );

  const parsed = new URL(authorizeUrl);
  expect(parsed.protocol, `${entry.id}: authorize URL must be https`).toBe('https:');
  expect(
    authorizeUrl.startsWith(`${authorizationEndpoint}?`),
    `${entry.id}: authorize URL must be rooted at the authorization endpoint`
  ).toBe(true);
  const params = parsed.searchParams;
  expect(params.get('response_type'), `${entry.id}: response_type`).toBe('code');
  expect(params.get('client_id'), `${entry.id}: client_id`).toBe(clientId);
  expect(params.get('redirect_uri'), `${entry.id}: redirect_uri`).toBe(REDIRECT_URI);
  expect(params.get('state'), `${entry.id}: state`).toBe(state);
  expect(params.get('code_challenge'), `${entry.id}: code_challenge`).toBe(codeChallenge);
  expect(params.get('code_challenge_method'), `${entry.id}: code_challenge_method`).toBe('S256');
  if (entry.defaultScopes.length > 0) {
    expect(params.get('scope'), `${entry.id}: scope`).toBe(entry.defaultScopes.join(' '));
  } else {
    expect(
      params.has('scope'),
      `${entry.id}: scope must be omitted when defaultScopes is empty`
    ).toBe(false);
  }
}

// --- Dynamic Client Registration mirroring packages/relay/src/oauth/dcr.rs ---

async function registerClient(
  entry: OAuthCatalogEntry,
  registrationEndpoint: string
): Promise<string> {
  const resp = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: `Endara Relay — ${entry.name}`,
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  expect(
    resp.ok,
    `${entry.id}: DCR at ${registrationEndpoint} returned ${resp.status}`
  ).toBe(true);
  const body = (await resp.json()) as { client_id?: string };
  expect(
    body.client_id,
    `${entry.id}: DCR response must contain a non-empty client_id`
  ).toBeTruthy();
  return body.client_id as string;
}

// --- Live tests (network, run on demand with RUN_LIVE_TESTS=1) ---

const discoveryEntries = oauthCatalog.filter((e) => e.supportsDiscovery);
const nonDiscoveryEntries = oauthCatalog.filter((e) => !e.supportsDiscovery);

describe.skipIf(!RUN_LIVE_TESTS)('live OAuth catalog validation', () => {
  it.each(discoveryEntries.map((e) => [e.id, e] as [string, OAuthCatalogEntry]))(
    'discovery entry %s validates end-to-end',
    async (_id, entry) => {
      // 1. RFC 9728 protected resource metadata (path → root fallback)
      const resourceMeta = await fetchWellKnown<ProtectedResourceMetadata>(
        entry.url,
        'oauth-protected-resource'
      );
      expect(resourceMeta.resource, `${entry.id}: missing resource`).toBeTruthy();
      const authServerUrl = resourceMeta.authorization_servers?.[0];
      expect(authServerUrl, `${entry.id}: missing authorization_servers[0]`).toBeTruthy();

      // 2. RFC 8414 authorization server metadata (path → root fallback)
      const asMeta = await fetchWellKnown<AuthorizationServerMetadata>(
        authServerUrl!,
        'oauth-authorization-server'
      );
      expect(asMeta.authorization_endpoint, `${entry.id}: missing authorization_endpoint`).toBeTruthy();
      expect(asMeta.token_endpoint, `${entry.id}: missing token_endpoint`).toBeTruthy();
      const methods = asMeta.code_challenge_methods_supported ?? [];
      if (methods.length > 0) {
        expect(methods, `${entry.id}: S256 PKCE must be supported`).toContain('S256');
      }
      expect(
        !!asMeta.registration_endpoint,
        `${entry.id}: registration_endpoint presence must match supportsDcr=${entry.supportsDcr}`
      ).toBe(entry.supportsDcr);

      // 3. Real DCR when supported
      let clientId = PLACEHOLDER_CLIENT_ID;
      if (entry.supportsDcr) {
        clientId = await registerClient(entry, asMeta.registration_endpoint!);
      }

      // 4. Authorize URL exactly as the relay builds it
      await assertAuthorizeUrl(entry, asMeta.authorization_endpoint!, clientId);
    },
    LIVE_TIMEOUT
  );

  it.each(nonDiscoveryEntries.map((e) => [e.id, e] as [string, OAuthCatalogEntry]))(
    'non-discovery entry %s validates end-to-end',
    async (_id, entry) => {
      // Convention-based endpoints (management.rs fallback path):
      // `{oauth_server_url}/authorize` + the catalog's explicit tokenEndpoint.
      expect(
        entry.oauthServerUrl,
        `${entry.id}: non-discovery entry must set oauthServerUrl`
      ).toBeTruthy();
      expect(
        entry.tokenEndpoint,
        `${entry.id}: non-discovery entry must set tokenEndpoint`
      ).toBeTruthy();
      const authorizationEndpoint = `${entry.oauthServerUrl!.replace(/\/+$/g, '')}/authorize`;

      const authResp = await fetch(authorizationEndpoint, { redirect: 'manual' });
      expect(
        authResp.status,
        `${entry.id}: authorize endpoint ${authorizationEndpoint} returned ${authResp.status}`
      ).not.toBe(404);
      expect(
        authResp.status,
        `${entry.id}: authorize endpoint ${authorizationEndpoint} returned ${authResp.status}`
      ).toBeLessThan(500);

      const tokenResp = await fetch(entry.tokenEndpoint!, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
      });
      expect(
        tokenResp.status,
        `${entry.id}: token endpoint ${entry.tokenEndpoint} returned ${tokenResp.status}`
      ).toBeLessThan(500);

      await assertAuthorizeUrl(entry, authorizationEndpoint, PLACEHOLDER_CLIENT_ID);
    },
    LIVE_TIMEOUT
  );
});
