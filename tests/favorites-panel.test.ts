import { describe, it, expect, vi } from "vitest";
import { createFavoritesSection } from "../src/favorites/favorites-panel";

// Favorites is a BOTTOM SECTION (M5) hosted inside the explorer's aside — see
// favorites-panel.ts header. Unlike the M4 aside (button/open/close/onOpen,
// header ★-add, 4-way mutual exclusion), the section is always mounted and
// visible: no toggle shell, no getCurrentFolder/onAdd (adding a favorite is
// now the explorer folder-row star's job — see explorer-panel.test.ts). Only
// onJump/onRemove remain as emitted events; main is the single
// favoriteFoldersSetting writer.

function mkSection(overrides: Partial<Parameters<typeof createFavoritesSection>[0]> = {}) {
  return createFavoritesSection({
    getFavorites: () => [],
    onJump: () => {},
    onRemove: () => {},
    ...overrides,
  });
}

describe("favorites section: shell", () => {
  it("el is a <section>, not an <aside>", () => {
    const s = mkSection();
    expect(s.el.tagName.toLowerCase()).toBe("section");
  });

  it("carries an explorer-favorites class + aria-label 즐겨찾기", () => {
    const s = mkSection();
    expect(s.el.classList.contains("explorer-favorites")).toBe(true);
    expect(s.el.getAttribute("aria-label")).toBe("즐겨찾기");
  });

  it("has no button, no aside, no open/close/onOpen — createFavoritesSection returns only el/refresh/focusFirst", () => {
    const s = mkSection();
    expect(s.el.querySelector("aside")).toBeNull();
    expect((s as unknown as Record<string, unknown>).button).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).aside).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).open).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).close).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).onOpen).toBeUndefined();
  });

  it("has a header labelled 즐겨찾기 with an .icon-bookmark glyph (decorative, no add button)", () => {
    const s = mkSection();
    expect(s.el.querySelector(".favorites-header")?.textContent).toContain("즐겨찾기");
    expect(s.el.querySelector(".favorites-header .icon-bookmark")).toBeTruthy();
    expect(s.el.querySelector(".favorites-add")).toBeNull();
  });
});

describe("favorites section: list rendering", () => {
  it("is rendered immediately at creation (no open() gate — always visible)", () => {
    const s = mkSection({ getFavorites: () => ["/x/docs"] });
    expect(s.el.querySelectorAll(".favorites-item").length).toBe(1);
  });

  it("renders each favorite as basename + a left-truncating path wrapped in <bdi>", () => {
    const s = mkSection({ getFavorites: () => ["/x/docs", "/y/notes"] });
    const items = s.el.querySelectorAll(".favorites-item");
    expect(items.length).toBe(2);
    expect(items[0].querySelector(".favorites-name")?.textContent).toBe("docs");
    // Shared with recent-panel: chrome/path-label.ts's truncatedPathLabel
    // renders `.path-label > bdi` (see docs/reviews/intent-review-2026-07-03.md #1).
    const pathEl = items[0].querySelector(".path-label") as HTMLElement;
    expect(pathEl.querySelector("bdi")?.textContent).toBe("/x/docs");
    expect(items[1].querySelector(".favorites-name")?.textContent).toBe("notes");
  });

  it("omits the .path-label when a favorited path has no directory component", () => {
    const s = mkSection({ getFavorites: () => ["docs", "/y/notes"] });
    const items = s.el.querySelectorAll(".favorites-item");
    expect(items[0].querySelector(".favorites-name")?.textContent).toBe("docs");
    expect(items[0].querySelector(".path-label")).toBeNull(); // "docs" === basename("docs")
    expect(items[1].querySelector(".path-label")).not.toBeNull();
  });

  it("shows the empty state when there are no favorites", () => {
    const s = mkSection({ getFavorites: () => [] });
    expect(s.el.querySelector<HTMLElement>(".favorites-empty")!.hidden).toBe(false);
  });

  it("hides the empty state when favorites exist", () => {
    const s = mkSection({ getFavorites: () => ["/x/docs"] });
    expect(s.el.querySelector<HTMLElement>(".favorites-empty")!.hidden).toBe(true);
  });

  it("each item carries a remove (X) button", () => {
    const s = mkSection({ getFavorites: () => ["/x/docs"] });
    expect(s.el.querySelector(".favorites-item .favorites-remove")).toBeTruthy();
  });

  it("re-renders on refresh() when the live list changed (subscription sink)", () => {
    let list = ["/a"];
    const s = mkSection({ getFavorites: () => list });
    expect(s.el.querySelectorAll(".favorites-item").length).toBe(1);
    list = ["/a", "/b"];
    s.refresh();
    expect(s.el.querySelectorAll(".favorites-item").length).toBe(2);
  });
});

describe("favorites section: click behavior", () => {
  it("clicking an item (mousedown) calls onJump with its path (no self-close — there's no aside)", () => {
    const onJump = vi.fn();
    const s = mkSection({ getFavorites: () => ["/x/docs"], onJump });
    const item = s.el.querySelector<HTMLElement>(".favorites-item")!;
    item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(onJump).toHaveBeenCalledWith("/x/docs");
  });

  it("clicking the remove (X) button calls onRemove and does NOT call onJump", () => {
    const onJump = vi.fn();
    const onRemove = vi.fn();
    const s = mkSection({ getFavorites: () => ["/x/docs"], onJump, onRemove });
    const removeBtn = s.el.querySelector<HTMLElement>(".favorites-remove")!;
    removeBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(onRemove).toHaveBeenCalledWith("/x/docs");
    expect(onJump).not.toHaveBeenCalled();
  });
});

describe("favorites section: focusFirst", () => {
  it("focuses the first favorite item when the list is non-empty", () => {
    document.body.innerHTML = "";
    const s = mkSection({ getFavorites: () => ["/x/docs", "/y/notes"] });
    document.body.append(s.el);
    s.focusFirst();
    expect(document.activeElement).toBe(s.el.querySelector(".favorites-item"));
    s.el.remove();
  });

  it("focuses the section itself when the list is empty", () => {
    document.body.innerHTML = "";
    const s = mkSection({ getFavorites: () => [] });
    document.body.append(s.el);
    s.focusFirst();
    expect(document.activeElement).toBe(s.el);
    s.el.remove();
  });
});
