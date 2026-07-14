// Picks "the run our dispatch just created" out of `gh run list` output —
// NOT "whatever run is most recent". Polling for "most recent" is wrong: a
// retry after a failed Windows build would see that stale failed run again
// and immediately report failure, without ever looking at the new attempt.
//
// A run only counts as ours if:
//   - event === "workflow_dispatch" (this workflow has no other trigger, but
//     the check stays explicit rather than trusting that invariant silently)
//   - createdAt is strictly after `since`, the timestamp release.sh recorded
//     immediately before calling `gh workflow run`
//
// Returns the run with the EARLIEST qualifying createdAt (the run our
// dispatch call actually produced, not a later unrelated dispatch that might
// race in), or null if none qualify yet.

/**
 * @param {Array<{databaseId: number|string, createdAt: string, event: string}>} runs
 * @param {string} since ISO 8601 timestamp
 * @returns {{databaseId: number|string, createdAt: string, event: string} | null}
 */
export function findDispatchedRun(runs, since) {
  const sinceMs = new Date(since).getTime();
  if (Number.isNaN(sinceMs)) {
    throw new Error(`invalid "since" timestamp: ${since}`);
  }
  const candidates = (runs ?? [])
    .filter((r) => r && r.event === "workflow_dispatch")
    .filter((r) => new Date(r.createdAt).getTime() > sinceMs)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return candidates[0] ?? null;
}
