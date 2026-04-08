import type { OAuthStatus, OAuthStatusValue, OAuthDisplayStatus, HealthStatus } from '$lib/types';

const statusMap: Record<OAuthStatusValue, OAuthDisplayStatus> = {
  authenticated: {
    color: 'green',
    label: 'Authenticated',
    healthDotVariant: 'healthy',
    canConnect: false,
    canDisconnect: true,
    canRefresh: true,
  },
  needs_login: {
    color: 'yellow',
    label: 'Needs Login',
    healthDotVariant: 'degraded',
    canConnect: true,
    canDisconnect: false,
    canRefresh: false,
  },
  refreshing: {
    color: 'blue',
    label: 'Refreshing',
    healthDotVariant: 'healthy',
    canConnect: false,
    canDisconnect: false,
    canRefresh: false,
  },
  auth_required: {
    color: 'orange',
    label: 'Auth Required',
    healthDotVariant: 'error',
    canConnect: true,
    canDisconnect: false,
    canRefresh: false,
  },
  disconnected: {
    color: 'gray',
    label: 'Disconnected',
    healthDotVariant: 'offline',
    canConnect: true,
    canDisconnect: false,
    canRefresh: false,
  },
  connection_failed: {
    color: 'red',
    label: 'Connection Failed',
    healthDotVariant: 'error',
    canConnect: false,
    canDisconnect: true,
    canRefresh: true,
  },
};

export function deriveOAuthDisplayStatus(status: OAuthStatus): OAuthDisplayStatus {
  return { ...statusMap[status.status] };
}

