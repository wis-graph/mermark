import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mountEditor } from "../src/editor";
import {
  openFindPanel,
  enterEditModeForReplace,
  resyncFindPanelForMode,
  FIND_KEYMAP_WITHOUT_MOD_F,
} from "../src/markdown/find";
import { modeSetting } from "../src/settings/app";

// Tauri invoke is stubbed exactly per the mermark-frontend skill's canonical
// pattern (render-smoke.test.ts) — read_file/write_file shapes match the real
// contract even though this test never calls save.
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

let host: HTMLElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => {
  host.remove();
});

const measure = (view: { measure(): void }) => view.measure();

describe("Mod-F document search panel", () => {
  it("openFindPanel mounts the .cm-search panel DOM", () => {
    const { view } = mountEditor(host, "hello world", "/tmp", "/tmp/doc.md", { initialMode: "edit" });
    openFindPanel(view);
    expect(host.querySelector(".cm-search")).not.toBeNull();
    view.destroy();
  });

  it("renders Korean phrases (찾기/바꾸기), never the English defaults", () => {
    const { view } = mountEditor(host, "hello world", "/tmp", "/tmp/doc.md", { initialMode: "edit" });
    openFindPanel(view);
    const panel = host.querySelector(".cm-search") as HTMLElement;
    // "Find"/"Replace" render as the search/replace inputs' placeholder +
    // aria-label (not text nodes); the button row (next/previous/all/…) DOES
    // render as text content — both surfaces are checked.
    const searchField = panel.querySelector('input[name="search"]') as HTMLInputElement;
    const replaceField = panel.querySelector('input[name="replace"]') as HTMLInputElement;
    expect(searchField.placeholder).toBe("찾기");
    expect(searchField.getAttribute("aria-label")).toBe("찾기");
    expect(replaceField.placeholder).toBe("바꾸기");
    expect(panel.textContent).toContain("다음"); // next
    expect(panel.textContent).toContain("이전"); // previous
    expect(panel.textContent).not.toContain("Find");
    expect(panel.textContent).not.toContain("Replace");
    view.destroy();
  });

  it("edit mode shows the replace field; read mode hides it (readOnly gate)", () => {
    const editView = mountEditor(host, "hello world", "/tmp", "/tmp/doc.md", { initialMode: "edit" }).view;
    openFindPanel(editView);
    expect(host.querySelector('input[name="replace"]')).not.toBeNull();
    editView.destroy();

    const readHost = document.createElement("div");
    document.body.append(readHost);
    const readView = mountEditor(readHost, "hello world", "/tmp", "/tmp/doc.md", { initialMode: "read" }).view;
    openFindPanel(readView);
    expect(readHost.querySelector('input[name="replace"]')).toBeNull();
    readView.destroy();
    readHost.remove();
  });

  it("a match inside a conceal region reveals its raw source once selection lands there (edit mode)", () => {
    const doc = "intro foo\n\n```mermaid\ngraph TD\nfoo --> bar\n```\n";
    const { view } = mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: "edit" });
    measure(view as unknown as { measure(): void });
    // Before selection touches the fenced block, the mermaid widget conceals
    // the raw source — the render-smoke precedent for this pipeline.
    expect(view.contentDOM.textContent).not.toContain("graph TD");
    const fenceMatchOffset = doc.indexOf("foo", doc.indexOf("```mermaid")) + 1;
    view.dispatch({ selection: { anchor: fenceMatchOffset } });
    measure(view as unknown as { measure(): void });
    expect(view.contentDOM.textContent).toContain("graph TD");
    view.destroy();
  });

  it("FIND_KEYMAP_WITHOUT_MOD_F carries no Mod-f binding (dispatcher owns Mod-F)", () => {
    expect(FIND_KEYMAP_WITHOUT_MOD_F.some((b) => b.key === "Mod-f")).toBe(false);
    // Other panel-scoped chords are preserved verbatim.
    expect(FIND_KEYMAP_WITHOUT_MOD_F.some((b) => b.key === "Escape")).toBe(true);
    expect(FIND_KEYMAP_WITHOUT_MOD_F.some((b) => b.key === "F3")).toBe(true);
  });
});

