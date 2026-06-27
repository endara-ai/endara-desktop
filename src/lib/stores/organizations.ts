import { writable } from 'svelte/store';
import { listOrganizations } from '$lib/api';
import type { Organization } from '$lib/types';

// Shared organizations state. Settings → Organizations used to read this into a
// component-local `$state` array, so a freshly-created org (including one still
// pending sign-in) only appeared after an app/relay restart or a remount. Now
// the store is the single source of truth: the Connect-org flow refreshes it
// after creating an org and on auth-poll resolution, and Settings subscribes.
export const organizations = writable<Organization[]>([]);

// Pull the current organization list from the relay and publish it to the
// shared store. Throws on failure so callers that own loading/error UI (the
// Settings section's mount) can surface it; mutation-time callers (Connect-org
// modal) wrap this in a try/catch since the mutation already succeeded.
export async function refreshOrganizations(): Promise<void> {
  organizations.set(await listOrganizations());
}
