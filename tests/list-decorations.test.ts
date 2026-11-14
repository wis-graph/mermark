// List marker/indent decorations. Geometry itself is CSS (see
// guide-alignment.test.ts); this pins the DOM contract that CSS relies on:
// one fixed marker box per item (concealed AND revealed), one indent box per
// indented item whose width is CSS-by-depth, so 2-space / 4-space / tab
// sources produce identical structure.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(false)),
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), openPath: vi.fn() }));

import { mountEditor } from "../src/editor";

describe("list decorations", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  const mount = (doc: string, mode: "edit" | "read" = "read") =>
    mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: mode }).view;
  const lines = (v: ReturnType<typeof mount>) => [...v.contentDOM.querySelectorAll(".cm-line")];

  it("nested depth and indent structure is identical for 2-space, 4-space and tab sources", () => {
    const shape = (src: string) => {
      const v = mount(src);
      const out = lines(v).map((l) => [
        l.className.match(/cm-list-d\d/)?.[0],
        l.querySelectorAll(".cm-list-indent").length,
        l.querySelectorAll(".cm-bullet").length,
      ]);
      v.destroy();
      return JSON.stringify(out);
    };
    const two = shape("- a\n  - b\n    - c");
    expect(shape("- a\n    - b\n        - c")).toBe(two);
    expect(shape("- a\n\t- b\n\t\t- c")).toBe(two);
    expect(JSON.parse(two)).toEqual([["cm-list-d1", 0, 1], ["cm-list-d2", 1, 1], ["cm-list-d3", 1, 1]]);
  });

  it("every marker kind occupies exactly one marker box (bullet, ordered, task)", () => {
    const v = mount("- a\n\n1. b\n\n- [ ] c");
    const kinds = lines(v)
      .filter((l) => l.classList.contains("cm-list-line"))
      .map((l) => l.querySelectorAll(".cm-list-marker, .cm-bullet").length);
    // concealed bullet: the widget itself is the (same-width) box
    expect(kinds).toEqual([1, 1, 1]);
    v.destroy();
  });

  it("the marker's trailing space is concealed with it (bullet text starts right after the box)", () => {
    const v = mount("- item");
    expect(v.contentDOM.textContent).toBe("item");
    v.destroy();
  });

  it("caret on the line reveals the raw marker INSIDE the same box (no box removed)", () => {
    const v = mount("- a\n  - b", "edit");
    v.dispatch({ selection: { anchor: v.state.doc.line(2).from + 5 } });
    (v as unknown as { measure(): void }).measure();
    const l2 = lines(v)[1];
    expect(l2.querySelectorAll(".cm-bullet").length).toBe(0);
    const box = l2.querySelector(".cm-list-marker");
    expect(box?.textContent).toBe("- ");
    expect(l2.querySelector(".cm-list-indent")?.textContent).toBe("  ");
    v.destroy();
  });

  it("source text is untouched by the decorations (indentation stays editable)", () => {
    const v = mount("- a\n\t- b", "edit");
    expect(v.state.doc.toString()).toBe("- a\n\t- b");
    v.destroy();
  });
});
