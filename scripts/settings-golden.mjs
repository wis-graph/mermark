// CDP Golden Master for settings behavior: theme dataset + persistence, mermaid
// re-render on theme switch, mode editability + persistence, button labels.
// Resets localStorage so each run starts from the system default, then drives
// the toggles and fingerprints observable state at each step.
//
//   node scripts/settings-golden.mjs /tmp/settings-before.json   (pre-refactor)
//   node scripts/settings-golden.mjs /tmp/settings-after.json    (post-refactor)
//
// Assumes `npm run dev:browser` + Chrome --remote-debugging-port=9222 running.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { assertPageRendered } from "./lib/preflight.mjs";

const out = process.argv[2] ?? "/tmp/settings-golden.json";
const url = process.argv[3] ?? "http://localhost:1430/?file=x.md";

// CDP port is overridable (env `CDP_PORT`, default 9222) so a run can target a
// FRESH browser: a long-lived shared automation Chrome degrades after renderer
// crashes and starts producing infra failures that mimic product regressions
// (2026-07-20).
const CDP_PORT = process.env.CDP_PORT ?? "9222";
const ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
const browser = await chromium.connectOverCDP(ver.webSocketDebuggerUrl);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = ctx.pages()[0] ?? (await ctx.newPage());

const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});

await page.setViewportSize({ width: 1200, height: 900 });
await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
// deterministic start: clear persisted prefs, reload to system default
await page.evaluate(() => localStorage.clear());
await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
await page.waitForTimeout(2000); // mermaid async render

// Refuse to measure a page that never rendered — see scripts/lib/preflight.mjs.
await assertPageRendered(page, { context: "settings-golden" });

const snap = (label) =>
  page.evaluate((label) => {
    const m = document.querySelector(".cm-mermaid svg");
    const content = document.querySelector(".cm-content");
    return {
      label,
      dataTheme: document.documentElement.dataset.theme ?? null,
      lsTheme: localStorage.getItem("mermark.theme"),
      lsMode: localStorage.getItem("mermark.mode"),
      editable: content?.getAttribute("contenteditable") ?? null,
      mermaidViewBox: m?.getAttribute("viewBox") ?? null,
      // CSS-transform pan/zoom is attached when the svg carries transform-origin
      // 0 0 (handler ran); off mode leaves it unset → "" (no svg-pan-zoom node).
      mermaidPanZoomOrigin: m ? getComputedStyle(m).transformOrigin : null,
      themeBtn: document.querySelector(".theme-toggle")?.textContent ?? null,
      modeBtn: document.querySelector(".mode-toggle")?.textContent ?? null,
    };
  }, label);

const states = [];
states.push(await snap("initial"));

await page.click(".theme-toggle");
await page.waitForTimeout(1500); // theme re-bakes + re-renders mermaid
states.push(await snap("after-theme-toggle"));

await page.click(".mode-toggle");
await page.waitForTimeout(500);
states.push(await snap("after-mode-toggle"));

await page.click(".theme-toggle");
await page.click(".mode-toggle");
await page.waitForTimeout(1500);
states.push(await snap("after-toggle-back"));

// ── headingFontSetting (2026-07-14, 01_headingfont.md §7 golden scenarios) ──
// Cold-load gate FIRST, before anything selects Paperlogy: with the default
// setting ("" / 테마 기본) untouched, no paperlogy woff2 should ever have been
// fetched — the @font-face declaration alone must not cost network.
const coldLoadResources = await page.evaluate(() =>
  performance.getEntriesByType("resource").map((r) => r.name),
);
const paperlogyColdLoadCount = coldLoadResources.filter((n) => n.toLowerCase().includes("paperlogy")).length;

// Open settings → 타이포그래피 category → find the "제목 글꼴" select.
await page.click(".settings-btn");
await page.waitForTimeout(200);
const catButtons = await page.$$(".settings-cat");
for (const b of catButtons) {
  const text = await b.textContent();
  if (text?.trim() === "타이포그래피") {
    await b.click();
    break;
  }
}
await page.waitForTimeout(200);

const headingFontSnap = (label) =>
  page.evaluate((label) => {
    const heading = document.querySelector(".cm-heading");
    return {
      label,
      headingFontFamily: heading ? getComputedStyle(heading).fontFamily : null,
      headingOffsetHeight: heading ? heading.offsetHeight : null, // ZOOM GUARD probe (§5)
      lsHeadingFont: localStorage.getItem("mermark.headingFont"),
    };
  }, label);

