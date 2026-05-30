import { describe, expect, it } from 'vitest';

import { describeTrayHealthIssue, deriveTrayHealth } from './tray-health';
import type { Endpoint, OAuthStatus } from './types';

// Engineering spec §2 + §8 — `deriveTrayHealth` derives the tray dot color
// (healthy/degraded/down) from sidecar status, relay connectivity, endpoint
// health, and OAuth status. These tests cover rows #1–#15 of the spec's
// test matrix. Rows #16/#17 (state-change deduping) live with the +page.svelte
// wire-up and are out of scope for this file.

function makeEndpoint(overrides: Partial<Endpoint> = {}): Endpoint {
  return {
    name: 'example',
    transport: 'stdio',
    health: 'healthy',
    tool_count: 0,
    last_activity: null,
    disabled: false,
    ...overrides,
  };
}

function makeOAuthStatus(overrides: Partial<OAuthStatus> = {}): OAuthStatus {
  return {
    status: 'authenticated',
    has_access_token: true,
    has_refresh_token: true,
    expires_at: null,
    expires_in_seconds: null,
    last_refreshed_at: null,
    next_refresh_at: null,
    state: null,
    ...overrides,
  };
}

describe('deriveTrayHealth', () => {
  // #1
  it('returns healthy when all endpoints are healthy', () => {
    const endpoints: Endpoint[] = [
      makeEndpoint({ name: 'a' }),
      makeEndpoint({ name: 'b' }),
      makeEndpoint({ name: 'c' }),
    ];
    expect(deriveTrayHealth('running', true, endpoints, new Map())).toBe('healthy');
  });

  // #2
  it('returns degraded when one endpoint is offline and the rest are healthy', () => {
    const endpoints: Endpoint[] = [
      makeEndpoint({ name: 'a' }),
      makeEndpoint({ name: 'b', health: 'offline' }),
      makeEndpoint({ name: 'c' }),
    ];
    expect(deriveTrayHealth('running', true, endpoints, new Map())).toBe('degraded');
  });

  // #3
  it('returns degraded when an OAuth endpoint is auth_required', () => {
    const endpoints: Endpoint[] = [
      makeEndpoint({ name: 'github', transport: 'oauth' }),
    ];
    const oauthStatuses = new Map<string, OAuthStatus>([
      ['github', makeOAuthStatus({ status: 'auth_required' })],
    ]);
    expect(deriveTrayHealth('running', true, endpoints, oauthStatuses)).toBe('degraded');
  });

  // #4
  it('returns degraded when an OAuth endpoint is needs_login', () => {
    const endpoints: Endpoint[] = [
      makeEndpoint({ name: 'github', transport: 'oauth' }),
    ];
    const oauthStatuses = new Map<string, OAuthStatus>([
      ['github', makeOAuthStatus({ status: 'needs_login' })],
    ]);
    expect(deriveTrayHealth('running', true, endpoints, oauthStatuses)).toBe('degraded');
  });

  // #5
  it('returns degraded when one endpoint has a Failed lifecycle', () => {
    const endpoints: Endpoint[] = [
      makeEndpoint({
        name: 'broken',
        lifecycle: { state: 'Failed', error: { kind: 'spawn', detail: 'boom' } },
      }),
    ];
    expect(deriveTrayHealth('running', true, endpoints, new Map())).toBe('degraded');
  });

  // #6
  it('returns healthy when all endpoints are disabled (nothing enabled to be wrong)', () => {
    const endpoints: Endpoint[] = [
      makeEndpoint({ name: 'a', disabled: true, health: 'offline' }),
      makeEndpoint({ name: 'b', disabled: true, health: 'error' }),
    ];
    expect(deriveTrayHealth('running', true, endpoints, new Map())).toBe('healthy');
  });

  // #7
  it('returns healthy with a mix of disabled and healthy endpoints (disabled excluded)', () => {
    const endpoints: Endpoint[] = [
      makeEndpoint({ name: 'a', disabled: true, health: 'offline' }),
      makeEndpoint({ name: 'b' }),
    ];
    expect(deriveTrayHealth('running', true, endpoints, new Map())).toBe('healthy');
  });

  // #8
  it('returns degraded when a disabled unhealthy endpoint is mixed with an enabled unhealthy one', () => {
    const endpoints: Endpoint[] = [
      makeEndpoint({ name: 'a', disabled: true, health: 'healthy' }),
      makeEndpoint({ name: 'b', health: 'error' }),
    ];
    expect(deriveTrayHealth('running', true, endpoints, new Map())).toBe('degraded');
  });

  // #9
  it('returns down when sidecar status is failed (regardless of endpoints)', () => {
    const endpoints: Endpoint[] = [makeEndpoint({ name: 'a' })];
    expect(deriveTrayHealth('failed', true, endpoints, new Map())).toBe('down');
  });

  // #10
  it('returns down when sidecar status is stopped', () => {
    expect(deriveTrayHealth('stopped', true, [], new Map())).toBe('down');
  });

  // #11
  it('returns down when relay is not connected and sidecar is not starting/unknown', () => {
    expect(deriveTrayHealth('running', false, [], new Map())).toBe('down');
  });

  // #12
  it('returns healthy when sidecar is starting (optimistic during startup)', () => {
    const endpoints: Endpoint[] = [makeEndpoint({ name: 'a', health: 'error' })];
    expect(deriveTrayHealth('starting', false, endpoints, new Map())).toBe('healthy');
  });

  // #13
  it('returns healthy when sidecar is restarting (optimistic during restart)', () => {
    const endpoints: Endpoint[] = [makeEndpoint({ name: 'a', health: 'error' })];
    expect(deriveTrayHealth('restarting', true, endpoints, new Map())).toBe('healthy');
  });

  // #14
  it('returns healthy when no endpoints are configured', () => {
    expect(deriveTrayHealth('running', true, [], new Map())).toBe('healthy');
  });

  // #15
  it('returns healthy when an endpoint is in starting health (initializing is expected)', () => {
    const endpoints: Endpoint[] = [
      makeEndpoint({ name: 'a', health: 'starting' }),
      makeEndpoint({ name: 'b' }),
    ];
    expect(deriveTrayHealth('running', true, endpoints, new Map())).toBe('healthy');
  });
});

