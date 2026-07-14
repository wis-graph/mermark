// Golden-master capture for the R11 viewer registry (_workspace/01_r11.md
// §7/§9 Step 5). Exercises the SAME dispatch path built-in (image) and
// extension (Excel) viewers now share, so a regression in either shows up
// here regardless of which one it hits.
//
//   node scripts/viewer-golden.mjs /tmp/viewer-golden.json
//
// Requires:
//   - `npm run dev:browser` + Chrome --remote-debugging-port=9222 running
//   - mock-assets/mock/vault/report.xlsx present (scripts/lib/make-excel-fixture.mjs)
//
// G1 (behavior-unchanged + VISUAL): pic.png → .viewer-backdrop/.image-viewer,
//     img src, dimmed backdrop, opaque panel with real chrome, Esc → full
//     teardown + .editor-host inert removed.
// G2 (cold-load NEGATIVE): boot alone never fetches an xlsx-named resource.
//     Written FIRST — a golden whose only signal is "0 resources" is
//     trivially green if the selector/probe itself is broken (this
//     session's "sidebar-contrast could never fail" lesson), so G3's
//     positive count is what actually proves this probe is alive.
// G3 (cold-load POSITIVE + render + VISUAL): report.xlsx → .excel-viewer,
//     known fixture cell text, 3 sheet tabs, resource entries ≥1, dimmed
//     backdrop, opaque panel, sheet data in exactly ONE <table> (not
//     scattered across disconnected boxes — the audit's screenshot finding,
//     04_audit_report.md).
// G4 (don't-stack): image open, then Excel open (no close between) →
//     exactly one .viewer-backdrop.
// G5 (inert preserved): an unclaimed extension (data.json) stays .is-nonmd
//     and inert.
// G6 (truncation caption is TRUTHFUL + CONTAINED): the fixture's "Big" sheet
//     has MAX_RENDERED_ROWS + 5 real rows — the caption must state the TRUE
//     total (not a count derived from the already-capped row array, the
//     bug the audit found: 04_audit_report.md 🟠) AND the 10,005-row table
//     must stay inside its panel (the SECOND real-device regression: a
//     small 3-row sheet, as G3 loads, never exposes an overflow bug — only
//     a genuinely large sheet does, which is this fixture's whole reason
//     to exist).
// G7~G9 (R11 2단계, _workspace/01_html_viewer.md §8 — HTML viewer):
// G7 (render positive + VISUAL): sample.html → .html-viewer iframe exists,
//     sandboxed frame's OWN document (reached via Playwright's
//     elementHandle.contentFrame(), CDP-backed — "CDP는 sandbox 무관하게
//     프레임에 닿는다", design §8) contains the fixture's marker text.
// G8 (script NEVER runs — adversarial pair, team-lead's "test a guard both
//     ways" mandate): positive — sample.html's inline PWNED script (design
//     §0 header) leaves document.title UNCHANGED under the real sandbox="".
//     Negative (proves the positive assertion actually bites): the SAME
//     iframe forced to reload with sandbox="allow-scripts" (still no
//     allow-same-origin) DOES run the script (title flips to "PWNED") —
//     dev:browser has no CSP (index.html carries no CSP meta; Tauri injects
//     it only in the real runtime), so this negative isolates sandbox
//     defense layer ① specifically, independent of CSP layer ③.
// G9 (relative asset rewrite): the fixture's sibling `sample-asset.png`
//     resolves — frame-internal `img.currentSrc` is the rewritten asset URL
//     and `naturalWidth > 0` (dev:browser: mock convertFileSrc=identity +
//     Vite publicDir serving the literal mock-assets file — same mechanism
//     G3's report.xlsx already relies on).
//
// VISUAL CONTRACT (checkPanelChrome below) applies to EVERY viewer's panel —
// this is what the audit's screenshot + real-device findings actually
// demand: "all viewers share the same shell chrome AND never spill past
// their panel" is a testable contract, not a one-off fix. A future HTML/HWP
// viewer that skips shell chrome, or that dumps unbounded content into it,
// fails here exactly like Excel did.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { assertPageRendered } from "./lib/preflight.mjs";

const out = process.argv[2] ?? "/tmp/viewer-golden.json";
const url = process.argv[3] ?? "http://localhost:1430/?file=/mock/vault/index.md";
const result = { g1: {}, g2: {}, g3: {}, g4: {}, g5: {}, g6: {}, g7: {}, g8: {}, g9: {}, errors: [], failedRequests: [] };

