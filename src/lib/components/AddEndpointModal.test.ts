import { describe, it, expect } from 'vitest';

/**
 * Endpoint name validation: must match ^[a-z0-9][a-z0-9_-]*$
 * This mirrors the regex exported from AddEndpointModal.svelte.
 */
function isValidEndpointName(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(value);
}

describe('AddEndpointModal name validation', () => {
  describe('valid names', () => {
    it.each([
      'echo',
      'my-server',
      'test_ep',
      'a',
      '0day',
      'abc-123',
      'a-b_c',
      '9lives',
    ])('accepts "%s"', (name) => {
      expect(isValidEndpointName(name)).toBe(true);
    });
  });

  describe('invalid names', () => {
    it.each([
      ['', 'empty string'],
      ['MyServer', 'uppercase letters'],
      ['-bad', 'starts with hyphen'],
      ['_bad', 'starts with underscore'],
      ['my server', 'contains space'],
      ['hello!', 'contains special character'],
      ['café', 'contains non-ASCII'],
      ['my.server', 'contains dot'],
      ['MY-SERVER', 'all uppercase'],
    ])('rejects "%s" (%s)', (name) => {
      expect(isValidEndpointName(name)).toBe(false);
    });
  });
});

