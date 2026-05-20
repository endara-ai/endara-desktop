/**
 * Deterministic endpoint → color helpers used by the relay log view (Slice B,
 * engineering spec §2.4). Same endpoint name always yields the same hue so the
 * 2px left stripe on a log row is stable across page reloads, app restarts,
 * and component re-renders — no random per-session colors.
 *
 * Pure helpers, no DOM access. Tested in `endpointColor.test.ts`.
 */

const FNV_OFFSET_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;

/** FNV-1a 32-bit hash. Pure, branch-free, stable across runs. */
function fnv1a(input: string): number {
  let h = FNV_OFFSET_32;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME_32);
  }
  return h >>> 0;
}

/**
 * Map an endpoint name to a hue in [0, 360). Deterministic — `endpointHue(x)`
 * always returns the same value for the same `x`.
 */
export function endpointHue(name: string): number {
  return fnv1a(name) % 360;
}

/**
 * Inline CSS for the 2px left stripe on a log row. Returns a transparent
 * stripe when the row has no endpoint context (relay-level events) so the
 * grid layout stays aligned across rows.
 */
export function endpointStripeStyle(name: string | null | undefined): string {
  if (!name) return 'border-left: 2px solid transparent;';
  const hue = endpointHue(name);
  return `border-left: 2px solid hsl(${hue}, 65%, 55%);`;
}
