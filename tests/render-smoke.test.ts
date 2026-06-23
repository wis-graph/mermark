import { describe, it, expect, vi, beforeEach } from "vitest";

// Tauri's invoke is called by image/wikilink widgets and autosave; stub it with
// the real command contracts: read_file -> {text, mtime}, write_file -> mtime,
// everything else (path_exists, …) -> false.
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

const DOC = `# Title

| A | B |
|:--|--:|
| 1 | 2 |

- [x] done
- [ ] todo

\`\`\`mermaid
graph TD
  A-->B
\`\`\`

Inline $e=mc^2$ and block:

$$
\\int_0^1 x\\,dx
$$

> [!note] hi
> body

Ref[^1] and [[wikilink]] and ![alt](pic.png) and [a link](https://x.com).

[^1]: def
`;

function mount(host: HTMLElement, doc: string) {
  // edit mode = live preview behavior, which most tests exercise
  return mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: "edit" }).view;
}

describe("full-editor render smoke", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("mounts and renders the feature-rich doc without throwing", () => {
    expect(() => {
      const view = mount(host, DOC);
      view.dispatch({ selection: { anchor: 0 } });
      (view as unknown as { measure(): void }).measure();
      view.destroy();
    }).not.toThrow();
  });

  it("is editable: typing changes the document", () => {
    const view = mount(host, "hello");
    view.dispatch({ changes: { from: 5, insert: " world" } });
    expect(view.state.doc.toString()).toBe("hello world");
    view.destroy();
  });

  it("survives a single huge line inside a code fence (D5)", () => {
    const huge = "```\n" + "x".repeat(25000) + "\n```\n";
    expect(() => {
      const view = mount(host, huge);
      (view as unknown as { measure(): void }).measure();
      view.destroy();
    }).not.toThrow();
  });

  it("conceals wikilink markers when cursor is elsewhere, reveals on the line (B1/B2)", () => {
    const doc = "first line\n\nsee [[target|Alias]] here";
    const view = mount(host, doc);
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    // concealed: widget shows alias, raw brackets hidden
    expect(view.contentDOM.textContent).not.toContain("[[target");
    expect(view.contentDOM.textContent).toContain("Alias");
    // move cursor onto the wikilink line → raw source revealed
    view.dispatch({ selection: { anchor: doc.indexOf("[[") + 2 } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.textContent).toContain("[[target|Alias]]");
    // move cursor away again → re-concealed
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.textContent).not.toContain("[[target");
    view.destroy();
  });

  it("conceals ==highlight== markers off-line, reveals on the line, re-conceals (highlight B1/B2)", () => {
    const doc = "first line\n\nsee ==marked== here";
    const view = mount(host, doc);
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    // concealed: body styled, == markers hidden
    expect(view.contentDOM.querySelector(".cm-highlight")).not.toBeNull();
    expect(view.contentDOM.textContent).toContain("marked");
    expect(view.contentDOM.textContent).not.toContain("==marked==");
    // cursor onto the highlight line → raw source revealed
    view.dispatch({ selection: { anchor: doc.indexOf("==") + 1 } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.textContent).toContain("==marked==");
    // cursor away again → re-concealed
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.textContent).not.toContain("==marked==");
    view.destroy();
  });

  it("does not render ==highlight== inside code fences", () => {
    const doc = "```\n==x==\n```\n\ntail";
    const view = mount(host, doc);
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.querySelector(".cm-highlight")).toBeNull();
    expect(view.contentDOM.textContent).toContain("==x==");
    view.destroy();
  });

  it("reveals table source when the cursor enters it", () => {
    const doc = "intro\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\noutro";
    const view = mount(host, doc);
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.querySelector(".cm-table")).not.toBeNull();
    view.dispatch({ selection: { anchor: doc.indexOf("| A") + 2 } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.textContent).toContain("| A | B |");
    view.destroy();
  });

  it("renders [text](url) as a clickable link span (D1)", () => {
    const view = mount(host, "go [home](https://example.com) now\n\nfar away");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    (view as unknown as { measure(): void }).measure();
    const link = view.contentDOM.querySelector(".cm-link") as HTMLElement | null;
    expect(link).not.toBeNull();
    expect(link!.dataset.href).toBe("https://example.com");
    expect(link!.textContent).toBe("home");
    // the (url) part is concealed
    expect(view.contentDOM.textContent).not.toContain("(https://example.com)");
    view.destroy();
  });

  it("headings get cm-heading + cm-hN line classes h1..h6 (typescale contract)", () => {
    const doc = "# A\n## B\n### C\n#### D\n##### E\n###### F";
    const ed = mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: "read" });
    (ed.view as unknown as { measure(): void }).measure();
    for (let n = 1; n <= 6; n++) {
      const line = ed.view.contentDOM.querySelector(`.cm-h${n}`);
      expect(line, `expected one .cm-h${n}`).not.toBeNull();
      expect(line!.classList.contains("cm-heading")).toBe(true);
    }
    // exactly one of each level — no duplicate/missing line classes
    expect(ed.view.contentDOM.querySelectorAll(".cm-h1").length).toBe(1);
    expect(ed.view.contentDOM.querySelectorAll(".cm-h6").length).toBe(1);
    ed.view.destroy();
  });

  it("renders a table inside a blockquote without > leaking into cells (D4)", () => {
    const doc = "intro\n\n> | A | B |\n> |---|---|\n> | 1 | 2 |\n\nend";
    const view = mount(host, doc);
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    const th = view.contentDOM.querySelector(".cm-table th");
    expect(th?.textContent).toBe("A");
    view.destroy();
  });

  it("renders a fenced code block as a widget; reveals raw source when the caret enters", () => {
    const doc = "intro\n\n```ts\nconst a = 1;\n```\n\ntail";
    const e = mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: "edit" });
    e.view.dispatch({ selection: { anchor: 0 } });
    (e.view as unknown as { measure(): void }).measure();
    // unfocused → a styled box holding the code body, no raw fence lines
    const box = e.view.contentDOM.querySelector(".cm-codeblock");
    expect(box).not.toBeNull();
    expect(box?.textContent).toContain("const a = 1;");
    expect(box?.getAttribute("data-lang")).toBe("ts");
    expect(e.view.contentDOM.textContent).not.toContain("```");
    // caret inside the block → raw source (fences + code) revealed for editing
    e.view.dispatch({ selection: { anchor: doc.indexOf("const a") } });
    (e.view as unknown as { measure(): void }).measure();
    expect(e.view.contentDOM.querySelector(".cm-codeblock")).toBeNull();
    expect(e.view.contentDOM.textContent).toContain("```ts");
    e.view.destroy();
  });

  it("renders a mermaid fence as a block widget (StateField path); reveals raw on caret entry", () => {
    const doc = "intro\n\n```mermaid\ngraph TD\n  A-->B\n```\n\ntail";
    const view = mount(host, doc);
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    // the block-widget container exists (proves block decoration came from the
    // StateField, not a ViewPlugin — CM would throw otherwise)
    expect(view.contentDOM.querySelector(".cm-mermaid")).not.toBeNull();
    expect(view.contentDOM.textContent).not.toContain("```mermaid");
    // caret inside → raw source (fence + body) revealed for editing
    view.dispatch({ selection: { anchor: doc.indexOf("graph TD") } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.querySelector(".cm-mermaid")).toBeNull();
    expect(view.contentDOM.textContent).toContain("```mermaid");
    view.destroy();
  });

  it("mounts a mermaid fence carrying a px size declaration without throwing (dims path)", () => {
    // first line `300, 400` is a size declaration stripped by parseDimensions;
    // the widget must still mount as a block widget (no throw, .cm-mermaid present)
    const doc = "intro\n\n```mermaid\n300, 400\ngraph TD\n  A-->B\n```\n\ntail";
    let view!: ReturnType<typeof mount>;
    expect(() => {
      view = mount(host, doc);
      view.dispatch({ selection: { anchor: 0 } });
      (view as unknown as { measure(): void }).measure();
    }).not.toThrow();
    expect(view.contentDOM.querySelector(".cm-mermaid")).not.toBeNull();
    view.destroy();
  });

  it("renders unordered list markers as CSS bullets; ordered numbers stay", () => {
    const doc = "- Fruit\n- Veg\n\n1. First\n2. Second";
    const ed = mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: "read" });
    (ed.view as unknown as { measure(): void }).measure();
    expect(ed.view.contentDOM.querySelectorAll(".cm-bullet").length).toBe(2);
    const text = ed.view.contentDOM.textContent ?? "";
    expect(text).not.toContain("- Fruit"); // dash concealed by the bullet
    expect(text).toContain("Fruit");
    expect(text).toContain("1. First"); // ordered marker left as a number
    ed.view.destroy();
  });

  it("renders --- as a horizontal rule; reveals raw on its line", () => {
    const doc = "above\n\n---\n\nbelow";
    const view = mount(host, doc);
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.querySelector(".cm-hr")).not.toBeNull();
    expect(view.contentDOM.textContent).not.toContain("---");
    view.dispatch({ selection: { anchor: doc.indexOf("---") + 1 } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.textContent).toContain("---");
    view.destroy();
  });

  it("task items keep the checkbox and get no bullet", () => {
    const doc = "- [x] done\n- [ ] todo";
    const ed = mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: "read" });
    (ed.view as unknown as { measure(): void }).measure();
    expect(ed.view.contentDOM.querySelectorAll(".cm-bullet").length).toBe(0);
    expect(ed.view.contentDOM.querySelector(".cm-task-checkbox")).not.toBeNull();
    ed.view.destroy();
  });

  it("checkbox stays a native input whose .checked mirrors [x]/[ ] (canvas-ize regression)", () => {
    const doc = "- [x] done\n- [ ] todo";
    const ed = mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: "read" });
    (ed.view as unknown as { measure(): void }).measure();
    const boxes = ed.view.contentDOM.querySelectorAll(
      "input.cm-task-checkbox[type=checkbox]",
    ) as NodeListOf<HTMLInputElement>;
    expect(boxes.length).toBe(2);
    expect(boxes[0].checked).toBe(true); // [x] done
    expect(boxes[1].checked).toBe(false); // [ ] todo
    ed.view.destroy();
  });

  it("clicking the checkbox toggles the source marker (dispatch path preserved)", () => {
    // task on a later line, caret parked at the top → widget stays rendered
    // (edit-mode reveal would otherwise drop the widget on the caret's own line).
    const doc = "intro\n\n- [x] done";
    const view = mount(host, doc);
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    const box = view.contentDOM.querySelector(
      "input.cm-task-checkbox",
    ) as HTMLInputElement | null;
    expect(box).not.toBeNull();
    box!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(view.state.doc.toString()).toBe("intro\n\n- [ ] done"); // [x] → [ ]
    view.destroy();
  });

  it("reveals the raw dash when the caret is on a bullet line (edit mode)", () => {
    const doc = "intro\n\n- Fruit\n- Veg";
    const view = mount(host, doc);
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.querySelectorAll(".cm-bullet").length).toBe(2);
    view.dispatch({ selection: { anchor: doc.indexOf("- Fruit") + 1 } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.textContent).toContain("- Fruit"); // revealed on its line
    expect(view.contentDOM.querySelectorAll(".cm-bullet").length).toBe(1); // other line still a bullet
    view.destroy();
  });

  it("does not render widgets inside code fences (A3)", () => {
    const doc = "```\n[[x]] ![a](b.png) $e=mc^2$\n```\n\ntail";
    const view = mount(host, doc);
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.querySelector(".cm-wikilink")).toBeNull();
    expect(view.contentDOM.querySelector(".cm-image")).toBeNull();
    expect(view.contentDOM.textContent).toContain("[[x]]");
    view.destroy();
  });

  // ── footnote ⌘+hover preview (overlay, not decoration) ──────────────────────
  // The chip render is unchanged; the preview is a separate ViewPlugin overlay.
  // jsdom has no layout, so getBoundingClientRect returns zeros — we assert the
  // popup's existence + text, not its position (position is covered by CDP).
  // Caret parks on line 1; the chip lives on line 3 so edit-mode reveal never
  // drops the conceal on the chip's own line (raw [^1] would show otherwise).
  const footnoteHoverDoc = "top\n\nbody [^1] here\n\n[^1]: hover definition body";

  function footnoteChip(view: ReturnType<typeof mount>): HTMLElement {
    const chip = view.contentDOM.querySelector(".cm-footnote-ref") as HTMLElement | null;
    expect(chip, "expected a rendered .cm-footnote-ref chip").not.toBeNull();
    return chip!;
  }

  it("still renders the footnote chip (no regression from the hover overlay)", () => {
    const view = mount(host, footnoteHoverDoc);
    view.dispatch({ selection: { anchor: 0 } }); // caret away from the chip line
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.querySelector(".cm-footnote-ref")?.textContent).toBe("1");
    view.destroy();
  });

  it("⌘+hover over the chip pops a preview carrying the definition text", () => {
    const view = mount(host, footnoteHoverDoc);
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    const chip = footnoteChip(view);
    chip.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, metaKey: true }));
    const popup = view.dom.querySelector(".cm-footnote-preview") as HTMLElement | null;
    expect(popup).not.toBeNull();
    expect(popup!.style.display).toBe("block");
    expect(popup!.textContent).toContain("hover definition body");
    view.destroy();
  });

  it("hover without the modifier does not show a preview", () => {
    const view = mount(host, footnoteHoverDoc);
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    const chip = footnoteChip(view);
    chip.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); // no metaKey
    const popup = view.dom.querySelector(".cm-footnote-preview") as HTMLElement | null;
    // either never created, or created-but-hidden — both mean "no preview shown"
    expect(popup === null || popup.style.display === "none").toBe(true);
    view.destroy();
  });

  it("releasing the modifier (keyup) hides an open preview", () => {
    const view = mount(host, footnoteHoverDoc);
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    const chip = footnoteChip(view);
    chip.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, metaKey: true }));
    const popup = view.dom.querySelector(".cm-footnote-preview") as HTMLElement;
    expect(popup.style.display).toBe("block");
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta" })); // modifier released
    expect(popup.style.display).toBe("none");
    view.destroy();
  });

  it("⌘+hover over a chip with no definition is a no-op", () => {
    const view = mount(host, "top\n\nbody [^x] here\n\nno definition for x");
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    const chip = footnoteChip(view);
    chip.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, metaKey: true }));
    const popup = view.dom.querySelector(".cm-footnote-preview") as HTMLElement | null;
    expect(popup === null || popup.style.display === "none").toBe(true);
    view.destroy();
  });

  it("removes the preview element and listeners on destroy (no leak)", () => {
    const view = mount(host, footnoteHoverDoc);
    view.dispatch({ selection: { anchor: 0 } });
    (view as unknown as { measure(): void }).measure();
    const chip = footnoteChip(view);
    chip.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, metaKey: true }));
    expect(view.dom.querySelector(".cm-footnote-preview")).not.toBeNull();
    view.destroy();
    expect(view.dom.querySelector(".cm-footnote-preview")).toBeNull();
  });
});

