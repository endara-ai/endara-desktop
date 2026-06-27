import { oauthCatalog, type OAuthCatalogEntry } from '$lib/data/oauth-catalog';
import type { AddEndpointParams, CreateOrganizationParams, EmaAuthConfig } from '$lib/api';
import type {
  Endpoint,
  IdpProvider,
  Organization,
  OrganizationSsoResponse,
  OrgProbeResult,
} from '$lib/types';

// ---------------------------------------------------------------------------
// Provider picker — issuer build (M6/M8)
// ---------------------------------------------------------------------------

/**
 * A provider is "custom" (raw issuer paste) when it ships no `issuer_pattern`.
 * Mirrors the relay's `custom` template (`issuer_pattern: None`).
 */
export function isCustomProvider(provider: IdpProvider): boolean {
  return !provider.issuer_pattern;
}

/**
 * Templated providers that embed a `{slug}` placeholder need a single
 * slug/tenant/env-id field (Okta, Entra, Ping). Providers with a fixed issuer
 * and no placeholder (Google) need no field, and `custom` takes a raw URL
 * instead (see {@link isCustomProvider}).
 */
export function providerNeedsSlug(provider: IdpProvider): boolean {
  return !!provider.issuer_pattern && provider.issuer_pattern.includes('{slug}');
}

/**
 * Preview the issuer the relay will build from a templated provider + slug, by
 * substituting `{slug}`. Returns the fixed pattern unchanged for placeholder-
 * free providers (Google), and `''` for custom providers (the user supplies the
 * issuer directly). This is a display-only convenience — the relay performs the
 * authoritative build + RFC 8414 validation on `POST /api/organizations`.
 */
export function buildIssuerPreview(provider: IdpProvider, slug: string): string {
  const pattern = provider.issuer_pattern;
  if (!pattern) return '';
  return pattern.replace('{slug}', slug.trim());
}

/**
 * Build the `POST /api/organizations` request body from a picked provider, the
 * org display name, and the single slug/url field. Custom providers send the
 * raw issuer as `idp`; templated providers send `slug` (omitted when the
 * provider needs none, e.g. Google). An optional pre-registered `client_id`
 * (required for Okta/Entra) is trimmed and only included when non-empty;
 * leaving it blank takes the CIMD/DCR path.
 */
export function buildCreateOrgParams(
  provider: IdpProvider,
  name: string,
  slugOrUrl: string,
  clientId = '',
): CreateOrganizationParams {
  const trimmedName = name.trim();
  const trimmedValue = slugOrUrl.trim();
  const trimmedClientId = clientId.trim();
  let params: CreateOrganizationParams;
  if (isCustomProvider(provider)) {
    params = { name: trimmedName, provider: provider.id, idp: trimmedValue };
  } else {
    params = { name: trimmedName, provider: provider.id };
    if (providerNeedsSlug(provider)) {
      params.slug = trimmedValue;
    }
  }
  if (trimmedClientId) {
    params.client_id = trimmedClientId;
  }
  return params;
}

// ---------------------------------------------------------------------------
// Probe candidates (D2 — desktop supplies the candidate resources)
// ---------------------------------------------------------------------------

/** The EMA-capable catalog entries sent to the probe + shown in onboarding. */
export function emaCandidates(): OAuthCatalogEntry[] {
  return oauthCatalog.filter((e) => e.ema_supported === true);
}

/** The candidate resource URLs (`POST /api/organizations/{org}/probe` body). */
export function emaCandidateResources(): string[] {
  return emaCandidates().map((e) => e.url);
}

// ---------------------------------------------------------------------------
// Review & select (M8 / D4 — review, add only checked accessible)
// ---------------------------------------------------------------------------

/** A probe result paired with its catalog entry (null when not in the catalog). */
export interface OnboardingCandidate {
  entry: OAuthCatalogEntry | null;
  result: OrgProbeResult;
}

/**
 * Pair each probe result with its catalog entry (matched by resource URL) so
 * the review step can render a friendly name/icon. Results with no matching
 * catalog entry keep `entry: null`.
 */
export function buildOnboardingCandidates(
  results: OrgProbeResult[],
  candidates: OAuthCatalogEntry[] = emaCandidates(),
): OnboardingCandidate[] {
  return results.map((result) => ({
    entry: candidates.find((c) => c.url === result.resource) ?? null,
    result,
  }));
}

/** Split probe results by status for the review step's three sections. */
export function partitionProbeResults(results: OrgProbeResult[]): {
  accessible: OrgProbeResult[];
  denied: OrgProbeResult[];
  unreachable: OrgProbeResult[];
} {
  return {
    accessible: results.filter((r) => r.status === 'accessible'),
    denied: results.filter((r) => r.status === 'denied'),
    unreachable: results.filter((r) => r.status === 'unreachable'),
  };
}

/**
 * True when an org-bound EMA endpoint already exists for this candidate's
 * `(resource, organization)` pair among the current endpoints. Reads the
 * Wave 12 `auth` binding surfaced on the endpoints listing (NOT local TOML), so
 * the review step can grey out servers already added to this organization.
 */
