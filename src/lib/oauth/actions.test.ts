import { describe, it, expect, vi } from 'vitest';
import { canReauthorize, reauthorize, type ReauthorizeDeps } from './actions';
import type { OAuthStartResult, OAuthStatusValue } from '$lib/types';

function makeDeps(overrides: Partial<ReauthorizeDeps> = {}): ReauthorizeDeps {
  return {
    startOAuth: vi.fn().mockResolvedValue({ authorize_url: 'https://example.com/authorize' } as OAuthStartResult),
    openUrl: vi.fn().mockResolvedValue(undefined),
    onSuccess: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

describe('reauthorize', () => {
  it('calls startOAuth with the endpoint name', async () => {
    const deps = makeDeps();
    await reauthorize('my-server', deps);
    expect(deps.startOAuth).toHaveBeenCalledTimes(1);
    expect(deps.startOAuth).toHaveBeenCalledWith('my-server');
  });

  it('does NOT call revokeOAuth (guards against re-introduced Disconnect logic)', async () => {
    const revokeOAuth = vi.fn();
    const deps = makeDeps();
    await reauthorize('my-server', deps);
    expect(revokeOAuth).not.toHaveBeenCalled();
  });

  it('opens the authorize URL and reports success on OAuthStartSuccess', async () => {
    const deps = makeDeps({
      startOAuth: vi.fn().mockResolvedValue({ authorize_url: 'https://example.com/auth' } as OAuthStartResult),
    });
    await reauthorize('srv', deps);
    expect(deps.openUrl).toHaveBeenCalledWith('https://example.com/auth');
    expect(deps.onSuccess).toHaveBeenCalledWith('Browser opened for authorization');
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it('reports a discovery_failed error when startOAuth returns that error', async () => {
    const deps = makeDeps({
      startOAuth: vi.fn().mockResolvedValue({ error: 'discovery_failed' } as OAuthStartResult),
    });
    await reauthorize('srv', deps);
    expect(deps.openUrl).not.toHaveBeenCalled();
    expect(deps.onSuccess).not.toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith(
      'OAuth discovery failed. Go to Settings to configure OAuth server URL manually.',
    );
  });

  it('reports a dcr_unsupported error when startOAuth returns that error', async () => {
    const deps = makeDeps({
      startOAuth: vi.fn().mockResolvedValue({ error: 'dcr_unsupported' } as OAuthStartResult),
    });
    await reauthorize('srv', deps);
    expect(deps.openUrl).not.toHaveBeenCalled();
    expect(deps.onSuccess).not.toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith(
      'This server requires manual OAuth app registration. Go to Settings to enter your Client ID.',
    );
  });
});

describe('canReauthorize', () => {
  const cases: Array<[OAuthStatusValue, boolean]> = [
    ['disconnected', true],
    ['auth_required', true],
    ['needs_login', true],
    ['authenticated', false],
    ['refreshing', false],
    ['connection_failed', false],
  ];

  for (const [status, expected] of cases) {
    it(`returns ${expected} for status "${status}"`, () => {
      expect(canReauthorize(status)).toBe(expected);
    });
  }
});

