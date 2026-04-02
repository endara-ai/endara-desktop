/**
 * Determines whether auto-scroll should remain active based on the
 * current scroll position. Returns true when the user is "at the bottom"
 * (within `threshold` pixels).
 */
export function isAtBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = 40,
): boolean {
  return scrollHeight - scrollTop - clientHeight < threshold;
}

