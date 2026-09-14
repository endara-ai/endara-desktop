/**
 * A guarded async task: calling it while a previous call is still pending
 * resolves to `undefined` immediately instead of starting a second run.
 */
export interface GuardedTask<T> {
  (): Promise<T | undefined>;
  /** `true` while a run started by this wrapper has not settled yet. */
  readonly inFlight: boolean;
  /** Number of calls skipped because a run was already in flight. */
  readonly skipped: number;
}

/**
 * Wrap a polling tick so at most one invocation is in flight at a time.
 *
 * `setInterval` keeps firing on schedule regardless of how long the previous
 * tick took; when the backend is slow (or the IPC bridge stalls) that piles up
 * unbounded concurrent requests. Pollers wrap their tick with this helper so a
 * slow tick simply causes the next interval fire(s) to be skipped.
 */
export function guardInFlight<T>(fn: () => Promise<T>): GuardedTask<T> {
  let inFlight = false;
  let skipped = 0;
  const run = async (): Promise<T | undefined> => {
    if (inFlight) {
      skipped++;
      return undefined;
    }
    inFlight = true;
    try {
      return await fn();
    } finally {
      inFlight = false;
    }
  };
  Object.defineProperty(run, 'inFlight', { get: () => inFlight });
  Object.defineProperty(run, 'skipped', { get: () => skipped });
  return run as GuardedTask<T>;
}