describe("mode toggle", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  const DOC2 = "first line\n\nsee [[target|Alias]] here";

  it("read mode never reveals, even with the cursor on the line", () => {
    const ed = mountEditor(host, DOC2, "/tmp", "/tmp/doc.md", { initialMode: "read" });
    ed.view.dispatch({ selection: { anchor: DOC2.indexOf("[[") + 2 } });
    (ed.view as unknown as { measure(): void }).measure();
    expect(ed.view.contentDOM.textContent).not.toContain("[[target");
    expect(ed.view.contentDOM.textContent).toContain("Alias");
    ed.view.destroy();
  });

  it("read mode never reveals ==highlight== markers, even on the cursor line", () => {
    const doc = "first line\n\nsee ==marked== here";
    const ed = mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: "read" });
    ed.view.dispatch({ selection: { anchor: doc.indexOf("==") + 1 } });
    (ed.view as unknown as { measure(): void }).measure();
    expect(ed.view.contentDOM.querySelector(".cm-highlight")).not.toBeNull();
    expect(ed.view.contentDOM.textContent).toContain("marked");
    expect(ed.view.contentDOM.textContent).not.toContain("==marked==");
    ed.view.destroy();
  });

  it("switching to edit enables reveal; back to read re-conceals", () => {
    const ed = mountEditor(host, DOC2, "/tmp", "/tmp/doc.md", { initialMode: "read" });
    ed.view.dispatch({ selection: { anchor: DOC2.indexOf("[[") + 2 } });
    ed.setMode("edit"); // → edit: cursor line reveals
    (ed.view as unknown as { measure(): void }).measure();
    expect(ed.view.contentDOM.textContent).toContain("[[target|Alias]]");
    ed.setMode("read"); // → read: fixed render again
    (ed.view as unknown as { measure(): void }).measure();
    expect(ed.view.contentDOM.textContent).not.toContain("[[target");
    ed.view.destroy();
  });

  it("switching edit→read flushes a pending autosave immediately", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const calls = invoke as unknown as ReturnType<typeof vi.fn>;
    calls.mockClear();
    const ed = mountEditor(host, "hello", "/tmp", "/tmp/doc.md", { initialMode: "edit" });
    ed.view.dispatch({ changes: { from: 5, insert: "!" } });
    ed.setMode("read"); // debounce not elapsed — flush must write now
    const writes = calls.mock.calls.filter((c: unknown[]) => c[0] === "write_file");
    expect(writes.length).toBe(1);
    expect((writes[0][1] as { text: string }).text).toBe("hello!");
    ed.view.destroy();
  });

  it("read mode blocks typing via commands (readOnly)", () => {
    const ed = mountEditor(host, "hello", "/tmp", "/tmp/doc.md", { initialMode: "read" });
    expect(ed.view.state.readOnly).toBe(true);
    expect(ed.view.contentDOM.getAttribute("contenteditable")).toBe("false");
    ed.view.destroy();
  });

  it("supports vimMode option and setVimMode dynamically", () => {
    const ed = mountEditor(host, "hello", "/tmp", "/tmp/doc.md", { initialMode: "edit", vimMode: "on" });
    // Verify it mounts with vim option
    expect(() => {
      ed.setVimMode(false);
      ed.setVimMode(true);
    }).not.toThrow();
    ed.view.destroy();
  });
});
