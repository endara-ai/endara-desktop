import type { CreateProfileParams } from '$lib/api';

/**
 * Path-segment regex for a profile. Must match the relay's
 * `validate_profile_path` (R1.A) byte-for-byte: starts with an
 * alphanumeric character, followed by alphanumerics, `_`, or `-`.
 */
export const PROFILE_PATH_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * Reserved path segments that conflict with existing relay routes
 * mounted under `/mcp/...`. Comparison is case-insensitive — `SSE`,
 * `Tools`, etc. are all rejected. Mirrors the relay-side reserved set.
 */
export const RESERVED_PROFILE_PATHS: readonly string[] = [
  'sse',
  'initialize',
  'tools',
  'oauth',
  'healthz',
];

/**
 * Validate a profile path slug.
 *
 * Returns `null` when the value is acceptable, otherwise a short,
 * human-readable error message suitable for inline display below the
 * field in `CreateProfileModal`. Matches the order/wording the relay
 * uses when it rejects the path on submit so the user sees the same
 * reason whether the modal blocks them client-side or the API does.
 */
export function validateProfilePath(path: string): string | null {
  if (!path) return 'Path is required';
  if (!PROFILE_PATH_REGEX.test(path)) {
    return 'Use letters, numbers, _ or -; must start with a letter or number';
  }
  if (RESERVED_PROFILE_PATHS.includes(path.toLowerCase())) {
    return `"${path}" is reserved — choose a different path`;
  }
  return null;
}

/**
 * Validate the profile name. Currently the only rule is non-empty
 * (after trimming) — the relay treats the friendly name as freeform.
 */
export function validateProfileName(name: string): string | null {
  if (!name.trim()) return 'Name is required';
  return null;
}

/**
 * Aggregated form-level validity check used to drive the Create button's
 * disabled state. Both name and path must be present and the path must
 * match the regex + reserved checks.
 */
export function isCreateProfileFormValid(name: string, path: string): boolean {
  return validateProfileName(name) === null && validateProfilePath(path) === null;
}

/**
 * Build the JSON body submitted to `POST /api/profiles`. Trims the
 * friendly name, leaves the path as-is (regex enforces no surrounding
 * whitespace), and seeds an empty endpoints list — server assignment
 * happens after creation in the right panel (Engineering Spec §9.3).
 *
 * The `js_execution` / `toon_output` toggles in `CreateProfileModal` are
 * seeded copy-on-write from the current global relay defaults at modal
 * open and the payload always carries concrete booleans — the relay
 * rejects requests that omit either field.
 */
export function buildCreateProfilePayload(input: {
  name: string;
  path: string;
  jsExecution: boolean;
  toonOutput: boolean;
}): CreateProfileParams {
  return {
    name: input.name.trim(),
    path: input.path,
    endpoints: [],
    js_execution: input.jsExecution,
    toon_output: input.toonOutput,
  };
}
