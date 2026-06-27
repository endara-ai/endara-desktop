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