const ver = await (await fetch("http://127.0.0.1:9222/json/version")).json();
const browser = await chromium.connectOverCDP(ver.webSocketDebuggerUrl);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = ctx.pages()[0] ?? (await ctx.newPage());

// G8's own POSITIVE assertion (sample.html's inline PWNED script must not
// run under sandbox="") makes Chrome itself log a console.error the instant
// that block succeeds — "Blocked script execution in 'about:srcdoc' because
// the document's frame is sandboxed...". That message IS the security
// contract working exactly as designed, not a regression; treating it as a
// golden-breaking error would make this file punish the very behavior G8
// exists to prove. Named so the one deliberate exception to "any console
// error fails the golden" stays a single, greppable rule instead of a bare
// string test inline at the listener. Pure query.
function isExpectedSandboxBlockMessage(text) {
  return /Blocked script execution.*sandboxed/i.test(text);
}

page.on("pageerror", (e) => result.errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error" && !isExpectedSandboxBlockMessage(m.text())) {
    result.errors.push("console: " + m.text());
  }
});

// A console error of the form "Failed to load resource: ... 404" tells you a
// request failed but NOT WHICH ONE — Chrome omits the URL from that message.
// This golden hit exactly that once (2026-07-14, on the HTML-viewer run) and
// then went clean for 9 consecutive runs, instrumented, cold-cache and warm:
// a real intermittent we could not name. So DON'T weaken the gate (a blanket
// 404 exemption would hide the regression that actually matters here — the
// fixture's relative <img> failing to resolve through convertFileSrc); make
// the gate self-diagnosing instead. `failedRequests` records url + status +
// resource type for every non-ok response, so the NEXT occurrence names
// itself in the JSON report rather than costing another investigation.
// Recorded, never gated on: `errors` alone still decides pass/fail.
page.on("response", (r) => {
  if (!r.ok()) {
    result.failedRequests.push({
      status: r.status(),
      url: r.url(),
      type: r.request().resourceType(),
    });
  }
});
page.on("requestfailed", (r) => {
  result.failedRequests.push({
    status: "FAILED",
    url: r.url(),
    error: r.failure()?.errorText ?? "",
  });
});

await page.setViewportSize({ width: 1280, height: 900 });
await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
await page.waitForTimeout(500);
await assertPageRendered(page, { context: "viewer-golden" });

const xlsxResourceCount = () =>
  page.evaluate(
    () => performance.getEntriesByType("resource").filter((r) => /xlsx/i.test(r.name)).length,
  );

/** The shared shell-chrome visual contract EVERY viewer panel must satisfy
 *  (audit finding 04_audit_report.md 🟠/🟡/screenshot: DOM presence alone
 *  passed a panel with no background, a transparent backdrop, and a caption
 *  spilling outside the panel — none of that shows up in an `.excel-viewer`
 *  existence check). Reads computed styles + geometry directly, the same way
 *  a human looking at the screenshot would judge it. Pure query (page-side
 *  evaluate, no mutation). */
