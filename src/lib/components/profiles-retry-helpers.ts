import type { RelaySidecarStatusType } from '$lib/stores';
import type { TopLevelTabId } from '$lib/relaySidecarUi';

/**
 * True when the Profiles top-level tab just became active while the last
 * profiles load failed. `prevTab === undefined` means this is the initial
 * subscription callback (onMount already loads), so it never triggers.
 * Staying on the profiles tab (prevTab === 'profiles') doesn't re-trigger —
 * only an actual activation transition does.
 */
export function shouldAutoReloadOnTabActivation(
  tab: TopLevelTabId,
  prevTab: TopLevelTabId | undefined,
  hasLoadError: boolean,
): boolean {
  return tab === 'profiles' && prevTab !== undefined && prevTab !== 'profiles' && hasLoadError;
}

/**
 * True when the relay sidecar just transitioned to `running` while the last
 * profiles load failed — covers the user sitting on the Profiles tab through
 * a relay restart. `prevStatus === undefined` (initial subscription callback)
 * never triggers.
 */
export function shouldAutoReloadOnRelayRecovery(
  status: RelaySidecarStatusType,
  prevStatus: RelaySidecarStatusType | undefined,
  hasLoadError: boolean,
): boolean {
  return status === 'running' && prevStatus !== undefined && prevStatus !== 'running' && hasLoadError;
}
