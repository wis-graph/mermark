import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRecentPanel } from "../src/recent/recent-panel";
import { createOutlinePanel } from "../src/outline/outline-panel";
import { createExplorerPanel, type DirEntry } from "../src/explorer/explorer-panel";
import { EditorState } from "@codemirror/state";
import { markdownLang } from "../src/markdown/parser";
import type { EditorView } from "@codemirror/view";

// The recent panel is now a LEFT SIDEBAR <aside> (was a fixed bottom popover
// .recent-row), sharing the .sidebar-aside shell with the explorer + outline:
// a static "최근 문서" header, close()/onOpen for the mutual-exclusion
// coordinator, and the toggle button's fixed `history` identity icon +
// disclosure ARIA (state = aria-expanded only, no icon swap).
// onOpen (panel-opened notification) is distinct from onOpenFile (open a
// document) — see design decision 2.

describe("recent panel", () => {
  let host: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("renders each recent doc as basename + full path", () => {
    const { button, aside } = createRecentPanel({
      getRecent: () => ["/notes/alpha.md", "/x/beta.md"],
      onOpenFile: () => {},
    });
    host.append(button, aside);
    button.click();
    const items = aside.querySelectorAll(".recent-item");
    expect(items.length).toBe(2);
    expect(items[0].querySelector(".recent-name")?.textContent).toBe("alpha.md");
    expect(items[0].querySelector(".recent-path")?.textContent).toBe("/notes/alpha.md");
    // M6-B: the path segment is wrapped in a <bdi> (mirrors favorites-panel's
    // left-truncation pattern) so styles.css's rtl trick can clip the LEFT of
    // the path while the segment order (and rightmost basename) stays intact.
    expect(items[0].querySelector(".recent-path > bdi")?.textContent).toBe("/notes/alpha.md");
  });

  it("shows the empty state when there is no history", () => {
    const { button, aside } = createRecentPanel({ getRecent: () => [], onOpenFile: () => {} });
    host.append(button, aside);
    button.click();
    expect(aside.querySelector<HTMLElement>(".recent-empty")!.hidden).toBe(false);
  });

  it("calls onOpenFile with the path on item mousedown, and closes the panel", () => {
    const onOpenFile = vi.fn();
    const { button, aside } = createRecentPanel({
      getRecent: () => ["/notes/a.md"],
      onOpenFile,
    });
    host.append(button, aside);
    button.click();
    const item = aside.querySelector<HTMLElement>(".recent-item")!;
    item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(onOpenFile).toHaveBeenCalledWith("/notes/a.md");
    expect(aside.hidden).toBe(true);
  });

  it("re-renders on refresh() when the live list changed (subscription sink)", () => {
    let list = ["/a.md"];
    const { button, aside, refresh } = createRecentPanel({
      getRecent: () => list,
      onOpenFile: () => {},
    });
    host.append(button, aside);
    button.click();
    expect(aside.querySelectorAll(".recent-item").length).toBe(1);
    list = ["/b.md", "/a.md"];
    refresh();
    expect(aside.querySelectorAll(".recent-item").length).toBe(2);
    expect(aside.querySelector(".recent-name")?.textContent).toBe("b.md");
  });

  it("refresh() is a no-op while the panel is closed (cost 0)", () => {
    const getRecent = vi.fn(() => ["/a.md"]);
    const { refresh } = createRecentPanel({ getRecent, onOpenFile: () => {} });
    refresh(); // closed → should not read the list
    expect(getRecent).not.toHaveBeenCalled();
  });
});

describe("recent panel: left-sidebar shell (C)", () => {
  it("renders a left-sidebar <aside> (not a fixed row), hidden by default", () => {
    const p = createRecentPanel({ getRecent: () => [], onOpenFile: () => {} });
    expect(p.aside.tagName.toLowerCase()).toBe("aside");
    expect(p.aside.classList.contains("recent-aside")).toBe(true);
    expect(p.aside.classList.contains("sidebar-aside")).toBe(true);
    expect(p.aside.id).toBe("recent-aside");
    expect(p.aside.hidden).toBe(true);
    expect((p as unknown as { row?: unknown }).row).toBeUndefined(); // row field removed
  });

  it("has a static header labelled 최근 문서", () => {
    const p = createRecentPanel({ getRecent: () => [], onOpenFile: () => {} });
    expect(p.aside.querySelector(".recent-header")?.textContent).toBe("최근 문서");
  });

  it("button toggles the aside and fires onOpen only when opening", () => {
    const onOpen = vi.fn();
    const p = createRecentPanel({ getRecent: () => [], onOpenFile: () => {}, onOpen });
    p.button.click();
    expect(p.aside.hidden).toBe(false);
    expect(onOpen).toHaveBeenCalledOnce();
    p.button.click();
    expect(p.aside.hidden).toBe(true);
    expect(onOpen).toHaveBeenCalledOnce(); // not fired on close
  });

  it("close() hides the aside (idempotent)", () => {
    const p = createRecentPanel({ getRecent: () => [], onOpenFile: () => {} });
    p.button.click();
    expect(p.aside.hidden).toBe(false);
    p.close();
    expect(p.aside.hidden).toBe(true);
    p.close();
    expect(p.aside.hidden).toBe(true);
  });
});

