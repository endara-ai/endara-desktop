import { describe, it, expect } from 'vitest';
import { serverIconFor, serverIconFragment, serverIconKeyFor } from './icons';

describe('serverIconKeyFor', () => {
  it.each([
    ['github', 'github'],
    ['GitHub', 'github'],
    ['Slack', 'slack'],
    ['Filesystem', 'filesystem'],
    ['files', 'filesystem'],
    ['postgres', 'postgres'],
    ['PostgreSQL', 'postgres'],
    ['pg', 'postgres'],
    ['Brave Search', 'search'],
    ['websearch', 'search'],
    ['Sentry', 'sentry'],
  ] as const)('maps %s → %s', (input, expected) => {
    expect(serverIconKeyFor(input)).toBe(expected);
  });

  it('falls back to "generic" for null/empty/unknown', () => {
    expect(serverIconKeyFor(null)).toBe('generic');
    expect(serverIconKeyFor(undefined)).toBe('generic');
    expect(serverIconKeyFor('')).toBe('generic');
    expect(serverIconKeyFor('Hubspot')).toBe('generic');
  });
});

describe('serverIconFragment / serverIconFor', () => {
  it('returns a non-empty SVG fragment for every known key', () => {
    for (const k of ['github', 'slack', 'filesystem', 'postgres', 'search', 'sentry', 'generic'] as const) {
      const frag = serverIconFragment(k);
      expect(frag.length).toBeGreaterThan(10);
      expect(/<(path|g)\b/.test(frag)).toBe(true);
    }
  });
  it('serverIconFor returns the generic fallback for an unknown type', () => {
    expect(serverIconFor('something-weird')).toBe(serverIconFragment('generic'));
  });
});
