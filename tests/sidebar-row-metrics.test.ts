import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Style contract for the sidebar ROW METRIC TOKENS (docs: styles.css, comment on
// `.sidebar-aside`). The explorer's row grid is the reference; the workspace
// vault rows and the explorer's open-files list consume the SAME tokens, so the
// panels agree at any zoom. Same technique as tests/sidebar-zoom.test.ts: read
// styles.css as text and extract rule blocks.
describe("sidebar row metrics (style contract)", () => {
  const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles.css"), "utf8");
  const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

  /** Declaration block of the first rule whose selector list is exactly `selector`. */
  function block(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = cssNoComments.match(new RegExp("(?:^|\\})\\s*" + escaped + "\\s*\\{([^}]*)\\}"));
    if (!m) throw new Error(`no CSS rule for ${selector}`);
    return m[1]!;
  }
  /** Value of `prop` in `block`, whitespace-normalized. */
  const decl = (b: string, prop: string): string | null => {
    const m = b.match(new RegExp("(?:^|[;\\s])" + prop + "\\s*:\\s*([^;]+);?"));
    return m ? m[1]!.replace(/\s+/g, " ").trim() : null;
  };

  it("declares the seven row tokens on .sidebar-aside with the explorer's own values", () => {
    const b = block(".sidebar-aside");
    expect(decl(b, "--sidebar-list-pad")).toBe("2px 6px 8px");
    expect(decl(b, "--sidebar-row-pad-block")).toBe("4px");
    expect(decl(b, "--sidebar-row-pad-inline")).toBe("6px");
    expect(decl(b, "--sidebar-row-lead")).toBe("4px");
    expect(decl(b, "--sidebar-row-gap")).toBe("4px");
    expect(decl(b, "--sidebar-indent-step")).toBe("12px");
    expect(decl(b, "--sidebar-row-line-height")).toBe("1.5");
    // Row-height floor = the explorer's own 20/13em chip, so 28px (32px at 1.2x) everywhere.
    expect(decl(b, "--sidebar-row-control")).toBe("calc(20em / 13)");
    expect(decl(block(".explorer-vault-toggle"), "height")).toBe("calc(20em / 13)");
  });

  it("the explorer tree/label consume the tokens (computed values unchanged)", () => {
    expect(decl(block(".explorer-tree"), "padding")).toBe("var(--sidebar-list-pad)");
    const label = block(".explorer-label");
    expect(decl(label, "gap")).toBe("var(--sidebar-row-gap)");
    expect(decl(label, "padding")).toBe(
      "var(--sidebar-row-pad-block) var(--sidebar-row-pad-inline) var(--sidebar-row-pad-block) calc(var(--sidebar-row-lead) + (var(--level, 1) - 1) * var(--sidebar-indent-step))",
    );
    expect(decl(label, "line-height")).toBe("var(--sidebar-row-line-height)");
  });

  it("the workspace list/rows consume the same tokens", () => {
    expect(decl(block(".workspace-vault-list"), "padding")).toBe("var(--sidebar-list-pad)");
    expect(decl(block(".workspace-vault-group"), "gap")).toBe("0");
    const row = block(".workspace-vault-row");
    expect(decl(row, "gap")).toBe("0");
    expect(row).not.toMatch(/margin-left/);
    expect(decl(row, "padding-left")).toContain("var(--sidebar-indent-step)");
    expect(decl(row, "padding-right")).toBe("var(--sidebar-row-pad-inline)");
    const select = block(".workspace-vault-select");
    expect(decl(select, "padding")).toBe("var(--sidebar-row-pad-block) 0");
    expect(decl(select, "gap")).toBe("var(--sidebar-row-gap)");
    expect(decl(select, "line-height")).toBe("var(--sidebar-row-line-height)");
    expect(decl(select, "min-height")).toBe("calc(var(--sidebar-row-control) + 2 * var(--sidebar-row-pad-block))");
    const toggle = block(".workspace-vault-toggle");
    expect(decl(toggle, "padding")).toBe("0 var(--sidebar-row-gap) 0 var(--sidebar-row-lead)");
    // leaf rows have no toggle: the select itself carries the lead
    expect(decl(block(".workspace-vault-select.is-leaf"), "padding-left")).toBe("var(--sidebar-row-lead)");
    expect(decl(block(".workspace-group-label"), "padding")).toBe(
      "0 var(--sidebar-row-pad-inline) var(--sidebar-row-pad-block) var(--sidebar-row-lead)",
    );
  });

  it("the open-files list rows use the same tokens", () => {
    expect(decl(block(".explorer-open-files"), "padding")).toBe("var(--sidebar-list-pad)");
    const select = block(".explorer-open-file-select");
    // glyph column = tree row's: glyph at lead (no chevron column).
    expect(decl(select, "padding")).toBe("var(--sidebar-row-pad-block) 0 var(--sidebar-row-pad-block) var(--sidebar-row-lead)");
    expect(decl(select, "min-height")).toBe("calc(var(--sidebar-row-control) + 2 * var(--sidebar-row-pad-block))");
    expect(decl(select, "gap")).toBe("var(--sidebar-row-gap)");
    expect(decl(select, "line-height")).toBe("var(--sidebar-row-line-height)");
    expect(decl(select, "font")).toBe("inherit");
  });

  it("icon boxes keep the literal 16/13em (zoom contract) and the action chip is 20/13em", () => {
    for (const sel of [".workspace-vault-glyph", ".explorer-open-file-glyph"]) {
      const b = block(sel);
      expect(decl(b, "width")).toBe("calc(16em / 13)");
      expect(decl(b, "height")).toBe("calc(16em / 13)");
    }
    const action = block(".workspace-vault-action");
    expect(decl(action, "width")).toBe("calc(20em / 13)");
    expect(decl(action, "height")).toBe("calc(20em / 13)");
    expect(decl(block(".explorer-vault-toggle"), "width")).toBe("calc(20em / 13)");
  });

  it("buttons in the new list/switch declare `font: inherit` (UA button font ignores zoom)", () => {
    for (const sel of [".explorer-view-option", ".explorer-open-file-close", ".workspace-vault-action"]) {
      expect(decl(block(sel), "font"), sel).toBe("inherit");
    }
  });

  // [hidden] locks: each base rule's `display` outranks the UA `[hidden]`, so
  // without these the view swap / refresh hide would write the attribute and
  // change nothing visible (jsdom can't see styles.css).
  it.each([".explorer-tree[hidden]", ".explorer-open-files[hidden]", ".explorer-refresh[hidden]", ".workspace-vault-row[hidden]"])(
    "locks %s { display: none }",
    (selector) => {
      expect(decl(block(selector), "display")).toBe("none");
    },
  );

  it("the tab-strip CSS is gone", () => {
    for (const dead of [".workspace-vault-tab", ".workspace-vault-tabs", "has-tabs"]) {
      expect(cssNoComments.includes(dead), dead).toBe(false);
    }
  });
});