describe("recent panel: toggle icon + disclosure ARIA (N)", () => {
  it("closed → history identity icon, aria-expanded=false, aria-controls set, label 최근", () => {
    const p = createRecentPanel({ getRecent: () => [], onOpenFile: () => {} });
    expect(p.button.querySelector(".icon-history")).toBeTruthy();
    expect(p.button.getAttribute("aria-expanded")).toBe("false");
    expect(p.button.getAttribute("aria-controls")).toBe("recent-aside");
    expect(p.button.querySelector(".chrome-btn-label")?.textContent).toBe("최근");
  });

  it("opening keeps the SAME history icon (no swap), aria-expanded=true, label preserved", () => {
    const p = createRecentPanel({ getRecent: () => [], onOpenFile: () => {} });
    p.button.click();
    expect(p.button.querySelector(".icon-history")).toBeTruthy();
    expect(p.button.getAttribute("aria-expanded")).toBe("true");
    expect(p.button.querySelector(".chrome-btn-label")?.textContent).toBe("최근");
  });

  it("closing keeps the icon, resets aria-expanded=false", () => {
    const p = createRecentPanel({ getRecent: () => [], onOpenFile: () => {} });
    p.button.click();
    p.button.click();
    expect(p.button.querySelector(".icon-history")).toBeTruthy();
    expect(p.button.getAttribute("aria-expanded")).toBe("false");
  });

  it("never renders a panel-left icon (no more identity-in-label/state-in-icon swap)", () => {
    const p = createRecentPanel({ getRecent: () => [], onOpenFile: () => {} });
    expect(p.button.querySelector(".icon-panel-left-open")).toBeNull();
    expect(p.button.querySelector(".icon-panel-left-close")).toBeNull();
  });
});

describe("recent panel: 3-way mutual exclusion with explorer + outline", () => {
  const fakeView = (doc: string) =>
    ({ state: EditorState.create({ doc, extensions: [markdownLang()] }) }) as unknown as EditorView;

  // Wires all three panels through the same "closeOtherSidebars(keep)" shape
  // main.ts uses, so the combination is exercised the same way production does
  // without importing main.ts's boot() directly.
  function wireThree() {
    let explorerPanel: ReturnType<typeof createExplorerPanel>;
    let outlinePanel: ReturnType<typeof createOutlinePanel>;
    let recentPanel: ReturnType<typeof createRecentPanel>;
    const closeOtherSidebars = (keep: "explorer" | "outline" | "recent"): void => {
      if (keep !== "explorer") explorerPanel.close();
      if (keep !== "outline") outlinePanel.close();
      if (keep !== "recent") recentPanel.close();
    };
    explorerPanel = createExplorerPanel({
      listDir: vi.fn(async (): Promise<DirEntry[]> => []),
      getBaseDir: () => "/root",
      onOpenFile: vi.fn(),
      onOpen: () => closeOtherSidebars("explorer"),
    });
    outlinePanel = createOutlinePanel({
      getView: () => fakeView("# a"),
      onOpen: () => closeOtherSidebars("outline"),
    });
    recentPanel = createRecentPanel({
      getRecent: () => [],
      onOpenFile: vi.fn(),
      onOpen: () => closeOtherSidebars("recent"),
    });
    return { explorerPanel, outlinePanel, recentPanel };
  }

  it("opening recent closes explorer + outline", () => {
    const { explorerPanel, outlinePanel, recentPanel } = wireThree();
    explorerPanel.button.click();
    expect(explorerPanel.aside.hidden).toBe(false);
    recentPanel.button.click();
    expect(recentPanel.aside.hidden).toBe(false);
    expect(explorerPanel.aside.hidden).toBe(true);
    expect(outlinePanel.aside.hidden).toBe(true);
  });

  it("opening explorer closes recent (reverse direction)", () => {
    const { explorerPanel, outlinePanel, recentPanel } = wireThree();
    recentPanel.button.click();
    expect(recentPanel.aside.hidden).toBe(false);
    explorerPanel.button.click();
    expect(explorerPanel.aside.hidden).toBe(false);
    expect(recentPanel.aside.hidden).toBe(true);
    expect(outlinePanel.aside.hidden).toBe(true);
  });

  it("opening outline closes recent", () => {
    const { explorerPanel, outlinePanel, recentPanel } = wireThree();
    recentPanel.button.click();
    outlinePanel.button.click();
    expect(outlinePanel.aside.hidden).toBe(false);
    expect(recentPanel.aside.hidden).toBe(true);
    expect(explorerPanel.aside.hidden).toBe(true);
  });

  it("at most one of the three asides is visible at any point, across a sequence", () => {
    const { explorerPanel, outlinePanel, recentPanel } = wireThree();
    const visibleCount = () =>
      [explorerPanel.aside, outlinePanel.aside, recentPanel.aside].filter((a) => !a.hidden).length;
    recentPanel.button.click();
    expect(visibleCount()).toBe(1);
    explorerPanel.button.click();
    expect(visibleCount()).toBe(1);
    outlinePanel.button.click();
    expect(visibleCount()).toBe(1);
    recentPanel.button.click();
    expect(visibleCount()).toBe(1);
  });
});
