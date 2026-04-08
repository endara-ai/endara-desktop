import { describe, it, expect } from 'vitest';
import { deriveOAuthDisplayStatus } from './derive-status';
import type { OAuthStatus, OAuthStatusValue, OAuthDisplayStatus } from '$lib/types';

function makeStatus(status: OAuthStatusValue): OAuthStatus {
  return {
    status,
    has_access_token: status === 'authenticated',
    has_refresh_token: false,
    expires_at: null,
    expires_in_seconds: null,
    last_refreshed_at: null,
    next_refresh_at: null,
    state: null,
  };
}

const expectedMappings: Array<{
  input: OAuthStatusValue;
  color: OAuthDisplayStatus['color'];
  label: string;
  healthDotVariant: OAuthDisplayStatus['healthDotVariant'];
  canConnect: boolean;
  canDisconnect: boolean;
  canRefresh: boolean;
}> = [
  { input: 'authenticated', color: 'green', label: 'Authenticated', healthDotVariant: 'healthy', canConnect: false, canDisconnect: true, canRefresh: true },
  { input: 'needs_login', color: 'yellow', label: 'Needs Login', healthDotVariant: 'degraded', canConnect: true, canDisconnect: false, canRefresh: false },
  { input: 'refreshing', color: 'blue', label: 'Refreshing', healthDotVariant: 'healthy', canConnect: false, canDisconnect: false, canRefresh: false },
  { input: 'auth_required', color: 'orange', label: 'Auth Required', healthDotVariant: 'error', canConnect: true, canDisconnect: false, canRefresh: false },
  { input: 'disconnected', color: 'gray', label: 'Disconnected', healthDotVariant: 'offline', canConnect: true, canDisconnect: false, canRefresh: false },
  { input: 'connection_failed', color: 'red', label: 'Connection Failed', healthDotVariant: 'error', canConnect: false, canDisconnect: true, canRefresh: true },
];

describe('deriveOAuthDisplayStatus', () => {
  describe.each(expectedMappings)(
    '$input → $color / $label',
    ({ input, color, label, healthDotVariant, canConnect, canDisconnect, canRefresh }) => {
      const result = deriveOAuthDisplayStatus(makeStatus(input));

      it(`maps to color "${color}"`, () => {
        expect(result.color).toBe(color);
      });

      it(`maps to label "${label}"`, () => {
        expect(result.label).toBe(label);
      });

      it(`maps to healthDotVariant "${healthDotVariant}"`, () => {
        expect(result.healthDotVariant).toBe(healthDotVariant);
      });

      it(`canConnect = ${canConnect}`, () => {
        expect(result.canConnect).toBe(canConnect);
      });

      it(`canDisconnect = ${canDisconnect}`, () => {
        expect(result.canDisconnect).toBe(canDisconnect);
      });

      it(`canRefresh = ${canRefresh}`, () => {
        expect(result.canRefresh).toBe(canRefresh);
      });
    },
  );

  it('returns a new object each call (no shared reference)', () => {
    const a = deriveOAuthDisplayStatus(makeStatus('authenticated'));
    const b = deriveOAuthDisplayStatus(makeStatus('authenticated'));
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