const headingStates = [];
headingStates.push({ ...(await headingFontSnap("panel-render-default")), paperlogyColdLoadCount });

// Panel-render assertion: the select exists with 3 options.
const selectOptionLabels = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll(".settings-row"));
  const row = rows.find((r) => r.querySelector(".settings-row-label")?.textContent?.trim() === "제목 글꼴");
  const select = row?.querySelector("select");
  return select ? Array.from(select.options).map((o) => o.textContent) : null;
});
headingStates.push({ label: "panel-options", selectOptionLabels });

// Select Paperlogy → assert (a) computed font-family starts with Paperlogy,
// (b) document.fonts.check proves the Hangul glyph is actually served by the
// Paperlogy face (not a fallback that merely LOOKS selected).
async function chooseHeadingFont(label) {
  await page.evaluate((wantLabel) => {
    const rows = Array.from(document.querySelectorAll(".settings-row"));
    const row = rows.find((r) => r.querySelector(".settings-row-label")?.textContent?.trim() === "제목 글꼴");
    const select = row.querySelector("select");
    const opt = Array.from(select.options).find((o) => o.textContent === wantLabel);
    select.value = opt.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, label);
  await page.waitForTimeout(150);
}

await chooseHeadingFont("Paperlogy (한글)");
await page.waitForTimeout(300);
const paperlogyGlyphCheck = await page.evaluate(async () => {
  await document.fonts.ready;
  return document.fonts.check('600 16px Paperlogy', "한");
});
headingStates.push({ ...(await headingFontSnap("after-select-paperlogy")), paperlogyGlyphCheck });

// Back to 테마 기본: computed font-family should revert to the theme default
// (claude's Georgia) via the removeProperty path — the precedence rule (§2).
await chooseHeadingFont("테마 기본");
await page.waitForTimeout(150);
headingStates.push(await headingFontSnap("back-to-theme-default"));

// Explicit Georgia selection: observationally identical to claude's own
// theme-default Georgia (byte-identical stack, §1).
await chooseHeadingFont("Georgia (Serif)");
await page.waitForTimeout(150);
headingStates.push(await headingFontSnap("after-select-georgia"));

// ── viewer on/off toggle (_workspace/03_viewer_toggle_design.md) ───────────
// The settings modal is already open (헤딩폰트 블록 above). Switch to the 뷰어
// category and assert the 5 built-in/extension viewers each render a row,
// and that a toggle click actually writes the disabled-set to localStorage.
const viewerCatButtons = await page.$$(".settings-cat");
for (const b of viewerCatButtons) {
  const text = await b.textContent();
  if (text?.trim() === "뷰어") {
    await b.click();
    break;
  }
}
await page.waitForTimeout(200);

const viewerToggleRows = await page.evaluate(() =>
  Array.from(document.querySelectorAll(".settings-vtoggle-item")).map((el) => ({
    id: el.getAttribute("data-id"),
    label: el.querySelector(".settings-vtoggle-label")?.textContent ?? null,
  })),
);

async function clickViewerToggle(id, segLabel) {
  await page.evaluate(
    ({ id, segLabel }) => {
      const row = document.querySelector(`.settings-vtoggle-item[data-id="${id}"]`);
      const btn = Array.from(row.querySelectorAll(".settings-seg-btn")).find(
        (b) => b.textContent === segLabel,
      );
      btn.click();
    },
    { id, segLabel },
  );
  await page.waitForTimeout(100);
}

await clickViewerToggle("ext.pdf", "끄기");
const disabledAfterOff = await page.evaluate(() => localStorage.getItem("mermark.disabledViewers"));
await clickViewerToggle("ext.pdf", "켜기");
const disabledAfterOn = await page.evaluate(() => localStorage.getItem("mermark.disabledViewers"));

const viewerToggleState = {
  rows: viewerToggleRows,
  rowCount: viewerToggleRows.length,
  hasAllFive: ["image", "hwp", "ext.excel", "ext.html", "ext.pdf"].every((id) =>
    viewerToggleRows.some((r) => r.id === id),
  ),
  disabledAfterOff,
  disabledAfterOn,
  toggleWritesAndRoundTrips:
    !!disabledAfterOff &&
    JSON.parse(disabledAfterOff).includes("ext.pdf") &&
    !!disabledAfterOn &&
    !JSON.parse(disabledAfterOn).includes("ext.pdf"),
};

await page.click(".settings-close");
await page.waitForTimeout(200);

// ── Theme color editor (2026-08 redesign: _workspace/01_ui_design.md) ─────
// The 18-swatch grid was replaced by a mini-frame live preview + docked
// inspector. Assert (a) zero visual drift before any edit, (b) a palette
// pick on a mini-frame target reaches --bold-color + localStorage, (c) a
// background chip pick + "없음" round-trips cleanly on a REAL .cm-strong node
// in the editor (not the settings-panel preview), (d) the box model is
// unchanged after all of the above (design decision 3: no padding added —
// background clones onto the glyph box via box-decoration-break), and (e)
// preset re-selection still works untouched (regression gate).
async function openThemeCategory() {
  await page.click(".settings-btn");
  await page.waitForTimeout(200);
  const cats = await page.$$(".settings-cat");
  for (const b of cats) {
    const text = await b.textContent();
    if (text?.trim() === "테마") {
      await b.click();
      break;
    }
  }
  await page.waitForTimeout(200);
}

const themeEditorStates = [];
await openThemeCategory();

const zeroDrift = await page.evaluate(() => {
  const strong = document.querySelector(".cm-content .cm-strong");
  const code = document.querySelector(".cm-content .cm-inline-code");
  return {
    strongBg: strong ? getComputedStyle(strong).backgroundColor : null,
    codeBg: code ? getComputedStyle(code).backgroundColor : null,
    strongBox: strong ? { w: strong.offsetWidth, h: strong.offsetHeight } : null,
  };
});
themeEditorStates.push({ label: "zero-drift-before-edit", ...zeroDrift });

await page.evaluate(() => document.querySelector('.theme-target[data-target="bold"]').click());
await page.waitForTimeout(100);
await page.evaluate(() => document.querySelector('.theme-chip[aria-label="블루"]').click());
await page.waitForTimeout(100);

const afterBoldPick = await page.evaluate(() => ({
  boldColorVar: getComputedStyle(document.documentElement).getPropertyValue("--bold-color").trim(),
  lsHasBold: (localStorage.getItem("mermark.themeJson") ?? "").includes('"bold": "#1d6fb8"'),
}));
themeEditorStates.push({ label: "after-bold-color-pick", ...afterBoldPick });

await page.evaluate(() => Array.from(document.querySelectorAll(".theme-inspector-tab"))[1].click()); // 배경색
await page.waitForTimeout(100);
await page.evaluate(() => document.querySelector('.theme-chip[aria-label="코랄"]').click());
await page.waitForTimeout(100);
const afterBgPick = await page.evaluate(() => {
  const strong = document.querySelector(".cm-content .cm-strong");
  return {
    strongBg: strong ? getComputedStyle(strong).backgroundColor : null,
    lsHasBoldBg: (localStorage.getItem("mermark.themeJson") ?? "").includes("boldBg"),
  };
});
themeEditorStates.push({ label: "after-bold-bg-pick", ...afterBgPick });

await page.evaluate(() => document.querySelector(".theme-chip-none").click());
await page.waitForTimeout(100);
const afterBgNone = await page.evaluate(() => {
  const strong = document.querySelector(".cm-content .cm-strong");
  return {
    strongBg: strong ? getComputedStyle(strong).backgroundColor : null,
    lsHasBoldBg: (localStorage.getItem("mermark.themeJson") ?? "").includes("boldBg"),
  };
});
themeEditorStates.push({ label: "after-bold-bg-none", ...afterBgNone });

const afterEditBox = await page.evaluate(() => {
  const strong = document.querySelector(".cm-content .cm-strong");
  return strong ? { w: strong.offsetWidth, h: strong.offsetHeight } : null;
});
themeEditorStates.push({ label: "layout-invariant", before: zeroDrift.strongBox, after: afterEditBox });

await page.evaluate(() => document.querySelector('.theme-target[data-target="h1"]').focus());
await page.keyboard.press("Enter");
await page.waitForTimeout(100);
const keyboardSelect = await page.evaluate(() => ({
  pressed: document.querySelector('.theme-target[data-target="h1"]')?.getAttribute("aria-pressed"),
}));
themeEditorStates.push({ label: "keyboard-enter-select", ...keyboardSelect });

// NOTE: Escape here would bubble past .theme-preview all the way to the
// settings MODAL's own Escape-closes-modal listener (modal.ts:169) and close
// the whole panel — the inspector's own ✕ button clears selection without
// that side effect.
await page.evaluate(() => document.querySelector(".theme-inspector-close")?.click());
await page.waitForTimeout(100);

// ── Round 2 (_workspace/01_ui2_design.md, 갈래 C) ───────────────────────────
// 9 new keys (boldItalic/Bg, strike/Bg, quote/Bg/quoteBar, codeBlock/Bg),
// plain-fg-click fix (결정 6), floating inspector (결정 7). Measured against
// the REAL editor (.cm-content), not the settings-panel preview — the
// preview mirrors these vars but the actual regression surface is styles.css.

// CM6 virtualizes off-screen content — x.md's fenced code block sits well
// below the fold, so `.cm-codeblock` doesn't exist in the DOM at all until
// scrolled into view (discovered empirically: an unscrolled query silently
// returned 0 matches, which is a harness gap, not a product bug). Can't
// scrollIntoView a line that isn't rendered yet (chicken/egg with
// virtualization) — step the scroller down numerically until the widget
// materializes, once, before any measurement below.
for (let step = 0; step < 12; step++) {
  const found = await page.evaluate((px) => {
    const s = document.querySelector(".cm-scroller");
    if (s) s.scrollTop = px;
    return document.querySelectorAll(".cm-content .cm-codeblock").length > 0;
  }, step * 250);
  await page.waitForTimeout(150);
  if (found) break;
}

// 1. Zero-drift: every new key unset across all 3 presets.
//
// boldItalic FINDING (실측, not assumed): `***bold italic***` in the real
// editor renders as a SINGLE `<span class="cm-strong">bold italic</span>` —
// no nested `.cm-em` at all (confirmed via outerHTML dump). styles.css's
// `.cm-strong.cm-em` compound selector (design decision 0's "italic wins"
// rule) therefore NEVER matches any real element — it is unreachable dead
// CSS today, and setting the `boldItalic`/`boldItalicBg` keys has ZERO
// observable effect on the real editor (verified: picking a curated color
// left the real `bold italic` span's color unchanged, still the plain
// --bold-color). This is a real product gap, not a test artifact — flagged
// below (`boldItalicWiredToRealEditor`) rather than worked around.
// Two SEPARATE scroll positions, not one — the "인라인 스타일"/"인용구" section
// and the fenced code block are far enough apart in x.md that CM6's virtualize
// buffer can't keep both mounted at once (discovered empirically: measuring
// both after scrolling down for the codeblock silently returned null for the
// upper-section fields on one preset run). Reading them in two passes avoids
// depending on a single scrollTop where every selector happens to coexist.
async function measureRealEditorNewKeys() {
  await page.evaluate(() => {
    const s = document.querySelector(".cm-scroller");
    if (s) s.scrollTop = 0;
  });
  await page.waitForTimeout(100);
  const top = await page.evaluate(() => {
    const bq = document.querySelector(".cm-content .cm-blockquote");
    const strike = document.querySelector(".cm-content .cm-strike");
    const boldItalicCompound = document.querySelector(".cm-content .cm-strong.cm-em");
    const boldItalicStrongOnly = Array.from(document.querySelectorAll(".cm-content .cm-strong")).find((e) =>
      e.textContent?.includes("bold italic"),
    );
    return {
      quoteBg: bq ? getComputedStyle(bq).backgroundColor : null,
      quoteBarColor: bq ? getComputedStyle(bq).borderLeftColor : null,
      strikeColor: strike ? getComputedStyle(strike).color : null,
      boldItalicCompoundSelectorMatches: !!boldItalicCompound, // expected false — see finding above
      boldItalicColor: boldItalicStrongOnly ? getComputedStyle(boldItalicStrongOnly).color : null,
    };
  });

  for (let step = 0; step < 12; step++) {
    const found = await page.evaluate((px) => {
      const s = document.querySelector(".cm-scroller");
      if (s) s.scrollTop = px;
      return document.querySelectorAll(".cm-content .cm-codeblock").length > 0;
    }, step * 250);
    if (found) break;
    await page.waitForTimeout(80);
  }
  const codeBlockBg = await page.evaluate(() => {
    const cb = document.querySelector(".cm-content .cm-codeblock");
    return cb ? getComputedStyle(cb).backgroundColor : null;
  });
  return { ...top, codeBlockBg };
}
await pickPreset("라이트");
const zeroDriftLight = await measureRealEditorNewKeys();
themeEditorStates.push({ label: "zero-drift-new-keys-light", ...zeroDriftLight });

await pickPreset("다크");
const zeroDriftDark = await measureRealEditorNewKeys();
themeEditorStates.push({ label: "zero-drift-new-keys-dark", ...zeroDriftDark });

await pickPreset("클로드");
const zeroDriftClaude = await measureRealEditorNewKeys();
themeEditorStates.push({
  label: "zero-drift-new-keys-claude",
  ...zeroDriftClaude,
  // 결정 0's claimed lock (#3d3d3a = italic) does NOT hold against the real
  // DOM (see the finding above the measure function) — the real element
  // only carries `.cm-strong`, so it renders --bold-color (#252523), not
  // --italic-color. Both booleans are recorded so a future fix flips the
  // first to true without this scenario silently going stale.
  boldItalicLocksToItalicPerDesignDoc: zeroDriftClaude.boldItalicColor === "rgb(61, 61, 58)", // #3d3d3a (decision 0's claim)
  boldItalicActuallyRendersAsBold: zeroDriftClaude.boldItalicColor === "rgb(37, 37, 35)", // #252523 (measured reality)
});

// 1b. Explicit confirmation of the finding above: pick a distinct color for
// `boldItalic` and check whether the real "bold italic" span's color moves
// AT ALL. Expected (per the DOM finding): false — the compound selector
// never matches, so this write only affects the settings-panel preview, not
// the real editor.
await pickPreset("라이트");
await page.evaluate(() => document.querySelector('.theme-target[data-target="boldItalic"]').click());
await page.waitForTimeout(100);
await page.evaluate(() => document.querySelector('.theme-chip[aria-label="그린"]').click());
await page.waitForTimeout(150);
const boldItalicWiring = await page.evaluate(() => {
  const strongOnly = Array.from(document.querySelectorAll(".cm-content .cm-strong")).find((e) =>
    e.textContent?.includes("bold italic"),
  );
  return { colorAfterGreenPick: strongOnly ? getComputedStyle(strongOnly).color : null };
});
await page.evaluate(() => document.querySelector(".theme-inspector-close")?.click());
themeEditorStates.push({
  label: "boldItalic-real-editor-wiring",
  ...boldItalicWiring,
  colorBeforePick: zeroDriftLight.boldItalicColor,
  boldItalicWiredToRealEditor: boldItalicWiring.colorAfterGreenPick !== zeroDriftLight.boldItalicColor,
});
await page.evaluate(() => localStorage.removeItem("mermark.themeJson"));
await pickPreset("라이트"); // re-apply a clean preset (removeItem alone leaves the in-memory setting stale)

// 2. Auto-direction-preserving: quoteBg/codeBlockBg are still UNSET here (no
// edit yet), so dark<->light must show the DERIVED (--block-fill) value
// flipping direction, not a frozen color — proves the CSS fallback chain
// (not a TS-side snapshot) is what's live.
await pickPreset("다크");
const derivedDark = await measureRealEditorNewKeys();
await pickPreset("라이트");
const derivedLight = await measureRealEditorNewKeys();
themeEditorStates.push({
  label: "auto-direction-preserved",
  derivedDarkQuoteBg: derivedDark.quoteBg,
  derivedLightQuoteBg: derivedLight.quoteBg,
  flips: derivedDark.quoteBg !== derivedLight.quoteBg,
});

// 3. Explicit color wins, then auto chip reverts to the derived value —
// the "거짓 앵커 방지" gate (an unwired var would never move the real editor).
await page.evaluate(() => document.querySelector('.theme-target[data-target="quote"]').click());
await page.waitForTimeout(100);
await page.evaluate(() => document.querySelector('.theme-chip[aria-label="블루"]').click());
await page.waitForTimeout(100);
const quoteBgExplicit = await page.evaluate(() => {
  const bq = document.querySelector(".cm-content .cm-blockquote");
  return bq ? getComputedStyle(bq).backgroundColor : null;
});
await page.evaluate(() => Array.from(document.querySelectorAll(".theme-inspector-tab"))[1].click()); // 배경색 탭
await page.waitForTimeout(100);
await page.evaluate(() => document.querySelector('.theme-chip[aria-label="블루"]').click());
await page.waitForTimeout(100);
const quoteBgExplicitReal = await page.evaluate(() => {
  const bq = document.querySelector(".cm-content .cm-blockquote");
  return bq ? getComputedStyle(bq).backgroundColor : null;
});
await page.evaluate(() => document.querySelector(".theme-chip-auto").click());
await page.waitForTimeout(100);
const quoteBgAutoReverted = await page.evaluate(() => {
  const bq = document.querySelector(".cm-content .cm-blockquote");
  return bq ? getComputedStyle(bq).backgroundColor : null;
});
themeEditorStates.push({
  label: "explicit-wins-then-auto-reverts",
  quoteBgExplicitFirstTabIgnored: quoteBgExplicit, // color tab pick shouldn't move bg — sanity
  quoteBgExplicit: quoteBgExplicitReal,
  quoteBgAutoReverted,
  explicitMatchesBlue: quoteBgExplicitReal === "rgb(29, 111, 184)",
  revertMatchesDerivedLight: quoteBgAutoReverted === derivedLight.quoteBg,
});

// 4. `initial` emission: with the key unset, the CSS var itself is empty
// (guaranteed-invalid), and the CONSUMING rule's fallback is what paints —
// proves resolveOptional's "initial" contract end to end, not just the
// resolved computed color.
await page.evaluate(() => document.querySelector(".theme-chip-auto")?.click()); // ensure unset (idempotent if already)
await page.waitForTimeout(100);
const initialEmission = await page.evaluate(() => ({
  quoteBgVarRaw: getComputedStyle(document.documentElement).getPropertyValue("--quote-bg").trim(),
  quoteBgComputed: (() => {
    const bq = document.querySelector(".cm-content .cm-blockquote");
    return bq ? getComputedStyle(bq).backgroundColor : null;
  })(),
}));
themeEditorStates.push({
  label: "initial-emission",
  ...initialEmission,
  varIsEmptyOrInitial: initialEmission.quoteBgVarRaw === "" || initialEmission.quoteBgVarRaw === "initial",
  fallbackPainted: initialEmission.quoteBgComputed !== null && initialEmission.quoteBgComputed !== "rgba(0, 0, 0, 0)",
});
await page.evaluate(() => document.querySelector('.theme-inspector-close')?.click());
await page.waitForTimeout(100);

// 6. 평문 클릭 (결정 6): 문단 중간 평문 좌표 실클릭 → fg, 스케일 스트립 구분자
// 좌표 실클릭 → bg (가드 삭제 검증 — 예전엔 무반응이던 죽은 영역).
const fgRunBox = await page.evaluate(() => {
  const runs = Array.from(document.querySelectorAll(".theme-fg-run"));
  const run = runs.find((r) => r.textContent?.includes("싸고"));
  if (!run) return null;
  const r = run.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
let plainClickFg = { found: false };
if (fgRunBox) {
  await page.mouse.click(fgRunBox.x, fgRunBox.y);
  await page.waitForTimeout(150);
  plainClickFg = {
    found: true,
    inspectorLabel: await page.evaluate(() => document.querySelector(".theme-inspector-label")?.textContent ?? null),
  };
}
themeEditorStates.push({ label: "plain-text-click-selects-fg", ...plainClickFg });

await page.evaluate(() => document.querySelector('.theme-inspector-close')?.click());
await page.waitForTimeout(100);

const scaleGapBox = await page.evaluate(() => {
  const h3 = document.querySelector('.theme-target[data-target="h3"]');
  const h4 = document.querySelector('.theme-target[data-target="h4"]');
  if (!h3 || !h4) return null;
  const r3 = h3.getBoundingClientRect();
  const r4 = h4.getBoundingClientRect();
  return { x: (r3.right + r4.left) / 2, y: (r3.top + r3.bottom) / 2 };
});
let plainClickGapToBg = { found: false };
if (scaleGapBox) {
  await page.mouse.click(scaleGapBox.x, scaleGapBox.y);
  await page.waitForTimeout(150);
  plainClickGapToBg = {
    found: true,
    inspectorLabel: await page.evaluate(() => document.querySelector(".theme-inspector-label")?.textContent ?? null),
  };
}
themeEditorStates.push({ label: "scale-strip-gap-click-selects-bg", ...plainClickGapToBg });

await page.evaluate(() => document.querySelector('.theme-inspector-close')?.click());
await page.waitForTimeout(100);

// 7. 플로팅 카드 가시성 (결정 7, 불변식 A): 가장자리 대상 3종 선택 시 카드
// rect ∩ 대상 rect = ∅. muted(하단) 선택 상태에서 슬라이더 실드래그 — 카드
// 위치/rect 불변(불변식 B, 감사 blocker #1 재현 절차 재사용).
async function selectAndCheckNoOverlap(id) {
  await page.evaluate((id) => document.querySelector(`.theme-target[data-target="${id}"]`).click(), id);
  await page.waitForTimeout(150);
  return page.evaluate((id) => {
    const card = document.querySelector(".theme-inspector");
    const els = Array.from(document.querySelectorAll(`[data-target="${id}"]`));
    if (!card || els.length === 0) return { found: false };
    const cardRect = card.getBoundingClientRect();
    const overlapsAny = els.some((el) => {
      const r = el.getBoundingClientRect();
      return !(cardRect.bottom <= r.top || cardRect.top >= r.bottom);
    });
    return { found: true, cardHidden: card.hidden, overlapsAny };
  }, id);
}
for (const id of ["h1", "muted", "quote"]) {
  const res = await selectAndCheckNoOverlap(id);
  themeEditorStates.push({ label: `floating-card-no-overlap-${id}`, ...res });
}

// Re-select muted explicitly (the loop above ends on "quote") — drag its H
// slider through a full multi-step gesture and confirm the card's edge
// class + rect never move mid-drag (same repro shape as the round-1 audit's
// blocker #1, applied to card PLACEMENT instead of slider identity).
await page.evaluate(() => document.querySelector('.theme-target[data-target="muted"]').click());
await page.waitForTimeout(150);
const mutedDragCheck = await (async () => {
  const slider = await page.$(".theme-inspector-sliders input[type=range]");
  if (!slider) return { found: false };
  const box = await slider.boundingBox();
  const cardBefore = await page.evaluate(() => {
    const c = document.querySelector(".theme-inspector");
    const r = c.getBoundingClientRect();
    return { top: r.top, left: r.left, edgeTop: c.classList.contains("edge-top"), edgeBottom: c.classList.contains("edge-bottom") };
  });
  const steps = [];
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    const x = box.x + (box.width * i) / 9;
    await page.mouse.move(x, box.y + box.height / 2, { steps: 3 });
    const snap = await page.evaluate(() => {
      const c = document.querySelector(".theme-inspector");
      const r = c.getBoundingClientRect();
      const s = document.querySelector(".theme-inspector-sliders input[type=range]");
      return { top: r.top, left: r.left, value: s?.value, sliderConnected: s?.isConnected };
    });
    steps.push(snap);
  }
  await page.mouse.up();
  const cardAfter = { top: steps[steps.length - 1].top, left: steps[steps.length - 1].left };
  return {
    found: true,
    cardBefore,
    cardNeverMoved: steps.every((s) => s.top === cardBefore.top && s.left === cardBefore.left),
    sliderAlwaysConnected: steps.every((s) => s.sliderConnected),
    values: steps.map((s) => s.value),
    cardAfter,
  };
})();
themeEditorStates.push({ label: "floating-card-stable-during-drag-muted", ...mutedDragCheck });

await page.evaluate(() => document.querySelector('.theme-inspector-close')?.click());
await page.waitForTimeout(100);

// Revert every round-2 edit (quoteBg blue pick etc.) so it doesn't bleed into
// the preset-reselect scenario below.
await page.evaluate(() => localStorage.removeItem("mermark.themeJson"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(500);
await openThemeCategory();

// Revert the bold/boldBg edit so it doesn't bleed into the preset-reselect
// scenario below or any later comparison.
await page.evaluate(() => localStorage.removeItem("mermark.themeJson"));

async function pickPreset(label) {
  await page.evaluate((wantLabel) => {
    const rows = Array.from(document.querySelectorAll(".settings-row"));
    const row = rows.find((r) => r.querySelector(".settings-row-label")?.textContent?.trim() === "프리셋");
    const select = row.querySelector("select");
    const opt = Array.from(select.options).find((o) => o.textContent === wantLabel);
    select.value = opt.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, label);
  await page.waitForTimeout(300);
}
await pickPreset("클로드");
await pickPreset("라이트");
const presetRoundTrip = await page.evaluate(() => document.documentElement.dataset.theme ?? null);
themeEditorStates.push({ label: "preset-reselect-roundtrip", dataTheme: presetRoundTrip });

await page.click(".settings-close");
await page.waitForTimeout(200);

const themeEditorState = { states: themeEditorStates };

// ── showHiddenFilesSetting (_workspace/01_hidden_toggle_design.md) ─────────
// New "탐색기" category, 3-step round trip (same shape as the conceal/reveal
// 3-step assertions elsewhere): default OFF (dotfiles absent) → ON (dotfiles
// present, subscribe sink → explorer.refreshListing() proven) → back OFF
// (regression guard). Reload onto a MOCK-VAULT-rooted doc first — the
// dotfile fixtures (.hidden-note.md, .config/) only exist under /mock/vault
// in the browser mock's TREE (src/mocks/tauri-core.ts), not under the
// default `x.md` this script otherwise drives. `mermark.showHiddenFiles` is
// untouched by every scenario above, so its localStorage value is still
// unset here — the true cold-boot default, not a reset.
await page.goto("http://localhost:1430/?file=/mock/vault/index.md", {
  waitUntil: "networkidle",
  timeout: 15000,
});
await page.waitForTimeout(500);
await assertPageRendered(page, { context: "settings-golden (hidden-toggle)" });

const rowFor = (path) => page.locator(`.explorer-item[data-path="${path}"]`);
const HIDDEN_NOTE = "/mock/vault/.hidden-note.md";
const HIDDEN_DIR = "/mock/vault/.config";

await page.click(".explorer-btn");
await page.waitForTimeout(300);

async function clickShowHiddenSeg(segLabel) {
  await page.evaluate((segLabel) => {
    const rows = Array.from(document.querySelectorAll(".settings-row"));
    const row = rows.find(
      (r) => r.querySelector(".settings-row-label")?.textContent?.trim() === "숨김 파일 표시",
    );
    const btn = Array.from(row.querySelectorAll(".settings-seg-btn")).find(
      (b) => b.textContent === segLabel,
    );
    btn.click();
  }, segLabel);
  await page.waitForTimeout(150);
}

async function openExplorerCategory() {
  await page.click(".settings-btn");
  await page.waitForTimeout(200);
  const cats = await page.$$(".settings-cat");
  for (const b of cats) {
    const text = await b.textContent();
    if (text?.trim() === "탐색기") {
      await b.click();
      break;
    }
  }
  await page.waitForTimeout(200);
}

const hiddenToggleStates = [];

// ① default (off, no prior write): dotfile rows absent.
hiddenToggleStates.push({
  label: "default-off",
  lsShowHidden: await page.evaluate(() => localStorage.getItem("mermark.showHiddenFiles")),
  hiddenNoteCount: await rowFor(HIDDEN_NOTE).count(),
  hiddenDirCount: await rowFor(HIDDEN_DIR).count(),
});

// ② settings modal → 탐색기 category → "켜기" → close → dotfile rows appear
//    (proves the subscribe sink drove explorer.refreshListing(), not just a
//    localStorage write).
await openExplorerCategory();
await clickShowHiddenSeg("켜기");
const lsAfterOn = await page.evaluate(() => localStorage.getItem("mermark.showHiddenFiles"));
await page.click(".settings-close");
await page.waitForTimeout(200);

hiddenToggleStates.push({
  label: "after-on",
  lsShowHidden: lsAfterOn,
  hiddenNoteCount: await rowFor(HIDDEN_NOTE).count(),
  hiddenDirCount: await rowFor(HIDDEN_DIR).count(),
});

// ③ "끄기" → dotfile rows disappear again (round-trip regression guard).
await openExplorerCategory();
await clickShowHiddenSeg("끄기");
const lsAfterOff = await page.evaluate(() => localStorage.getItem("mermark.showHiddenFiles"));
await page.click(".settings-close");
await page.waitForTimeout(200);

hiddenToggleStates.push({
  label: "after-off",
  lsShowHidden: lsAfterOff,
  hiddenNoteCount: await rowFor(HIDDEN_NOTE).count(),
  hiddenDirCount: await rowFor(HIDDEN_DIR).count(),
});

const hiddenToggleState = {
  states: hiddenToggleStates,
  roundTrips:
    (hiddenToggleStates[0].lsShowHidden === null || hiddenToggleStates[0].lsShowHidden === "off") &&
    hiddenToggleStates[0].hiddenNoteCount === 0 &&
    hiddenToggleStates[0].hiddenDirCount === 0 &&
    hiddenToggleStates[1].lsShowHidden === "on" &&
    hiddenToggleStates[1].hiddenNoteCount === 1 &&
    hiddenToggleStates[1].hiddenDirCount === 1 &&
    hiddenToggleStates[2].lsShowHidden === "off" &&
    hiddenToggleStates[2].hiddenNoteCount === 0 &&
    hiddenToggleStates[2].hiddenDirCount === 0,
};

writeFileSync(
  out,
  JSON.stringify({ states, headingStates, viewerToggleState, themeEditorState, hiddenToggleState, errors }, null, 2),
);
console.log(
  JSON.stringify({ states, headingStates, viewerToggleState, themeEditorState, hiddenToggleState, errors }, null, 2),
);
console.log("\nwrote", out);
await browser.close();
