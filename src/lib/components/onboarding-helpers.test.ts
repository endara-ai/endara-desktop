import { describe, it, expect, vi } from 'vitest';
import type { Endpoint, IdpProvider, Organization, OrgProbeResult } from '$lib/types';
import {
  isCustomProvider,
  providerNeedsSlug,
  buildIssuerPreview,
  buildCreateOrgParams,
  emaCandidates,
  emaCandidateResources,
  buildOnboardingCandidates,
  partitionProbeResults,
  defaultSelectedResources,
  isAlreadyInstalled,
  buildEmaEndpointParams,
  buildSelectedEmaEndpoints,
  addEndpointsWithRefresh,
  orgStatusLabel,
  startOrgConnection,
  reauthenticateOrg,
  pollForOrgAuth,
  unauthenticatedOrgs,
  orgExpiryBannerMessage,
} from './onboarding-helpers';
import type { AddEndpointParams } from '$lib/api';

const okta: IdpProvider = {
  id: 'okta',
  name: 'Okta',
  issuer_pattern: 'https://{slug}.okta.com',
  slug_hint: 'Your Okta org subdomain',
};
const entra: IdpProvider = {
  id: 'entra',
  name: 'Microsoft Entra ID',
  issuer_pattern: 'https://login.microsoftonline.com/{slug}/v2.0',
  slug_hint: 'Your Entra tenant ID',
};
const google: IdpProvider = {
  id: 'google',
  name: 'Google Workspace',
  issuer_pattern: 'https://accounts.google.com',
};
const custom: IdpProvider = { id: 'custom', name: 'Custom' };

// ---------------------------------------------------------------------------
// Provider picker — issuer build (M6/M8)
// ---------------------------------------------------------------------------

describe('provider classification', () => {
  it('treats a provider with no issuer_pattern as custom', () => {
    expect(isCustomProvider(custom)).toBe(true);
    expect(isCustomProvider(okta)).toBe(false);
    expect(isCustomProvider(google)).toBe(false);
  });

  it('needs a slug only when the issuer pattern has a {slug} placeholder', () => {
    expect(providerNeedsSlug(okta)).toBe(true);
    expect(providerNeedsSlug(entra)).toBe(true);
    expect(providerNeedsSlug(google)).toBe(false);
    expect(providerNeedsSlug(custom)).toBe(false);
  });
});

describe('buildIssuerPreview', () => {
  it('substitutes {slug} for templated providers', () => {
    expect(buildIssuerPreview(okta, 'acme')).toBe('https://acme.okta.com');
    expect(buildIssuerPreview(entra, 'contoso.onmicrosoft.com')).toBe(
      'https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0',
    );
  });

  it('trims the slug before substitution', () => {
    expect(buildIssuerPreview(okta, '  acme  ')).toBe('https://acme.okta.com');
  });

  it('returns the fixed pattern unchanged for placeholder-free providers', () => {
    expect(buildIssuerPreview(google, '')).toBe('https://accounts.google.com');
  });

  it('returns empty string for custom providers', () => {
    expect(buildIssuerPreview(custom, 'https://id.example.com')).toBe('');
  });
});

