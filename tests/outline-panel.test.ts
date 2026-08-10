import { describe, it, expect, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdownLang } from "../src/markdown/parser";
import type { EditorView } from "@codemirror/view";
import { createOutlinePanel } from "../src/sidebar/outline/outline-panel";

// Outline is now a LEFT SIDEBAR <aside> (was a fixed bottom popover .outline-row):
// a shared sidebar shell, a static "목차" header, close()/onOpen for the mutual-
// exclusion coordinator, and the toggle button's fixed `list-tree` identity icon
// + disclosure ARIA (state = aria-expanded only, no icon swap).

const fakeView = (doc: string) =>
  ({ state: EditorState.create({ doc, extensions: [markdownLang()] }) }) as unknown as EditorView;

describe("outline panel: left-sidebar shell (C)", () => {
  it("renders a left-sidebar <aside> (not a fixed row), hidden by default", () => {
    const p = createOutlinePanel({ getView: () => fakeView("# a") });
    expect(p.aside.tagName.toLowerCase()).toBe("aside");
    expect(p.aside.classList.contains("outline-aside")).toBe(true);
    expect(p.aside.classList.contains("sidebar-aside")).toBe(true);
    expect(p.aside.id).toBe("outline-aside");
    expect(p.aside.hidden).toBe(true);
    expect((p as unknown as { row?: unknown }).row).toBeUndefined(); // row field removed
  });

  it("has a static header labelled 목차", () => {
    const p = createOutlinePanel({ getView: () => fakeView("# a") });
    expect(p.aside.querySelector(".outline-header")?.textContent).toBe("목차");
  });

  it("button toggles the aside and fires onOpen only when opening", () => {
    const onOpen = vi.fn();
    const p = createOutlinePanel({ getView: () => fakeView("# a\n## b"), onOpen });
    p.button.click();
    expect(p.aside.hidden).toBe(false);
    expect(onOpen).toHaveBeenCalledOnce();
    p.button.click();
    expect(p.aside.hidden).toBe(true);
    expect(onOpen).toHaveBeenCalledOnce(); // not fired on close
  });

  it("close() hides the aside (idempotent)", () => {
    const p = createOutlinePanel({ getView: () => fakeView("# a") });
    p.button.click();
    expect(p.aside.hidden).toBe(false);
    p.close();
    expect(p.aside.hidden).toBe(true);
    p.close();
    expect(p.aside.hidden).toBe(true);
  });
});

describe("outline panel: EPUB toc override (setOverride, design §5)", () => {
  it("renders override items instead of md headings when the panel is open, and clicking one calls jump()", () => {
    const p = createOutlinePanel({ getView: () => fakeView("# a\n## b") });
    const jump = vi.fn();
    p.setOverride([{ level: 1, text: "Chapter 1", jump }]);
    p.button.click(); // open() calls refresh()
    const items = Array.from(p.aside.querySelectorAll(".outline-item"));
    expect(items.map((i) => i.textContent)).toEqual(["Chapter 1"]);
    expect(items.some((i) => i.textContent === "a" || i.textContent === "b")).toBe(false);

    (items[0] as HTMLElement).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(jump).toHaveBeenCalledOnce();
  });

  it("setOverride(null) restores the md heading path", () => {
    const p = createOutlinePanel({ getView: () => fakeView("# a\n## b") });
    p.setOverride([{ level: 1, text: "Chapter 1", jump: vi.fn() }]);
    p.button.click();
    expect(Array.from(p.aside.querySelectorAll(".outline-item")).map((i) => i.textContent)).toEqual(["Chapter 1"]);

    p.setOverride(null);
    expect(Array.from(p.aside.querySelectorAll(".outline-item")).map((i) => i.textContent)).toEqual(["a", "b"]);
  });

  it("a doc-change refresh while override is active does not fall back to md headings", () => {
    let doc = "# a\n## b";
    const p = createOutlinePanel({ getView: () => fakeView(doc) });
    p.setOverride([{ level: 1, text: "Chapter 1", jump: vi.fn() }]);
    p.button.click();
    doc = "# a\n## b\n### c"; // md doc changed underneath the override
    p.refresh();
    expect(Array.from(p.aside.querySelectorAll(".outline-item")).map((i) => i.textContent)).toEqual(["Chapter 1"]);
  });
});

describe("outline panel: toggle icon + disclosure ARIA (N)", () => {
  it("closed → list identity icon, aria-expanded=false, aria-controls set", () => {
    const p = createOutlinePanel({ getView: () => fakeView("# a") });
    expect(p.button.querySelector(".icon-list")).toBeTruthy();
    expect(p.button.getAttribute("aria-expanded")).toBe("false");
    expect(p.button.getAttribute("aria-controls")).toBe("outline-aside");
    expect(p.button.querySelector(".chrome-btn-label")?.textContent).toBe("목차");
  });

  it("opening keeps the SAME list icon (no swap), aria-expanded=true, label preserved", () => {
    const p = createOutlinePanel({ getView: () => fakeView("# a") });
    p.button.click();
    expect(p.button.querySelector(".icon-list")).toBeTruthy();
    expect(p.button.getAttribute("aria-expanded")).toBe("true");
    expect(p.button.querySelector(".chrome-btn-label")?.textContent).toBe("목차");
  });

  it("never renders a panel-left icon (no more identity-in-label/state-in-icon swap)", () => {
    const p = createOutlinePanel({ getView: () => fakeView("# a") });
    expect(p.button.querySelector(".icon-panel-left-open")).toBeNull();
    expect(p.button.querySelector(".icon-panel-left-close")).toBeNull();
    p.button.click();
    expect(p.button.querySelector(".icon-panel-left-open")).toBeNull();
    expect(p.button.querySelector(".icon-panel-left-close")).toBeNull();
  });
});
