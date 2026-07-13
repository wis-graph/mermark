import { describe, it, expect, vi } from "vitest";
import { createFavoritesSection, pickDropIndex, dropIndexToFinalIndex } from "../src/favorites/favorites-panel";
import { reorderFavorite } from "../src/favorites/favorite-folders";

// Favorites is a BOTTOM SECTION (M5) hosted inside the explorer's aside — see
// favorites-panel.ts header. Unlike the M4 aside (button/open/close/onOpen,
// header ★-add, 4-way mutual exclusion), the section is always mounted and
// visible: no toggle shell, no getCurrentFolder/onAdd (adding a favorite is
// now the explorer folder-row star's job — see explorer-panel.test.ts). Only
// onJump/onRemove/onReorder remain as emitted events; main is the single
// favoriteFoldersSetting writer.

function mkSection(overrides: Partial<Parameters<typeof createFavoritesSection>[0]> = {}) {
  return createFavoritesSection({
    getFavorites: () => [],
    onJump: () => {},
    onRemove: () => {},
    onReorder: () => {},
    ...overrides,
  });
}

/** Synthesize a PointerEvent the way sidebar-sash.test.ts does (bubbles so a
 *  dispatch on an item reaches the delegated listener on .favorites-list). */
function pointer(type: string, clientY: number, extra: Partial<PointerEventInit> = {}) {
  return new PointerEvent(type, { clientY, pointerId: 1, bubbles: true, cancelable: true, ...extra });
}

/** Stub every .favorites-item's getBoundingClientRect to a fixed-height
 *  (40px) row stack in list order, so pickDropIndex's midpoint math is
 *  deterministic in jsdom (which never computes real layout). Item i's
 *  midpoint lands at i*40 + 20. */