describe('buildCreateOrgParams', () => {
  it('sends slug for slug-templated providers', () => {
    expect(buildCreateOrgParams(okta, 'Acme Corp', 'acme')).toEqual({
      name: 'Acme Corp',
      provider: 'okta',
      slug: 'acme',
    });
  });

  it('omits slug for placeholder-free providers (Google)', () => {
    expect(buildCreateOrgParams(google, 'Acme', 'ignored')).toEqual({
      name: 'Acme',
      provider: 'google',
    });
  });

  it('sends the raw issuer URL as idp for custom providers', () => {
    expect(buildCreateOrgParams(custom, 'Acme', 'https://id.example.com')).toEqual({
      name: 'Acme',
      provider: 'custom',
      idp: 'https://id.example.com',
    });
  });

  it('trims name and value', () => {
    expect(buildCreateOrgParams(okta, '  Acme  ', '  acme  ')).toEqual({
      name: 'Acme',
      provider: 'okta',
      slug: 'acme',
    });
  });

  it('includes a trimmed client_id when provided', () => {
    expect(buildCreateOrgParams(okta, 'Acme', 'acme', '  abc123  ')).toEqual({
      name: 'Acme',
      provider: 'okta',
      slug: 'acme',
      client_id: 'abc123',
    });
  });

  it('omits client_id when blank or whitespace-only', () => {
    expect(buildCreateOrgParams(okta, 'Acme', 'acme', '   ')).toEqual({
      name: 'Acme',
      provider: 'okta',
      slug: 'acme',
    });
    expect(buildCreateOrgParams(okta, 'Acme', 'acme')).toEqual({
      name: 'Acme',
      provider: 'okta',
      slug: 'acme',
    });
  });

  it('includes client_id for custom providers alongside idp', () => {
    expect(
      buildCreateOrgParams(custom, 'Acme', 'https://id.example.com', 'abc123'),
    ).toEqual({
      name: 'Acme',
      provider: 'custom',
      idp: 'https://id.example.com',
      client_id: 'abc123',
    });
  });

  it('includes a trimmed client_secret when provided', () => {
    expect(buildCreateOrgParams(okta, 'Acme', 'acme', 'abc123', '  s3cret  ')).toEqual({
      name: 'Acme',
      provider: 'okta',
      slug: 'acme',
      client_id: 'abc123',
      client_secret: 's3cret',
    });
  });

  it('omits client_secret when blank or whitespace-only', () => {
    expect(buildCreateOrgParams(okta, 'Acme', 'acme', 'abc123', '   ')).toEqual({
      name: 'Acme',
      provider: 'okta',
      slug: 'acme',
      client_id: 'abc123',
    });
    expect(buildCreateOrgParams(okta, 'Acme', 'acme', 'abc123')).toEqual({
      name: 'Acme',
      provider: 'okta',
      slug: 'acme',
      client_id: 'abc123',
    });
  });

  it('allows a client_secret without a client_id (confidential public-client edge case)', () => {
    expect(buildCreateOrgParams(custom, 'Acme', 'https://id.example.com', '', 's3cret')).toEqual({
      name: 'Acme',
      provider: 'custom',
      idp: 'https://id.example.com',
      client_secret: 's3cret',
    });
  });

  it('omits client creds when blank or whitespace-only', () => {
    expect(buildCreateOrgParams(okta, 'Acme', 'acme', '   ', '   ')).toEqual({
      name: 'Acme',
      provider: 'okta',
      slug: 'acme',
    });
    expect(buildCreateOrgParams(okta, 'Acme', 'acme')).toEqual({
      name: 'Acme',
      provider: 'okta',
      slug: 'acme',
    });
  });
});

// ---------------------------------------------------------------------------
// Probe candidates (D2)
// ---------------------------------------------------------------------------

describe('emaCandidates / emaCandidateResources', () => {
  it('returns only ema_supported catalog entries', () => {
    const cands = emaCandidates();
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.every((c) => c.ema_supported === true)).toBe(true);
    const ids = cands.map((c) => c.id);
    expect(ids).toContain('linear');
    expect(ids).toContain('asana');
    // Non-EMA entries are excluded.
    expect(ids).not.toContain('notion');
    expect(ids).not.toContain('github');
  });

  it('maps candidates to their resource URLs', () => {
    const resources = emaCandidateResources();
    expect(resources.length).toBe(emaCandidates().length);
    expect(resources).toContain('https://mcp.linear.app/mcp');
  });
});

// ---------------------------------------------------------------------------
// Review & select (M8 / D4)
// ---------------------------------------------------------------------------

const results: OrgProbeResult[] = [
  { resource: 'https://mcp.linear.app/mcp', status: 'accessible', server_as_issuer: 'https://linear.app' },
  { resource: 'https://mcp.asana.com/v2/mcp', status: 'accessible' },
  { resource: 'https://mcp.slack.com/mcp', status: 'denied' },
  { resource: 'https://mcp.figma.com/mcp', status: 'unreachable' },
];

