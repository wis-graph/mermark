import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// D1 styles.css contracts for "where am I" chrome (design review 🔴5 + Y15):
//  - the document filename (.title-bar-doc-name) mirrors the viewer caption's
//    13px/500 look and yields to the viewer caption while a viewer is open;
//  - the status bar hides the reading-width slider and Ln/Col where they mean
//    nothing (welcome, viewer), except while a flash message borrows the pos cell.
// CSS-text contracts, same technique as tests/sidebar-contrast.test.ts.
const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles.css"), "utf8");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\~]/g, "\\$&");
function ruleBlock(selector: string): string {
  const m = css.match(new RegExp("(?:^|[}\\n,])\\s*" + esc(selector) + "\\s*(?:,[^{]*)?\\{([^}]*)\\}"));
  if (!m) throw new Error(`no CSS rule for ${selector}`);
  return m[1];
}

describe("document filename label", () => {
  const name = ruleBlock(".title-bar-doc-name");
  const title = ruleBlock(".title-bar-doc-title");

  it("matches the viewer caption look: 13px / 500 / var(--fg) (the caption's colour is on .viewer-panel-caption)", () => {
    for (const block of [name, title]) {
      expect(block).toMatch(/font-size:\s*13px/);
      expect(block).toMatch(/font-weight:\s*500/);
    }
    expect(name).toMatch(/color:\s*var\(--fg\)/);
    expect(ruleBlock(".viewer-panel-caption")).toMatch(/color:\s*var\(--fg\)/);
  });

  it("yields to the viewer caption: hidden when the title slot has content", () => {
    expect(ruleBlock(".title-bar-doc-title:not(:empty) + .title-bar-doc-name")).toMatch(/display:\s*none/);
  });

  it("truncates instead of pushing the right cluster", () => {
    expect(name).toMatch(/text-overflow:\s*ellipsis/);
    expect(name).toMatch(/min-width:\s*0/);
  });
});

describe("status bar context (welcome / viewer)", () => {
  const contexts = [".editor-host.welcome-host", ".editor-host[hidden]"];

  it("hides the width slider in welcome and viewer states", () => {
    for (const ctx of contexts) {
      expect(css).toContain(`${ctx} ~ .status-bar .status-width`);
    }
    expect(ruleBlock(`.editor-host.welcome-host ~ .status-bar .status-width`)).toMatch(/display:\s*none/);
  });

  it("hides Ln/Col in both states EXCEPT while a flash message is showing (:not([data-flash]))", () => {
    for (const ctx of contexts) {
      expect(css).toContain(`${ctx} ~ .status-bar .status-pos:not([data-flash])`);
    }
    expect(ruleBlock(`.editor-host.welcome-host ~ .status-bar .status-pos:not([data-flash])`)).toMatch(/display:\s*none/);
  });
});

// D2a Y8: Korean chrome text breaks at word boundaries (keep-all); the
// document body follows the same word-boundary rule (D2b, user decision #3).
describe("chrome keep-all (D2 Y8)", () => {
  it("body: word-break keep-all + overflow-wrap break-word", () => {
    const body = ruleBlock("body");
    expect(body).toMatch(/word-break:\s*keep-all/);
    expect(body).toMatch(/overflow-wrap:\s*break-word/);
  });
  it(".cm-editor .cm-content: body text also breaks at word boundaries (keep-all, no setting)", () => {
    const block = ruleBlock(".cm-editor .cm-content");
    expect(block).toMatch(/word-break:\s*keep-all/);
    expect(block).not.toMatch(/word-break:\s*normal/);
  });
});

// ---- D2b: body typography & block family (CSS-text contracts) ----
/** Every rule block whose selector list contains exactly `selector` (joined). */
function allBlocks(selector: string): string {
  const out: string[] = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const sels = m[1].replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((x) => x.trim());
    if (sels.includes(selector)) out.push(m[2]);
  }
  if (!out.length) throw new Error(`no CSS rule for ${selector}`);
  return out.join("\n");
}

describe("D2b block family", () => {
  it(".cm-mermaid frame uses --block-edge + the shared --block-radius chain", () => {
    const b = allBlocks(".cm-mermaid");
    expect(b).toMatch(/border:\s*1px solid var\(--block-edge\)/);
    expect(b).toMatch(/border-radius:\s*var\(--block-radius,\s*var\(--radius-md\)\)/);
  });
  it(".cm-table th: --block-fill + left aligned", () => {
    const b = allBlocks(".cm-table th");
    expect(b).toMatch(/background:\s*var\(--block-fill\)/);
    expect(b).toMatch(/text-align:\s*left/);
  });
  it(".cm-frontmatter-key: --block-fill", () => {
    expect(allBlocks(".cm-frontmatter-key")).toMatch(/background:\s*var\(--block-fill\)/);
  });
  it("callout right corners follow --block-radius (fallback 0 keeps the default shape)", () => {
    expect(allBlocks(".cm-callout-head")).toMatch(/border-top-right-radius:\s*var\(--block-radius,\s*0\)/);
    expect(allBlocks(".cm-callout-last")).toMatch(/border-bottom-right-radius:\s*var\(--block-radius,\s*0\)/);
  });
  it("code language label is sans 500", () => {
    const b = allBlocks(".cm-codeblock[data-lang]::before");
    expect(b).toMatch(/font-family:\s*var\(--font-sans\)/);
    expect(b).toMatch(/font-weight:\s*500/);
  });
});

