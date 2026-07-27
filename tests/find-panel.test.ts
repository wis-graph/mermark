import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mountEditor } from "../src/editor";
import { openFindPanel, FIND_KEYMAP_WITHOUT_MOD_F } from "../src/markdown/find";

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
