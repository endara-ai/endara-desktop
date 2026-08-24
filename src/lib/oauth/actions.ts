import type { OAuthStartResult, OAuthStatusValue } from '$lib/types';

const REAUTHORIZE_STATUSES: ReadonlyArray<OAuthStatusValue> = [
  'disconnected',
  'auth_required',
  'needs_login',
  'connection_failed',
];

export function canReauthorize(status: OAuthStatusValue): boolean {
  return REAUTHORIZE_STATUSES.includes(status);
}

/**
 * "Reset authorization" discards the existing grant and forces a fresh
 * consent screen. Unlike re-authenticate (which targets broken auth states),
 * the primary use case is a LIVE grant the user wants to re-approve — so
 * `authenticated` is included alongside every re-authenticate state.
 */
export function canResetAuthorization(status: OAuthStatusValue): boolean {
  return status === 'authenticated' || REAUTHORIZE_STATUSES.includes(status);
}

/**
 * `connection_failed` means the server is unreachable — the stored tokens are
 * likely still valid, so retry/refresh (not re-authentication) should be the
 * suggested first step in the UI.
 */
export function isConnectivityFailure(status: OAuthStatusValue): boolean {
  return status === 'connection_failed';
}

export interface ReauthorizeDeps {
  startOAuth: (name: string) => Promise<OAuthStartResult>;
  openUrl: (url: string) => Promise<void>;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
}

export async function reauthorize(name: string, deps: ReauthorizeDeps): Promise<void> {
  const result = await deps.startOAuth(name);
  if ('authorize_url' in result) {
    await deps.openUrl(result.authorize_url);
    deps.onSuccess('Browser opened for authorization');
  } else if ('error' in result && result.error === 'discovery_unreachable') {
    deps.onError("Couldn't reach the server to start authorization. Check your connection and try again.");
  } else if ('error' in result && result.error === 'discovery_failed') {
    deps.onError('OAuth discovery failed. Go to Settings to configure OAuth server URL manually.');
  } else if ('error' in result && result.error === 'dcr_unsupported') {
    deps.onError('This server requires manual OAuth app registration. Go to Settings to enter your Client ID.');
  } else {
    deps.onError('Failed to start OAuth flow');
  }
}

export interface ResetAuthorizationDeps {
  resetOAuth: (name: string) => Promise<OAuthStartResult>;
  openUrl: (url: string) => Promise<void>;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
}

/**
 * "Reset authorization": the relay discards the old grant (upstream revoke +
 * local token delete) and returns a forced-consent authorize URL, so the
 * provider re-shows its consent screen instead of silently reusing the prior
 * grant.
 */
export async function resetAuthorization(name: string, deps: ResetAuthorizationDeps): Promise<void> {
  const result = await deps.resetOAuth(name);
  if ('authorize_url' in result) {
    await deps.openUrl(result.authorize_url);
    deps.onSuccess('Authorization reset — approve access on the consent screen to finish');
  } else if ('error' in result && result.error === 'discovery_unreachable') {
    // Typed errors come from the start half of the reset: the relay already
    // discarded the old grant, so the copy must not imply nothing happened.
    deps.onError(
      "Authorization was reset, but the new sign-in couldn't start: the server is unreachable. Re-authenticate when the connection is back.",
    );
  } else if ('error' in result && result.error === 'discovery_failed') {
    deps.onError(
      'Authorization was reset, but OAuth discovery failed. Go to Settings to configure the OAuth server URL, then re-authenticate.',
    );
  } else if ('error' in result && result.error === 'dcr_unsupported') {
    deps.onError(
      'Authorization was reset, but this server requires manual OAuth app registration. Go to Settings to enter your Client ID, then re-authenticate.',
    );
  } else {
    deps.onError('Failed to reset authorization');
  }
}