describe('partitionProbeResults', () => {
  it('splits results by status', () => {
    const p = partitionProbeResults(results);
    expect(p.accessible.map((r) => r.resource)).toEqual([
      'https://mcp.linear.app/mcp',
      'https://mcp.asana.com/v2/mcp',
    ]);
    expect(p.denied.map((r) => r.resource)).toEqual(['https://mcp.slack.com/mcp']);
    expect(p.unreachable.map((r) => r.resource)).toEqual(['https://mcp.figma.com/mcp']);
  });
});

describe('buildOnboardingCandidates', () => {
  it('pairs each result with its catalog entry by resource URL', () => {
    const cands = buildOnboardingCandidates(results);
    const linear = cands.find((c) => c.result.resource === 'https://mcp.linear.app/mcp');
    expect(linear?.entry?.name).toBe('Linear');
  });

  it('keeps entry null for resources not in the catalog', () => {
    const cands = buildOnboardingCandidates([
      { resource: 'https://unknown.example.com/mcp', status: 'accessible' },
    ]);
    expect(cands[0].entry).toBeNull();
  });
});

describe('defaultSelectedResources', () => {
  it('checks accessible resources only by default', () => {
    const sel = defaultSelectedResources(results);
    expect(sel.has('https://mcp.linear.app/mcp')).toBe(true);
    expect(sel.has('https://mcp.asana.com/v2/mcp')).toBe(true);
    expect(sel.has('https://mcp.slack.com/mcp')).toBe(false);
    expect(sel.has('https://mcp.figma.com/mcp')).toBe(false);
    expect(sel.size).toBe(2);
  });

  it('excludes resources already installed for the org (re-detect)', () => {
    const sel = defaultSelectedResources(results, 'Acme Corp', [installedLinear]);
    expect(sel.has('https://mcp.linear.app/mcp')).toBe(false);
    expect(sel.has('https://mcp.asana.com/v2/mcp')).toBe(true);
    expect(sel.size).toBe(1);
  });

  it('does not exclude when the installed endpoint belongs to another org', () => {
    const sel = defaultSelectedResources(results, 'Other Corp', [installedLinear]);
    expect(sel.has('https://mcp.linear.app/mcp')).toBe(true);
    expect(sel.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Already-installed predicate (Wave 13 — grey out + de-dupe re-detect)
// ---------------------------------------------------------------------------

const installedLinear: Endpoint = {
  name: 'Linear',
  transport: 'http',
  health: 'healthy',
  tool_count: 0,
  last_activity: null,
  disabled: false,
  auth: { type: 'ema', organization: 'Acme Corp', resource: 'https://mcp.linear.app/mcp' },
};

describe('isAlreadyInstalled', () => {
  const linearCandidate = buildOnboardingCandidates(results).find(
    (c) => c.result.resource === 'https://mcp.linear.app/mcp',
  )!;
  const asanaCandidate = buildOnboardingCandidates(results).find(
    (c) => c.result.resource === 'https://mcp.asana.com/v2/mcp',
  )!;

  it('matches on (resource, organization) from the endpoint auth binding', () => {
    expect(isAlreadyInstalled(linearCandidate, 'Acme Corp', [installedLinear])).toBe(true);
  });

  it('does not match when the organization differs', () => {
    expect(isAlreadyInstalled(linearCandidate, 'Other Corp', [installedLinear])).toBe(false);
  });

  it('does not match a different resource in the same org', () => {
    expect(isAlreadyInstalled(asanaCandidate, 'Acme Corp', [installedLinear])).toBe(false);
  });

  it('ignores non-EMA endpoints and an empty org name', () => {
    const plain: Endpoint = {
      name: 'plain',
      transport: 'http',
      health: 'healthy',
      tool_count: 0,
      last_activity: null,
      disabled: false,
    };
    expect(isAlreadyInstalled(linearCandidate, 'Acme Corp', [plain])).toBe(false);
    expect(isAlreadyInstalled(linearCandidate, '', [installedLinear])).toBe(false);
  });
});

describe('buildEmaEndpointParams', () => {
  it('builds a plain http endpoint with the ema auth block', () => {
    const cands = buildOnboardingCandidates(results);
    const linear = cands.find((c) => c.result.resource === 'https://mcp.linear.app/mcp')!;
    expect(buildEmaEndpointParams('Acme Corp', linear.entry, linear.result)).toEqual({
      name: 'Linear',
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
      description: 'Issue tracking and project management',
      auth: { type: 'ema', organization: 'Acme Corp', resource: 'https://mcp.linear.app/mcp' },
    });
  });

  it('falls back to the resource URL as the name when no catalog entry', () => {
    const result: OrgProbeResult = { resource: 'https://x.example.com/mcp', status: 'accessible' };
    const params = buildEmaEndpointParams('Acme', null, result);
    expect(params.name).toBe('https://x.example.com/mcp');
    expect(params.auth).toEqual({ type: 'ema', organization: 'Acme', resource: 'https://x.example.com/mcp' });
  });
});

describe('buildSelectedEmaEndpoints', () => {
  it('builds params only for checked accessible candidates', () => {
    const cands = buildOnboardingCandidates(results);
    const selected = new Set(['https://mcp.linear.app/mcp']);
    const built = buildSelectedEmaEndpoints('Acme Corp', cands, selected);
    expect(built).toHaveLength(1);
    expect(built[0].name).toBe('Linear');
  });

  it('never adds a denied or unreachable resource even if it is in the selection', () => {
    const cands = buildOnboardingCandidates(results);
    // Maliciously/erroneously select every resource, including denied + unreachable.
    const selected = new Set(results.map((r) => r.resource));
    const built = buildSelectedEmaEndpoints('Acme Corp', cands, selected);
    const builtResources = built.map((b) => b.url);
    expect(builtResources).toEqual([
      'https://mcp.linear.app/mcp',
      'https://mcp.asana.com/v2/mcp',
    ]);
    expect(builtResources).not.toContain('https://mcp.slack.com/mcp');
    expect(builtResources).not.toContain('https://mcp.figma.com/mcp');
  });

  it('returns an empty list when nothing accessible is selected', () => {
    const cands = buildOnboardingCandidates(results);
    expect(buildSelectedEmaEndpoints('Acme', cands, new Set())).toEqual([]);
  });

  it('excludes candidates already installed for the org', () => {
    const cands = buildOnboardingCandidates(results);
    const selected = new Set([
      'https://mcp.linear.app/mcp',
      'https://mcp.asana.com/v2/mcp',
    ]);
    const built = buildSelectedEmaEndpoints('Acme Corp', cands, selected, [installedLinear]);
    expect(built.map((b) => b.url)).toEqual(['https://mcp.asana.com/v2/mcp']);
  });
});

// ---------------------------------------------------------------------------
// Org management (M7)
// ---------------------------------------------------------------------------

describe('orgStatusLabel', () => {
  it('labels authenticated and unauthenticated orgs', () => {
    const base: Organization = { name: 'Acme', provider: 'okta', idp: 'https://acme.okta.com', authenticated: true };
    expect(orgStatusLabel(base)).toBe('Connected');
    expect(orgStatusLabel({ ...base, authenticated: false })).toBe('Sign-in required');
  });
});

describe('startOrgConnection', () => {
  it('creates the org then opens the returned SSO URL', async () => {
    const sso = {
      name: 'Acme',
      provider: 'okta',
      idp: 'https://acme.okta.com',
      authorize_url: 'https://acme.okta.com/authorize?x=1',
    };
    const createOrganization = vi.fn().mockResolvedValue(sso);
    const openUrl = vi.fn().mockResolvedValue(undefined);

    const params = { name: 'Acme', provider: 'okta', slug: 'acme' };
    const res = await startOrgConnection(params, { createOrganization, openUrl });

    expect(createOrganization).toHaveBeenCalledWith(params);
    expect(openUrl).toHaveBeenCalledWith('https://acme.okta.com/authorize?x=1');
    expect(res).toEqual(sso);
  });

  it('does not open a URL when org creation fails', async () => {
    const createOrganization = vi.fn().mockRejectedValue(new Error('boom'));
    const openUrl = vi.fn().mockResolvedValue(undefined);
    await expect(
      startOrgConnection({ name: 'Acme', provider: 'okta', slug: 'acme' }, { createOrganization, openUrl }),
    ).rejects.toThrow('boom');
    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe('reauthenticateOrg', () => {
  it('asks the relay for a fresh SSO URL and opens it', async () => {
    const sso = {
      name: 'Acme',
      provider: 'custom',
      idp: 'https://id.example.com',
      authorize_url: 'https://id.example.com/authorize?y=2',
    };
    const reauthenticateOrganization = vi.fn().mockResolvedValue(sso);
    const openUrl = vi.fn().mockResolvedValue(undefined);

    const res = await reauthenticateOrg('Acme', { reauthenticateOrganization, openUrl });

    expect(reauthenticateOrganization).toHaveBeenCalledWith('Acme');
    expect(openUrl).toHaveBeenCalledWith('https://id.example.com/authorize?y=2');
    expect(res).toEqual(sso);
  });
});

// ---------------------------------------------------------------------------
// pollForOrgAuth — shared by ConnectOrgModal and OrganizationsSection so both
// initial-connect and Settings re-authenticate flip the row from "Sign-in
// required" to "Connected" on the same cadence.
// ---------------------------------------------------------------------------

const orgRow = (name: string, authenticated: boolean): Organization => ({
  name,
  provider: 'okta',
  idp: 'okta',
  authenticated,
});

describe('pollForOrgAuth', () => {
  it('resolves once the org flips to authenticated', async () => {
    const listOrganizations = vi
      .fn()
      .mockResolvedValueOnce([orgRow('Acme', false)])
      .mockResolvedValueOnce([orgRow('Acme', false)])
      .mockResolvedValueOnce([orgRow('Acme', true)]);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const outcome = await pollForOrgAuth(
      'Acme',
      { listOrganizations },
      { intervalMs: 10, timeoutMs: 1000, sleep },
    );

    expect(outcome).toEqual({ status: 'authenticated' });
    expect(listOrganizations).toHaveBeenCalledTimes(3);
    // Sleep runs once per poll iteration before the list call.
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it('keeps polling through transient list failures', async () => {
    const listOrganizations = vi
      .fn()
      .mockRejectedValueOnce(new Error('relay hiccup'))
      .mockResolvedValueOnce([orgRow('Acme', true)]);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const outcome = await pollForOrgAuth(
      'Acme',
      { listOrganizations },
      { intervalMs: 1, timeoutMs: 100, sleep },
    );

    expect(outcome).toEqual({ status: 'authenticated' });
    expect(listOrganizations).toHaveBeenCalledTimes(2);
  });

  it('returns cancelled without touching the relay when aborted before the first list call', async () => {
    const listOrganizations = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);

    const outcome = await pollForOrgAuth(
      'Acme',
      { listOrganizations },
      { intervalMs: 1, timeoutMs: 100, sleep, shouldCancel: () => true },
    );

    expect(outcome).toEqual({ status: 'cancelled' });
    expect(listOrganizations).not.toHaveBeenCalled();
  });

  it('returns cancelled mid-poll and stops issuing list calls', async () => {
    let cancelled = false;
    const listOrganizations = vi
      .fn()
      .mockImplementationOnce(async () => {
        cancelled = true;
        return [orgRow('Acme', false)];
      })
      .mockImplementation(async () => [orgRow('Acme', false)]);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const outcome = await pollForOrgAuth(
      'Acme',
      { listOrganizations },
      { intervalMs: 1, timeoutMs: 1000, sleep, shouldCancel: () => cancelled },
    );

    expect(outcome).toEqual({ status: 'cancelled' });
    // First iteration issued the list call that flipped the cancel flag;
    // the second iteration bails at the pre-list cancel check.
    expect(listOrganizations).toHaveBeenCalledTimes(1);
  });

  it('times out when the org never reports authenticated', async () => {
    const listOrganizations = vi.fn().mockResolvedValue([orgRow('Acme', false)]);
    let now = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      now += ms;
    });

    const outcome = await pollForOrgAuth(
      'Acme',
      { listOrganizations },
      { intervalMs: 50, timeoutMs: 100, sleep },
    );

    expect(outcome).toEqual({ status: 'timeout' });
    // Loop budget covers two iterations (50 + 50 = 100), then deadline fails.
    expect(listOrganizations).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Wiring (source-level, mirroring the `?raw` convention in Settings.test.ts)
// ---------------------------------------------------------------------------

describe('AddEndpointModal launches the org onboarding flow', () => {
  it('imports and renders ConnectOrgModal from the add-server surface', async () => {
    const source = (await import('./AddEndpointModal.svelte?raw')).default;
    expect(source).toMatch(/import\s+ConnectOrgModal\s+from\s+['"]\.\/ConnectOrgModal\.svelte['"]/);
    expect(source).toContain('showConnectOrg = true');
    expect(source).toMatch(/<ConnectOrgModal\s+onclose=/);
  });
});

describe('Settings embeds the organizations management section', () => {
  it('imports and renders OrganizationsSection', async () => {
    const source = (await import('./Settings.svelte?raw')).default;
    expect(source).toMatch(
      /import\s+OrganizationsSection\s+from\s+['"]\.\/OrganizationsSection\.svelte['"]/,
    );
    expect(source).toContain('<OrganizationsSection />');
  });
});

describe('OrganizationsSection wires list / re-auth / remove', () => {
  it('uses the org lifecycle API + helpers', async () => {
    const source = (await import('./OrganizationsSection.svelte?raw')).default;
    expect(source).toMatch(/refreshOrganizations/);
    expect(source).toMatch(/deleteOrganization/);
    expect(source).toMatch(/reauthenticateOrg\(/);
    expect(source).toContain('orgStatusLabel');
  });
});

describe('OrganizationsSection polls for auth after re-authenticate', () => {
  it('kicks off pollForOrgAuth and cancels stale polls on unmount / repeat click', async () => {
    const source = (await import('./OrganizationsSection.svelte?raw')).default;
    // Uses the shared helper (not a copy-pasted loop) so the initial-connect
    // and Settings re-auth flows stay in lockstep.
    expect(source).toMatch(/pollForOrgAuth\(/);
    expect(source).toMatch(/listOrganizations/);
    // Per-row `busy` clears once the browser opens; poll continues in the
    // background inside a `void (async () => ...)` block.
    expect(source).toMatch(/void\s*\(async\s*\(\)\s*=>/);
    // Cancellation plumbing: repeat click cancels the prior poll, and
    // `onDestroy` cancels every outstanding poll so no timers leak.
    expect(source).toMatch(/onDestroy/);
    expect(source).toMatch(/activeReauthPolls/);
    expect(source).toMatch(/cancelReauthPoll/);
    expect(source).toMatch(/shouldCancel:/);
  });
});

describe('ConnectOrgModal reuses the shared poll-for-auth helper', () => {
  it('delegates pollForAuth to pollForOrgAuth so both flows share cadence + cancel', async () => {
    const source = (await import('./ConnectOrgModal.svelte?raw')).default;
    expect(source).toMatch(/pollForOrgAuth\(/);
    // Cancellation is threaded via `shouldCancel` — the raw setTimeout loop
    // that used to live here is gone.
    expect(source).toMatch(/shouldCancel:\s*\(\)\s*=>\s*pollCancelled/);
    expect(source).not.toMatch(/setTimeout\(r,\s*2000\)/);
  });
});

describe('OrganizationsSection offers per-org re-detect', () => {
  it('renders ConnectOrgModal in re-detect mode, gated on sign-in', async () => {
    const source = (await import('./OrganizationsSection.svelte?raw')).default;
    expect(source).toMatch(
      /import\s+ConnectOrgModal\s+from\s+['"]\.\/ConnectOrgModal\.svelte['"]/,
    );
    expect(source).toContain('Detect servers');
    expect(source).toContain('redetectOrg');
    // The action is disabled until the org is signed in.
    expect(source).toMatch(/!org\.authenticated/);
  });
});

describe('ConnectOrgModal supports re-detect + already-installed greying', () => {
  it('reads the redetect prop, probes immediately, and marks installed servers', async () => {
    const source = (await import('./ConnectOrgModal.svelte?raw')).default;
    expect(source).toContain('redetectOrg');
    expect(source).toContain('runProbe(redetectOrg)');
    expect(source).toContain('isAlreadyInstalled');
    expect(source).toContain('Already added');
  });
});

describe('ConnectOrgModal exposes a Client Secret field', () => {
  it('binds a clientSecret state to a password input and threads it through buildCreateOrgParams', async () => {
    const source = (await import('./ConnectOrgModal.svelte?raw')).default;
    expect(source).toMatch(/let\s+clientSecret\s*=\s*\$state\(/);
    expect(source).toContain('id="org-client-secret"');
    expect(source).toMatch(/type="password"/);
    expect(source).toMatch(
      /buildCreateOrgParams\(\s*selectedProvider\s*,\s*name\s*,\s*slugOrUrl\s*,\s*clientId\s*,\s*clientSecret\s*,?\s*\)/,
    );
  });
});

describe('ConnectOrgModal no longer exposes resource credential fields', () => {
  it('moved the resource (Step-3 MAS) credential to the per-endpoint Config tab (R3)', async () => {
    const source = (await import('./ConnectOrgModal.svelte?raw')).default;
    expect(source).not.toContain('id="org-resource-client-id"');
    expect(source).not.toContain('id="org-resource-client-secret"');
  });
});

describe('ConfigTab exposes per-endpoint EMA resource credential fields', () => {
  it('binds resource client id/secret for EMA endpoints and persists via updateEndpoint', async () => {
    const source = (await import('./ConfigTab.svelte?raw')).default;
    // Fields live under the EMA-binding section, gated on showEmaBinding.
    expect(source).toContain('id="config-ep-resource-client-id"');
    expect(source).toContain('id="config-ep-resource-client-secret"');
    expect(source).toMatch(/let\s+resourceClientId\s*=\s*\$state\(/);
    expect(source).toMatch(/let\s+resourceClientSecret\s*=\s*\$state\(/);
    // Write-only secret with an explicit clear toggle (absent-vs-empty merge).
    expect(source).toContain('clearResourceSecret');
    expect(source).toMatch(/params\.resource_client_secret\s*=\s*''/);
    expect(source).toMatch(/params\.resource_client_id\s*=/);
  });
});

describe('OrganizationsSection offers per-org Edit', () => {
  it('renders an Edit button that opens EditOrganizationModal', async () => {
    const source = (await import('./OrganizationsSection.svelte?raw')).default;
    expect(source).toMatch(
      /import\s+EditOrganizationModal\s+from\s+['"]\.\/EditOrganizationModal\.svelte['"]/,
    );
    expect(source).toContain('editingOrg');
    expect(source).toMatch(/>\s*Edit\s*<\/button>/);
    expect(source).toMatch(/<EditOrganizationModal[\s\S]*org=\{editingOrg\}/);
  });
});

describe('EditOrganizationModal uses the update API + reauth fork', () => {
  it('calls updateOrganization and opens authorize_url when identity changed', async () => {
    const source = (await import('./EditOrganizationModal.svelte?raw')).default;
    expect(source).toMatch(/updateOrganization\(/);
    expect(source).toMatch(/updateRequiresReauth\(/);
    // Client secret field never shows the stored secret back to the user.
    expect(source).toContain('id="edit-org-client-secret"');
    expect(source).toMatch(/type="password"/);
    // The "clear" toggles send an explicit empty string (per relay contract).
    expect(source).toContain('clearSecret');
    expect(source).toContain('clearClientId');
    expect(source).toMatch(/refreshOrganizations\(/);
    // R3 moved the resource (Step-3 MAS) credential fields off the org modal to
    // the per-endpoint Config tab — they must no longer appear here.
    expect(source).not.toContain('id="edit-org-resource-client-id"');
    expect(source).not.toContain('id="edit-org-resource-client-secret"');
  });
});

describe('addEndpointsWithRefresh', () => {
  const params = (name: string): AddEndpointParams => ({ name, transport: 'http', url: `https://${name}.example.com/mcp` });

  it('adds every endpoint then refreshes the store on full success', async () => {
    const added: string[] = [];
    const setEndpoints = vi.fn();
    const getEndpoints = vi.fn().mockResolvedValue([]);

    await addEndpointsWithRefresh([params('a'), params('b')], {
      addEndpoint: async (p) => { added.push(p.name); },
      getEndpoints,
      setEndpoints,
    });

    expect(added).toEqual(['a', 'b']);
    expect(getEndpoints).toHaveBeenCalledTimes(1);
    expect(setEndpoints).toHaveBeenCalledTimes(1);
  });

  it('refreshes the store even when an add throws partway, and re-throws the original error', async () => {
    const added: string[] = [];
    const setEndpoints = vi.fn();
    // The relay would already hold the first add; the refresh must reflect it.
    const getEndpoints = vi.fn().mockResolvedValue([{ name: 'a' }]);

    await expect(
      addEndpointsWithRefresh([params('a'), params('b'), params('c')], {
        addEndpoint: async (p) => {
          if (p.name === 'b') throw new Error('add failed');
          added.push(p.name);
        },
        getEndpoints,
        setEndpoints,
      }),
    ).rejects.toThrow('add failed');

    expect(added).toEqual(['a']);
    expect(getEndpoints).toHaveBeenCalledTimes(1);
    expect(setEndpoints).toHaveBeenCalledTimes(1);
    expect(setEndpoints).toHaveBeenCalledWith([{ name: 'a' }]);
  });

  it('does not let a refresh failure mask the original add error', async () => {
    const setEndpoints = vi.fn();
    const getEndpoints = vi.fn().mockRejectedValue(new Error('refresh down'));

    await expect(
      addEndpointsWithRefresh([params('a')], {
        addEndpoint: async () => { throw new Error('add failed'); },
        getEndpoints,
        setEndpoints,
      }),
    ).rejects.toThrow('add failed');

    expect(getEndpoints).toHaveBeenCalledTimes(1);
    expect(setEndpoints).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Wave 20 — Org-expiry banner derive logic
// ---------------------------------------------------------------------------

describe('unauthenticatedOrgs / orgExpiryBannerMessage (banner derive)', () => {
  const mk = (name: string, authenticated: boolean): Organization => ({
    name,
    provider: 'okta',
    idp: 'okta',
    authenticated,
  });

  it('filters to only orgs with authenticated === false', () => {
    const list = [mk('acme', true), mk('beta-co', false), mk('gamma', true), mk('delta', false)];
    expect(unauthenticatedOrgs(list).map((o) => o.name)).toEqual(['beta-co', 'delta']);
  });

  it('returns null when there are zero orgs (banner hidden)', () => {
    expect(orgExpiryBannerMessage([])).toBeNull();
  });

  it('returns null when every org is authenticated (banner hidden)', () => {
    expect(orgExpiryBannerMessage([mk('acme', true), mk('gamma', true)])).toBeNull();
  });

  it('names the org for a single unauthenticated org', () => {
    expect(orgExpiryBannerMessage([mk('acme', true), mk('beta-co', false)])).toBe(
      'Sign-in required for beta-co',
    );
  });

  it('counts unauthenticated orgs when more than one need re-auth', () => {
    const msg = orgExpiryBannerMessage([
      mk('acme', true),
      mk('beta-co', false),
      mk('delta', false),
      mk('eps', false),
    ]);
    expect(msg).toBe('3 organizations need re-authentication');
  });
});
