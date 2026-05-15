import { describe, it, expect } from 'vitest';
import { shouldShowSidebarSkeleton } from './sidebar-helpers';

// Engineering Spec §4 Slice C rows 9 & 10: Sidebar must show a skeleton
// before the first endpoint poll returns, then swap to the real list once
// the initial poll completes. Loaded-but-empty falls through to the
// existing onboarding/empty UI handled at the route level.
describe('shouldShowSidebarSkeleton', () => {
  // Row 9 — skeleton renders before first poll returns
  it('returns true while initial load has not completed', () => {
    expect(shouldShowSidebarSkeleton(false)).toBe(true);
  });

  // Row 10 — real endpoints render after the poll returns; the
  // skeleton must be gone regardless of whether the result is empty
  // (route-level onboarding handles loaded-empty).
  it('returns false once initial load has completed', () => {
    expect(shouldShowSidebarSkeleton(true)).toBe(false);
  });
});