export function isAlreadyInstalled(
  candidate: OnboardingCandidate,
  orgName: string,
  endpoints: Endpoint[],
): boolean {
  if (!orgName) return false;
  return endpoints.some(
    (ep) =>
      ep.auth?.type === 'ema' &&
      ep.auth.organization === orgName &&
      ep.auth.resource === candidate.result.resource,
  );
}

/**
 * Resources checked by default in the review step — accessible only (D4), minus
 * any already installed for `orgName` (so re-detect never re-checks a server
 * that is already bound to this organization).
 */
export function defaultSelectedResources(
  results: OrgProbeResult[],
  orgName = '',
  endpoints: Endpoint[] = [],
): Set<string> {
  return new Set(
    results
      .filter((r) => r.status === 'accessible')
      .filter((r) => !isAlreadyInstalled({ entry: null, result: r }, orgName, endpoints))
      .map((r) => r.resource),
  );
}

/**
 * Build the EMA endpoint create-params for a single accessible resource. The
 * endpoint is a plain `http` transport carrying an `auth.type="ema"` block that
 * binds it to the org; the catalog display name is reused as the endpoint name
 * (falling back to the resource URL).
 */
export function buildEmaEndpointParams(
  orgName: string,
  entry: OAuthCatalogEntry | null,
  result: OrgProbeResult,
): AddEndpointParams {
  const auth: EmaAuthConfig = {
    type: 'ema',
    organization: orgName,
    resource: result.resource,
  };
  return {
    name: entry?.name ?? result.resource,
    transport: 'http',
    url: result.resource,
    description: entry?.description,
    auth,
  };
}

/**
 * Build the create-params for every checked, **accessible** candidate. Denied /
 * unreachable results are always excluded even if their resource somehow ends
 * up in `selected`, enforcing "add only checked accessible servers" (D4).
 * Candidates already installed for `orgName` (matching the Wave 12 `auth`
 * binding in `endpoints`) are also excluded so re-detect never re-adds them.
 */
export function buildSelectedEmaEndpoints(
  orgName: string,
  candidates: OnboardingCandidate[],
  selected: Set<string>,
  endpoints: Endpoint[] = [],
): AddEndpointParams[] {
  return candidates
    .filter((c) => c.result.status === 'accessible' && selected.has(c.result.resource))
    .filter((c) => !isAlreadyInstalled(c, orgName, endpoints))
    .map((c) => buildEmaEndpointParams(orgName, c.entry, c.result));
}

export interface AddEndpointsWithRefreshDeps {
  addEndpoint: (params: AddEndpointParams) => Promise<void>;
  getEndpoints: () => Promise<Endpoint[]>;
  setEndpoints: (list: Endpoint[]) => void;
}

/**
 * Adds each endpoint in sequence, then refreshes the shared endpoints list.
 *
 * The refresh runs in a `finally` so that endpoints already created before a
 * mid-loop failure are still reflected in the store — otherwise a retry from
 * the same modal could attempt duplicates or show stale 'Already added'. A
 * refresh failure is swallowed (the page poll reconciles the list) so it can
 * never mask the original add error, which is re-thrown for the caller.
 */
export async function addEndpointsWithRefresh(
  toCreate: AddEndpointParams[],
  deps: AddEndpointsWithRefreshDeps,
): Promise<void> {
  try {
    for (const params of toCreate) {
      await deps.addEndpoint(params);
    }
  } finally {
    try {
      deps.setEndpoints(await deps.getEndpoints());
    } catch {
      // refresh failed; the page poll reconciles the list
    }
  }
}

// ---------------------------------------------------------------------------
// Org management — list status (M7)
// ---------------------------------------------------------------------------

/** Human-readable auth-status label for an org row in the management list. */
export function orgStatusLabel(org: Organization): string {
  return org.authenticated ? 'Connected' : 'Sign-in required';
}

// ---------------------------------------------------------------------------
// SSO actions (deps-injected for testability — mirrors oauth/actions.ts)
// ---------------------------------------------------------------------------

export interface StartOrgConnectionDeps {
  createOrganization: (params: CreateOrganizationParams) => Promise<OrganizationSsoResponse>;
  openUrl: (url: string) => Promise<void>;
}

/**
 * Create an org and open the returned IdP SSO authorize URL in the browser.
 * Returns the relay's SSO response so the caller can advance the flow.
 */
export async function startOrgConnection(
  params: CreateOrganizationParams,
  deps: StartOrgConnectionDeps,
): Promise<OrganizationSsoResponse> {
  const res = await deps.createOrganization(params);
  await deps.openUrl(res.authorize_url);
  return res;
}

export interface ReauthenticateOrgDeps {
  reauthenticateOrganization: (name: string) => Promise<OrganizationSsoResponse>;
  openUrl: (url: string) => Promise<void>;
}

/**
 * Re-run an org's IdP sign-in: ask the relay for a fresh SSO URL and open it.
 */
export async function reauthenticateOrg(
  name: string,
  deps: ReauthenticateOrgDeps,
): Promise<OrganizationSsoResponse> {
  const res = await deps.reauthenticateOrganization(name);
  await deps.openUrl(res.authorize_url);
  return res;
}
