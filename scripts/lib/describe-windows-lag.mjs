// Windows is opt-in (`./scripts/release.sh --with-windows`) — the default
// path ships macOS only. The failure mode of an opt-in step is "nobody
// remembers to opt in, ever again" and Windows users silently fall behind
// forever while every release note says "updated!". This module makes that
// state impossible to miss: given the release history (newest first, GitHub
// release assets as the source of truth — not our own bookkeeping), it
// counts how many releases in a row (counting from the most recent) shipped
// without a Windows asset, and which release last had one.
//
// release.sh always computes this and prints the answer whenever it deploys
// WITHOUT --with-windows — see scripts/describe-windows-lag-cli.mjs for the
// CLI wrapper that feeds it real `gh release view` data.

/**
 * @param {Array<{tag: string, hasWindows: boolean}>} releases newest-first,
 *   NOT including the release currently being shipped (release.sh adds +1
 *   for that itself, since it's mid-flight and not on GitHub as "no windows"
 *   until this deploy completes).
 * @returns {{staleCount: number, lastWindowsTag: string | null}}
 *   staleCount: how many of the given (past) releases in a row lack Windows.
 *   lastWindowsTag: the most recent past release that DID ship Windows, or
 *   null if none in the given history ever did.
 */
export function describeWindowsLag(releases) {
  let staleCount = 0;
  let lastWindowsTag = null;
  for (const r of releases ?? []) {
    if (r.hasWindows) {
      lastWindowsTag = r.tag;
      break;
    }
    staleCount++;
  }
  return { staleCount, lastWindowsTag };
}
