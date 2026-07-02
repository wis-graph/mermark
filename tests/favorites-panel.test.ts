import { describe, it, expect, vi } from "vitest";
import { createFavoritesPanel } from "../src/favorites/favorites-panel";
import { createRecentPanel } from "../src/recent/recent-panel";
import { createOutlinePanel } from "../src/outline/outline-panel";
import { createExplorerPanel, type DirEntry } from "../src/explorer/explorer-panel";
import { EditorState } from "@codemirror/state";
import { markdownLang } from "../src/markdown/parser";
import type { EditorView } from "@codemirror/view";

// Favorites is a LEFT SIDEBAR sharing the .sidebar-aside shell (explorer/
// outline/recent's twin), but a different domain: it lists CURATED folders
// (not an MRU of opened documents), so its handlers are onJump/onAdd/onRemove
// (not onOpenFile), it carries a header ★-add button and per-item X-remove
// buttons that recent's shell doesn't have, and it does NOT self-close on
// click (see favorites-panel.ts header comment — jump closes it via the
// explorer's own open path instead).

function mkPanel(overrides: Partial<Parameters<typeof createFavoritesPanel>[0]> = {}) {
  return createFavoritesPanel({
    getFavorites: () => [],
    getCurrentFolder: () => "/cur",
    onJump: () => {},
    onAdd: () => {},
    onRemove: () => {},
    ...overrides,
  });
}

