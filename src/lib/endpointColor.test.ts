import { describe, expect, it } from 'vitest';

import { endpointHue, endpointStripeStyle } from './endpointColor';

// Engineering spec §5 row #12 — endpoint color stripe is consistent for the
// same endpoint name across renders.
describe('endpointHue', () => {
  it('is deterministic for the same input', () => {
    expect(endpointHue('github')).toBe(endpointHue('github'));
    expect(endpointHue('postgres')).toBe(endpointHue('postgres'));
    expect(endpointHue('a-very-long-endpoint-name-with-dashes')).toBe(
      endpointHue('a-very-long-endpoint-name-with-dashes'),
    );
  });

  it('returns a value in [0, 360)', () => {
    for (const name of ['github', 'slack', 'gmail', 'postgres', '', 'x']) {
      const hue = endpointHue(name);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
      expect(Number.isInteger(hue)).toBe(true);
    }
  });

  it('produces different hues for typical distinct endpoint names', () => {
    // Not a strict requirement of FNV-1a, but a sanity check that we aren't
    // collapsing common names to the same hue.
    const names = ['github', 'slack', 'gmail', 'postgres', 'notion'];
    const hues = new Set(names.map(endpointHue));
    expect(hues.size).toBeGreaterThan(1);
  });
});

describe('endpointStripeStyle', () => {
  it('returns a transparent stripe when name is missing', () => {
    expect(endpointStripeStyle(undefined)).toBe('border-left: 2px solid transparent;');
    expect(endpointStripeStyle(null)).toBe('border-left: 2px solid transparent;');
    expect(endpointStripeStyle('')).toBe('border-left: 2px solid transparent;');
  });

  it('renders a 2px hsl stripe using the endpoint hue', () => {
    const style = endpointStripeStyle('github');
    expect(style).toBe(`border-left: 2px solid hsl(${endpointHue('github')}, 65%, 55%);`);
  });

  it('is stable across calls (same name → same style string)', () => {
    expect(endpointStripeStyle('github')).toBe(endpointStripeStyle('github'));
    expect(endpointStripeStyle('postgres')).toBe(endpointStripeStyle('postgres'));
  });
});
