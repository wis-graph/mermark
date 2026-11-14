import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Style-contract for the full-height sidebar rail shell (_workspace/01_architect_design.md):
// the sidebar rail now spans the window's full top~bottom, and the header
// (.title-bar) / footer (.status-bar) live only inside the right-hand
// .main-column. main.ts's DOM assembly can't be mounted+measured directly in
// jsdom the way render-smoke.test.ts mounts a full editor (main.ts is a boot
// script, not an exported mount function), so — same technique as
// tests/sidebar-zoom.test.ts — this reads styles.css as TEXT and regex-checks
// the (selector -> declaration block) contract. Zero-runtime-cost, not a CSS
// parser; the real visual gate is the CDP golden-master screenshots (plan
// §골든마스터 시나리오).
describe("shell layout: full-height sidebar rail (style contract)", () => {
  const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles.css");
  const css = readFileSync(cssPath, "utf8");

  // Same ruleBlock() convention as sidebar-contrast.test.ts / sidebar-zoom.test.ts:
  // pulls the declaration block of the FIRST rule whose selector text appears
  // in the sheet.
  function ruleBlock(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const strict = css.match(new RegExp(escaped + "\\s*\\{([^}]*)\\}"));
    if (strict) return strict[1];
    const grouped = css.match(new RegExp(escaped + "[^{}]*\\{([^}]*)\\}"));
    if (!grouped) throw new Error(`no CSS rule found for selector ${selector}`);
    return grouped[1];
  }

  it(".main-column: column flex, flex:1, min-width:0 (the right-hand editor column)", () => {
    const block = ruleBlock(".main-column");
    expect(block).toMatch(/flex-direction:\s*column/);
    expect(block).toMatch(/flex:\s*1\b/);
    expect(block).toMatch(/min-width:\s*0\b/);
  });

  it(".sidebar-top-strip: sticky, 36px height, flex row, --sidebar-bg background (rail's window-chrome band)", () => {
    const block = ruleBlock(".sidebar-top-strip");
    expect(block).toMatch(/position:\s*sticky/);
    expect(block).toMatch(/height:\s*36px/);
    expect(block).toMatch(/background:\s*var\(--sidebar-bg\)/);
    // M6 rehome: the strip now hosts the left-command-group when a rail is
    // open, so it needs to lay that group out (flex row, vertically centered)
    // and clip an overflowing button at the rail's minimum width instead of
    // wrapping/pushing layout.
    expect(block).toMatch(/display:\s*flex/);
    expect(block).toMatch(/align-items:\s*center/);
    expect(block).toMatch(/overflow:\s*hidden/);
  });

  // M6 rehome: mac traffic-light clearance follows the group into the rail —
  // same token .title-bar.mac uses, applied to the strip instead once it's
  // the window's effective left edge.
  it(".sidebar-top-strip.mac: traffic-light inset", () => {
    const block = ruleBlock(".sidebar-top-strip.mac");
    expect(block).toMatch(/padding-left:\s*var\(--traffic-light-inset\)/);
  });

  // Icon-only chrome (design decision): every .chrome-btn-label is visually
  // hidden, NOT display:none (which would strip the accessible name) — the
  // classic clip-rect pattern.
  it(".chrome-btn-label: visually-hidden (not display:none)", () => {
    const block = ruleBlock(".chrome-btn-label");
    expect(block).toMatch(/position:\s*absolute/);
    expect(block).toMatch(/clip:\s*rect\(/);
    expect(block).not.toMatch(/display:\s*none/);
  });

  // M6 rehome: a chrome button that lands in the rail repaints in
  // --sidebar-* tokens (SIDEBAR CONTRAST RULE), never the title-bar's bare
  // global --muted/--accent — see sidebar-contrast.test.ts's fuller sweep.
  it(".sidebar-top-strip .chrome-btn: consumes --sidebar-muted, not the bare global --muted", () => {
    const block = ruleBlock(".sidebar-top-strip .chrome-btn");
    expect(block).toMatch(/color:\s*var\(--sidebar-muted\)/);
  });

  it("mac traffic-light inset drops to .5em when the rail is open (sibling-combinator rule exists)", () => {
    // peek 오버레이는 레일을 차지하지 않는다 — 2026-11-14 (:not([data-peek]) 추가)
    expect(css).toContain(".sidebar-aside:not([hidden]):not([data-peek]) ~ .main-column > .title-bar.mac { padding-left: .5em; }");
    expect(css).not.toContain(".sidebar-aside:not([hidden]) ~ .main-column > .title-bar.mac");
  });

  // Regression guard: the sash's sibling-combinator visibility rule (aside
  // ~ .workspace-sash) must survive the .main-column refactor unchanged —
  // the design's whole point was keeping aside/sash as direct .workspace
  // children so this selector never needed to change.
  it("regression: the sidebar-open -> sash-visible sibling rule is unchanged", () => {
    // peek 오버레이는 레일을 차지하지 않는다 — 2026-11-14 (sash 없음: 본문 5px 안 줄어듦)
    expect(css).toContain(".sidebar-aside:not([hidden]):not([data-peek]) ~ .workspace-sash { display: block; }");
    expect(css).not.toContain(".sidebar-aside:not([hidden]) ~ .workspace-sash");
  });

  it("peek overlay: 흐름 밖 fixed, title-bar 아래에서 시작, 새 font-size 없음", () => {
    const block = ruleBlock(".sidebar-aside[data-peek]");
    expect(block).toMatch(/position:\s*fixed/);
    expect(block).toMatch(/top:\s*36px/);
    expect(block).toMatch(/left:\s*0/);
    expect(block).toMatch(/bottom:\s*0/);
    expect(block).toMatch(/z-index:\s*40/);
    expect(block).toMatch(/box-shadow:\s*var\(--elev-1-shadow\)/);
    expect(block).not.toMatch(/font-size/);
    expect(css).toContain(".sidebar-aside[data-peek] > .sidebar-top-strip { display: none; }");
  });

  it("세 값 묶기: .title-bar height == peek top == EDGE_ZONE_TOP_PX == 36", async () => {
    const { EDGE_ZONE_TOP_PX } = await import("../src/sidebar/edge-peek");
    expect(ruleBlock(".title-bar")).toMatch(/height:\s*36px/);
    expect(ruleBlock(".sidebar-aside[data-peek]")).toMatch(/top:\s*36px/);
    expect(EDGE_ZONE_TOP_PX).toBe(36);
  });
});
