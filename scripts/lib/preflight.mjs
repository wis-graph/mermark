// Preflight health check for the CDP golden scripts: refuse to MEASURE a page
// that never rendered properly. Shared by every golden script (nav-trace /
// mermaid-golden / settings-golden / cdp-debug) so the rule lives in exactly
// one place — a rule copy-pasted into four scripts drifts when only one copy
// gets fixed.
//
// WHY THIS EXISTS (do not delete as "an unnecessary check"):
//
// A golden capture taken from a page that failed to boot produces numbers that
// LOOK like data. Diffing two such captures ("before" vs "after") yields a
// confident-looking regression report built on garbage. During the plugin-API
// refactor a phantom "decisive caret regression" was chased for a full QA round
// before anyone checked whether the page under measurement had rendered at all.
// A silent bad measurement is worse than a crash: it does not look like a
// failure, so it gets believed.
//
// The common ways to get such a page: the Vite dev server
// (`npm run dev:browser`) keeps a transformed-module cache that survives
// `git stash` / branch switches — swapping the working tree does not restart or
// reliably invalidate an already-running `vite --mode browser` process; and a
// Chrome tab left open across a dev-server restart keeps showing a dead page.
// Both are fixed by a cold restart (see the failure message).
//
// SIGNAL CHOICE — the part that is easy to get wrong, so it is spelled out.
// The check must be:
//
//   (a) VIEWPORT-INDEPENDENT. CodeMirror virtualizes: only lines in the visible
//       viewport exist in the DOM. The fixture doc (src/mocks/tauri-core.ts
//       `SAMPLE`) is ~2200px tall while the scroller shows ~400px, so only ~14
//       of its lines render. The FIRST version of this guard asserted
//       `.cm-table > 0` — but the fixture's "## Table" sits at line 51, far
//       below the fold, so it renders in NO reasonable window size without
//       scrolling. That guard returned 0 on a perfectly healthy page and would
//       have blocked every golden run forever. It was caught only by running it
//       against a real browser; a mocked `evaluate` returning 1 "passed" it.
//       Do not re-introduce a below-the-fold signal.
//
//   (b) SYNCHRONOUS. Async widgets (mermaid, katex) have legitimate render
//       delays and independent failure modes, so a missing one is not evidence
//       of a bad bundle — using one here would make this guard flaky.
//
//   (c) PRODUCED BY THE LIVE-PREVIEW PIPELINE. A bare `.cm-line` count only
//       proves CodeMirror mounted; it would still pass if every markdown
//       feature silently failed to load. A decoration class exists only if the
//       inline live-preview pipeline actually ran over the document.
//
// `.cm-heading` satisfies all three: the fixture opens with an H1 on its first
// line (always in view), the heading feature is a synchronous inline
// decoration, and the class is applied by the live-preview pipeline itself.
const REQUIRED = [
  // [selector, why a healthy page must have it]
  [".cm-line", "CodeMirror mounted and rendered the document"],
  [".cm-heading", "the inline live-preview pipeline decorated the fixture's H1"],
];

/**
 * Assert that `page` actually rendered, or print the fix and exit(1). Call this
 * AFTER the page's normal settle wait, at the point the golden script is about
 * to begin measuring.
 *
 * @param {import("playwright").Page} page
 * @param {{ context?: string }} [opts] label for the error (e.g. the script
 *   name) so a failure inside a multi-script run is traceable.
 */
export async function assertPageRendered(page, opts = {}) {
  const counts = await page.evaluate(
    (sels) => sels.map((s) => document.querySelectorAll(s).length),
    REQUIRED.map(([sel]) => sel),
  );
  const missing = REQUIRED.map(([sel, why], i) => [sel, why, counts[i]]).filter(
    ([, , n]) => n === 0,
  );
  if (missing.length === 0) return;

  const label = opts.context ? ` [${opts.context}]` : "";
  const detail = missing
    .map(([sel, why]) => `    ${sel} → 0   (expected > 0: ${why})`)
    .join("\n");
  console.error(
    `\n✖ PAGE DID NOT RENDER${label} — refusing to measure.\n\n` +
      `${detail}\n\n` +
      `  A golden captured from this page would be garbage that LOOKS like data.\n` +
      `  Most likely the dev server is serving a stale module graph, or the tab is\n` +
      `  a dead page left over from a dev-server restart. Both are fixed by a cold\n` +
      `  restart — the Vite cache survives \`git stash\` / branch switches:\n\n` +
      `    pkill -f "vite --mode browser"\n` +
      `    rm -rf node_modules/.vite\n` +
      `    npm run dev:browser\n` +
      `    # then relaunch/reload the CDP tab and re-run this script\n\n` +
      `  If the fixture doc (src/mocks/tauri-core.ts SAMPLE) lost its leading\n` +
      `  heading, fix the signal here instead — but read SIGNAL CHOICE above first.\n`,
  );
  process.exit(1);
}
