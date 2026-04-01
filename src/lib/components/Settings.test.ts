import { describe, expect, it, vi } from 'vitest';

import { canRetryRelay, restartRelay } from '$lib/relaySidecarUi';

describe('Settings relay retry behavior', () => {
  it('shows the retry button when the sidecar failed', () => {
    expect(canRetryRelay('failed')).toBe(true);
  });

  it('shows the retry button when the sidecar stopped', () => {
    expect(canRetryRelay('stopped')).toBe(true);
  });

  it('does not show the retry button when the sidecar is running', () => {
    expect(canRetryRelay('running')).toBe(false);
  });

  it('does not show the retry button when the sidecar is starting', () => {
    expect(canRetryRelay('starting')).toBe(false);
  });

  it('does not show the retry button when the sidecar status is unknown', () => {
    expect(canRetryRelay('unknown')).toBe(false);
  });

  it('invokes restart_relay when retry is triggered', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);

    await restartRelay(invoke);

    expect(invoke).toHaveBeenCalledWith('restart_relay');
  });
});

