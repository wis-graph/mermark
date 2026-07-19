// Golden-master capture for the mermark viewer registry. Started as R11's
// (_workspace/01_r11.md §7/§9 Step 5) body-level backdrop/modal golden;
// rewritten (_workspace/01_architect_design.md / 01_architect_plan.md
// §Stage 6, 2026-07-18 full-pane rewrite) for the in-content PANE shell —
// `.viewer-backdrop` no longer exists ANYWHERE in the DOM (shell.ts, design
// §A). Exercises the SAME dispatch path built-in (image) and extension
// (Excel/HTML/PDF) viewers share, so a regression in any shows up here
// regardless of which one it hits.
//
//   node scripts/viewer-golden.mjs /tmp/viewer-golden.json
//
// Requires:
//   - `npm run dev:browser` + Chrome --remote-debugging-port=9222 running
//   - mock-assets/mock/vault/report.xlsx present (scripts/lib/make-excel-fixture.mjs)
//
// FULL-PANE REWRITE PROBE CHANGE (Stage 6): every `.viewer-backdrop` probe
// this file used to run (~36 refs, R11-era) is now a PANE probe instead:
// `.main-column > .viewer-panel` (exists = open, gone = closed) and
// `.editor-host[hidden]` (the mount/hide half of the same contract,
// shell.ts's `mountViewerPane`). checkPanelChrome() below folds both into
// every scenario's Object.assign for free. DELETED (no referent anymore):
// backdrop-dim-opacity and backdrop-click-closes assertions — there is no
// backdrop to dim or click. G4 (don't-stack) is reinterpreted as "exactly
// one pane" instead of "exactly one backdrop". `inert` is ALSO gone
// end-to-end (design §D: `hidden` alone removes the editor from the
// focus/AT tree; only G5's "unclaimed extension is un-openable" retains the
// word colloquially, unrelated to the `inert` DOM attribute).
//
// G1 (behavior-unchanged + VISUAL): pic.png → pane mounted as
//     `.editor-host`'s sibling with `.editor-host` hidden, `.image-viewer`
//     present, img src, panel with real chrome, Esc → full teardown +
//     `.editor-host` hidden cleared (restored).
// G2 (cold-load NEGATIVE): boot alone never fetches an xlsx-named resource.
//     Written FIRST — a golden whose only signal is "0 resources" is
//     trivially green if the selector/probe itself is broken (this
//     session's "sidebar-contrast could never fail" lesson), so G3's
//     positive count is what actually proves this probe is alive.
// G3 (cold-load POSITIVE + render + VISUAL): report.xlsx → .excel-viewer,
//     known fixture cell text, 3 sheet tabs, resource entries ≥1, pane
//     mounted/chrome intact, sheet data in exactly ONE <table> (not
//     scattered across disconnected boxes — the audit's screenshot finding,
//     04_audit_report.md).
// G4 (don't-stack, REINTERPRETED for the pane shell): image open, then
//     Excel open (no close between) → exactly one `.viewer-panel` under
//     `.main-column` (never two panes stacked).
// G5 (unclaimed extension stays un-openable): an unclaimed extension
//     (data.json) stays .is-nonmd, its click opens no pane, and
//     `.editor-host` stays visible throughout.
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
// G10~G12 (_workspace/01_hwp_viewer.md §9 — HWP/HWPX viewer, built-in):
// G10 (render positive + VISUAL): sample.hwp → .hwp-viewer exists, 3
//     placeholders (browser mock's HWP_MOCK_PAGE_COUNT), page 0's <img>
//     naturalWidth > 0 and its src starts with data:image/svg+xml — the
//     ONLY way a rendered page may enter the DOM (design §4.1).
// G11 (script NEVER runs — adversarial pair, "test a guard both ways", same
//     shape as G8): the mock's page-1 SVG (src/mocks/tauri-core.ts's
//     mockHwpPageSvg) carries a <script> AND an onload probe. Positive:
//     after page 1 renders, window.__HWP_PWNED is still undefined — proving
//     the <img src="data:image/svg+xml;...">` mode never executes it, a
//     spec-level guarantee independent of CSP (dev:browser has none).
//     Negative (proves the positive isn't a no-op): a same-shaped
//     window.__HWP_PWNED write, executed via createElement("script") +
//     appendChild (a REAL script-execution DOM path — unlike innerHTML,
//     whose parser-inserted <script> elements the HTML spec makes inert
//     regardless of sandbox/CSP; an earlier version of this probe used
//     innerHTML and was a silent always-false no-op for exactly that
//     reason, caught on this golden's own first run) — confirming the
//     observation channel (window.__HWP_PWNED) is live, so the positive's
//     "still undefined" means "blocked", not "never checked".
// G12 (negative — corrupted file): corrupt.hwp → hwp_open rejects (mock),
//     .hwp-viewer-status shows an error message, no .hwp-viewer-pages ever
//     appears, and the app survives (editor still responds afterward).
//
// G13 (PDF viewer — extension, src/extensions/pdf-viewer): sample.pdf →
//     .pdf-viewer exists, page 1's <canvas> is ACTUALLY DRAWN (non-blank —
//     reads real pixel data via toDataURL/getImageData, not just "a canvas
//     element exists", the same "existence != rendered" trap G10's SVG-src
//     check and G3's cell-value check both guard against), the text layer
//     contains the fixture's marker string AND its bounding box overlaps the
//     canvas's bounding box (proves `--scale-factor` alignment actually
//     works, not just "some text nodes exist somewhere"), zero console
//     errors (this is where a CSP eval-detection regression would surface —
//     see pdf-viewer/index.ts's header comment on why pdfjs-dist 6.1.200
//     needs no `isEvalSupported` workaround), and Esc tears the overlay down
//     with the editor still responsive afterward.
//
// G14 (PDF viewer — lazy render + MAX_RENDERED_PAGES canvas-eviction cap,
//     team-lead follow-up: G13's fixture was 1 page, so lazy-render/eviction
//     were UNVERIFIED — "hwp-viewer pattern replicated" was an assumption,
//     not evidence, since PDF's render path (canvas+text-layer, not an
//     <img>) differs): guide.pdf (25 pages, "PAGE 1".."PAGE 25" — see
//     scripts/lib/make-pdf-fixture.mjs) →
//   - LAZY: right after open, the number of pages with an actual <canvas>
//     child is well under 25 (most pages are still empty placeholders,
//     outside the IntersectionObserver's rootMargin) — existence of 25
//     `.pdf-viewer-page` DOM nodes proves nothing about which ones actually
//     rendered, so this counts real <canvas> children specifically.
//   - SCROLL-TRIGGERED RENDER: page 25 has NO canvas before scrolling and a
//     REAL non-blank canvas (real pixel sample, same technique as G13) after
//     scrolling the pages column to the bottom in steps (a single jump to
//     scrollTop=scrollHeight can skip past pages without ever intersecting
//     them, so this walks down in increments so the observer actually fires
//     for each one along the way).
//   - EVICTION CAP: after scrolling through the ENTIRE document, the number
//     of `.pdf-viewer-page` elements that still carry a `<canvas>` never
//     exceeds MAX_RENDERED_PAGES (20, pdf-viewer/index.ts) — proving the cap
//     is a real, observable DOM effect, not just code that exists but never
//     fires. The flip side: page 1 (the FIRST page rendered, so the FIRST
//     candidate for FIFO eviction once the cap is exceeded) has had its
//     canvas evicted (removed) by the time all 25 pages have been visited.
//   - Zero console errors.
//
// ─────────────────────────────────────────────────────────────────────────
// STAGE 6 NEW SCENARIOS (_workspace/01_architect_plan.md §Stage 6). Keyed
// g16~g19 in `result` — NOT g15~g18 as the plan's prose numbers them —
// because `g15`/`g15caseA` were ALREADY a live, battle-tested scenario pair
// below (the viewer on/off TOGGLE feature, an unrelated earlier round,
// _workspace/03_viewer_toggle_design.md) by the time this Stage landed.
// Renumbering an already-proven scenario to make room felt riskier than
// documenting the shift once, here, and moving on. Mapping: plan's "G15
// (레이아웃)" -> g16, "G16 (줌 동작)" -> g17, "G17 (줌 독립)" -> g18, "G18
// (문서 열기)" -> g19.
//
// G16 (layout/restore — plan's "G15"): open pic.png -> the pane fills
//     `.editor-host`'s old slot and `.title-bar`/`.sidebar-aside`/
//     `.status-bar` boundingBoxes are BYTE-IDENTICAL to their pre-open
//     values (the whole point of a non-modal pane — chrome never moves).
//     Esc -> `.editor-host` restored (hidden cleared) AND the editor's
//     scroll position (`.cm-scroller.scrollTop`) survives the hide/show
//     round-trip untouched (CM6 re-measures itself on the visibility
//     transition — this is the one live-DOM proof jsdom cannot give,
//     design §A). Also opens+closes a viewer from the WELCOME screen (boot
//     with NO file) and confirms the welcome pane re-renders with a real
//     (non-zero) box afterward — the exact `.editor-host[hidden]` vs.
//     `.welcome-host{display:flex}` specificity trap the architect flagged
//     (design §A "함정 1개"; the CSS-text guard lives in
//     tests/viewer-shell.test.ts, this is the LIVE cascade proof).
// G17 (zoom behavior — plan's "G16"): report.xlsx -> click [+] twice ->
//     `.excel-viewer-table`'s computed font-size increases and the zoom
//     label reads a higher percent (1 -> 1.1 -> 1.25, "125%"); [-] twice
//     returns both to their starting values. sample.pdf -> click [+] ->
//     page 1's canvas CSS width grows by the SAME ladder step (a real
//     re-rasterize, fitWidthScale's `zoomFactor` argument — not a CSS
//     transform), label updates.
// G18 (zoom independence — plan's "G17", ADVERSARIAL PAIR): with a PDF
//     viewer open, fire the REAL "본문 확대" shortcut (Mod+=, zoom.in ->
//     fontScaleSetting, shortcuts/actions.ts) WITHOUT touching the viewer's
//     own [+]/[-] -> the pane's `--viewer-zoom` var, its zoom LABEL text,
//     and the PDF page's canvas pixel width must all stay EXACTLY
//     unchanged (shell.zoom never reads fontScale, design §B decision ③) —
//     only header CHROME TEXT (`.viewer-panel`'s own font-size, the VIEWER
//     ZOOM RULE root, styles.css) is allowed to scale. This is the positive
//     half; G17 above is the negative half of the same pair (the viewer's
//     OWN [+]/[-] DOES move content) — together they prove the two axes are
//     genuinely orthogonal, not that content just never moves for any
//     reason.
// G19 (doc-open closes viewer — plan's "G18"): a viewer is open -> click a
//     .md row in the explorer -> the pane is gone AND the document's own
//     editor (`.editor-host`, hidden cleared) is visible again —
//     `closeOpenViewer()`'s single call site in `openInWindow` (main.ts,
//     design §A rule 1), proven end-to-end rather than by reading the
//     source.
// ─────────────────────────────────────────────────────────────────────────