describe("D2b heading first-paint fallbacks == headingScales(1.25)", () => {
  it("--hN-scale fallbacks in styles.css match the sink's values to 3 decimals", async () => {
    const { headingScales } = await import("../src/settings/sinks");
    const want = headingScales("1.25");
    for (let n = 1; n <= 6; n++) {
      const m = css.match(new RegExp(`var\\(--h${n}-scale,\\s*([0-9.]+)\\)`));
      expect(m, `h${n} fallback`).not.toBeNull();
      expect(Number(m![1])).toBeCloseTo(want[n - 1], 2);
    }
  });
});

describe("D2b read-mode fold markers", () => {
  it("read mode hides open markers only (closed stay), pointing at the gutter cell reveals one", () => {
    expect(css).toMatch(/\.cm-editor\.cm-mode-read \.cm-fold-marker:not\(\.cm-fold-marker-closed\)[^{]*\{[^}]*opacity:\s*0/);
    expect(css).toMatch(/\.cm-editor\.cm-mode-read \.cm-foldGutter \.cm-gutterElement:hover \.cm-fold-marker\s*\{[^}]*opacity:\s*\.75/);
  });
});

describe("claude focus ring is ink-derived (distinct from the danger border)", () => {
  it("claude block declares --focus-ring from --fg, not the accent", () => {
    const m = css.match(/:root\[data-theme="claude"\]\s*\{[\s\S]*?--focus-ring:\s*([^;]+);/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/var\(--fg\)/);
    expect(m![1]).not.toMatch(/accent/);
  });
});

// ---- D2c: settings panel row grammar (CSS-text contracts) ----
describe("D2c settings panel", () => {
  it("label column clamps and keeps words; empty label cells collapse (list controls go full width)", () => {
    const b = allBlocks(".settings-row-label");
    expect(b).toMatch(/width:\s*clamp\(140px,\s*30%,\s*200px\)/);
    expect(b).toMatch(/word-break:\s*keep-all/);
    expect(allBlocks(".settings-row-label:empty")).toMatch(/display:\s*none/);
  });
  it("header is 48px; title is plain 13px text (no uppercase)", () => {
    expect(allBlocks(".settings-header")).toMatch(/height:\s*48px/);
    const t = allBlocks(".settings-title");
    expect(t).toMatch(/text-transform:\s*none/);
    expect(t).toMatch(/font-size:\s*var\(--text-md\)/);
  });
  it("pane title (settings, version, remote-share) share one 20px/600 look", () => {
    for (const sel of [".settings-pane-title", ".version-pane-heading", ".remote-share-heading"]) {
      const b = allBlocks(sel);
      expect(b, sel).toMatch(/font-size:\s*20px/);
      expect(b, sel).toMatch(/font-weight:\s*600/);
    }
  });
  it("switch: track/thumb/checked/focus rules", () => {
    expect(allBlocks(".settings-switch")).toMatch(/width:\s*32px/);
    expect(allBlocks(".settings-switch")).toMatch(/height:\s*18px/);
    expect(allBlocks('.settings-switch[aria-checked="true"]')).toMatch(/background:\s*var\(--accent-ui\)/);
    expect(allBlocks('.settings-switch[aria-checked="true"] .settings-switch-thumb')).toMatch(/translateX\(14px\)/);
    expect(allBlocks(".settings-switch:focus-visible")).toMatch(/var\(--focus-ring\)/);
  });
  it("keybind buttons: capture hidden until row hover/focus-within; reset only on overridden rows", () => {
    expect(allBlocks(".keybind-capture")).toMatch(/opacity:\s*0/);
    expect(css).toMatch(/\.keybind-item:hover \.keybind-capture/);
    expect(css).toMatch(/\.keybind-item:focus-within \.keybind-capture/);
    expect(css).toMatch(/\.keybind-capture\.is-capturing[^{]*\{[^}]*opacity:\s*1/);
    expect(allBlocks(".keybind-item:not(.is-overridden) .keybind-reset")).toMatch(/visibility:\s*hidden/);
  });
  it("inputs: control height token and accent-ui focus border", () => {
    expect(allBlocks(".settings-select")).toMatch(/min-height:\s*var\(--control-h-md\)/);
    expect(allBlocks(".settings-text")).toMatch(/min-height:\s*var\(--control-h-md\)/);
    expect(allBlocks(".settings-text:focus")).toMatch(/border-color:\s*var\(--accent-ui\)/);
  });
});