function stubItemRects(listEl: HTMLElement): void {
  const items = Array.from(listEl.querySelectorAll<HTMLElement>(".favorites-item"));
  items.forEach((item, i) => {
    item.getBoundingClientRect = () =>
      ({ top: i * 40, bottom: i * 40 + 40, height: 40, left: 0, right: 0, width: 0, x: 0, y: i * 40 }) as DOMRect;
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

// 2026-07-12 design-polish batch ①: click semantics moved from mousedown
// (fires immediately on press) to pointerdown→pointerup with no drag travel
// in between — mousedown-fires-immediately would make a drag impossible to
// start (see favorites-panel.ts's listener header). This REPLACES the prior
// mousedown-based assertions with the pointer sequence.
describe("favorites section: click behavior (pointerdown -> pointerup, no drag)", () => {
  it("pressing and releasing an item with no travel calls onJump with its path", () => {
    const onJump = vi.fn();
    const s = mkSection({ getFavorites: () => ["/x/docs"], onJump });
    const item = s.el.querySelector<HTMLElement>(".favorites-item")!;
    item.dispatchEvent(pointer("pointerdown", 0));
    item.dispatchEvent(pointer("pointerup", 0));
    expect(onJump).toHaveBeenCalledWith("/x/docs");
  });

  it("pressing and releasing the remove (X) button calls onRemove and does NOT call onJump", () => {
    const onJump = vi.fn();
    const onRemove = vi.fn();
    const s = mkSection({ getFavorites: () => ["/x/docs"], onJump, onRemove });
    const removeBtn = s.el.querySelector<HTMLElement>(".favorites-remove")!;
    removeBtn.dispatchEvent(pointer("pointerdown", 0));
    removeBtn.dispatchEvent(pointer("pointerup", 0));
    expect(onRemove).toHaveBeenCalledWith("/x/docs");
    expect(onJump).not.toHaveBeenCalled();
  });

  it("travel below the drag threshold (3px) still reads as a click, not a drag", () => {
    const onJump = vi.fn();
    const onReorder = vi.fn();
    const s = mkSection({ getFavorites: () => ["/a", "/b", "/c"], onJump, onReorder });
    const listEl = s.el.querySelector<HTMLElement>(".favorites-list")!;
    stubItemRects(listEl);
    const item = s.el.querySelectorAll<HTMLElement>(".favorites-item")[0]!;
    item.dispatchEvent(pointer("pointerdown", 0));
    listEl.dispatchEvent(pointer("pointermove", 3));
    listEl.dispatchEvent(pointer("pointerup", 3));
    expect(onJump).toHaveBeenCalledWith("/a");
    expect(onReorder).not.toHaveBeenCalled();
  });
});

describe("pickDropIndex", () => {
  it("returns 0 when the pointer is above every midpoint", () => {
    expect(pickDropIndex([20, 60, 100], 0)).toBe(0);
  });

  it("returns midYs.length when the pointer is below every midpoint", () => {
    expect(pickDropIndex([20, 60, 100], 500)).toBe(3);
  });

  it("returns the count of midpoints above the pointer for an interior position", () => {
    expect(pickDropIndex([20, 60, 100], 65)).toBe(2);
  });
});

// Regression (code-auditor 04_audit_report.md #1, 2026-07-13): pickDropIndex's
// raw insert-before index and reorderFavorite's final-position toIndex speak
// different languages once the dragged item's own old slot is spliced out —
// see dropIndexToFinalIndex's doc comment for the full contract.
describe("dropIndexToFinalIndex", () => {
  it("passes the raw index through unchanged for an upward move", () => {
    expect(dropIndexToFinalIndex(0, 2)).toBe(0);
  });

  it("decrements the raw index by one for a downward move (the bug this fixes)", () => {
    expect(dropIndexToFinalIndex(3, 0)).toBe(2);
  });

  it("passes the raw index through unchanged when dropping back on the source's own slot", () => {
    expect(dropIndexToFinalIndex(1, 1)).toBe(1);
  });
});

describe("favorites section: drag reorder", () => {
  // Regression (code-auditor 04_audit_report.md #1, 2026-07-13): dropping "/a"
  // under "/c"'s midpoint in a 3-item list means "insert before /c" — the
  // correct final order is ["/b","/a","/c"] (/a lands directly ahead of /c).
  // pickDropIndex's raw insert-before index (2, computed against the
  // PRE-removal list) overcounts by one once /a's own old slot is spliced
  // out, so the committed toIndex must be dropIndexToFinalIndex(2, 0) = 1,
  // not the raw 2 (which would land /a AFTER /c instead of before it — the
  // bug this test now pins).
  it("commits onReorder(path, finalIndex) — converts the raw drop index for the post-removal list", () => {
    const onJump = vi.fn();
    const onReorder = vi.fn();
    const s = mkSection({ getFavorites: () => ["/a", "/b", "/c"], onJump, onReorder });
    const listEl = s.el.querySelector<HTMLElement>(".favorites-list")!;
    stubItemRects(listEl);
    const first = s.el.querySelectorAll<HTMLElement>(".favorites-item")[0]!;

    first.dispatchEvent(pointer("pointerdown", 20)); // "/a"'s own midpoint
    listEl.dispatchEvent(pointer("pointermove", 100)); // past threshold, under "/c"'s midpoint
    listEl.dispatchEvent(pointer("pointerup", 100));

    expect(onReorder).toHaveBeenCalledWith("/a", 1);
    expect(onJump).not.toHaveBeenCalled();
  });

  // The exact scenario from the audit trace: a downward INTERIOR drop (target
  // is neither the first nor the last item) is where the raw/final index
  // languages diverge — upward moves and moves to the very end happen to
  // agree, which is how the original bug slipped past the first test round.
  it("a downward interior drop lands the item directly before its target, not after (audit trace)", () => {
    const onReorder = vi.fn();
    const s = mkSection({ getFavorites: () => ["/a", "/b", "/c", "/d"], onReorder });
    const listEl = s.el.querySelector<HTMLElement>(".favorites-list")!;
    stubItemRects(listEl);
    const first = s.el.querySelectorAll<HTMLElement>(".favorites-item")[0]!;

    first.dispatchEvent(pointer("pointerdown", 20)); // "/a"
    listEl.dispatchEvent(pointer("pointermove", 90)); // between "/b" (60) and "/c" (100)
    listEl.dispatchEvent(pointer("pointerup", 90));

    // pickDropIndex([20,60,100,140], 90) = 2 (raw insert-before /c);
    // dropIndexToFinalIndex(2, 0) = 1 -> reorderFavorite(list, "/a", 1) = ["/b","/a","/c","/d"].
    expect(onReorder).toHaveBeenCalledWith("/a", 1);
  });

  // team-lead's exact reproduction (2026-07-13 review): moving a MIDDLE item
  // downward, not just the first. Verified against the REAL reorderFavorite
  // (not a hand-computed expected index) so this can't repeat the earlier
  // mistake of asserting call args that happened to match a buggy
  // implementation — this pins the actual materialized list.
  it("[A,B,C,D]: dragging B down between C and D lands it there — [A,C,B,D]", () => {
    const list = ["A", "B", "C", "D"];
    const onReorder = vi.fn((path: string, toIndex: number) => reorderFavorite(list, path, toIndex));
    const s = mkSection({ getFavorites: () => list, onReorder });
    const listEl = s.el.querySelector<HTMLElement>(".favorites-list")!;
    stubItemRects(listEl);
    const second = s.el.querySelectorAll<HTMLElement>(".favorites-item")[1]!; // "B"

    second.dispatchEvent(pointer("pointerdown", 60)); // "B"'s own midpoint
    listEl.dispatchEvent(pointer("pointermove", 120)); // between "C" (100) and "D" (140)
    listEl.dispatchEvent(pointer("pointerup", 120));

    expect(onReorder).toHaveBeenCalledWith("B", 2);
    expect(onReorder.mock.results[0]!.value).toEqual(["A", "C", "B", "D"]);
  });

  // code-auditor 🟡 (2026-07-13): crossing the drag threshold and releasing
  // back over the SAME slot (net move = 0) must not silently swallow the
  // release — it falls back to the click-era meaning (remove-checked-first,
  // then jump), matching a plain non-dragging press/release.
  describe("net-zero drag (crossed the threshold, released on the original slot)", () => {
    it("falls back to onJump when the press started on the item body", () => {
      const onJump = vi.fn();
      const onReorder = vi.fn();
      const s = mkSection({ getFavorites: () => ["/a", "/b", "/c"], onJump, onReorder });
      const listEl = s.el.querySelector<HTMLElement>(".favorites-list")!;
      stubItemRects(listEl);
      const first = s.el.querySelectorAll<HTMLElement>(".favorites-item")[0]!;

      first.dispatchEvent(pointer("pointerdown", 20)); // "/a"'s own midpoint
      listEl.dispatchEvent(pointer("pointermove", 25)); // past threshold, still over "/a"'s own slot
      listEl.dispatchEvent(pointer("pointerup", 25));

      expect(onJump).toHaveBeenCalledWith("/a");
      expect(onReorder).not.toHaveBeenCalled();
    });

    it("falls back to onRemove (not onJump) when the press started on the remove button", () => {
      const onJump = vi.fn();
      const onRemove = vi.fn();
      const onReorder = vi.fn();
      const s = mkSection({ getFavorites: () => ["/a", "/b", "/c"], onJump, onRemove, onReorder });
      const listEl = s.el.querySelector<HTMLElement>(".favorites-list")!;
      stubItemRects(listEl);
      const removeBtn = s.el.querySelector<HTMLElement>(".favorites-remove")!;

      removeBtn.dispatchEvent(pointer("pointerdown", 20));
      listEl.dispatchEvent(pointer("pointermove", 25));
      listEl.dispatchEvent(pointer("pointerup", 25));

      expect(onRemove).toHaveBeenCalledWith("/a");
      expect(onJump).not.toHaveBeenCalled();
      expect(onReorder).not.toHaveBeenCalled();
    });
  });

  it("dims the dragged item and shows a drop-before indicator while dragging", () => {
    const s = mkSection({ getFavorites: () => ["/a", "/b", "/c"] });
    const listEl = s.el.querySelector<HTMLElement>(".favorites-list")!;
    stubItemRects(listEl);
    const [first, , third] = Array.from(s.el.querySelectorAll<HTMLElement>(".favorites-item"));

    first!.dispatchEvent(pointer("pointerdown", 20));
    listEl.dispatchEvent(pointer("pointermove", 90)); // above "/c"'s midpoint (100) -> drop-before on it

    expect(first!.classList.contains("favorites-drag-source")).toBe(true);
    expect(third!.classList.contains("favorites-drop-before")).toBe(true);
  });

  it("emits no onReorder/onJump on pointercancel", () => {
    const onJump = vi.fn();
    const onReorder = vi.fn();
    const s = mkSection({ getFavorites: () => ["/a", "/b", "/c"], onJump, onReorder });
    const listEl = s.el.querySelector<HTMLElement>(".favorites-list")!;
    stubItemRects(listEl);
    const first = s.el.querySelectorAll<HTMLElement>(".favorites-item")[0]!;

    first.dispatchEvent(pointer("pointerdown", 20));
    listEl.dispatchEvent(pointer("pointermove", 100));
    listEl.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, bubbles: true }));

    expect(onReorder).not.toHaveBeenCalled();
    expect(onJump).not.toHaveBeenCalled();
  });
});

describe("favorites section: keyboard reorder (Alt+↑/↓)", () => {
  it("Alt+ArrowDown on a focused item moves it one slot later and restores focus to it", () => {
    document.body.innerHTML = "";
    let list = ["/a", "/b", "/c"];
    const onReorder = vi.fn((path: string, toIndex: number) => {
      // Mirror main.ts's synchronous set(reorderFavorite(...)) + refresh chain.
      const idx = list.indexOf(path);
      const next = [...list];
      const [item] = next.splice(idx, 1);
      next.splice(Math.min(Math.max(toIndex, 0), next.length), 0, item);
      list = next;
      s.refresh();
    });
    const s = mkSection({ getFavorites: () => list, onReorder });
    document.body.append(s.el);

    const first = s.el.querySelectorAll<HTMLElement>(".favorites-item")[0]!;
    first.focus();
    first.dispatchEvent(
      new KeyboardEvent("keydown", { code: "ArrowDown", altKey: true, bubbles: true, cancelable: true }),
    );

    expect(onReorder).toHaveBeenCalledWith("/a", 1);
    expect(list).toEqual(["/b", "/a", "/c"]);
    const restored = document.activeElement as HTMLElement;
    expect(restored.dataset.path).toBe("/a");
    s.el.remove();
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