async function checkPanelChrome(page, panelSelector, captionSelector) {
  return page.evaluate(
    ({ panelSelector, captionSelector }) => {
      const parseAlpha = (color) => {
        // Two computed-style shapes turn up here depending on the source
        // declaration: `rgba(r, g, b, a)` / `rgb(r, g, b)` (a plain color,
        // e.g. `background: transparent` or `var(--bg)`) and
        // `color(srgb r g b / a)` (this app's `color-mix()` output). A
        // MISSING alpha component in EITHER shape means fully opaque (1) —
        // conflating "no match" with "opaque" was the original bug here:
        // `background: transparent` computes to `rgba(0, 0, 0, 0)` (comma
        // form), which the old slash-only regex never matched, so it fell
        // through to the "1 = opaque" default and silently reported a
        // transparent backdrop as opaque (caught by this file's own
        // mutation-proof step — see _workspace/02_r11_changes.md).
        if (!color) return 1;
        let m = /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(color);
        if (m) return m[1] !== undefined ? parseFloat(m[1]) : 1;
        m = /^color\([^)]*?(?:\/\s*([\d.]+)\s*)?\)$/.exec(color);
        if (m) return m[1] !== undefined ? parseFloat(m[1]) : 1;
        return 1;
      };
      const backdrop = document.querySelector(".viewer-backdrop");
      const panel = document.querySelector(panelSelector);
      const caption = captionSelector ? document.querySelector(captionSelector) : null;
      // `.viewer-panel-body` (shell.ts's wrapper, styles.css) is the ONE
      // shell-owned containment box every viewer's content sits inside —
      // checking THIS, not a viewer-specific inner element, is what makes
      // this check universal (same assertion for image AND Excel AND any
      // future viewer, no per-viewer selector needed). The real-device
      // regression (04_audit_report.md 재호출 2차): a 10,000+-row sheet's
      // content div was a plain block appended directly as the panel's flex
      // item — no ancestor box constrained it — so it grew past the panel's
      // fixed height and spilled over the document underneath, invisibly to
      // every prior DOM-existence check.
      const body = document.querySelector(".viewer-panel-body");
      // The viewer's own content, whatever it is (image-viewer-stage /
      // excel-viewer-status / excel-viewer-body / a future HTML/HWP root) —
      // `.viewer-panel-body`'s single child, generic across every viewer.
      const bodyContent = body?.firstElementChild ?? null;
      const bcs = backdrop ? getComputedStyle(backdrop) : null;
      const pcs = panel ? getComputedStyle(panel) : null;
      const panelRect = panel?.getBoundingClientRect() ?? null;
      const bodyRect = body?.getBoundingClientRect() ?? null;
      const bodyContentRect = bodyContent?.getBoundingClientRect() ?? null;
      const captionRect = caption?.getBoundingClientRect() ?? null;
      return {
        backdropAlpha: bcs ? parseAlpha(bcs.backgroundColor) : 0,
        panelAlpha: pcs ? parseAlpha(pcs.backgroundColor) : 0,
        panelDisplay: pcs?.display ?? null,
        panelInViewport:
          !!panelRect &&
          panelRect.top >= 0 &&
          panelRect.left >= 0 &&
          panelRect.bottom <= window.innerHeight &&
          panelRect.right <= window.innerWidth,
        // 4px slack for subpixel rounding — not a tolerance for a real overflow.
        captionInsidePanel:
          !panelRect || !captionRect
            ? false
            : captionRect.top >= panelRect.top - 4 &&
              captionRect.bottom <= panelRect.bottom + 4 &&
              captionRect.left >= panelRect.left - 4 &&
              captionRect.right <= panelRect.right + 4,
        // Sanity check: `.viewer-panel-body`'s OWN box (not its content)
        // must sit inside the panel — this is guaranteed by CSS flex-basis
        // math almost by construction (a red herring on its own: a first
        // pass at this check compared `body`'s rect to the panel's and it
        // STAYED GREEN through every mutation below, because flex-basis
        // sizes a flex item's box from AVAILABLE SPACE regardless of its
        // `overflow` value — `overflow` only controls whether that box's
        // OWN CONTENT is clipped at its edge or allowed to spill past it.
        // Kept as a weak sanity check; `contentContainedInBody` below is
        // the assertion that actually catches the regression).
        bodyContainedInPanel:
          !panelRect || !bodyRect
            ? false
            : bodyRect.bottom <= panelRect.bottom + 4 && bodyRect.right <= panelRect.right + 4,
        // THE real containment check: does the viewer's content stay inside
        // `.viewer-panel-body`'s box, or does it spill past it onto the
        // document underneath (the real-device regression, audit finding
        // 재호출 2차)? Comparing the CONTENT's rect against its immediate
        // container (not the outer panel) is deliberate — a properly
        // scrollable deep descendant (e.g. `.excel-viewer-table` inside an
        // `overflow:auto` `.excel-viewer-sheet`) legitimately has a huge
        // un-clipped rect while still being correctly invisible-clipped by
        // ITS OWN ancestor; checking `.viewer-panel-body`'s DIRECT child is
        // what is actually supposed to never exceed it, since that's the
        // element `overflow: hidden` on `.viewer-panel-body` claims to bound.
        contentContainedInBody:
          !bodyRect || !bodyContentRect
            ? false
            : bodyContentRect.bottom <= bodyRect.bottom + 4 && bodyContentRect.right <= bodyRect.right + 4,
      };
    },
    { panelSelector, captionSelector },
  );
}

// ── G2 (negative) — measured BEFORE anything opens a viewer ────────────────
result.g2.xlsxResourcesAtBoot = await xlsxResourceCount();

// Open the explorer sidebar (⌘B's button) so the fixture tree rows exist.
await page.click(".explorer-btn");
await page.waitForTimeout(200);

