import { describe, it, expect } from 'vitest';

import { toggleEndpointFilter } from './relay-logs-helpers';

describe('toggleEndpointFilter', () => {
  it('selects an endpoint when nothing is selected', () => {
    const next = toggleEndpointFilter(new Set(), 'github');
    expect([...next]).toEqual(['github']);
  });

  it('clears the filter when the only selection is toggled off', () => {
    const next = toggleEndpointFilter(new Set(['github']), 'github');
    expect(next.size).toBe(0);
  });

  it('replaces a different single selection with the clicked one', () => {
    const next = toggleEndpointFilter(new Set(['slack']), 'github');
    expect([...next]).toEqual(['github']);
  });
});
