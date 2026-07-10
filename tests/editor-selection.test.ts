import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Tauri's invoke is called by autosave / widgets; stub it with the real command
// contracts: read_file -> {text, mtime}, write_file -> mtime, else -> false.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) =>
    cmd === "read_file"
      ? Promise.resolve({ text: "", mtime: 1 })
      : cmd === "write_file"
        ? Promise.resolve(1)
        : Promise.resolve(false),
  ),
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));

import { mountEditor } from "../src/editor";
import { getCM } from "@replit/codemirror-vim";

// drawSelection() renders the EditorState selection into CM's own
// .cm-selectionLayer overlay. Without it, CM relies on the browser's native DOM
// ::selection, which vim mode kills (hideNativeSelection) while setting
// visual-mode ranges as EditorState selection — leaving the highlight invisible.
// These tests guard that the overlay layer is wired up; a regression that drops
// drawSelection() removes the .cm-selectionLayer node and fails here.
//
// LAYOUT NOTE: jsdom has no layout engine, so the per-range .cm-selectionBackground
// RECTS are never measured/painted (measure() yields empty geometry). We therefore
// assert the overlay LAYER presence + the vim wiring (DOM/config), not the rects.
// The painted rect, its --selection-bg color/contrast in light & dark, and the
// WebKit real-app vim-visual visibility are covered by the golden master + manual.

describe("text-selection rendering (drawSelection)", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
  });

  it("mounts the .cm-selectionLayer overlay in edit mode (drawSelection registered)", () => {
    const { view } = mountEditor(host, "hello world", "/tmp", "/tmp/doc.md", {
      initialMode: "edit",
    });
    // drawSelection() installs a layer view-plugin whose host is .cm-selectionLayer.
    // Absent the extension this node does not exist — this is the core guard.
    expect(view.dom.querySelector(".cm-selectionLayer")).not.toBeNull();
    view.destroy();
  });

  it("keeps the selection overlay layer in read mode too (base layer, mode-independent)", () => {
    // drawSelection sits in the always-on base layer, outside the mode compartment,
    // so the overlay exists regardless of edit/read — guards against it being
    // accidentally gated behind editable.
    const { view } = mountEditor(host, "hello world", "/tmp", "/tmp/doc.md", {
      initialMode: "read",
    });
    expect(view.dom.querySelector(".cm-selectionLayer")).not.toBeNull();
    view.destroy();
  });

  it("keeps the CM selection overlay under vim mode (where native ::selection is dead)", () => {
    const doc = "hello world";
    const { view } = mountEditor(host, doc, "/tmp", "/tmp/doc.md", {
      initialMode: "edit",
      vimMode: "on",
    });
    // Vim is active: its hideNativeSelection (Prec.highest) forces native
    // ::selection transparent, and visual-mode ranges surface as EditorState
    // selection. The whole fix is that the CM drawSelection overlay — not the
    // dead native selection — is the layer that can paint them. Confirm vim is
    // wired AND the overlay layer is still present (outside the vim compartment).
    expect(getCM(view)).not.toBeNull();
    view.dispatch({ selection: { anchor: 0, head: doc.length } });
    expect(view.dom.querySelector(".cm-selectionLayer")).not.toBeNull();
    view.destroy();
  });
});

// jsdom has no layout engine (see the LAYOUT NOTE above), so we cannot paint-test
// that a selection is visible over a code line. Instead we lock the CSS CONTRACT
// that makes it visible: any surface background painted ON/INSIDE .cm-line must be
// a translucent derivative of --surface, because drawSelection()'s
// hideNativeSelection kills native ::selection inside .cm-line (mode-independent),
// leaving .cm-selectionLayer (z-index -1) as the only selection paint there — an
// opaque line background occludes it. Style is read as TEXT (regex extraction of
// "selector -> first {...} block"), the same zero-drift-via-CSS-text technique
// tests/settings-theme-schema.test.ts uses for the theme tokens.
describe("in-line surface backgrounds stay selection-permeable (style contract)", () => {
  const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles.css");
  const css = readFileSync(cssPath, "utf8");

  // Pulls the declaration block of the FIRST rule whose selector matches exactly
  // (selector immediately followed by `{`), so e.g. ".cm-callout" does not also
  // match ".cm-callout-note { ... }". Intentionally a light regex, not a CSS
  // parser (tests/settings-theme-schema.test.ts's convention).
  function ruleBlock(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(escaped + "\\s*\\{([^}]*)\\}"));
    if (!match) throw new Error(`no CSS rule found for selector ${selector}`);
    return match[1];
  }

  it("declares --surface-veil in :root as a translucent derivative of --surface", () => {
    const rootMatch = css.match(/--surface-veil:\s*([^;]+);/);
    expect(rootMatch).not.toBeNull();
    const value = rootMatch![1];
    expect(value).toContain("var(--surface)");
    expect(value).toContain("transparent");
  });

  it.each([".cm-code-line", ".cm-callout", ".cm-inline-code"])(
    "%s paints its background with var(--surface-veil), not opaque var(--surface)",
    (selector) => {
      const block = ruleBlock(selector);
      expect(block).toMatch(/background:\s*var\(--surface-veil\)/);
    },
  );

  it.each([".cm-code-line", ".cm-callout", ".cm-inline-code"])(
    "%s's declaration block does not reintroduce the opaque var(--surface) background (regression guard)",
    (selector) => {
      const block = ruleBlock(selector);
      // exact-token match: "var(--surface)" (closing paren right after the name),
      // so it does NOT false-positive on "var(--surface-veil)".
      expect(block).not.toMatch(/var\(--surface\)/);
    },
  );
});