describe("favorites panel: shell", () => {
  it("renders a left-sidebar <aside> (hidden by default), toggle button classes", () => {
    const p = mkPanel();
    expect(p.aside.tagName.toLowerCase()).toBe("aside");
    expect(p.aside.classList.contains("favorites-aside")).toBe(true);
    expect(p.aside.classList.contains("sidebar-aside")).toBe(true);
    expect(p.aside.id).toBe("favorites-aside");
    expect(p.aside.hidden).toBe(true);
    expect(p.button.classList.contains("chrome-btn")).toBe(true);
    expect(p.button.classList.contains("favorites-btn")).toBe(true);
  });

  it("has a header labelled 즐겨찾기", () => {
    const p = mkPanel();
    expect(p.aside.querySelector(".favorites-header")?.textContent).toContain("즐겨찾기");
  });

  it("toggle button carries the star identity icon", () => {
    const p = mkPanel();
    expect(p.button.querySelector(".icon-star")).toBeTruthy();
  });

  it("button toggles the aside and fires onOpen only when opening", () => {
    const onOpen = vi.fn();
    const p = mkPanel({ onOpen });
    p.button.click();
    expect(p.aside.hidden).toBe(false);
    expect(onOpen).toHaveBeenCalledOnce();
    p.button.click();
    expect(p.aside.hidden).toBe(true);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("close() hides the aside (idempotent)", () => {
    const p = mkPanel();
    p.button.click();
    expect(p.aside.hidden).toBe(false);
    p.close();
    expect(p.aside.hidden).toBe(true);
    p.close();
    expect(p.aside.hidden).toBe(true);
  });

  it("aria-expanded tracks open/closed", () => {
    const p = mkPanel();
    expect(p.button.getAttribute("aria-expanded")).toBe("false");
    p.button.click();
    expect(p.button.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("favorites panel: ★-add button", () => {
  it("clicking the header ★ button calls onAdd(getCurrentFolder())", () => {
    const onAdd = vi.fn();
    const p = mkPanel({ getCurrentFolder: () => "/cur", onAdd });
    const addBtn = p.aside.querySelector<HTMLButtonElement>(".favorites-add")!;
    addBtn.click();
    expect(onAdd).toHaveBeenCalledWith("/cur");
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it("disables the ★-add button when the current folder is already a favorite", () => {
    const p = mkPanel({ getFavorites: () => ["/cur"], getCurrentFolder: () => "/cur" });
    p.button.click(); // open → refresh
    const addBtn = p.aside.querySelector<HTMLButtonElement>(".favorites-add")!;
    expect(addBtn.disabled).toBe(true);
    expect(addBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the ★-add button enabled when the current folder is not a favorite", () => {
    const p = mkPanel({ getFavorites: () => ["/other"], getCurrentFolder: () => "/cur" });
    p.button.click();
    const addBtn = p.aside.querySelector<HTMLButtonElement>(".favorites-add")!;
    expect(addBtn.disabled).toBe(false);
    expect(addBtn.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("favorites panel: list rendering", () => {
  it("renders each favorite as basename + full path", () => {
    const p = mkPanel({ getFavorites: () => ["/x/docs", "/y/notes"] });
    p.button.click();
    const items = p.aside.querySelectorAll(".favorites-item");
    expect(items.length).toBe(2);
    expect(items[0].querySelector(".favorites-name")?.textContent).toBe("docs");
    expect(items[0].querySelector(".favorites-path")?.textContent).toBe("/x/docs");
    expect(items[1].querySelector(".favorites-name")?.textContent).toBe("notes");
  });

  it("shows the empty state when there are no favorites", () => {
    const p = mkPanel({ getFavorites: () => [] });
    p.button.click();
    expect(p.aside.querySelector<HTMLElement>(".favorites-empty")!.hidden).toBe(false);
  });

  it("hides the empty state when favorites exist", () => {
    const p = mkPanel({ getFavorites: () => ["/x/docs"] });
    p.button.click();
    expect(p.aside.querySelector<HTMLElement>(".favorites-empty")!.hidden).toBe(true);
  });

  it("each item carries a remove (X) button", () => {
    const p = mkPanel({ getFavorites: () => ["/x/docs"] });
    p.button.click();
    expect(p.aside.querySelector(".favorites-item .favorites-remove")).toBeTruthy();
  });

  it("refresh() is a no-op while the panel is closed (cost 0)", () => {
    const getFavorites = vi.fn(() => ["/a"]);
    const p = mkPanel({ getFavorites });
    p.refresh();
    expect(getFavorites).not.toHaveBeenCalled();
  });

  it("re-renders on refresh() when the live list changed (subscription sink)", () => {
    let list = ["/a"];
    const p = mkPanel({ getFavorites: () => list });
    p.button.click();
    expect(p.aside.querySelectorAll(".favorites-item").length).toBe(1);
    list = ["/a", "/b"];
    p.refresh();
    expect(p.aside.querySelectorAll(".favorites-item").length).toBe(2);
  });
});

describe("favorites panel: click behavior", () => {
  it("clicking an item (mousedown) calls onJump with its path, and does NOT self-close", () => {
    const onJump = vi.fn();
    const p = mkPanel({ getFavorites: () => ["/x/docs"], onJump });
    p.button.click();
    const item = p.aside.querySelector<HTMLElement>(".favorites-item")!;
    item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(onJump).toHaveBeenCalledWith("/x/docs");
    expect(p.aside.hidden).toBe(false); // single-close-path: explorer's open closes this, not itself
  });

  it("clicking the remove (X) button calls onRemove and does NOT call onJump", () => {
    const onJump = vi.fn();
    const onRemove = vi.fn();
    const p = mkPanel({ getFavorites: () => ["/x/docs"], onJump, onRemove });
    p.button.click();
    const removeBtn = p.aside.querySelector<HTMLElement>(".favorites-remove")!;
    removeBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(onRemove).toHaveBeenCalledWith("/x/docs");
    expect(onJump).not.toHaveBeenCalled();
  });
});

describe("favorites panel: 4-way mutual exclusion with explorer + outline + recent", () => {
  const fakeView = (doc: string) =>
    ({ state: EditorState.create({ doc, extensions: [markdownLang()] }) }) as unknown as EditorView;

  // Mirrors recent-panel.test.ts's wireThree — extended to the fourth sidebar,
  // exercising the SAME closeOtherSidebars(keep) shape main.ts uses.
  function wireFour() {
    let explorerPanel: ReturnType<typeof createExplorerPanel>;
    let outlinePanel: ReturnType<typeof createOutlinePanel>;
    let recentPanel: ReturnType<typeof createRecentPanel>;
    let favoritesPanel: ReturnType<typeof createFavoritesPanel>;
    const closeOtherSidebars = (keep: "explorer" | "outline" | "recent" | "favorites"): void => {
      if (keep !== "explorer") explorerPanel.close();
      if (keep !== "outline") outlinePanel.close();
      if (keep !== "recent") recentPanel.close();
      if (keep !== "favorites") favoritesPanel.close();
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
    favoritesPanel = createFavoritesPanel({
      getFavorites: () => [],
      getCurrentFolder: () => "/root",
      onJump: vi.fn(),
      onAdd: vi.fn(),
      onRemove: vi.fn(),
      onOpen: () => closeOtherSidebars("favorites"),
    });
    return { explorerPanel, outlinePanel, recentPanel, favoritesPanel };
  }

  it("opening favorites closes explorer + outline + recent", () => {
    const { explorerPanel, outlinePanel, recentPanel, favoritesPanel } = wireFour();
    recentPanel.button.click();
    expect(recentPanel.aside.hidden).toBe(false);
    favoritesPanel.button.click();
    expect(favoritesPanel.aside.hidden).toBe(false);
    expect(explorerPanel.aside.hidden).toBe(true);
    expect(outlinePanel.aside.hidden).toBe(true);
    expect(recentPanel.aside.hidden).toBe(true);
  });

  it("opening explorer closes favorites (reverse direction)", () => {
    const { explorerPanel, outlinePanel, recentPanel, favoritesPanel } = wireFour();
    favoritesPanel.button.click();
    expect(favoritesPanel.aside.hidden).toBe(false);
    explorerPanel.button.click();
    expect(explorerPanel.aside.hidden).toBe(false);
    expect(favoritesPanel.aside.hidden).toBe(true);
    expect(outlinePanel.aside.hidden).toBe(true);
    expect(recentPanel.aside.hidden).toBe(true);
  });

  it("at most one of the four asides is visible at any point, across a sequence", () => {
    const { explorerPanel, outlinePanel, recentPanel, favoritesPanel } = wireFour();
    const visibleCount = () =>
      [explorerPanel.aside, outlinePanel.aside, recentPanel.aside, favoritesPanel.aside].filter(
        (a) => !a.hidden,
      ).length;
    favoritesPanel.button.click();
    expect(visibleCount()).toBe(1);
    recentPanel.button.click();
    expect(visibleCount()).toBe(1);
    explorerPanel.button.click();
    expect(visibleCount()).toBe(1);
    outlinePanel.button.click();
    expect(visibleCount()).toBe(1);
    favoritesPanel.button.click();
    expect(visibleCount()).toBe(1);
  });
});
