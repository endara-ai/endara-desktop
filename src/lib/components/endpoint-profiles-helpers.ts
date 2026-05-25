import type { ProfileSummary, UpdateProfileParams } from '$lib/api';

/**
 * One row in the per-endpoint Profiles sub-tab checklist (Engineering Spec
 * §9.4). Each row maps one profile to whether the currently-viewed endpoint
 * is a member of it.
 */
export interface EndpointProfileRow {
  name: string;
  path: string;
  member: boolean;
}

/**
 * Build the checklist rows shown in the per-endpoint Profiles sub-tab. The
 * rows preserve `allProfiles` order; membership comes from the dedicated
 * `GET /api/endpoints/{name}/profiles` response so we don't have to scan every
 * profile's `endpoints` array client-side.
 */
export function buildEndpointProfileRows(
  allProfiles: ReadonlyArray<ProfileSummary>,
  memberPaths: ReadonlyArray<string>,
): EndpointProfileRow[] {
  const memberSet = new Set(memberPaths);
  return allProfiles.map((p) => ({
    name: p.name,
    path: p.path,
    member: memberSet.has(p.path),
  }));
}

/**
 * Compute the new `endpoints` list for a profile after toggling membership of
 * `endpointName`. When `nextMember` is true we add the endpoint if absent;
 * when false we remove every occurrence. Order is preserved on add (append)
 * and on remove (filter), matching the existing convention used by the
 * Profiles detail editor.
 */
export function toggleEndpointInProfile(
  profile: Pick<ProfileSummary, 'endpoints'>,
  endpointName: string,
  nextMember: boolean,
): string[] {
  const current = profile.endpoints;
  if (nextMember) {
    return current.includes(endpointName) ? [...current] : [...current, endpointName];
  }
  return current.filter((n) => n !== endpointName);
}

/**
 * Build the `PUT /api/profiles/{path}` payload for a membership toggle. All
 * profile-level fields are preserved verbatim; only the `endpoints` list is
 * recomputed via {@link toggleEndpointInProfile}.
 */
export function buildToggleUpdatePayload(
  profile: ProfileSummary,
  endpointName: string,
  nextMember: boolean,
): UpdateProfileParams {
  return {
    name: profile.name,
    path: profile.path,
    endpoints: toggleEndpointInProfile(profile, endpointName, nextMember),
    js_execution: profile.js_execution,
    toon_output: profile.toon_output,
  };
}