const rowFor = (path) => page.locator(`.explorer-item[data-path="${path}"]`);

// ── G1 — image viewer behavior-unchanged (shell extraction regression guard) ─
await rowFor("/mock/vault/pic.png").click();
await page.waitForTimeout(300);
result.g1.backdropCount = await page.locator(".viewer-backdrop").count();
result.g1.hasImageViewer = (await page.locator(".image-viewer").count()) > 0;
result.g1.imgSrc = await page.locator(".image-viewer-img").getAttribute("src").catch(() => null);
Object.assign(result.g1, await checkPanelChrome(page, ".image-viewer", ".image-viewer-caption"));
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
result.g1.backdropCountAfterEsc = await page.locator(".viewer-backdrop").count();
result.g1.editorHostInertAfterEsc = await page
  .locator(".editor-host")
  .first()
  .getAttribute("inert");

// ── G5 — an unclaimed extension stays inert ────────────────────────────────
const dataRow = rowFor("/mock/vault/data.json");
result.g5.isNonmdBefore = (await dataRow.evaluate((el) => el.classList.contains("is-nonmd")).catch(() => null));
await dataRow.click().catch(() => {});
await page.waitForTimeout(150);
result.g5.backdropCountAfterClick = await page.locator(".viewer-backdrop").count();

// ── G3 — Excel viewer cold-load positive + render + VISUAL ─────────────────
await rowFor("/mock/vault/report.xlsx").click();
await page.waitForTimeout(600); // fetch bytes + dynamic import("xlsx") + parse
result.g3.hasExcelViewer = (await page.locator(".excel-viewer").count()) > 0;
result.g3.tabCount = await page.locator(".excel-viewer-tab").count();
result.g3.bodyText = await page.locator(".excel-viewer").innerText().catch(() => "");
// Known fixture values (scripts/lib/make-excel-fixture.mjs): sheet "Data" has
// a sparse cell "Alice" at B2 — asserts the real cell reached the DOM, not
// just that SOME table rendered.
result.g3.hasKnownCellValue = result.g3.bodyText.includes("Alice");
result.g3.xlsxResourcesAfterOpen = await xlsxResourceCount();
Object.assign(result.g3, await checkPanelChrome(page, ".excel-viewer", ".excel-viewer-caption"));
// The audit's screenshot finding: sheet data must land in exactly ONE
// <table>, not three disconnected boxes (a symptom of the missing panel
// chrome — no flex/overflow context to hold the table together).
result.g3.tableCount = await page.locator(".excel-viewer-table").count();
// SIZE CONTRACT (04_audit_report.md 재호출 4차): height -> max-height means
// a 3-row sheet's panel must actually SHRINK to fit its content, not sit in
// a fixed 640px box with a huge dead-whitespace gutter below the table
// (the audit's screenshot finding). 640 is the design's max-height cap
// (min(85vh, 640px)) — well under it proves shrink-to-fit is really
// happening, not coincidentally landing at the cap.
result.g3.panelHeight = await page
  .locator(".excel-viewer")
  .evaluate((el) => el.getBoundingClientRect().height);

