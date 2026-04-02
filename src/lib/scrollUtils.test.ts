import { describe, it, expect } from 'vitest';
import { isAtBottom } from '$lib/scrollUtils';

describe('isAtBottom', () => {
  it('returns true when scrolled to the exact bottom', () => {
    // scrollHeight 1000, clientHeight 400, scrollTop 600 → gap = 0
    expect(isAtBottom(600, 1000, 400)).toBe(true);
  });

  it('returns true when within the default threshold', () => {
    // gap = 39px < 40
    expect(isAtBottom(561, 1000, 400)).toBe(true);
  });

  it('returns false when scrolled away from bottom', () => {
    // gap = 100px > 40
    expect(isAtBottom(500, 1000, 400)).toBe(false);
  });

  it('returns true when content fits without scrolling', () => {
    // scrollHeight === clientHeight, scrollTop = 0 → gap = 0
    expect(isAtBottom(0, 400, 400)).toBe(true);
  });

  it('returns false when exactly at threshold boundary', () => {
    // gap = 40px, threshold is < 40, so false
    expect(isAtBottom(560, 1000, 400)).toBe(false);
  });

  it('respects custom threshold', () => {
    // gap = 50px, custom threshold 60
    expect(isAtBottom(550, 1000, 400, 60)).toBe(true);
    // gap = 50px, custom threshold 30
    expect(isAtBottom(550, 1000, 400, 30)).toBe(false);
  });

  it('handles empty container (zero height)', () => {
    expect(isAtBottom(0, 0, 0)).toBe(true);
  });
});

