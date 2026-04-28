import type { OAuthStartResult, OAuthStatusValue } from '$lib/types';

const REAUTHORIZE_STATUSES: ReadonlyArray<OAuthStatusValue> = [
  'disconnected',
  'auth_required',
  'needs_login',
];

export function canReauthorize(status: OAuthStatusValue): boolean {
  return REAUTHORIZE_STATUSES.includes(status);
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
  } else if ('error' in result && result.error === 'discovery_failed') {
    deps.onError('OAuth discovery failed. Go to Settings to configure OAuth server URL manually.');
  } else if ('error' in result && result.error === 'dcr_unsupported') {
    deps.onError('This server requires manual OAuth app registration. Go to Settings to enter your Client ID.');
  } else {
    deps.onError('Failed to start OAuth flow');
  }
}

