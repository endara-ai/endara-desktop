import { describe, it, expect } from 'vitest';

import type { IsolationState } from '$lib/types';
import { getIsolationBadge, getIsolationDetail } from './endpoint-row-helpers';

// The test env is Node (vitest.config.ts), so we exercise the pure helpers
// shared by `EndpointRow.svelte` / `DetailPanel.svelte` (via
// `IsolationBadge.svelte`) rather than mounting Svelte components — same
// pattern as ToolCallRow.test.ts and detail-panel-helpers.test.ts.

describe('getIsolationBadge', () => {
  it('returns null when isolation_state is absent (older relay / non-stdio)', () => {
    expect(getIsolationBadge(undefined)).toBeNull();
    expect(getIsolationBadge(null)).toBeNull();
  });

  it('returns null for a normal direct spawn (configured = none, actual = direct)', () => {
    const iso: IsolationState = { configured: 'none', actual: 'direct' };
    expect(getIsolationBadge(iso)).toBeNull();
  });

  it('returns a container badge naming the runtime when actual = container', () => {
    const iso: IsolationState = {
      configured: 'container',
      actual: 'container',
      runtime: 'docker',
    };
    const badge = getIsolationBadge(iso);
    expect(badge?.kind).toBe('container');
    expect(badge?.label).toBe('Containerized (docker)');
  });

  it('names podman when that is the reported runtime', () => {
    const iso: IsolationState = {
      configured: 'container',
      actual: 'container',
      runtime: 'podman',
    };
    expect(getIsolationBadge(iso)?.label).toBe('Containerized (podman)');
  });

  it('omits the runtime suffix when the relay does not report one', () => {
    const iso: IsolationState = { configured: 'container', actual: 'container' };
    const badge = getIsolationBadge(iso);
    expect(badge?.kind).toBe('container');
    expect(badge?.label).toBe('Containerized');
  });

  it('returns a warning fallback badge when configured = container but actual = direct', () => {
    const iso: IsolationState = { configured: 'container', actual: 'direct' };
    const badge = getIsolationBadge(iso);
    expect(badge?.kind).toBe('fallback');
    expect(badge?.label).toBe('Direct (fallback)');
    expect(badge?.title).toContain('fell back');
  });
});

describe('getIsolationDetail', () => {
  it('returns null when isolation_state is absent or not containerized', () => {
    expect(getIsolationDetail(undefined)).toBeNull();
    expect(getIsolationDetail(null)).toBeNull();
    expect(getIsolationDetail({ configured: 'container', actual: 'direct' })).toBeNull();
  });

  it('joins image and container name when both are reported', () => {
    const iso: IsolationState = {
      configured: 'container',
      actual: 'container',
      runtime: 'docker',
      image: 'node:20-alpine',
      container_name: 'endara-mcp-github',
    };
    expect(getIsolationDetail(iso)).toBe('node:20-alpine · endara-mcp-github');
  });

  it('renders whichever of image / container name is present', () => {
    expect(
      getIsolationDetail({ configured: 'container', actual: 'container', image: 'node:20' }),
    ).toBe('node:20');
    expect(
      getIsolationDetail({
        configured: 'container',
        actual: 'container',
        container_name: 'endara-mcp-fetch',
      }),
    ).toBe('endara-mcp-fetch');
  });

  it('returns null when containerized but neither image nor name is reported', () => {
    expect(getIsolationDetail({ configured: 'container', actual: 'container' })).toBeNull();
  });
});