// v0.9.12 real-app defect 2 — "찾아 바꾸기가 없는데?": mermark defaults to
// reader mode, and @codemirror/search's panel omits the replace row whenever
// state.readOnly, so replace was unreachable until enterEditModeForReplace
// (search.replace's mode-switch) shipped.
describe("search.replace mode switch (v0.9.12 defect 2)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("enterEditModeForReplace flips reader mode to edit via the modeSetting SSOT", () => {
    modeSetting.set("read");
    enterEditModeForReplace();
    expect(modeSetting.get()).toBe("edit");
  });

  it("enterEditModeForReplace is a no-op already in edit mode", () => {
    modeSetting.set("edit");
    enterEditModeForReplace();
    expect(modeSetting.get()).toBe("edit");
  });

  it("read mode: ⌘F panel shows a replace-hint button pointing at the live search.replace chord", () => {
    const { view } = mountEditor(host, "hello world", "/tmp", "/tmp/doc.md", { initialMode: "read" });
    openFindPanel(view, { chordLabel: "⌥⌘F", activate: () => {} });
    const hint = host.querySelector(".cm-search-replace-hint");
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain("⌥⌘F");
    expect(host.querySelector('input[name="replace"]')).toBeNull(); // real row absent
    view.destroy();
  });

  it("read mode: clicking the replace hint runs the caller's activate callback", () => {
    const { view } = mountEditor(host, "hello world", "/tmp", "/tmp/doc.md", { initialMode: "read" });
    const activate = vi.fn();
    openFindPanel(view, { chordLabel: "⌥⌘F", activate });
    const hint = host.querySelector<HTMLButtonElement>(".cm-search-replace-hint");
    hint?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(activate).toHaveBeenCalledOnce();
    view.destroy();
  });

  it("edit mode: no replace-hint is shown (the real replace row already covers it)", () => {
    const { view } = mountEditor(host, "hello world", "/tmp", "/tmp/doc.md", { initialMode: "edit" });
    openFindPanel(view, { chordLabel: "⌥⌘F", activate: () => {} });
    expect(host.querySelector(".cm-search-replace-hint")).toBeNull();
    expect(host.querySelector('input[name="replace"]')).not.toBeNull();
    view.destroy();
  });

  it("omitting replaceEntry never adds a hint (search.replace's own ⌘F reopen path)", () => {
    const { view } = mountEditor(host, "hello world", "/tmp", "/tmp/doc.md", { initialMode: "read" });
    openFindPanel(view);
    expect(host.querySelector(".cm-search-replace-hint")).toBeNull();
    view.destroy();
  });
});