// ── G6 — truncation caption states the TRUE total, AND the 10,000-row table
//     stays contained (the real-device regression: a small 3-row sheet never
//     exposes an overflow bug — this fixture's whole reason to exist) ───────
// Switch to the "Big" sheet (MAX_RENDERED_ROWS + 5 real rows, fixture §Big).
await page.getByText("Big", { exact: true }).click();
await page.waitForTimeout(200);
result.g6.caption = await page.locator(".excel-viewer-caption").innerText().catch(() => "");
result.g6.statesTrueTotal = result.g6.caption.includes("10005");
result.g6.statesCap = result.g6.caption.includes("10,000") || result.g6.caption.includes("10000");
Object.assign(result.g6, await checkPanelChrome(page, ".excel-viewer", ".excel-viewer-caption"));
result.g6.tableCount = await page.locator(".excel-viewer-table").count();
// SIZE CONTRACT — the flip side of G3's: a 10,005-row sheet's OWN scroll
// box (`.excel-viewer-sheet`, not the outer `.viewer-panel-body` — see
// checkPanelChrome's comment on why the outer box alone can't prove this)
// must actually be scrollABLE — scrollHeight strictly greater than
// clientHeight — not just "not visibly spilling" (contentContainedInBody
// already covers that half; this proves the OTHER half, that content is
// still fully reachable via scroll, not silently clipped-and-stuck at
// flex-shrink like an `overflow: hidden` mistake would produce).
result.g6.sheetScrollState = await page.locator(".excel-viewer-sheet").evaluate((el) => ({
  scrollHeight: el.scrollHeight,
  clientHeight: el.clientHeight,
  scrolls: el.scrollHeight > el.clientHeight,
}));
await page.screenshot({ path: out.replace(/\.json$/, ".g6-big-sheet.png") });
// Second shot at the bottom of the internal scroll — team-lead's ask: does
// the caption stay put (it's a flex sibling of `.excel-viewer-sheet`, not a
// descendant of it, so scrolling the sheet must never carry the caption
// away) while the table content scrolls underneath?
result.g6.captionVisibleAfterScroll = await page.locator(".excel-viewer-sheet").evaluate((el) => {
  el.scrollTop = el.scrollHeight;
  const caption = document.querySelector(".excel-viewer-caption");
  const rect = caption?.getBoundingClientRect();
  return !!rect && rect.width > 0 && rect.height > 0 && rect.bottom <= window.innerHeight;
});
await page.waitForTimeout(100);
await page.screenshot({ path: out.replace(/\.json$/, ".g6-big-sheet-scrolled.png") });
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// ── G7~G9 — HTML viewer (R11 2단계) ──────────────────────────────────────
await rowFor("/mock/vault/sample.html").click();
await page.waitForTimeout(400);
result.g7.hasHtmlViewer = (await page.locator(".html-viewer").count()) > 0;

const htmlIframeEl = await page.locator(".html-viewer-frame").elementHandle();
const htmlFrame = await htmlIframeEl?.contentFrame();
result.g7.frameReachable = !!htmlFrame;
result.g7.markerText = htmlFrame
  ? await htmlFrame.locator("body").innerText().catch(() => "")
  : "";
result.g7.hasMarker = result.g7.markerText.includes("HTML-VIEWER-GOLDEN-MARKER");
Object.assign(result.g7, await checkPanelChrome(page, ".html-viewer", ".html-viewer-caption"));
await page.screenshot({ path: out.replace(/\.json$/, ".g7-html-viewer.png") });

// G9 first (reads the UNMUTATED sandbox="" frame) — G8's negative probe
// below intentionally mutates this same iframe afterward.
if (htmlFrame) {
  const imgState = await htmlFrame.evaluate(() => {
    const img = document.querySelector("img");
    return img ? { currentSrc: img.currentSrc, naturalWidth: img.naturalWidth } : null;
  });
  result.g9.currentSrc = imgState?.currentSrc ?? null;
  result.g9.naturalWidth = imgState?.naturalWidth ?? 0;
  result.g9.rewrittenToAssetUrl =
    !!result.g9.currentSrc && result.g9.currentSrc.includes("/mock/vault/sample-asset.png");
}

// G8 positive: the fixture's inline `document.title = "PWNED"` never ran
// under the real sandbox="".
result.g8.titleBefore = htmlFrame ? await htmlFrame.evaluate(() => document.title) : null;
result.g8.scriptDidNotRun = result.g8.titleBefore !== "PWNED";

// G8 negative (the guard-both-ways proof): force the SAME iframe to reload
// with sandbox="allow-scripts" (still no allow-same-origin) and confirm the
// probe DOES fire this time — otherwise the positive assertion above could
// never turn red and would be a silent no-op forever.
await page.evaluate(() => {
  return new Promise((resolve) => {
    const iframe = document.querySelector(".html-viewer-frame");
    const html = iframe.srcdoc;
    iframe.addEventListener("load", () => resolve(true), { once: true });
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.srcdoc = html; // reassign to force a reload under the new sandbox flags
  });
});
await page.waitForTimeout(200);
const htmlIframeEl2 = await page.locator(".html-viewer-frame").elementHandle();
const htmlFrame2 = await htmlIframeEl2?.contentFrame();
result.g8.titleAfterAllowScripts = htmlFrame2 ? await htmlFrame2.evaluate(() => document.title) : null;
result.g8.scriptRanWhenAllowed = result.g8.titleAfterAllowScripts === "PWNED";

