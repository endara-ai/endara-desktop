import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import type { OAuthStatus } from '$lib/types';

// Mock the api module before importing the poller
vi.mock('$lib/api', () => ({
  getOAuthStatus: vi.fn(),
}));

import { getOAuthStatus } from '$lib/api';
import { oauthStatuses } from '$lib/stores';
import { createOAuthStatusPoller } from './oauth-status-poller';

const mockGetOAuthStatus = vi.mocked(getOAuthStatus);

function makeOAuthStatus(status: OAuthStatus['status'] = 'authenticated'): OAuthStatus {
  return {
    status,
    has_access_token: true,
    has_refresh_token: true,
    expires_at: null,
    expires_in_seconds: null,
    last_refreshed_at: null,
    next_refresh_at: null,
    state: null,
  };
}

describe('createOAuthStatusPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGetOAuthStatus.mockReset();
    oauthStatuses.set(new Map());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls getOAuthStatus immediately on start', async () => {
    mockGetOAuthStatus.mockResolvedValue(makeOAuthStatus());
    const poller = createOAuthStatusPoller('linear', 5000);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockGetOAuthStatus).toHaveBeenCalledWith('linear');
    expect(mockGetOAuthStatus).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it('polls at the specified interval', async () => {
    mockGetOAuthStatus.mockResolvedValue(makeOAuthStatus());
    const poller = createOAuthStatusPoller('linear', 5000);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetOAuthStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(mockGetOAuthStatus).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5000);
    expect(mockGetOAuthStatus).toHaveBeenCalledTimes(3);

    poller.stop();
  });

  it('updates the status readable store on successful poll', async () => {
    const expected = makeOAuthStatus('needs_login');
    mockGetOAuthStatus.mockResolvedValue(expected);

    const poller = createOAuthStatusPoller('test-ep', 1000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(get(poller.status)).toEqual(expected);
    poller.stop();
  });

  it('updates the oauthStatuses store on successful poll', async () => {
    const expected = makeOAuthStatus('authenticated');
    mockGetOAuthStatus.mockResolvedValue(expected);

    const poller = createOAuthStatusPoller('my-endpoint', 1000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    const map = get(oauthStatuses);
    expect(map.get('my-endpoint')).toEqual(expected);
    poller.stop();
  });

  it('sets status to null on error', async () => {
    mockGetOAuthStatus.mockRejectedValue(new Error('network error'));

    const poller = createOAuthStatusPoller('broken', 1000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(get(poller.status)).toBeNull();
    poller.stop();
  });

  it('stops polling after stop() is called', async () => {
    mockGetOAuthStatus.mockResolvedValue(makeOAuthStatus());
    const poller = createOAuthStatusPoller('linear', 1000);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetOAuthStatus).toHaveBeenCalledTimes(1);

    poller.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockGetOAuthStatus).toHaveBeenCalledTimes(1);
  });

  it('does not start twice if start() called multiple times', async () => {
    mockGetOAuthStatus.mockResolvedValue(makeOAuthStatus());
    const poller = createOAuthStatusPoller('linear', 1000);

    poller.start();
    poller.start(); // second call should be no-op
    await vi.advanceTimersByTimeAsync(0);

    expect(mockGetOAuthStatus).toHaveBeenCalledTimes(1);
    poller.stop();
  });
});

