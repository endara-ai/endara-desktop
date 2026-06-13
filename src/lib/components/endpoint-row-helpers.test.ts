import { describe, it, expect } from 'vitest';

import type { IsolationState } from '$lib/types';
import {
  getIsolationBadge,
  getCustomImage,
  DEFAULT_CONTAINER_IMAGE,
} from './endpoint-row-helpers';

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

describe('getCustomImage', () => {
  it('returns null when isolation_state is absent or not containerized', () => {
    expect(getCustomImage(undefined)).toBeNull();
    expect(getCustomImage(null)).toBeNull();
    expect(getCustomImage({ configured: 'container', actual: 'direct' })).toBeNull();
  });

  it('returns null when the image is the default runner image', () => {
    const iso: IsolationState = {
      configured: 'container',
      actual: 'container',
      runtime: 'docker',
      image: DEFAULT_CONTAINER_IMAGE,
    };
    expect(getCustomImage(iso)).toBeNull();
  });

  it('returns the image string when a custom image is in effect', () => {
    const iso: IsolationState = {
      configured: 'container',
      actual: 'container',
      runtime: 'docker',
      image: 'node:20-alpine',
    };
    expect(getCustomImage(iso)).toBe('node:20-alpine');
  });

  it('ignores container_name entirely (internal plumbing, never surfaced)', () => {
    expect(
      getCustomImage({
        configured: 'container',
        actual: 'container',
        container_name: 'endara-mcp-github',
      }),
    ).toBeNull();
    expect(
      getCustomImage({
        configured: 'container',
        actual: 'container',
        image: 'node:20',
        container_name: 'endara-mcp-github',
      }),
    ).toBe('node:20');
  });

  it('returns null when containerized but no image is reported', () => {
    expect(getCustomImage({ configured: 'container', actual: 'container' })).toBeNull();
  });
});

// Source-level guard: the isolation badge must live only in the detail-panel
// header, never in the sidebar row. Mirrors the `?raw` source-assertion
// pattern used in ToastFeed.test.ts since the test env doesn't mount Svelte.
describe('sidebar / detail isolation badge placement', () => {
  it('EndpointRow.svelte renders no IsolationBadge', async () => {
    const src = (await import('./EndpointRow.svelte?raw')).default as string;
    expect(src).not.toContain('IsolationBadge');
  });

  it('DetailPanel.svelte still renders the IsolationBadge in its header', async () => {
    const src = (await import('./DetailPanel.svelte?raw')).default as string;
    expect(src).toContain('IsolationBadge');
  });
});