describe('describeTrayHealthIssue', () => {
  it('returns "Relay failed: <first line>" when sidecar failed with an error', () => {
    const detail = describeTrayHealthIssue(
      'failed',
      'Address already in use\nstack trace line 1\nstack trace line 2',
      true,
      [],
      new Map(),
    );
    expect(detail).toBe('Relay failed: Address already in use');
  });

  it('returns "Relay failed" when sidecar failed with no error message', () => {
    expect(describeTrayHealthIssue('failed', null, true, [], new Map())).toBe('Relay failed');
    expect(describeTrayHealthIssue('failed', '', true, [], new Map())).toBe('Relay failed');
  });

  it('returns "Relay stopped" when sidecar is stopped', () => {
    expect(describeTrayHealthIssue('stopped', null, true, [], new Map())).toBe('Relay stopped');
  });

  it('returns "Relay not reachable" when sidecar is running but not connected', () => {
    expect(describeTrayHealthIssue('running', null, false, [], new Map())).toBe(
      'Relay not reachable',
    );
  });

  it('returns null while starting / restarting / unknown even if not connected (optimistic)', () => {
    expect(describeTrayHealthIssue('starting', null, false, [], new Map())).toBeNull();
    expect(describeTrayHealthIssue('restarting', null, false, [], new Map())).toBeNull();
    expect(describeTrayHealthIssue('unknown', null, false, [], new Map())).toBeNull();
  });

  it('returns "Sign in required for {name}" when exactly one OAuth endpoint needs login', () => {
    const endpoints: Endpoint[] = [
      makeEndpoint({ name: 'github-mcp', transport: 'oauth' }),
      makeEndpoint({ name: 'b' }),
    ];
    const oauth = new Map<string, OAuthStatus>([
      ['github-mcp', makeOAuthStatus({ status: 'needs_login' })],
    ]);
    expect(describeTrayHealthIssue('running', null, true, endpoints, oauth)).toBe(
      'Sign in required for github-mcp',
    );
  });

  it('returns "N endpoints need sign-in" when multiple OAuth endpoints need login', () => {
    const endpoints: Endpoint[] = [
      makeEndpoint({ name: 'github-mcp', transport: 'oauth' }),
      makeEndpoint({ name: 'slack-mcp', transport: 'oauth' }),
    ];
    const oauth = new Map<string, OAuthStatus>([
      ['github-mcp', makeOAuthStatus({ status: 'needs_login' })],
      ['slack-mcp', makeOAuthStatus({ status: 'auth_required' })],
    ]);
    expect(describeTrayHealthIssue('running', null, true, endpoints, oauth)).toBe(
      '2 endpoints need sign-in',
    );
  });

  it('returns "{name} unhealthy" when exactly one non-OAuth endpoint is unhealthy', () => {
    const endpoints: Endpoint[] = [
      makeEndpoint({ name: 'pg', health: 'error' }),
      makeEndpoint({ name: 'b' }),
    ];
    expect(describeTrayHealthIssue('running', null, true, endpoints, new Map())).toBe(
      'pg unhealthy',
    );
  });

  it('returns "N endpoints need attention" when problems are a mix of auth and health buckets', () => {
    const endpoints: Endpoint[] = [
      makeEndpoint({ name: 'github-mcp', transport: 'oauth' }),
      makeEndpoint({ name: 'pg', health: 'error' }),
    ];
    const oauth = new Map<string, OAuthStatus>([
      ['github-mcp', makeOAuthStatus({ status: 'needs_login' })],
    ]);
    expect(describeTrayHealthIssue('running', null, true, endpoints, oauth)).toBe(
      '2 endpoints need attention',
    );
  });

  it('returns null when everything is healthy', () => {
    const endpoints: Endpoint[] = [
      makeEndpoint({ name: 'a' }),
      makeEndpoint({ name: 'b' }),
    ];
    expect(describeTrayHealthIssue('running', null, true, endpoints, new Map())).toBeNull();
  });

  it('excludes disabled endpoints from counts and names', () => {
    // Two enabled OAuth endpoints with auth issues plus a disabled offline
    // one — the disabled endpoint must not change the message.
    const endpoints: Endpoint[] = [
      makeEndpoint({ name: 'github-mcp', transport: 'oauth' }),
      makeEndpoint({ name: 'slack-mcp', transport: 'oauth' }),
      makeEndpoint({ name: 'old', disabled: true, health: 'offline' }),
    ];
    const oauth = new Map<string, OAuthStatus>([
      ['github-mcp', makeOAuthStatus({ status: 'needs_login' })],
      ['slack-mcp', makeOAuthStatus({ status: 'needs_login' })],
    ]);
    expect(describeTrayHealthIssue('running', null, true, endpoints, oauth)).toBe(
      '2 endpoints need sign-in',
    );

    // And a single disabled-only unhealthy endpoint surfaces as healthy.
    const onlyDisabled: Endpoint[] = [
      makeEndpoint({ name: 'a', disabled: true, health: 'error' }),
    ];
    expect(describeTrayHealthIssue('running', null, true, onlyDisabled, new Map())).toBeNull();
  });

  it('treats an OAuth endpoint with both auth + health issues as an auth problem (auth wins)', () => {
    // Regression test for the Todoist case: the OAuth re-login is the
    // actionable cause and any downstream health/lifecycle failure on the
    // same endpoint must not mask the sign-in copy.
    const endpoints: Endpoint[] = [
      makeEndpoint({ name: 'github-mcp', transport: 'oauth', health: 'error' }),
    ];
    const oauth = new Map<string, OAuthStatus>([
      ['github-mcp', makeOAuthStatus({ status: 'needs_login' })],
    ]);
    expect(describeTrayHealthIssue('running', null, true, endpoints, oauth)).toBe(
      'Sign in required for github-mcp',
    );
  });

  it('treats an OAuth endpoint with needs_login + failed lifecycle as an auth problem (Todoist regression)', () => {
    const endpoints: Endpoint[] = [
      makeEndpoint({
        name: 'todoist',
        transport: 'oauth',
        health: 'error',
        lifecycle: { state: 'Failed', error: { kind: 'spawn', detail: 'auth' } },
      }),
    ];
    const oauth = new Map<string, OAuthStatus>([
      ['todoist', makeOAuthStatus({ status: 'needs_login' })],
    ]);
    expect(describeTrayHealthIssue('running', null, true, endpoints, oauth)).toBe(
      'Sign in required for todoist',
    );
  });

  it('treats an OAuth endpoint with auth_required + health error as an auth problem', () => {
    const endpoints: Endpoint[] = [
      makeEndpoint({ name: 'jira', transport: 'oauth', health: 'error' }),
    ];
    const oauth = new Map<string, OAuthStatus>([
      ['jira', makeOAuthStatus({ status: 'auth_required' })],
    ]);
    expect(describeTrayHealthIssue('running', null, true, endpoints, oauth)).toBe(
      'Sign in required for jira',
    );
  });

  it('reports an auth-OK OAuth endpoint with failed lifecycle as "unhealthy"', () => {
    const endpoints: Endpoint[] = [
      makeEndpoint({
        name: 'linear',
        transport: 'oauth',
        lifecycle: { state: 'Failed', error: { kind: 'spawn', detail: 'boom' } },
      }),
    ];
    const oauth = new Map<string, OAuthStatus>([
      ['linear', makeOAuthStatus({ status: 'authenticated' })],
    ]);
    expect(describeTrayHealthIssue('running', null, true, endpoints, oauth)).toBe(
      'linear unhealthy',
    );
  });

  it('returns "N endpoints need sign-in" when two OAuth endpoints both need login and both have failed lifecycle', () => {
    const endpoints: Endpoint[] = [
      makeEndpoint({
        name: 'github-mcp',
        transport: 'oauth',
        health: 'error',
        lifecycle: { state: 'Failed', error: { kind: 'spawn', detail: 'auth' } },
      }),
      makeEndpoint({
        name: 'slack-mcp',
        transport: 'oauth',
        health: 'error',
        lifecycle: { state: 'Failed', error: { kind: 'spawn', detail: 'auth' } },
      }),
    ];
    const oauth = new Map<string, OAuthStatus>([
      ['github-mcp', makeOAuthStatus({ status: 'needs_login' })],
      ['slack-mcp', makeOAuthStatus({ status: 'needs_login' })],
    ]);
    expect(describeTrayHealthIssue('running', null, true, endpoints, oauth)).toBe(
      '2 endpoints need sign-in',
    );
  });

  it('returns "N endpoints unhealthy" when all problems are health-bucket and none are auth', () => {
    const endpoints: Endpoint[] = [
      makeEndpoint({ name: 'a', health: 'error' }),
      makeEndpoint({ name: 'b', health: 'offline' }),
      makeEndpoint({
        name: 'c',
        lifecycle: { state: 'Failed', error: { kind: 'spawn', detail: 'boom' } },
      }),
    ];
    expect(describeTrayHealthIssue('running', null, true, endpoints, new Map())).toBe(
      '3 endpoints unhealthy',
    );
  });
});
