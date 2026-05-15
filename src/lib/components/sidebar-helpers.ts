/**
 * Whether `Sidebar.svelte` should render the loading skeleton instead of
 * the endpoint list. We show the skeleton while we haven't yet completed
 * a first successful endpoint poll — at that point `endpoints` is still
 * `[]` but the empty state would be misleading. Once `initialLoadComplete`
 * flips to true, the parent route routes loaded-but-empty into the
 * existing onboarding/empty UI via `showOnboarding`.
 */
export function shouldShowSidebarSkeleton(initialLoadComplete: boolean): boolean {
  return !initialLoadComplete;
}

