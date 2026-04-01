/**
 * Sanitize an MCP server name for use as an identifier.
 *
 * Mirrors the Rust `sanitize_name()` logic in `packages/relay/src/prefix.rs`:
 * - Converts to lowercase
 * - Replaces spaces with underscores
 * - Strips characters not matching [a-z0-9_-]
 * - Returns null if the result is empty
 */
export function sanitizeName(name: string): string | null {
  const sanitized = name
    .toLowerCase()
    .split('')
    .map((c) => (c === ' ' ? '_' : c))
    .filter((c) => /^[a-z0-9_-]$/.test(c))
    .join('');

  return sanitized.length === 0 ? null : sanitized;
}

/** Validate that a tool prefix matches the allowed pattern: [a-z0-9][a-z0-9_-]* */
export function isValidToolPrefix(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(value);
}

