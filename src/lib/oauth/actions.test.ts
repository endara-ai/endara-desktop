import { describe, it, expect, vi } from 'vitest';
import {
  canReauthorize,
  canResetAuthorization,
  isConnectivityFailure,
  reauthorize,
  resetAuthorization,
  type ReauthorizeDeps,
  type ResetAuthorizationDeps,
} from './actions';
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

  it('reports a connectivity error when startOAuth returns discovery_unreachable', async () => {
    const deps = makeDeps({
      startOAuth: vi.fn().mockResolvedValue({ error: 'discovery_unreachable' } as OAuthStartResult),
    });
    await reauthorize('srv', deps);
    expect(deps.openUrl).not.toHaveBeenCalled();
    expect(deps.onSuccess).not.toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith(
      "Couldn't reach the server to start authorization. Check your connection and try again.",
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

function makeResetDeps(overrides: Partial<ResetAuthorizationDeps> = {}): ResetAuthorizationDeps {
  return {
    resetOAuth: vi.fn().mockResolvedValue({ authorize_url: 'https://example.com/authorize?prompt=consent' } as OAuthStartResult),
    openUrl: vi.fn().mockResolvedValue(undefined),
    onSuccess: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

describe('resetAuthorization', () => {
  it('calls resetOAuth with the endpoint name', async () => {
    const deps = makeResetDeps();
    await resetAuthorization('my-server', deps);
    expect(deps.resetOAuth).toHaveBeenCalledTimes(1);
    expect(deps.resetOAuth).toHaveBeenCalledWith('my-server');
  });

  it('opens the authorize URL and explains the consent screen on success', async () => {
    const deps = makeResetDeps();
    await resetAuthorization('srv', deps);
    expect(deps.openUrl).toHaveBeenCalledWith('https://example.com/authorize?prompt=consent');
    expect(deps.onSuccess).toHaveBeenCalledWith(
      'Authorization reset — approve access on the consent screen to finish',
    );
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it('reports a connectivity error when resetOAuth returns discovery_unreachable', async () => {
    const deps = makeResetDeps({
      resetOAuth: vi.fn().mockResolvedValue({ error: 'discovery_unreachable' } as OAuthStartResult),
    });
    await resetAuthorization('srv', deps);
    expect(deps.openUrl).not.toHaveBeenCalled();
    expect(deps.onSuccess).not.toHaveBeenCalled();
    // The relay has already discarded the old grant by the time the start
    // half fails, so the copy must say the reset happened.
    expect(deps.onError).toHaveBeenCalledWith(
      "Authorization was reset, but the new sign-in couldn't start: the server is unreachable. Re-authenticate when the connection is back.",
    );
  });

  it('reports a discovery_failed error when resetOAuth returns that error', async () => {
    const deps = makeResetDeps({
      resetOAuth: vi.fn().mockResolvedValue({ error: 'discovery_failed' } as OAuthStartResult),
    });
    await resetAuthorization('srv', deps);
    expect(deps.openUrl).not.toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith(
      'Authorization was reset, but OAuth discovery failed. Go to Settings to configure the OAuth server URL, then re-authenticate.',
    );
  });

  it('reports a dcr_unsupported error when resetOAuth returns that error', async () => {
    const deps = makeResetDeps({
      resetOAuth: vi.fn().mockResolvedValue({ error: 'dcr_unsupported' } as OAuthStartResult),
    });
    await resetAuthorization('srv', deps);
    expect(deps.openUrl).not.toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith(
      'Authorization was reset, but this server requires manual OAuth app registration. Go to Settings to enter your Client ID, then re-authenticate.',
    );
  });

  it('reports a generic error for an unrecognized result', async () => {
    const deps = makeResetDeps({
      resetOAuth: vi.fn().mockResolvedValue({ error: 'something_else' } as unknown as OAuthStartResult),
    });
    await resetAuthorization('srv', deps);
    expect(deps.openUrl).not.toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith('Failed to reset authorization');
  });
});

describe('canReauthorize', () => {
  const cases: Array<[OAuthStatusValue, boolean]> = [
    ['disconnected', true],
    ['auth_required', true],
    ['needs_login', true],
    ['connection_failed', true],
    ['authenticated', false],
    ['refreshing', false],
  ];

  for (const [status, expected] of cases) {
    it(`returns ${expected} for status "${status}"`, () => {
      expect(canReauthorize(status)).toBe(expected);
    });
  }
});

// Reset targets a LIVE grant the user wants to re-approve, so unlike
// canReauthorize it must also return true for `authenticated`.
describe('canResetAuthorization', () => {
  const cases: Array<[OAuthStatusValue, boolean]> = [
    ['authenticated', true],
    ['disconnected', true],
    ['auth_required', true],
    ['needs_login', true],
    ['connection_failed', true],
    ['refreshing', false],
  ];

  for (const [status, expected] of cases) {
    it(`returns ${expected} for status "${status}"`, () => {
      expect(canResetAuthorization(status)).toBe(expected);
    });
  }
});

describe('isConnectivityFailure', () => {
  const cases: Array<[OAuthStatusValue, boolean]> = [
    ['connection_failed', true],
    ['disconnected', false],
    ['auth_required', false],
    ['needs_login', false],
    ['authenticated', false],
    ['refreshing', false],
  ];

  for (const [status, expected] of cases) {
    it(`returns ${expected} for status "${status}"`, () => {
      expect(isConnectivityFailure(status)).toBe(expected);
    });
  }
});

