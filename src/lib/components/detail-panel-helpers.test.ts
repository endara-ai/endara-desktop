import { describe, it, expect } from 'vitest';
import { shouldShowRestartButton, type EndpointTransport } from './detail-panel-helpers';

describe('shouldShowRestartButton', () => {
  const cases: Array<[EndpointTransport, boolean]> = [
    ['stdio', true],
    ['sse', true],
    ['http', false],
    ['oauth', false],
  ];

  for (const [transport, expected] of cases) {
    it(`returns ${expected} for transport "${transport}"`, () => {
      expect(shouldShowRestartButton(transport)).toBe(expected);
    });
  }
});