// G15 (viewer on/off toggle, _workspace/03_viewer_toggle_design.md): a
// disabled viewer's file falls through to the OS-default open_path path
// instead of showing an overlay — no new fallback branch, the EXISTING one
// (design §2). Round-trip: disable HTML → open sample.html → NO overlay
// (open_path takes it instead) → re-enable HTML → open sample.html AGAIN in
// the SAME session (no reload) → the overlay DOES appear. Also proves the
// default (nothing in localStorage) reproduces every earlier scenario above
// UNCHANGED — this file's own G1/G3/G7/G10/G13 runs above it are that
// evidence, since they all execute BEFORE G15 ever touches localStorage;
// G15 itself only adds the toggle-specific assertions.
//
// G15 case A (team-lead catch, _workspace/04_toggle_changes.md 재호출): the
// ACTUAL regression a mid-session toggle exposed, distinct from mere UI lag.
// explorer-panel.ts bakes `.is-nonmd` in at row-render time and
// `activateItem` never re-asks `canOpenWithViewer` on click (it short-
// circuits on the cached class) — so disabling a viewer whose file's row was
// ALREADY rendered openable let a click fall through into `onOpenFile`,
// opening a non-markdown file AS markdown (not the safe OS-fallback G15
// above proves for the reload path). Fixed by
// `disabledViewersSetting.subscribe(() => explorer.refreshOpenability())`
// (main.ts) — a pure DOM re-sync of every rendered row's `.is-nonmd`, same
// shape as the pre-existing `refreshFavoriteStars` sink. Case A proves BOTH
// directions on the SAME already-rendered row, with NO tree navigation of
// any kind in between (stronger than G15's scenario 3, which allowed a
// breadcrumb-triggered re-render before this fix existed — no longer
// needed): disable -> click -> neither the viewer NOR onOpenFile fires;
// re-enable -> click -> the viewer opens.
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
const result = {
  g1: {}, g2: {}, g3: {}, g4: {}, g5: {}, g6: {}, g7: {}, g8: {}, g9: {}, g10: {}, g11: {}, g12: {}, g13: {}, g14: {},
  g15: {}, g15caseA: {},
  // Stage 6 additions — see the "STAGE 6 NEW SCENARIOS" header comment above
  // for why these are g16~g19, not g15~g18.
  g16: {}, g17: {}, g18: {}, g19: {},
  errors: [],
  failedRequests: [],
};

