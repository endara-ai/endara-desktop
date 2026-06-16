import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  findRequestRowIndex,
  resolvePendingHighlight,
  toggleEndpointFilter,
} from './relay-logs-helpers';

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

describe('resolvePendingHighlight', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves synchronously when the row is already present', () => {
    const onFound = vi.fn();
    const onTimeout = vi.fn();
    const lines = [{ requestId: 'a' }, { requestId: '7' }];
    resolvePendingHighlight({ jsonrpcId: '7', getLines: () => lines, onFound, onTimeout });
    expect(onFound).toHaveBeenCalledExactlyOnceWith(1);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('resolves once a matching row is pushed in before the budget elapses', () => {
    const onFound = vi.fn();
    const onTimeout = vi.fn();
    let lines: { requestId?: string }[] = [];
    resolvePendingHighlight({
      jsonrpcId: '7',
      getLines: () => lines,
      onFound,
      onTimeout,
      budgetMs: 2000,
      intervalMs: 100,
    });
    expect(onFound).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(onFound).not.toHaveBeenCalled();

    lines = [{ requestId: 'other' }, { requestId: '7' }];
    vi.advanceTimersByTime(100);
    expect(onFound).toHaveBeenCalledExactlyOnceWith(1);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('calls onTimeout when no row appears within the budget', () => {
    const onFound = vi.fn();
    const onTimeout = vi.fn();
    resolvePendingHighlight({
      jsonrpcId: 'missing',
      getLines: () => [{ requestId: 'a' }],
      onFound,
      onTimeout,
      budgetMs: 2000,
      intervalMs: 100,
    });

    vi.advanceTimersByTime(2000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onFound).not.toHaveBeenCalled();
  });

  it('stops polling after cancel and never fires the callbacks', () => {
    const onFound = vi.fn();
    const onTimeout = vi.fn();
    let lines: { requestId?: string }[] = [];
    const cancel = resolvePendingHighlight({
      jsonrpcId: '7',
      getLines: () => lines,
      onFound,
      onTimeout,
      budgetMs: 2000,
      intervalMs: 100,
    });

    cancel();
    lines = [{ requestId: '7' }];
    vi.advanceTimersByTime(5000);
    expect(onFound).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
