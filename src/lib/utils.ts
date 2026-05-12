/**
 * Sanitize a free-form string into the relay's canonical
 * `[a-z0-9_-]{1,64}` form, mirroring `sanitize_server_name` in
 * `packages/relay/src/adapter/server_name.rs`:
 *
 * 1. Lowercase.
 * 2. Trim leading/trailing whitespace.
 * 3. Replace any character outside `[a-z0-9_]` with `-`,
 *    collapsing runs of replacements (and existing `-`s) to a single `-`.
 * 4. Trim leading/trailing `-`.
 * 5. Truncate to 64 characters (the relay rejects longer; the JS helper
 *    truncates so the override field cannot produce an invalid value).
 *
 * Returns `''` for inputs that reduce to nothing — callers decide what to
 * do with the empty result (treat as "no override", show validation, etc).
 */
export function sanitizeName(name: string): string {
  const lowered = name.toLowerCase().trim();
  if (!lowered) return '';

  let out = '';
  let lastWasDash = false;
  for (const ch of lowered) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '_') {
      out += ch;
      lastWasDash = false;
    } else {
      if (lastWasDash) continue;
      out += '-';
      lastWasDash = true;
    }
  }

  // Trim leading/trailing dashes
  let start = 0;
  let end = out.length;
  while (start < end && out[start] === '-') start++;
  while (end > start && out[end - 1] === '-') end--;
  const trimmed = out.slice(start, end);

  return trimmed.length > 64 ? trimmed.slice(0, 64) : trimmed;
}