// v0.9.13 real-app defect — @codemirror/search's SearchPanel bakes whether it
// draws a replace row into its CONSTRUCTOR (reads state.readOnly ONCE, at
// panel-open time). mermark's mode toggle reconfigures a Compartment on the
// SAME EditorView (editor.ts's setMode never remounts), so a panel opened
// before a mode switch never grew (or lost) its replace row — until
// resyncFindPanelForMode(view) started forcing a close+reopen via
// editor.ts's setMode. These tests drive the real EditorController.setMode
// path (not the raw find.ts function in isolation) so a regression in the
// editor.ts wiring is caught, not just in find.ts.
describe("search panel resyncs on mode switch while open (v0.9.13 defect)", () => {
  it("panel opened in reader mode grows a replace row once setMode('edit') fires", () => {
    const controller = mountEditor(host, "hello world", "/tmp", "/tmp/doc.md", { initialMode: "read" });
    openFindPanel(controller.view, { chordLabel: "⌥⌘F", activate: () => {} });
    expect(host.querySelector(".cm-search-replace-hint")).not.toBeNull();
    expect(host.querySelector('input[name="replace"]')).toBeNull();

    controller.setMode("edit");

    expect(host.querySelector('input[name="replace"]')).not.toBeNull();
    expect(host.querySelector(".cm-search-replace-hint")).toBeNull(); // real row covers it now
    controller.view.destroy();
  });

  it("panel opened in edit mode loses its replace row and gains the hint once setMode('read') fires", () => {
    const controller = mountEditor(host, "hello world", "/tmp", "/tmp/doc.md", {
      initialMode: "edit",
      findReplaceHint: () => ({ chordLabel: "⌥⌘F", activate: () => {} }),
    });
    openFindPanel(controller.view);
    expect(host.querySelector('input[name="replace"]')).not.toBeNull();

    controller.setMode("read");

    expect(host.querySelector('input[name="replace"]')).toBeNull();
    const hint = host.querySelector(".cm-search-replace-hint");
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain("⌥⌘F");
    controller.view.destroy();
  });

  it("resync preserves the typed search term and options (case/regexp/word)", () => {
    const controller = mountEditor(host, "hello world", "/tmp", "/tmp/doc.md", { initialMode: "read" });
    openFindPanel(controller.view);
    const searchField = host.querySelector<HTMLInputElement>('input[name="search"]')!;
    const caseField = host.querySelector<HTMLInputElement>('input[name="case"]')!;
    searchField.value = "wor.d";
    searchField.dispatchEvent(new Event("change", { bubbles: true }));
    caseField.checked = true;
    caseField.dispatchEvent(new Event("change", { bubbles: true }));

    controller.setMode("edit"); // triggers a close+reopen resync

    const searchFieldAfter = host.querySelector<HTMLInputElement>('input[name="search"]')!;
    const caseFieldAfter = host.querySelector<HTMLInputElement>('input[name="case"]')!;
    expect(searchFieldAfter.value).toBe("wor.d");
    expect(caseFieldAfter.checked).toBe(true);
    controller.view.destroy();
  });

  it("mode switches with no panel open are a no-op (nothing to resync)", () => {
    const controller = mountEditor(host, "hello world", "/tmp", "/tmp/doc.md", { initialMode: "read" });
    expect(() => controller.setMode("edit")).not.toThrow();
    expect(host.querySelector(".cm-search")).toBeNull();
    controller.view.destroy();
  });

  it("resyncFindPanelForMode is a no-op when the panel isn't open (unit-level guard)", () => {
    const { view } = mountEditor(host, "hello world", "/tmp", "/tmp/doc.md", { initialMode: "edit" });
    expect(() => resyncFindPanelForMode(view)).not.toThrow();
    expect(host.querySelector(".cm-search")).toBeNull();
    view.destroy();
  });
});

// v0.9.12 real-app defect 1 — 검정 위 검정: light/claude themes invert the
// sidebar to a DARK palette (SIDEBAR CONTRAST RULE), so a search-panel rule
// that fell back to --sidebar-bg/border/accent produced dark-on-dark text on
// the (light) editor canvas. Source-scan guard: the panel block must never
// reference --sidebar-* again, on any theme.
describe("search panel CSS uses canvas tokens, never --sidebar-* (v0.9.12 defect 1)", () => {
  const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles.css");
  const css = readFileSync(cssPath, "utf8");

  it("the .cm-panel.cm-search / .cm-searchMatch block contains no --sidebar- token", () => {
    const start = css.indexOf(".cm-panel.cm-search {");
    expect(start).toBeGreaterThan(-1);
    const selEnd = css.indexOf(".cm-searchMatch-selected", start);
    expect(selEnd).toBeGreaterThan(start);
    const ruleEnd = css.indexOf("}", selEnd); // close of .cm-searchMatch-selected { ... }
    expect(ruleEnd).toBeGreaterThan(selEnd);
    const block = css.slice(start, ruleEnd + 1);
    expect(block).not.toMatch(/--sidebar-/);
  });
});
