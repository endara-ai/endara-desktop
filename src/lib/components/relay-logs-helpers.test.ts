import { describe, it, expect } from 'vitest';

import { findRequestRowIndex, toggleEndpointFilter } from './relay-logs-helpers';

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

describe('findRequestRowIndex', () => {
  it('returns -1 when no row matches', () => {
    const lines = [{ requestId: 'a' }, { requestId: 'b' }];
    expect(findRequestRowIndex(lines, 'missing')).toBe(-1);
  });

  it('returns -1 for an empty list', () => {
    expect(findRequestRowIndex([], 'a')).toBe(-1);
  });

  it('returns the latest matching index for a duplicate id', () => {
    // Started + completed for the same JSON-RPC id produce two rows; the
    // overlay click should scroll to the newest one (the completion row).
    const lines = [
      { requestId: '7' },
      { requestId: 'other' },
      { requestId: '7' },
      { requestId: 'tail' },
    ];
    expect(findRequestRowIndex(lines, '7')).toBe(2);
  });

  it('ignores rows whose requestId is undefined', () => {
    const lines = [{}, { requestId: '42' }, {}];
    expect(findRequestRowIndex(lines, '42')).toBe(1);
  });
});