await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// ── G4 — don't-stack: image then Excel, no close between ───────────────────
// The second row sits visually under the first viewer's backdrop
// (position:fixed, inset:0, z-index:50), which real-hit-tests any actual
// mouse click to the backdrop itself (closing the viewer, per the
// backdrop-self-click-only-closes rule) — even Playwright's `{force:true}`
// dispatches a real OS-level click at that screen point, so it lands on the
// backdrop too, not the row underneath. The REACHABLE real path is keyboard:
// the sidebar tree is not marked `inert` (only `.editor-host` is —
// shell.ts), so a user who Tabs back to the still-focusable tree and presses
// Enter on the second row CAN trigger a second viewer.open() while the first
// handle is still live. `element.click()` called in-page (not a simulated
// mouse coordinate) reproduces that same DOM click-event dispatch without
// needing to script the exact Tab order.
await rowFor("/mock/vault/pic.png").click();
await page.waitForTimeout(300);
await rowFor("/mock/vault/report.xlsx").evaluate((el) => el.click());
await page.waitForTimeout(600);
result.g4.backdropCount = await page.locator(".viewer-backdrop").count();
result.g4.hasExcelViewer = (await page.locator(".excel-viewer").count()) > 0;
result.g4.hasImageViewer = (await page.locator(".image-viewer").count()) > 0;
await page.keyboard.press("Escape");

writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));

const pass =
  result.g1.backdropCount === 1 &&
  result.g1.hasImageViewer &&
  result.g1.backdropCountAfterEsc === 0 &&
  result.g1.editorHostInertAfterEsc === null &&
  result.g1.backdropAlpha > 0 &&
  result.g1.panelAlpha > 0 &&
  result.g1.panelDisplay === "flex" &&
  result.g1.panelInViewport &&
  result.g1.captionInsidePanel &&
  result.g1.bodyContainedInPanel &&
  result.g1.contentContainedInBody &&
  result.g2.xlsxResourcesAtBoot === 0 &&
  result.g3.hasExcelViewer &&
  result.g3.tabCount === 3 &&
  result.g3.hasKnownCellValue &&
  result.g3.xlsxResourcesAfterOpen >= 1 &&
  result.g3.backdropAlpha > 0 &&
  result.g3.panelAlpha > 0 &&
  result.g3.panelDisplay === "flex" &&
  result.g3.panelInViewport &&
  result.g3.captionInsidePanel &&
  result.g3.bodyContainedInPanel &&
  result.g3.contentContainedInBody &&
  result.g3.tableCount === 1 &&
  // SIZE CONTRACT: a 3-row sheet's panel shrinks well under the 640px cap
  // (height -> max-height fix) instead of sitting in a fixed dead box.
  result.g3.panelHeight < 640 &&
  result.g4.backdropCount === 1 &&
  result.g4.hasExcelViewer &&
  !result.g4.hasImageViewer &&
  result.g5.isNonmdBefore === true &&
  result.g5.backdropCountAfterClick === 0 &&
  result.g6.statesTrueTotal &&
  result.g6.statesCap &&
  // The real containment test: a 10,005-row sheet must stay inside its
  // panel — the small G3 fixture (3 rows) would never expose this.
  result.g6.bodyContainedInPanel &&
  result.g6.contentContainedInBody &&
  result.g6.panelInViewport &&
  result.g6.tableCount === 1 &&
  // SIZE CONTRACT (flip side of G3): the sheet's OWN box actually scrolls
  // (min-height:0 + overflow:auto both alive) rather than just not-spilling.
  result.g6.sheetScrollState.scrolls &&
  result.g6.captionVisibleAfterScroll &&
  // G7 — HTML viewer render positive.
  result.g7.hasHtmlViewer &&
  result.g7.frameReachable &&
  result.g7.hasMarker &&
  result.g7.backdropAlpha > 0 &&
  result.g7.panelAlpha > 0 &&
  result.g7.panelDisplay === "flex" &&
  result.g7.panelInViewport &&
  result.g7.captionInsidePanel &&
  result.g7.bodyContainedInPanel &&
  result.g7.contentContainedInBody &&
  // G8 — script never runs under sandbox="" (positive) AND DOES run once
  // sandbox is (adversarially) relaxed to allow-scripts (negative) — the
  // guard-both-ways pair that proves the positive isn't a no-op probe.
  result.g8.scriptDidNotRun &&
  result.g8.scriptRanWhenAllowed &&
  // G9 — relative sibling image rewritten to a real, loadable asset URL.
  result.g9.rewrittenToAssetUrl &&
  result.g9.naturalWidth > 0 &&
  result.errors.length === 0;

console.log("\nwrote", out);
console.log(pass ? "\n✓ viewer-golden PASS" : "\n✗ viewer-golden FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
