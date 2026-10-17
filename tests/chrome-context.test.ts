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
