import { describe, expect, it } from 'vitest';

import profilesSource from './Profiles.svelte?raw';
import profilesTabSource from './ProfilesTab.svelte?raw';
import {
  shouldAutoReloadOnRelayRecovery,
  shouldAutoReloadOnTabActivation,
} from './profiles-retry-helpers';

// Coverage for "recover Profiles tab from transient load failure".
//
// The Svelte components can't be mounted in the node test environment
// (matching the convention documented in Profiles.unsaved.test.ts), so the
// component wiring is asserted at the source level and the reload-decision
// logic is exercised behaviourally through the extracted helpers.

describe('Profiles error-state Retry button (source wiring)', () => {
  it('renders a Retry button in the load-error branch that calls retry()', () => {
    // Error branch shows the message plus a Retry button wired to retry().
    expect(profilesSource).toMatch(
      /\{#if loadError && profiles\.length === 0\}[\s\S]*?\{loadError\}[\s\S]*?<button[\s\S]*?onclick=\{retry\}[\s\S]*?Retry[\s\S]*?\{:else if/,
    );
  });

  it('retry() re-runs load() and exposes a retrying state for the button', () => {
    expect(profilesSource).toMatch(
      /async function retry\(\)\s*\{[\s\S]*?retrying = true;[\s\S]*?await load\(\);[\s\S]*?retrying = false;[\s\S]*?\}/,
    );
    expect(profilesSource).toMatch(/disabled=\{retrying\}/);
    expect(profilesSource).toMatch(/retrying \? 'Retrying…' : 'Retry'/);
  });

  it('load() success populates profiles and clears loadError (Retry renders data)', () => {
    // Clicking Retry runs load(); on success it stores the fetched profiles
    // and clears the error, which switches the template off the error branch.
    expect(profilesSource).toMatch(
      /const data = await listProfiles\(\);\s*profiles = data;\s*loadError = '';/,
    );
  });
});

describe('Profiles auto-reload subscriptions (source wiring)', () => {
  it('subscribes to activeTopLevelTab and retries via shouldAutoReloadOnTabActivation', () => {
    expect(profilesSource).toMatch(
      /activeTopLevelTab\.subscribe\(\(tab\) => \{[\s\S]*?shouldAutoReloadOnTabActivation\(tab, prevTab, Boolean\(loadError\)\)[\s\S]*?void retry\(\);[\s\S]*?prevTab = tab;/,
    );
  });

  it('subscribes to relaySidecarStatus and retries via shouldAutoReloadOnRelayRecovery', () => {
    expect(profilesSource).toMatch(
      /relaySidecarStatus\.subscribe\(\(status\) => \{[\s\S]*?shouldAutoReloadOnRelayRecovery\(status, prevRelayStatus, Boolean\(loadError\)\)[\s\S]*?void retry\(\);[\s\S]*?prevRelayStatus = status;/,
    );
  });

  it('cleans up both subscriptions on unmount', () => {
    expect(profilesSource).toMatch(
      /return \(\) => \{\s*unsubTab\(\);\s*unsubRelay\(\);\s*\};/,
    );
  });
});

describe('shouldAutoReloadOnTabActivation', () => {
  it('triggers when the profiles tab becomes active after a failed load', () => {
    expect(shouldAutoReloadOnTabActivation('profiles', 'servers', true)).toBe(true);
    expect(shouldAutoReloadOnTabActivation('profiles', 'settings', true)).toBe(true);
  });

  it('does not trigger when the last load succeeded', () => {
    expect(shouldAutoReloadOnTabActivation('profiles', 'servers', false)).toBe(false);
  });

  it('does not trigger on the initial subscription callback (onMount already loads)', () => {
    expect(shouldAutoReloadOnTabActivation('profiles', undefined, true)).toBe(false);
  });

  it('does not re-trigger while staying on the profiles tab', () => {
    expect(shouldAutoReloadOnTabActivation('profiles', 'profiles', true)).toBe(false);
  });

  it('does not trigger when a different tab becomes active', () => {
    expect(shouldAutoReloadOnTabActivation('servers', 'profiles', true)).toBe(false);
    expect(shouldAutoReloadOnTabActivation('settings', 'servers', true)).toBe(false);
  });
});

describe('shouldAutoReloadOnRelayRecovery', () => {
  it('triggers when the relay transitions to running while loadError is set', () => {
    expect(shouldAutoReloadOnRelayRecovery('running', 'restarting', true)).toBe(true);
    expect(shouldAutoReloadOnRelayRecovery('running', 'starting', true)).toBe(true);
    expect(shouldAutoReloadOnRelayRecovery('running', 'failed', true)).toBe(true);
  });

  it('does not trigger when the last load succeeded', () => {
    expect(shouldAutoReloadOnRelayRecovery('running', 'restarting', false)).toBe(false);
  });

  it('does not trigger on the initial subscription callback', () => {
    expect(shouldAutoReloadOnRelayRecovery('running', undefined, true)).toBe(false);
  });

  it('does not re-trigger while the relay stays running', () => {
    expect(shouldAutoReloadOnRelayRecovery('running', 'running', true)).toBe(false);
  });

  it('does not trigger on transitions to non-running states', () => {
    expect(shouldAutoReloadOnRelayRecovery('failed', 'running', true)).toBe(false);
    expect(shouldAutoReloadOnRelayRecovery('restarting', 'running', true)).toBe(false);
  });
});

describe('ProfilesTab error-state Retry button (source wiring)', () => {
  it('renders a Retry button in the error branch that re-runs load($selectedEndpoint)', () => {
    expect(profilesTabSource).toMatch(
      /\{:else if error\}[\s\S]*?\{error\}[\s\S]*?<button[\s\S]*?if \(\$selectedEndpoint\) load\(\$selectedEndpoint\);[\s\S]*?Retry[\s\S]*?\{:else if rows\.length === 0\}/,
    );
  });
});