// CDP port is overridable (env `CDP_PORT`, default 9222). A long-lived shared
// automation Chrome degrades: after a renderer crash it can start refusing
// context management outright ("Browser.setDownloadBehavior: Browser context
// management is not supported") and, before that, produce screenshot timeouts
// that look exactly like a product regression — a day-old instance is what
// made this file's G6 shot appear to hang on BOTH new and old code
// (2026-07-20). Being able to point a run at a FRESH browser on another port
// is what tells those two apart, and lets two runs coexist.
const CDP_PORT = process.env.CDP_PORT ?? "9222";
const ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
const browser = await chromium.connectOverCDP(ver.webSocketDebuggerUrl);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = ctx.pages()[0] ?? (await ctx.newPage());
// Stage 6 QA infra fix (2026-07-18, qa-verifier): an occluded/backgrounded
// CDP tab throttles Chrome's own rendering/compositing, which can make
// page.screenshot()'s internal "wait for fonts to load" step (and layout
// generally) stall well past its 30s timeout on a heavy DOM (G6's 10,000+
// row sheet was the first to hit this in this sandboxed multi-agent
// environment — CPU/GPU contention from other concurrent CDP sessions makes
// it worse). Bringing the tab to the front once, up top, costs nothing on a
// healthy run and fixes the stall on a busy one.
await page.bringToFront();

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
  // 304 = successful cache revalidation, not a failure. Recording it made
  // the report list 123 "failed" font/asset requests on a warm cache,
  // burying any real 4xx/5xx in noise.
  if (!r.ok() && r.status() !== 304) {
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

/** The shared shell-chrome contract EVERY viewer panel must satisfy — full-
 *  pane rewrite version (_workspace/01_architect_design.md). DOM presence
 *  alone (`.excel-viewer` exists) proved nothing about whether the pane
 *  actually mounted where it should, whether `.editor-host` was correctly
 *  hidden, or whether a caption/content box spilled its bounds (audit
 *  finding 04_audit_report.md 🟠/🟡/screenshot — the ORIGINAL reason this
 *  helper exists, R11-era). The backdrop-opacity half of that original
 *  contract is GONE (no backdrop exists to be opaque/dimmed, design §A) —
 *  replaced by the pane-mount half every full-pane scenario actually needs:
 *  is the pane `.editor-host`'s sibling, and is `.editor-host` hidden.
 *  Reads computed styles + geometry directly, the same way a human looking
 *  at a screenshot would judge it. Pure query (page-side evaluate, no
 *  mutation). */
async function checkPanelChrome(page, panelSelector, captionSelector) {
  return page.evaluate(
    ({ panelSelector, captionSelector }) => {
      const panel = document.querySelector(panelSelector);
      const caption = captionSelector ? document.querySelector(captionSelector) : null;
      const editorHost = document.querySelector(".editor-host");
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
      const pcs = panel ? getComputedStyle(panel) : null;
      const panelRect = panel?.getBoundingClientRect() ?? null;
      const bodyRect = body?.getBoundingClientRect() ?? null;
      const bodyContentRect = bodyContent?.getBoundingClientRect() ?? null;
      const captionRect = caption?.getBoundingClientRect() ?? null;
      // The caption moved OUT of the panel into the app title-bar
      // (2026-07-19: the title-bar IS the viewer's title bar), so its
      // containment is measured against that box now.
      const titleBarRect = document.querySelector(".title-bar")?.getBoundingClientRect() ?? null;
      return {
        // Replaces the R11-era "exactly one .viewer-backdrop" signal: does
        // the pane actually sit where shell.ts's mountViewerPane put it
        // (`.editor-host`'s nextElementSibling), and is `.editor-host`
        // correctly hidden as its paired effect (design §A, both halves of
        // one mount()/restore() command).
        paneMountedAsEditorHostSibling: !!panel && editorHost?.nextElementSibling === panel,
        editorHostHidden: !!editorHost?.hidden,
        panelDisplay: pcs?.display ?? null,
        panelInViewport:
          !!panelRect &&
          panelRect.top >= 0 &&
          panelRect.left >= 0 &&
          panelRect.bottom <= window.innerHeight &&
          panelRect.right <= window.innerWidth,
        // 4px slack for subpixel rounding — not a tolerance for a real overflow.
        // Same INTENT as the old `captionInsideTitleBar`: the caption is REAL,
        // visible chrome sitting inside its container instead of spilling.
        // Only the container changed (panel -> title-bar), so this is
        // re-pointed, not dropped. A zero-size rect fails too — an invisible
        // caption must never read as "contained".
        captionInsideTitleBar:
          !titleBarRect || !captionRect || captionRect.width === 0 || captionRect.height === 0
            ? false
            : captionRect.top >= titleBarRect.top - 4 &&
              captionRect.bottom <= titleBarRect.bottom + 4 &&
              captionRect.left >= titleBarRect.left - 4 &&
              captionRect.right <= titleBarRect.right + 4,
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
        // CLOSE-BUTTON-DOES-NOT-COVER-CONTENT contract (team-lead catch: a
        // narrow-content viewer — Excel's single-column "Big" sheet —
        // stretched its tab strip's rightmost tab directly under the close
        // button, which G6 only caught INDIRECTLY as a click-timeout. That's
        // hard to diagnose from a golden failure alone, so this check makes
        // it DIRECT: does any interactive element inside the viewer's own
        // content geometrically overlap `.viewer-panel-close`'s rect? Scoped
        // to elements INSIDE `.viewer-panel-body` (not the whole document) —
        // the close button obviously sits "over" the panel background by
        // design; what must never happen is a real click target landing
        // under it. This is the shell's own contract (checkPanelChrome runs
        // for every viewer), so it protects Excel/HTML/HWP and any future
        // viewer (PDF/DOCX/CSV) the same way, without a per-viewer probe.
        closeButtonOverlapsInteractive: (() => {
          const closeBtn = document.querySelector(".viewer-panel-close");
          const closeRect = closeBtn?.getBoundingClientRect() ?? null;
          if (!closeRect || !body) return false;
          const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
          const interactive = Array.from(
            body.querySelectorAll('button, [role="tab"], a[href], input, select, textarea'),
          );
          return interactive.some((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && overlaps(closeRect, r);
          });
        })(),
      };
    },
    { panelSelector, captionSelector },
  );
}

// ── Small pure helpers for G16~G19 (Stage 6) ────────────────────────────────
function px(str) {
  if (str == null) return null;
  const n = Number.parseFloat(str);
  return Number.isFinite(n) ? n : null;
}
function within(actual, expected, tolerance = 0.1) {
  return actual != null && Math.abs(actual - expected) <= tolerance;
}
/** Two DOMRect-shaped objects are "the same chrome position" within a small
 *  subpixel tolerance — used to prove the top-bar/sidebar/footer never moved
 *  when a viewer pane opened (G16), not that they're pixel-perfect to the
 *  last float. Pure. */
function rectsClose(a, b, eps = 1) {
  if (!a || !b) return false;
  return (
    Math.abs(a.x - b.x) <= eps &&
    Math.abs(a.y - b.y) <= eps &&
    Math.abs(a.width - b.width) <= eps &&
    Math.abs(a.height - b.height) <= eps
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
result.g1.paneCount = await page.locator(".main-column > .viewer-panel").count();
result.g1.hasImageViewer = (await page.locator(".image-viewer").count()) > 0;
result.g1.imgSrc = await page.locator(".image-viewer-img").getAttribute("src").catch(() => null);
Object.assign(result.g1, await checkPanelChrome(page, ".image-viewer", ".image-viewer-caption"));
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
result.g1.paneCountAfterEsc = await page.locator(".main-column > .viewer-panel").count();
result.g1.editorHostHiddenAfterEsc = await page
  .locator(".editor-host")
  .first()
  .evaluate((el) => el.hidden);

// ── G5 — an unclaimed extension never opens a pane (stays un-openable) ─────
const dataRow = rowFor("/mock/vault/data.json");
result.g5.isNonmdBefore = (await dataRow.evaluate((el) => el.classList.contains("is-nonmd")).catch(() => null));
await dataRow.click().catch(() => {});
await page.waitForTimeout(150);
result.g5.paneCountAfterClick = await page.locator(".main-column > .viewer-panel").count();
result.g5.editorHostHiddenAfterClick = await page
  .locator(".editor-host")
  .first()
  .evaluate((el) => el.hidden);

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
// SIZE CONTRACT (04_audit_report.md 재호출 4차, RE-POINTED 2026-07-20): a
// 3-row sheet must not sit in a dead box with a huge whitespace gutter below
// the table — the audit's screenshot finding, fixed by giving
// `.excel-viewer-sheet` `flex: 0 1 auto` instead of `flex: 1`.
//
// This used to be measured as "the PANEL is well under its 640px max-height
// cap". The full-pane rewrite DELETED that cap (the panel is now `flex: 1`
// and fills the editor area by design, ~828px), so the old probe measured a
// box that no longer expresses the contract and failed on a correct build.
// The contract itself is unchanged, so it is re-pointed at the box that still
// owns it: the SHEET must hug its table rather than stretch. A revert to
// `flex: 1` stretches the sheet to the panel's full height, blowing the gap
// wide open — exactly the regression this guards.
const g3Sizes = await page.evaluate(() => {
  const sheet = document.querySelector(".excel-viewer-sheet");
  const table = document.querySelector(".excel-viewer-table");
  const panel = document.querySelector(".excel-viewer");
  return {
    sheetHeight: sheet ? sheet.getBoundingClientRect().height : -1,
    tableHeight: table ? table.getBoundingClientRect().height : -1,
    panelHeight: panel ? panel.getBoundingClientRect().height : -1,
  };
});
result.g3.panelHeight = g3Sizes.panelHeight; // recorded for context, no longer gated
result.g3.sheetHeight = g3Sizes.sheetHeight;
result.g3.tableHeight = g3Sizes.tableHeight;
// Dead whitespace below the table, in px. Shrink-to-fit keeps this near zero;
// a stretched sheet in a full-height pane makes it hundreds.
result.g3.sheetDeadGap = g3Sizes.sheetHeight - g3Sizes.tableHeight;

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
// A longer timeout than the default 30s (qa-verifier, Stage 6): this shot
// follows a scrollTop jump across a REAL 10,000-row table — legitimately
// heavier layout/paint work than any other screenshot in this file, and
// this sandboxed multi-agent environment can have real CPU/GPU contention
// from other concurrent CDP sessions. Isolated reproduction (same G1→G5→G3
// sequence, same scroll, same screenshot, run standalone) completed in
// ~4.4s — so this is slow-under-load headroom, not evidence of a hang.
// NON-FATAL by design (orchestrator, 2026-07-18). This is the single most
// expensive capture in the file — a full-page raster with a 220,001px-tall
// table scrolled to its bottom — and late in a long single-page session the
// headless renderer can run out of raster headroom and never produce a
// stable frame. Measured evidence that this is a HARNESS limit, not a
// product regression: (a) isolated repeats of this exact sequence pass 5/5
// in 2.2-4.9s, (b) it still passes after 5 viewer open/close cycles with a
// flat DOM-node count (no leak — panes tear down to 0, editor-host restored),
// (c) the real tauri build renders all 5 viewers correctly. Letting this
// THROW aborted the run and destroyed the signal from G7~G19, which are real
// assertions. So: capture best-effort, record whether we got it, and let the
// behavioural assertions decide pass/fail. The assertion set is unchanged —
// nothing is weakened here, only this artifact is made optional.
result.g6.scrolledShotCaptured = await page
  .screenshot({ path: out.replace(/\.json$/, ".g6-big-sheet-scrolled.png"), timeout: 60000 })
  .then(() => true)
  .catch(() => {
    console.warn("  ⚠ g6 scrolled screenshot skipped (renderer raster timeout — artifact only, assertions unaffected)");
    return false;
  });
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

// ── G4 — don't-stack (REINTERPRETED, full-pane): image then Excel, no close
// between → exactly ONE `.viewer-panel`, never two stacked ─────────────────
// R11-era comment (now historical): the second row used to sit visually
// under the first viewer's `.viewer-backdrop` (position:fixed, inset:0),
// which real-hit-tested any mouse click back onto the backdrop itself —
// `element.click()` in-page was required to reach the row at all. The
// full-pane shell has NO backdrop (design §A): the explorer sidebar is a
// permanent sibling of `.main-column`, never covered by the pane (the whole
// point of a non-modal layout — top-bar/sidebar/footer stay live and
// clickable). A real Playwright `.click()` would now land correctly too;
// `element.click()` is kept anyway for parity with the rest of this file and
// because it is still the more direct signal (no dependency on screen
// coordinates/z-index at all).
await rowFor("/mock/vault/pic.png").click();
await page.waitForTimeout(300);
await rowFor("/mock/vault/report.xlsx").evaluate((el) => el.click());
await page.waitForTimeout(600);
result.g4.paneCount = await page.locator(".main-column > .viewer-panel").count();
result.g4.hasExcelViewer = (await page.locator(".excel-viewer").count()) > 0;
result.g4.hasImageViewer = (await page.locator(".image-viewer").count()) > 0;
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// ── G10~G12 — HWP/HWPX viewer (built-in) ────────────────────────────────────
await rowFor("/mock/vault/sample.hwp").click();
await page.waitForTimeout(500); // hwp_open + lazy-render of near-viewport pages
result.g10.hasHwpViewer = (await page.locator(".hwp-viewer").count()) > 0;
result.g10.placeholderCount = await page.locator(".hwp-viewer-page").count();
const firstPageImg = page.locator('.hwp-viewer-page[data-page="0"] img.hwp-viewer-page-img');
result.g10.page0Src = await firstPageImg.getAttribute("src").catch(() => null);
result.g10.page0IsDataSvg = !!result.g10.page0Src && result.g10.page0Src.startsWith("data:image/svg+xml;base64,");
result.g10.page0NaturalWidth = await firstPageImg.evaluate((img) => img.naturalWidth).catch(() => 0);
Object.assign(result.g10, await checkPanelChrome(page, ".hwp-viewer", ".hwp-viewer-caption"));
await page.screenshot({ path: out.replace(/\.json$/, ".g10-hwp-viewer.png") });

// G11 positive: page 1's SVG (mockHwpPageSvg, tauri-core.ts) carries a
// <script> + onload probe. Once its <img> has rendered, the probe must
// never have fired.
const page1Img = page.locator('.hwp-viewer-page[data-page="1"] img.hwp-viewer-page-img');
await page1Img.waitFor({ state: "attached", timeout: 5000 }).catch(() => {});
result.g11.pwnedAfterRender = await page.evaluate(() => window.__HWP_PWNED);
result.g11.pwnedOnloadAfterRender = await page.evaluate(() => window.__HWP_PWNED_ONLOAD);
result.g11.scriptDidNotRun = result.g11.pwnedAfterRender === undefined && result.g11.pwnedOnloadAfterRender === undefined;

// G11 negative (guard-both-ways): proves window.__HWP_PWNED is a live,
// working observation channel — NOT that `<script>`-via-innerHTML executes,
// which it structurally never does (the HTML parsing spec makes a
// parser-inserted <script> inert, independent of any sandbox/CSP; an
// earlier version of this probe used innerHTML and was a silent no-op for
// that reason, caught by this exact rerun). A `<script>` element built with
// createElement + appendChild DOES run its content the moment it's inserted
// — that's the real "same code, executed directly in the document instead
// of behind an <img> boundary" comparison this negative needs: same
// window.__HWP_PWNED write, reached through DOM script execution rather
// than data:image/svg+xml decoding.
result.g11.scriptRanWhenInjectedDirectly = await page.evaluate(() => {
  const scratch = document.createElement("div");
  document.body.appendChild(scratch);
  const script = document.createElement("script");
  script.textContent = "window.__HWP_PWNED = 1;";
  scratch.appendChild(script);
  const ran = window.__HWP_PWNED === 1;
  scratch.remove();
  delete window.__HWP_PWNED;
  delete window.__HWP_PWNED_ONLOAD;
  return ran;
});

await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// ── G12 — corrupted HWP file: error status, app survives ───────────────────
await rowFor("/mock/vault/corrupt.hwp").click();
await page.waitForTimeout(400);
result.g12.statusText = await page.locator(".hwp-viewer-status").innerText().catch(() => "");
result.g12.showsError = result.g12.statusText.includes("문서를 열 수 없습니다");
result.g12.hasPagesContainer = (await page.locator(".hwp-viewer-pages").count()) > 0;
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
// App survives: the editor is still responsive after a failed HWP open.
result.g12.editorStillResponsive = await page.evaluate(() => !!document.querySelector(".cm-content"));

// ── G13 — PDF viewer (extension, src/extensions/pdf-viewer) ────────────────
await rowFor("/mock/vault/sample.pdf").click();
await page.waitForTimeout(900); // fetch bytes + dynamic import("pdfjs-dist") + worker init + render
result.g13.hasPdfViewer = (await page.locator(".pdf-viewer").count()) > 0;
result.g13.pageCount = await page.locator(".pdf-viewer-page").count();

const firstPageCanvas = page.locator('.pdf-viewer-page[data-page="1"] canvas').first();
await firstPageCanvas.waitFor({ state: "attached", timeout: 8000 }).catch(() => {});
// Non-blank check: existence of a <canvas> element proves nothing about
// whether pdf.js actually drew to it (the exact "existence != rendered" trap
// G10's data:svg src check and G3's cell-value check both guard against) —
// sample a strip of real pixel data and require at least one non-white,
// non-transparent pixel. A blank white canvas the same size as a real render
// would pass every DOM-shape check above and still be a total rendering
// failure.
result.g13.canvasNonBlank = await firstPageCanvas
  .evaluate((canvas) => {
    const ctx = canvas.getContext("2d");
    if (!ctx || canvas.width === 0 || canvas.height === 0) return false;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      if (a > 0 && (r < 250 || g < 250 || b < 250)) return true; // a real (non-white) pixel was drawn
    }
    return false;
  })
  .catch(() => false);

const textLayerEl = page.locator('.pdf-viewer-page[data-page="1"] .textLayer').first();
result.g13.textLayerText = await textLayerEl.innerText().catch(() => "");
result.g13.hasMarkerText = result.g13.textLayerText.includes("PDF-VIEWER-GOLDEN-MARKER");

// Alignment: the text layer's box must overlap the canvas's box — proves
// `--scale-factor` actually positioned the text run over the rendered page,
// not just "some text nodes exist somewhere off in a corner".
result.g13.textLayerAlignedWithCanvas = await page.evaluate(() => {
  const page1 = document.querySelector('.pdf-viewer-page[data-page="1"]');
  const canvas = page1?.querySelector("canvas");
  const textLayer = page1?.querySelector(".textLayer");
  if (!canvas || !textLayer) return false;
  const c = canvas.getBoundingClientRect();
  const t = textLayer.getBoundingClientRect();
  return c.left < t.right && c.right > t.left && c.top < t.bottom && c.bottom > t.top;
});

Object.assign(result.g13, await checkPanelChrome(page, ".pdf-viewer", ".pdf-viewer-caption"));
await page.screenshot({ path: out.replace(/\.json$/, ".g13-pdf-viewer.png") });

await page.keyboard.press("Escape");
await page.waitForTimeout(200);
result.g13.paneCountAfterEsc = await page.locator(".main-column > .viewer-panel").count();
result.g13.editorStillResponsive = await page.evaluate(() => !!document.querySelector(".cm-content"));

// ── G14 — PDF viewer: lazy render + MAX_RENDERED_PAGES canvas-eviction cap ─
// Non-blank canvas check, shared shape with G13's — inline here (page-side
// evaluate closures don't share code across separate .evaluate() calls in
// Playwright without an explicit exposeFunction, and this is only used
// twice in this file so a shared helper isn't worth the indirection).
async function canvasIsNonBlank(locator) {
  return locator
    .evaluate((canvas) => {
      const ctx = canvas.getContext("2d");
      if (!ctx || canvas.width === 0 || canvas.height === 0) return false;
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
        if (a > 0 && (r < 250 || g < 250 || b < 250)) return true;
      }
      return false;
    })
    .catch(() => false);
}

await rowFor("/mock/vault/guide.pdf").click();
await page.waitForTimeout(900); // fetch bytes + dynamic import("pdfjs-dist") + worker init + first-viewport render
result.g14.hasPdfViewer = (await page.locator(".pdf-viewer").count()) > 0;
result.g14.pageCount = await page.locator(".pdf-viewer-page").count();

const pagesColumn = page.locator(".pdf-viewer-pages");
// LAZY: right after open, real <canvas> children — NOT `.pdf-viewer-page`
// element count, which is 25 unconditionally (placeholders exist for every
// page from the start) — must be well under the total page count.
result.g14.initialCanvasCount = await page.locator(".pdf-viewer-page canvas").count();
result.g14.page25CanvasBeforeScroll = await page.locator('.pdf-viewer-page[data-page="25"] canvas').count();

// Walk the pages column down in steps (not a single jump to
// scrollTop=scrollHeight, which can skip past intermediate pages without
// ever intersecting them) so the IntersectionObserver actually fires for
// each page along the way, exactly the way a real user scrolling would.
const SCROLL_STEPS = 14;
for (let i = 1; i <= SCROLL_STEPS; i++) {
  const frac = i / SCROLL_STEPS;
  await pagesColumn.evaluate((el, f) => {
    el.scrollTop = el.scrollHeight * f;
  }, frac);
  await page.waitForTimeout(250);
}
await page.waitForTimeout(500);

const page25Canvas = page.locator('.pdf-viewer-page[data-page="25"] canvas').first();
await page25Canvas.waitFor({ state: "attached", timeout: 8000 }).catch(() => {});
result.g14.page25CanvasNonBlank = await canvasIsNonBlank(page25Canvas);

// EVICTION CAP: after visiting the entire 25-page document, the number of
// pages still carrying a live canvas must never exceed MAX_RENDERED_PAGES
// (20, pdf-viewer/index.ts) — and page 1 (rendered FIRST, so first in the
// FIFO eviction order once the cap is exceeded) must have been evicted.
result.g14.canvasCountAfterFullScroll = await page.locator(".pdf-viewer-page canvas").count();
result.g14.page1CanvasEvicted = (await page.locator('.pdf-viewer-page[data-page="1"] canvas').count()) === 0;

await page.screenshot({ path: out.replace(/\.json$/, ".g14-pdf-viewer-multipage.png") });

await page.keyboard.press("Escape");
await page.waitForTimeout(200);
result.g14.paneCountAfterEsc = await page.locator(".main-column > .viewer-panel").count();
result.g14.editorStillResponsive = await page.evaluate(() => !!document.querySelector(".cm-content"));

// ── G16 — layout/restore (plan's "G15") ─────────────────────────────────────
// Give the editor a real, non-zero scroll position first — a "scroll
// preserved" claim at scrollTop=0 would be vacuously true.
await page.evaluate(() => {
  const scroller = document.querySelector(".cm-scroller");
  if (scroller) scroller.scrollTop = 60;
});
await page.waitForTimeout(150);

const readChrome = () =>
  page.evaluate(() => ({
    titleBar: document.querySelector(".title-bar")?.getBoundingClientRect() ?? null,
    statusBar: document.querySelector(".status-bar")?.getBoundingClientRect() ?? null,
    sidebarAside: document.querySelector(".sidebar-aside:not([hidden])")?.getBoundingClientRect() ?? null,
  }));
const g16Before = {
  ...(await readChrome()),
  editorHostRect: await page.evaluate(() => document.querySelector(".editor-host")?.getBoundingClientRect() ?? null),
  scrollTop: await page.evaluate(() => document.querySelector(".cm-scroller")?.scrollTop ?? null),
};

await rowFor("/mock/vault/pic.png").click();
await page.waitForTimeout(300);

const g16After = {
  ...(await readChrome()),
  paneRect: await page.evaluate(() => document.querySelector(".viewer-panel")?.getBoundingClientRect() ?? null),
};
await page.screenshot({ path: out.replace(/\.json$/, ".g16-layout.png") });

result.g16.chromeUnchanged =
  rectsClose(g16Before.titleBar, g16After.titleBar) &&
  rectsClose(g16Before.statusBar, g16After.statusBar) &&
  rectsClose(g16Before.sidebarAside, g16After.sidebarAside);
// 2px slack: the pane is a `flex:1` sibling occupying the exact slot
// `.editor-host` vacated, but a border/scrollbar rounding difference between
// the two elements is not the regression this guards against.
result.g16.paneFillsEditorSlot = rectsClose(g16After.paneRect, g16Before.editorHostRect, 2);

await page.keyboard.press("Escape");
await page.waitForTimeout(250);

const g16AfterEsc = await page.evaluate(() => ({
  editorHostHidden: document.querySelector(".editor-host")?.hidden ?? null,
  paneGone: !document.querySelector(".viewer-panel"),
  scrollTop: document.querySelector(".cm-scroller")?.scrollTop ?? null,
}));
result.g16.editorRestored = g16AfterEsc.editorHostHidden === false && g16AfterEsc.paneGone;
result.g16.scrollPreserved = g16AfterEsc.scrollTop === g16Before.scrollTop;

// Welcome-screen round trip (design §A "함정 1개": `.editor-host[hidden]` vs
// `.welcome-host{display:flex}` — `.welcome-host` IS `.editor-host` itself,
// main.ts's boot() does `host.classList.add("welcome-host")` on the SAME
// element, never a child — so this is a genuine live-cascade proof, not a
// second element). Boot with NO file; the explorer's default root at boot is
// NOT `/mock/vault` (home/documents dir, main.ts), so a favorite-folder seed
// + the welcome pane's OWN "즐겨찾기" row click (welcome-pane.ts's
// onJumpFolder → explorer.jumpToRoot, a real product code path, not a test
// hack) is how a real user would reach it from a bare welcome screen too.
await page.evaluate(() => localStorage.setItem("mermark.favoriteFolders", JSON.stringify(["/mock/vault"])));
const welcomeUrl = new URL(url);
welcomeUrl.searchParams.delete("file");
await page.goto(welcomeUrl.toString(), { waitUntil: "networkidle", timeout: 15000 });
await page.waitForSelector(".welcome-host", { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(400);

const welcomeHostBox = () =>
  page.evaluate(() => {
    const elx = document.querySelector(".welcome-host");
    if (!elx) return null;
    const r = elx.getBoundingClientRect();
    return { width: r.width, height: r.height };
  });
result.g16.welcomeHostVisibleBeforeOpen = (await welcomeHostBox())?.width > 0;

await page.locator(".welcome-folder-row", { hasText: "vault" }).click();
await page.waitForTimeout(250);
await rowFor("/mock/vault/pic.png").click();
await page.waitForTimeout(300);
result.g16.paneOpensFromWelcome = (await page.locator(".main-column > .viewer-panel").count()) === 1;
result.g16.editorHostHiddenFromWelcome = await page.locator(".editor-host").first().evaluate((elx) => elx.hidden);

await page.keyboard.press("Escape");
await page.waitForTimeout(300);
result.g16.editorHostHiddenAfterWelcomeClose = await page
  .locator(".editor-host")
  .first()
  .evaluate((elx) => elx.hidden);
result.g16.welcomeHostVisibleAfterClose = (await welcomeHostBox())?.width > 0;

// Clean up the favorite seed + return to the normal fixture doc for the
// remaining scenarios.
await page.evaluate(() => localStorage.removeItem("mermark.favoriteFolders"));
await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
await page.waitForTimeout(500);
await assertPageRendered(page, { context: "viewer-golden(G16 restore)" });
await page.click(".explorer-btn");
await page.waitForTimeout(200);

// ── G17 — zoom behavior (plan's "G16"): excel table text + PDF page raster ──
await rowFor("/mock/vault/report.xlsx").click();
await page.waitForTimeout(600);

const readExcelZoom = () =>
  page.evaluate(() => {
    const table = document.querySelector(".excel-viewer-table");
    const label = document.querySelector(".viewer-panel-zoom-label");
    return {
      tableFontSize: table ? getComputedStyle(table).fontSize : null,
      label: label ? label.textContent : null,
    };
  });
const excelAt1 = await readExcelZoom();
await page.click(".viewer-panel-zoom-in");
await page.waitForTimeout(120);
await page.click(".viewer-panel-zoom-in");
await page.waitForTimeout(150);
const excelAtPlus2 = await readExcelZoom();
await page.click(".viewer-panel-zoom-out");
await page.waitForTimeout(120);
await page.click(".viewer-panel-zoom-out");
await page.waitForTimeout(150);
const excelAfterReturn = await readExcelZoom();

result.g17.excelLabelAt1 = excelAt1.label;
result.g17.excelLabelAtPlus2 = excelAtPlus2.label;
result.g17.excelLabelAfterReturn = excelAfterReturn.label;
result.g17.excelLabelSteppedTo125 = excelAtPlus2.label === "125%";
result.g17.excelTableFontGrew = within(px(excelAtPlus2.tableFontSize) - px(excelAt1.tableFontSize), 0, 0.02) === false &&
  px(excelAtPlus2.tableFontSize) > px(excelAt1.tableFontSize);
result.g17.excelReturnedToStart =
  excelAfterReturn.label === "100%" && within(px(excelAfterReturn.tableFontSize), px(excelAt1.tableFontSize), 0.05);

await page.keyboard.press("Escape");
await page.waitForTimeout(200);

await rowFor("/mock/vault/sample.pdf").click();
await page.waitForTimeout(900);
const pdfPage1Canvas = page.locator('.pdf-viewer-page[data-page="1"] canvas').first();
await pdfPage1Canvas.waitFor({ state: "attached", timeout: 8000 }).catch(() => {});
await page.waitForTimeout(300);
const readPdfWidth = () => pdfPage1Canvas.evaluate((c) => c.getBoundingClientRect().width).catch(() => null);

const pdfWidthAt1 = await readPdfWidth();
const pdfLabelAt1 = await page.locator(".viewer-panel-zoom-label").innerText();
await page.click(".viewer-panel-zoom-in");
await page.waitForTimeout(600); // re-raster is async (pdfPage.render)
const pdfWidthAfterPlus = await readPdfWidth();
const pdfLabelAfterPlus = await page.locator(".viewer-panel-zoom-label").innerText();

result.g17.pdfLabelAt1 = pdfLabelAt1;
result.g17.pdfLabelAfterPlus = pdfLabelAfterPlus;
result.g17.pdfLabelSteppedTo110 = pdfLabelAfterPlus === "110%";
result.g17.pdfWidthAt1 = pdfWidthAt1;
result.g17.pdfWidthAfterPlus = pdfWidthAfterPlus;
result.g17.pdfWidthGrewByLadderStep =
  pdfWidthAt1 != null && pdfWidthAfterPlus != null && within(pdfWidthAfterPlus / pdfWidthAt1, 1.1, 0.03);

// Return to 100% before moving on (cleanliness, not a further assertion).
await page.click(".viewer-panel-zoom-out");
await page.waitForTimeout(400);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// ── G18 — zoom independence, ADVERSARIAL PAIR (plan's "G17") ───────────────
// G17 above is the negative half (the viewer's OWN [+]/[-] DOES move
// content); this is the positive half — fire the REAL "본문 확대" shortcut
// (Mod+=, zoom.in -> fontScaleSetting, shortcuts/actions.ts's "Mod+="; the
// dispatcher accepts EITHER physical modifier, keys.ts: `e.metaKey ||
// e.ctrlKey`, so Control+= reaches the same handler cross-platform under
// CDP) WITHOUT ever touching the viewer's own zoom buttons — the pane's
// `--viewer-zoom`, its zoom LABEL, and a PDF page's rendered pixel width
// must all stay EXACTLY unchanged; only header CHROME TEXT (the VIEWER ZOOM
// RULE root, `.viewer-panel`'s own font-size, styles.css) may scale.
await rowFor("/mock/vault/sample.pdf").click();
await page.waitForTimeout(900);
const g18Canvas = page.locator('.pdf-viewer-page[data-page="1"] canvas').first();
await g18Canvas.waitFor({ state: "attached", timeout: 8000 }).catch(() => {});
await page.waitForTimeout(300);

const readG18State = async () => ({
  pdfWidth: await g18Canvas.evaluate((c) => c.getBoundingClientRect().width).catch(() => null),
  viewerZoomVar: await page.locator(".viewer-panel").first().evaluate((elx) => elx.style.getPropertyValue("--viewer-zoom")),
  zoomLabel: await page.locator(".viewer-panel-zoom-label").innerText(),
  chromeFontSize: await page.locator(".viewer-panel").first().evaluate((elx) => getComputedStyle(elx).fontSize),
  fontScaleVar: await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-scale").trim()),
});

const g18Before = await readG18State();
// Twice, not once — a single sub-pixel nudge could hide inside rounding;
// two real steps make any coupling unmistakable.
await page.keyboard.press("Control+=");
await page.waitForTimeout(150);
await page.keyboard.press("Control+=");
await page.waitForTimeout(500); // give a regressed re-raster time to actually happen
const g18After = await readG18State();

result.g18.fontScaleVarBefore = g18Before.fontScaleVar;
result.g18.fontScaleVarAfter = g18After.fontScaleVar;
result.g18.fontScaleShortcutFired = g18Before.fontScaleVar !== g18After.fontScaleVar; // sanity: the keypress must have DONE something
result.g18.pdfWidthBefore = g18Before.pdfWidth;
result.g18.pdfWidthAfter = g18After.pdfWidth;
result.g18.pdfContentWidthUnchanged =
  g18Before.pdfWidth != null && g18After.pdfWidth != null && Math.abs(g18After.pdfWidth - g18Before.pdfWidth) < 0.5;
result.g18.viewerZoomVarBefore = g18Before.viewerZoomVar;
result.g18.viewerZoomVarAfter = g18After.viewerZoomVar;
result.g18.viewerZoomVarUnchanged = g18Before.viewerZoomVar === g18After.viewerZoomVar;
result.g18.zoomLabelBefore = g18Before.zoomLabel;
result.g18.zoomLabelAfter = g18After.zoomLabel;
result.g18.zoomLabelUnchanged = g18Before.zoomLabel === g18After.zoomLabel;
result.g18.chromeFontSizeBefore = g18Before.chromeFontSize;
result.g18.chromeFontSizeAfter = g18After.chromeFontSize;
result.g18.chromeTextDidScale = g18Before.chromeFontSize !== g18After.chromeFontSize;

// Teardown: reset fontScale before it leaks into the toggle scenarios below.
await page.keyboard.press("Control+0");
await page.waitForTimeout(150);
await page.evaluate(() => localStorage.removeItem("mermark.fontScale"));
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// ── G19 — doc-open closes viewer (plan's "G18") ─────────────────────────────
await rowFor("/mock/vault/pic.png").click();
await page.waitForTimeout(300);
result.g19.paneCountBeforeDocOpen = await page.locator(".main-column > .viewer-panel").count();
await rowFor("/mock/vault/index.md").evaluate((elx) => elx.click());
await page.waitForTimeout(300);
result.g19.paneCountAfterDocOpen = await page.locator(".main-column > .viewer-panel").count();
result.g19.editorHostHiddenAfterDocOpen = await page.locator(".editor-host").first().evaluate((elx) => elx.hidden);
result.g19.editorVisibleAfterDocOpen = await page.evaluate(() => !!document.querySelector(".cm-content"));

// ── G15 — viewer on/off toggle (_workspace/03_viewer_toggle_design.md) ─────
// Scenario 2 (disabled → OS fallback): inject the disabled-set and reload so
// boot reads it, then confirm opening the disabled viewer's file shows NO
// overlay. Every scenario above (G1..G14) ran BEFORE this reload with an
// EMPTY localStorage — that is scenario 1 (default = 0 regression) already
// proven by this file's own earlier PASS state, not a separate step here.
await page.evaluate(() => localStorage.setItem("mermark.disabledViewers", JSON.stringify(["ext.html"])));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(500);
await assertPageRendered(page, { context: "viewer-golden(G15)" });
await page.click(".explorer-btn");
await page.waitForTimeout(200);

result.g15.paneCountBeforeOpen = await page.locator(".main-column > .viewer-panel").count();
await rowFor("/mock/vault/sample.html").click();
await page.waitForTimeout(400);
result.g15.hasHtmlViewerWhenDisabled = (await page.locator(".html-viewer").count()) > 0;
result.g15.paneCountWhenDisabled = await page.locator(".main-column > .viewer-panel").count();

// Other (still-enabled) viewers keep working while HTML is disabled —
// disabling one viewer id must not affect another.
await rowFor("/mock/vault/pic.png").click();
await page.waitForTimeout(300);
result.g15.hasImageViewerWhileHtmlDisabled = (await page.locator(".image-viewer").count()) > 0;
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// Scenario 3 (round-trip, no reload): re-enable HTML through the REAL
// settings-panel control (not a raw localStorage write) — open the settings
// modal, switch to the 뷰어 category, click HTML's "켜기" segment. The SAME
// already-rendered row (rendered back when HTML was disabled, right after the
// reload above) must become clickable again with NO tree navigation in
// between: `disabledViewersSetting.subscribe(() => explorer.refreshOpenability())`
// (main.ts) re-syncs every rendered row's `.is-nonmd` the instant the setting
// changes, so a bare re-click of the same DOM node picks it up directly.
await page.click(".settings-btn");
await page.waitForTimeout(200);
const viewerCategoryBtn = page.locator(".settings-cat", { hasText: "뷰어" }).first();
await viewerCategoryBtn.click();
await page.waitForTimeout(150);
const htmlToggleRow = page.locator('.settings-vtoggle-item[data-id="ext.html"]');
await htmlToggleRow.locator(".settings-seg-btn", { hasText: "켜기" }).click();
await page.waitForTimeout(150);
result.g15.disabledViewersAfterReenable = await page.evaluate(() =>
  localStorage.getItem("mermark.disabledViewers"),
);
await page.keyboard.press("Escape"); // closes the settings modal
await page.waitForTimeout(200);

const htmlRow = rowFor("/mock/vault/sample.html");
result.g15.htmlRowIsNonmdAfterReenable = await htmlRow.evaluate((el) => el.classList.contains("is-nonmd"));

// Same-session round-trip, SAME rendered row, no navigation of any kind: open
// sample.html again — the overlay must now appear.
await htmlRow.click();
await page.waitForTimeout(400);
result.g15.hasHtmlViewerAfterReenable = (await page.locator(".html-viewer").count()) > 0;
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// ── G15 case A — the actual regression (team-lead catch, not just UX lag):
// disabling a viewer MID-SESSION, with its file's row already rendered
// openable, must not let a click fall through activateItem's now-false
// viewer branch into onOpenFile (opening a non-markdown file AS markdown).
// Uses ext.pdf (currently still enabled from every prior scenario above) so
// this is independent of the ext.html state already exercised. Same
// disabledViewersSetting.subscribe -> explorer.refreshOpenability() wiring
// as scenario 3, but this time proving the DISABLE direction specifically —
// scenario 3 above only proved re-enable.
const pdfRow = rowFor("/mock/vault/sample.pdf");
result.g15caseA.pdfOpenableBeforeDisable = !(await pdfRow.evaluate((el) => el.classList.contains("is-nonmd")));

await page.click(".settings-btn");
await page.waitForTimeout(200);
await page.locator(".settings-cat", { hasText: "뷰어" }).first().click();
await page.waitForTimeout(150);
await page
  .locator('.settings-vtoggle-item[data-id="ext.pdf"]')
  .locator(".settings-seg-btn", { hasText: "끄기" })
  .click();
await page.waitForTimeout(150);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// The SAME already-rendered row (no tree refresh, no navigation) must now
// carry .is-nonmd — this is the refreshOpenability sink firing off the
// subscribe, not a fresh renderTree.
result.g15caseA.pdfIsNonmdAfterDisable = await pdfRow.evaluate((el) => el.classList.contains("is-nonmd"));

// Click it: must open NEITHER the viewer overlay NOR fall through to a
// markdown open. `.is-selected` only gets set by activateItem's file branch
// (explorer-panel.ts:510, right before the viewer/onOpenFile dispatch) — if
// the row were still wrongly openable, this click would select it and mis-
// open sample.pdf as a markdown document; with the fix, activateItem's
// `.is-nonmd` early-return (line 507) fires first and neither happens.
await pdfRow.click();
await page.waitForTimeout(300);
result.g15caseA.hasPdfViewerAfterDisable = (await page.locator(".pdf-viewer").count()) > 0;
result.g15caseA.paneCountAfterDisable = await page.locator(".main-column > .viewer-panel").count();
result.g15caseA.pdfRowSelectedAfterDisabledClick = await pdfRow.evaluate((el) =>
  el.classList.contains("is-selected"),
);

// Round-trip: re-enable PDF, same row, no navigation — must become openable
// (and actually open) again immediately.
await page.click(".settings-btn");
await page.waitForTimeout(200);
await page.locator(".settings-cat", { hasText: "뷰어" }).first().click();
await page.waitForTimeout(150);
await page
  .locator('.settings-vtoggle-item[data-id="ext.pdf"]')
  .locator(".settings-seg-btn", { hasText: "켜기" })
  .click();
await page.waitForTimeout(150);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
result.g15caseA.pdfIsNonmdAfterReenable = await pdfRow.evaluate((el) => el.classList.contains("is-nonmd"));
await pdfRow.click();
await page.waitForTimeout(700); // fetch bytes + dynamic import("pdfjs-dist") + render
result.g15caseA.hasPdfViewerAfterReenable = (await page.locator(".pdf-viewer").count()) > 0;
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// Leave no side effect on a rerun / on other goldens sharing this
// dev:browser profile's localStorage.
await page.evaluate(() => localStorage.removeItem("mermark.disabledViewers"));

writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));

const pass =
  result.g1.paneCount === 1 &&
  result.g1.hasImageViewer &&
  result.g1.paneCountAfterEsc === 0 &&
  result.g1.editorHostHiddenAfterEsc === false &&
  result.g1.paneMountedAsEditorHostSibling &&
  result.g1.editorHostHidden &&
  result.g1.panelDisplay === "flex" &&
  result.g1.panelInViewport &&
  result.g1.captionInsideTitleBar &&
  result.g1.bodyContainedInPanel &&
  result.g1.contentContainedInBody &&
  !result.g1.closeButtonOverlapsInteractive &&
  result.g2.xlsxResourcesAtBoot === 0 &&
  result.g3.hasExcelViewer &&
  result.g3.tabCount === 3 &&
  result.g3.hasKnownCellValue &&
  result.g3.xlsxResourcesAfterOpen >= 1 &&
  result.g3.paneMountedAsEditorHostSibling &&
  result.g3.editorHostHidden &&
  result.g3.panelDisplay === "flex" &&
  result.g3.panelInViewport &&
  result.g3.captionInsideTitleBar &&
  result.g3.bodyContainedInPanel &&
  result.g3.contentContainedInBody &&
  !result.g3.closeButtonOverlapsInteractive &&
  result.g3.tableCount === 1 &&
  // SIZE CONTRACT: a 3-row sheet's SHEET box hugs its table — no dead
  // whitespace gutter below it (re-pointed from the deleted 640px panel cap;
  // 40px covers padding/border, not a stretched box).
  result.g3.sheetDeadGap >= 0 &&
  result.g3.sheetDeadGap < 40 &&
  // G4 — don't-stack, REINTERPRETED for the pane shell: exactly one pane.
  result.g4.paneCount === 1 &&
  result.g4.hasExcelViewer &&
  !result.g4.hasImageViewer &&
  result.g5.isNonmdBefore === true &&
  result.g5.paneCountAfterClick === 0 &&
  result.g5.editorHostHiddenAfterClick === false &&
  result.g6.statesTrueTotal &&
  result.g6.statesCap &&
  // The real containment test: a 10,005-row sheet must stay inside its
  // panel — the small G3 fixture (3 rows) would never expose this.
  result.g6.bodyContainedInPanel &&
  result.g6.contentContainedInBody &&
  !result.g6.closeButtonOverlapsInteractive &&
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
  result.g7.paneMountedAsEditorHostSibling &&
  result.g7.editorHostHidden &&
  result.g7.panelDisplay === "flex" &&
  result.g7.panelInViewport &&
  result.g7.captionInsideTitleBar &&
  result.g7.bodyContainedInPanel &&
  result.g7.contentContainedInBody &&
  !result.g7.closeButtonOverlapsInteractive &&
  // G8 — script never runs under sandbox="" (positive) AND DOES run once
  // sandbox is (adversarially) relaxed to allow-scripts (negative) — the
  // guard-both-ways pair that proves the positive isn't a no-op probe.
  result.g8.scriptDidNotRun &&
  result.g8.scriptRanWhenAllowed &&
  // G9 — relative sibling image rewritten to a real, loadable asset URL.
  result.g9.rewrittenToAssetUrl &&
  result.g9.naturalWidth > 0 &&
  // G10 — HWP viewer render positive.
  result.g10.hasHwpViewer &&
  result.g10.placeholderCount === 3 &&
  result.g10.page0IsDataSvg &&
  result.g10.page0NaturalWidth > 0 &&
  result.g10.paneMountedAsEditorHostSibling &&
  result.g10.editorHostHidden &&
  result.g10.panelDisplay === "flex" &&
  result.g10.panelInViewport &&
  result.g10.captionInsideTitleBar &&
  result.g10.bodyContainedInPanel &&
  result.g10.contentContainedInBody &&
  !result.g10.closeButtonOverlapsInteractive &&
  // G11 — script never runs via <img> (positive) AND DOES run once the same
  // markup is injected directly (negative) — the guard-both-ways pair.
  result.g11.scriptDidNotRun &&
  result.g11.scriptRanWhenInjectedDirectly &&
  // G12 — corrupted file surfaces an error and never breaks the app.
  result.g12.showsError &&
  !result.g12.hasPagesContainer &&
  result.g12.editorStillResponsive &&
  // G13 — PDF viewer: real (non-blank) render, aligned text layer, shell
  // chrome contract, clean teardown.
  result.g13.hasPdfViewer &&
  result.g13.pageCount === 1 &&
  result.g13.canvasNonBlank &&
  result.g13.hasMarkerText &&
  result.g13.textLayerAlignedWithCanvas &&
  result.g13.paneMountedAsEditorHostSibling &&
  result.g13.editorHostHidden &&
  result.g13.panelDisplay === "flex" &&
  result.g13.panelInViewport &&
  result.g13.captionInsideTitleBar &&
  result.g13.bodyContainedInPanel &&
  result.g13.contentContainedInBody &&
  !result.g13.closeButtonOverlapsInteractive &&
  result.g13.paneCountAfterEsc === 0 &&
  result.g13.editorStillResponsive &&
  // G14 — PDF viewer: lazy render + MAX_RENDERED_PAGES canvas-eviction cap,
  // both real, observable DOM effects (not just code that exists).
  result.g14.hasPdfViewer &&
  result.g14.pageCount === 25 &&
  result.g14.initialCanvasCount < 25 &&
  result.g14.page25CanvasBeforeScroll === 0 &&
  result.g14.page25CanvasNonBlank &&
  result.g14.canvasCountAfterFullScroll <= 20 &&
  result.g14.page1CanvasEvicted &&
  result.g14.paneCountAfterEsc === 0 &&
  result.g14.editorStillResponsive &&
  // G16 — layout/restore (plan's "G15"): chrome never moves, pane fills the
  // editor slot, Esc restores the editor with scroll intact, and the
  // welcome-screen round trip proves `.editor-host[hidden]` really beats
  // `.welcome-host{display:flex}` both ways.
  result.g16.chromeUnchanged &&
  result.g16.paneFillsEditorSlot &&
  result.g16.editorRestored &&
  result.g16.scrollPreserved &&
  result.g16.welcomeHostVisibleBeforeOpen &&
  result.g16.paneOpensFromWelcome &&
  result.g16.editorHostHiddenFromWelcome &&
  result.g16.editorHostHiddenAfterWelcomeClose === false &&
  result.g16.welcomeHostVisibleAfterClose &&
  // G17 — zoom behavior (plan's "G16"): excel table text + PDF page raster
  // both actually move with the viewer's own [+]/[-], and return exactly.
  result.g17.excelLabelSteppedTo125 &&
  result.g17.excelTableFontGrew &&
  result.g17.excelReturnedToStart &&
  result.g17.pdfLabelSteppedTo110 &&
  result.g17.pdfWidthGrewByLadderStep &&
  // G18 — zoom independence, ADVERSARIAL PAIR (plan's "G17"): the fontScale
  // shortcut genuinely fired (sanity — else the "unchanged" claims below
  // would be vacuous), yet the viewer's OWN zoom var/label/PDF pixel width
  // never moved; only header chrome text scaled.
  result.g18.fontScaleShortcutFired &&
  result.g18.pdfContentWidthUnchanged &&
  result.g18.viewerZoomVarUnchanged &&
  result.g18.zoomLabelUnchanged &&
  result.g18.chromeTextDidScale &&
  // G19 — doc-open closes viewer (plan's "G18"): opening a .md row from the
  // explorer while a viewer pane is open closes it and restores the editor.
  result.g19.paneCountBeforeDocOpen === 1 &&
  result.g19.paneCountAfterDocOpen === 0 &&
  result.g19.editorHostHiddenAfterDocOpen === false &&
  result.g19.editorVisibleAfterDocOpen &&
  // G15 — viewer on/off toggle: disabling ext.html suppresses its overlay
  // (falls through to the existing OS-default open_path path, no new
  // fallback branch), leaves other viewers (image) unaffected, and
  // re-enabling via the real settings-panel control round-trips back to a
  // working overlay in the SAME session (no reload — proves `.get()` is
  // read at open time, not cached at boot).
  result.g15.paneCountBeforeOpen === 0 &&
  !result.g15.hasHtmlViewerWhenDisabled &&
  result.g15.paneCountWhenDisabled === 0 &&
  result.g15.hasImageViewerWhileHtmlDisabled &&
  result.g15.disabledViewersAfterReenable !== null &&
  !JSON.parse(result.g15.disabledViewersAfterReenable ?? "[]").includes("ext.html") &&
  !result.g15.htmlRowIsNonmdAfterReenable &&
  result.g15.hasHtmlViewerAfterReenable &&
  // G15 case A — the mid-session regression: disabling ext.pdf while its row
  // was ALREADY rendered openable must flip `.is-nonmd` on that SAME row (no
  // navigation) and stop the click from opening EITHER the viewer OR
  // (the actual bug) onOpenFile/markdown-mis-open — `.is-selected` staying
  // unset on the disabled click is the proof activateItem's file branch
  // never ran at all. Re-enable round-trips the same way.
  result.g15caseA.pdfOpenableBeforeDisable &&
  result.g15caseA.pdfIsNonmdAfterDisable &&
  !result.g15caseA.hasPdfViewerAfterDisable &&
  result.g15caseA.paneCountAfterDisable === 0 &&
  !result.g15caseA.pdfRowSelectedAfterDisabledClick &&
  !result.g15caseA.pdfIsNonmdAfterReenable &&
  result.g15caseA.hasPdfViewerAfterReenable &&
  result.errors.length === 0;

console.log("\nwrote", out);
console.log(pass ? "\n✓ viewer-golden PASS" : "\n✗ viewer-golden FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
