import { describe, it, expect, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdownLang } from "../src/markdown/parser";
import { collectHeadings } from "../src/markdown/outline";

// Tauri's invoke is called by image/wikilink widgets + autosave when a full
// editor is mounted (the integration block below). Stub with the real command
// contracts: read_file -> {text, mtime}, write_file -> mtime, else false.
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

const state = (doc: string) =>
  EditorState.create({ doc, extensions: [markdownLang()] });

// ---------------------------------------------------------------------------
// collectHeadings — pure tree query. No layout needed; runs on EditorState.
// ---------------------------------------------------------------------------
describe("collectHeadings: levels & order", () => {
  it("extracts every ATX level 1..6 in document order", () => {
    const s = state("# a\n## b\n### c\n#### d\n##### e\n###### f");
    expect(collectHeadings(s).map((h) => h.level)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(collectHeadings(s).map((h) => h.text)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("keeps document order even when levels are out of order", () => {
    const s = state("## b\n# a");
    expect(collectHeadings(s).map((h) => [h.level, h.text])).toEqual([
      [2, "b"],
      [1, "a"],
    ]);
  });

  it("records pos at the heading line start (the jumpTo target)", () => {
    const doc = "intro\n\n## here";
    const s = state(doc);
    const [h] = collectHeadings(s);
    expect(h.pos).toBe(doc.indexOf("## here"));
  });
});

describe("collectHeadings: inline-mark normalization", () => {
  it("strips bold/italic/code markers, keeping the text", () => {
    const s = state("# **Bold** and *em* and `code`");
    expect(collectHeadings(s)[0].text).toBe("Bold and em and code");
  });

  it("shows a link's display text, not its URL", () => {
    expect(collectHeadings(state("## [txt](http://x)"))[0].text).toBe("txt");
  });

  it("shows a wikilink alias, not the target", () => {
    expect(collectHeadings(state("### [[note|Alias]]"))[0].text).toBe("Alias");
  });

  it("shows a bare wikilink target when there is no alias", () => {
    expect(collectHeadings(state("### [[note]]"))[0].text).toBe("note");
  });

  it("strips highlight markers", () => {
    expect(collectHeadings(state("#### ==hl=="))[0].text).toBe("hl");
  });

  it("drops a trailing closing hash", () => {
    expect(collectHeadings(state("# Title #"))[0].text).toBe("Title");
  });
});

describe("collectHeadings: setext", () => {
  it("reads setext level 1 (=) and level 2 (-)", () => {
    const s = state("Title\n=====\n\nSub\n-----");
    expect(collectHeadings(s).map((h) => [h.level, h.text])).toEqual([
      [1, "Title"],
      [2, "Sub"],
    ]);
  });
});

describe("collectHeadings: edge cases", () => {
  it("returns [] for an empty document", () => {
    expect(collectHeadings(state(""))).toEqual([]);
  });

  it("returns [] when there are no headings", () => {
    expect(collectHeadings(state("just a paragraph\n\nand another"))).toEqual([]);
  });

  it("uses a placeholder for a heading with no visible text", () => {
    expect(collectHeadings(state("#"))[0].text).toBe("(제목 없음)");
    expect(collectHeadings(state("##   "))[0].text).toBe("(제목 없음)");
  });

  it("ignores '# text' inside a fenced code block (not a heading node)", () => {
    expect(collectHeadings(state("```\n# not a heading\n```"))).toEqual([]);
  });

  it("extracts a heading inside a blockquote without leaking the '>' marker", () => {
    const s = state("> # quoted");
    expect(collectHeadings(s).map((h) => [h.level, h.text])).toEqual([[1, "quoted"]]);
  });
});

// ---------------------------------------------------------------------------
// Panel click → jumpTo. jumpTo is mocked: we assert the panel routes the click
// through the SHARED landing with the heading's pos (not a raw view.dispatch).
// ---------------------------------------------------------------------------
// Spy on jumpTo only; editor.ts also imports footnoteNav from this module, so
// keep every other export real (the mounted integration tests need footnoteNav).
vi.mock("../src/markdown/footnote-nav", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/markdown/footnote-nav")>()),
  jumpTo: vi.fn(),
}));
import { jumpTo } from "../src/markdown/footnote-nav";
import { createOutlinePanel } from "../src/outline/outline-panel";
import { EditorView } from "@codemirror/view";

function fakeView(doc: string): EditorView {
  return { state: state(doc) } as unknown as EditorView;
}

describe("outline panel: click navigation", () => {
  it("jumps to the clicked heading's pos via the shared jumpTo landing", () => {
    const doc = "# one\n## two\n### three";
    const view = fakeView(doc);
    const panel = createOutlinePanel({ getView: () => view });
    panel.aside.hidden = false;
    panel.refresh();

    const items = panel.aside.querySelectorAll<HTMLElement>(".outline-item");
    expect(items).toHaveLength(3);

    items[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(jumpTo).toHaveBeenCalledTimes(1);
    expect((jumpTo as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(doc.indexOf("## two"));
  });

  it("renders nothing and stays cheap while the panel is closed", () => {
    const panel = createOutlinePanel({ getView: () => fakeView("# a\n## b") });
    panel.refresh(); // closed → no-op
    expect(panel.aside.querySelectorAll(".outline-item")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: mount a real editor + panel. Guards the zoom invariant (the
// panel is OUTSIDE .cm-content) and live refresh on doc change.
// ---------------------------------------------------------------------------
import { mountEditor } from "../src/editor";

describe("outline panel: mounted integration", () => {
  it("lists every heading and lives OUTSIDE the editor content (zoom guard)", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const { view } = mountEditor(host, "# A\n## B\n### C", "/tmp", "/tmp/d.md", {
      initialMode: "edit",
    });
    const panel = createOutlinePanel({ getView: () => view });
    document.body.append(panel.aside);
    panel.aside.hidden = false;
    panel.refresh();

    expect(panel.aside.querySelectorAll(".outline-item")).toHaveLength(3);
    // Zoom guard: the panel is NOT inside the editor's measured content tree.
    expect(view.contentDOM.querySelector(".outline-aside")).toBeNull();
    expect(view.contentDOM.querySelector(".outline-item")).toBeNull();
    expect(document.querySelector(".outline-aside")).not.toBeNull();

    view.destroy();
    host.remove();
    panel.aside.remove();
  });

  it("makes no decorations in the editor content (only heading classes)", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const { view } = mountEditor(host, "# A\n## B", "/tmp", "/tmp/d.md", {
      initialMode: "read",
    });
    createOutlinePanel({ getView: () => view });
    // The panel emits zero inline/block decorations: the content has only the
    // heading line classes the live-preview already produces.
    expect(view.contentDOM.querySelector(".outline-item")).toBeNull();
    expect(view.contentDOM.querySelectorAll(".cm-heading").length).toBeGreaterThan(0);
    view.destroy();
    host.remove();
  });
});
