import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createExplorerPanel, type DirEntry, type ExplorerHandlers } from "../src/explorer/explorer-panel";

// ---------------------------------------------------------------------------
// Explorer LEFT SIDEBAR — a lazy folder tree built from an INJECTED listDir()
// (no real backend). The P0 contract this panel owns:
//   1. Click expands (NOT hover — mouseenter never reads a dir); re-expand caches.
//   2. WAI-ARIA Tree roles + roving tabindex (exactly one tabindex=0).
//   3. Keyboard ↑↓→←/Enter/Home/End.
//   4. Focus ≠ Selection (arrows move focus only; Enter/click activates+selects).
//   5. `..` single-click/Enter changes the root.
//   6. Only .md opens (non-md is greyed + inert).
//   7. Sidebar shell interface (aside / button / resetToBaseDir).
// ---------------------------------------------------------------------------

const dir = (name: string, path: string): DirEntry => ({ name, path, is_dir: true });
const file = (name: string, path: string): DirEntry => ({ name, path, is_dir: false });

/** A fake backend list_dir over a fixed tree. `renderTree` canonicalizes the
 *  root (via `normalizePath`) BEFORE calling this, so listDir only ever
 *  receives canonical keys — a plain lookup, no `/..` folding needed here
 *  (that folding used to stand in for canonicalization; now the panel itself
 *  canonicalizes, so a literal `/..` reaching this function would be a bug). */
function fakeTree(): (path: string) => Promise<DirEntry[]> {
  const TREE: Record<string, DirEntry[]> = {
    "/root": [dir("sub", "/root/sub"), file("a.md", "/root/a.md"), file("pic.png", "/root/pic.png")],
    "/root/sub": [file("b.md", "/root/sub/b.md")],
    "/root/child": [file("c.md", "/root/child/c.md")],
  };
  return (path: string) => Promise.resolve(TREE[path] ?? []);
}

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => {
  host.remove();
});

/** Let the awaited list_dir promise chain settle (renderTree / expandFolder are
 *  async; open() fires them fire-and-forget). Real timers — no hover debounce. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** Open the panel and settle the initial renderTree. */
async function openPanel(opts: ExplorerHandlers) {
  const panel = createExplorerPanel(opts);
  host.append(panel.button, panel.aside);
  panel.button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await flush();
  return panel;
}

const treeOf = (aside: HTMLElement) => aside.querySelector('[role="tree"]') as HTMLElement;
const items = (aside: HTMLElement) =>
  [...aside.querySelectorAll(".explorer-item")].map((e) => e as HTMLElement);
const names = (aside: HTMLElement) =>
  items(aside).map((e) => e.querySelector(".explorer-name")?.textContent);
const focusedItem = (aside: HTMLElement) =>
  aside.querySelector(".explorer-item.is-focused") as HTMLElement | null;
const nameOf = (item: HTMLElement | null) => item?.querySelector(".explorer-name")?.textContent;
const press = (aside: HTMLElement, key: string) =>
  treeOf(aside).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
const clickItem = (item: HTMLElement) =>
  item.dispatchEvent(new MouseEvent("click", { bubbles: true }));

// 1. Click expands (NOT hover) + cache -----------------------------------------
describe("explorer: click expands, hover does nothing (1)", () => {
  it("root read once; folder CLICK reads its children once; re-expand caches", async () => {
    const listDir = vi.fn(fakeTree());
    const panel = await openPanel({ listDir, getBaseDir: () => "/root", onOpenFile: vi.fn() });

    expect(listDir).toHaveBeenCalledTimes(1);
    expect(listDir).toHaveBeenCalledWith("/root");
    expect(names(panel.aside)).toEqual(["..", "sub", "a.md", "pic.png"]);

    const sub = panel.aside.querySelector(".explorer-dir") as HTMLElement;
    clickItem(sub);
    await flush();

    expect(listDir).toHaveBeenCalledTimes(2);
    expect(listDir).toHaveBeenLastCalledWith("/root/sub");
    expect(sub.getAttribute("aria-expanded")).toBe("true");
    const kids = sub.querySelector(".explorer-children") as HTMLElement;
    expect(kids.hidden).toBe(false);
    expect(kids.textContent).toContain("b.md");

    // Collapse (click again) then re-expand → cache hit, no re-call.
    clickItem(sub);
    expect(sub.getAttribute("aria-expanded")).toBe("false");
    expect(kids.hidden).toBe(true);
    clickItem(sub);
    await flush();
    expect(sub.getAttribute("aria-expanded")).toBe("true");
    expect(listDir).toHaveBeenCalledTimes(2); // still 2 — served from cache
  });

  it("hover (mouseenter) never reads a dir or expands (WCAG regression guard)", async () => {
    const listDir = vi.fn(fakeTree());
    const panel = await openPanel({ listDir, getBaseDir: () => "/root", onOpenFile: vi.fn() });
    expect(listDir).toHaveBeenCalledTimes(1);

    const sub = panel.aside.querySelector(".explorer-dir") as HTMLElement;
    sub.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    sub.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await flush();

    expect(listDir).toHaveBeenCalledTimes(1); // no hover read
    expect(sub.getAttribute("aria-expanded")).toBe("false"); // no hover expand
  });
});

// 2. ARIA roles + roving tabindex ----------------------------------------------
describe("explorer: ARIA tree roles + roving tabindex (2)", () => {
  it("tree/treeitem/group roles, aria-level, and exactly one tabindex=0", async () => {
    const panel = await openPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root", onOpenFile: vi.fn() });

    const tree = treeOf(panel.aside);
    expect(tree.getAttribute("aria-label")).toBeTruthy();
    for (const it of items(panel.aside)) expect(it.getAttribute("role")).toBe("treeitem");

    const sub = panel.aside.querySelector(".explorer-dir") as HTMLElement;
    expect(sub.getAttribute("aria-expanded")).toBe("false"); // folder has it
    expect(sub.getAttribute("aria-level")).toBe("1");
    const md = items(panel.aside).find((e) => nameOf(e) === "a.md") as HTMLElement;
    expect(md.hasAttribute("aria-expanded")).toBe(false); // file does NOT

    // roving tabindex: exactly one item is tabbable.
    const tabbable = items(panel.aside).filter((e) => e.tabIndex === 0);
    expect(tabbable).toHaveLength(1);

    // Expanded folder gets a role=group child container.
    clickItem(sub);
    await flush();
    const group = sub.querySelector('[role="group"]') as HTMLElement;
    expect(group).toBeTruthy();
    const child = group.querySelector(".explorer-item") as HTMLElement;
    expect(child.getAttribute("aria-level")).toBe("2");
    // Still exactly one tabbable across the now-larger tree.
    expect(items(panel.aside).filter((e) => e.tabIndex === 0)).toHaveLength(1);
  });
});

// 3. Keyboard navigation -------------------------------------------------------
describe("explorer: keyboard ↑↓→←/Enter/Home/End (3)", () => {
  it("↓/↑ move focus only (no list_dir, no open)", async () => {
    const listDir = vi.fn(fakeTree());
    const onOpenFile = vi.fn();
    const panel = await openPanel({ listDir, getBaseDir: () => "/root", onOpenFile });

    expect(nameOf(focusedItem(panel.aside))).toBe(".."); // initial cursor
    press(panel.aside, "ArrowDown");
    expect(nameOf(focusedItem(panel.aside))).toBe("sub");
    press(panel.aside, "ArrowDown");
    expect(nameOf(focusedItem(panel.aside))).toBe("a.md");
    press(panel.aside, "ArrowUp");
    expect(nameOf(focusedItem(panel.aside))).toBe("sub");

    expect(listDir).toHaveBeenCalledTimes(1); // arrows opened nothing
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("→ opens a closed folder / steps into an open one; ← closes / goes to parent", async () => {
    const listDir = vi.fn(fakeTree());
    const panel = await openPanel({ listDir, getBaseDir: () => "/root", onOpenFile: vi.fn() });

    press(panel.aside, "ArrowDown"); // focus "sub"
    const sub = panel.aside.querySelector(".explorer-dir") as HTMLElement;
    press(panel.aside, "ArrowRight"); // closed folder → expand
    await flush();
    expect(sub.getAttribute("aria-expanded")).toBe("true");
    expect(listDir).toHaveBeenLastCalledWith("/root/sub");

    press(panel.aside, "ArrowRight"); // open folder → first child (b.md)
    expect(nameOf(focusedItem(panel.aside))).toBe("b.md");

    press(panel.aside, "ArrowLeft"); // on a file → focus parent (sub)
    expect(nameOf(focusedItem(panel.aside))).toBe("sub");
    press(panel.aside, "ArrowLeft"); // open folder → collapse
    expect(sub.getAttribute("aria-expanded")).toBe("false");
  });

  it("Home/End jump to first/last visible node", async () => {
    const panel = await openPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root", onOpenFile: vi.fn() });
    press(panel.aside, "End");
    expect(nameOf(focusedItem(panel.aside))).toBe("pic.png");
    press(panel.aside, "Home");
    expect(nameOf(focusedItem(panel.aside))).toBe("..");
  });
});

// 4. Focus ≠ Selection ---------------------------------------------------------
describe("explorer: focus is not selection (4)", () => {
  it("arrowing to a file does not open/select it; Enter then opens + selects", async () => {
    const onOpenFile = vi.fn();
    const panel = await openPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root", onOpenFile });

    press(panel.aside, "ArrowDown"); // sub
    press(panel.aside, "ArrowDown"); // a.md
    const md = focusedItem(panel.aside) as HTMLElement;
    expect(nameOf(md)).toBe("a.md");
    expect(onOpenFile).not.toHaveBeenCalled(); // focus ≠ open
    expect(md.hasAttribute("aria-selected")).toBe(false); // focus ≠ select

    press(panel.aside, "Enter");
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledWith("/root/a.md");
    expect(md.getAttribute("aria-selected")).toBe("true");
    expect(md.classList.contains("is-selected")).toBe(true);
  });

  it("single-selection: selecting another file clears the prior selection", async () => {
    const panel = await openPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root", onOpenFile: vi.fn() });
    const md = items(panel.aside).find((e) => nameOf(e) === "a.md") as HTMLElement;
    const sub = panel.aside.querySelector(".explorer-dir") as HTMLElement;
    clickItem(md);
    await flush();
    clickItem(sub); // expand sub → b.md appears
    await flush();
    const b = items(panel.aside).find((e) => nameOf(e) === "b.md") as HTMLElement;
    clickItem(b);
    expect(panel.aside.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
    expect(md.hasAttribute("aria-selected")).toBe(false);
    expect(b.getAttribute("aria-selected")).toBe("true");
  });
});

// 5. `..` single-click / Enter changes the root --------------------------------
describe("explorer: `..` changes root (5)", () => {
  it("single-click rebuilds at the parent and clears prior expansion", async () => {
    const listDir = vi.fn(fakeTree());
    const panel = await openPanel({ listDir, getBaseDir: () => "/root/child", onOpenFile: vi.fn() });
    expect(names(panel.aside)).toEqual(["..", "c.md"]);

    const up = panel.aside.querySelector(".explorer-up") as HTMLElement;
    clickItem(up); // single click (was dblclick)
    await flush();

    // [RED-수정] renderTree canonicalizes before calling listDir — the literal
    // "/root/child/.." instruction never reaches listDir, only "/root" does.
    expect(listDir).toHaveBeenLastCalledWith("/root");
    expect(names(panel.aside)).toEqual(["..", "sub", "a.md", "pic.png"]);
  });

  it("Enter on `..` also changes root", async () => {
    const listDir = vi.fn(fakeTree());
    const panel = await openPanel({ listDir, getBaseDir: () => "/root/child", onOpenFile: vi.fn() });
    press(panel.aside, "Enter"); // initial focus is `..`
    await flush();
    // [RED-수정] same canonicalization contract as the click case above.
    expect(listDir).toHaveBeenLastCalledWith("/root");
    expect(names(panel.aside)).toEqual(["..", "sub", "a.md", "pic.png"]);
  });
});

// F. Child nesting structure (P0 527faf6 regression) --------------------------
// jsdom can't compute flex geometry, so we pin the DOM STRUCTURE that caused the
// bug: the row content must live in .explorer-label, and a folder's children must
// be a block SIBLING after the label (vertical), not a flex sibling to the right.
describe("explorer: folder children nest vertically, not to the right (F)", () => {
  it("folder row content lives in .explorer-label, NOT directly under .explorer-item", async () => {
    const panel = await openPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root", onOpenFile: vi.fn() });
    const item = panel.aside.querySelector(".explorer-item.explorer-dir") as HTMLElement;
    const label = item.querySelector(":scope > .explorer-label") as HTMLElement;
    expect(label).toBeTruthy();
    expect(label.querySelector(".explorer-chevron")).toBeTruthy();
    expect(label.querySelector(".explorer-name")).toBeTruthy();
    // chevron/name are inside label now, not direct flex siblings of the item.
    expect(item.querySelector(":scope > .explorer-chevron")).toBeNull();
    expect(item.querySelector(":scope > .explorer-name")).toBeNull();
  });

  it("the `..` up entry also wraps its row in .explorer-label", async () => {
    const panel = await openPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root", onOpenFile: vi.fn() });
    const up = panel.aside.querySelector(".explorer-up") as HTMLElement;
    const label = up.querySelector(":scope > .explorer-label") as HTMLElement;
    expect(label).toBeTruthy();
    expect(label.querySelector(".explorer-name")?.textContent).toBe("..");
  });

  it("expanded children nest as a block sibling AFTER the label (vertical order)", async () => {
    const panel = await openPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root", onOpenFile: vi.fn() });
    const item = panel.aside.querySelector(".explorer-item.explorer-dir") as HTMLElement;
    clickItem(item);
    await flush();
    const label = item.querySelector(":scope > .explorer-label") as HTMLElement;
    const kids = item.querySelector(":scope > .explorer-children") as HTMLElement;
    expect(kids).toBeTruthy();
    // document order: label precedes children (children is the vertical block below).
    expect(label.compareDocumentPosition(kids) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(kids.querySelectorAll(".explorer-item").length).toBeGreaterThan(0);
  });

  it("child items are indented one level deeper (--level = parent+1)", async () => {
    const panel = await openPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root", onOpenFile: vi.fn() });
    const item = panel.aside.querySelector(".explorer-item.explorer-dir") as HTMLElement;
    expect(item.style.getPropertyValue("--level")).toBe("1");
    clickItem(item);
    await flush();
    const child = panel.aside.querySelector(".explorer-children .explorer-item") as HTMLElement;
    expect(child.style.getPropertyValue("--level")).toBe("2");
  });
});

// D. Header is static — path display is the footer breadcrumb's job now -------
describe("explorer: header is static '탐색기' (D)", () => {
  it("header stays '탐색기' after the initial renderTree (path display moved to the footer breadcrumb)", async () => {
    const panel = await openPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root/child", onOpenFile: vi.fn() });
    const header = panel.aside.querySelector(".explorer-header") as HTMLElement;
    expect(header.textContent).toBe("탐색기");
    expect(header.title).toBe("");
    expect(header.hasAttribute("aria-label")).toBe(false);
  });

  it("header stays static across a root change via `..` (changeRoot → renderTree)", async () => {
    const panel = await openPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root/child", onOpenFile: vi.fn() });
    const header = panel.aside.querySelector(".explorer-header") as HTMLElement;
    const up = panel.aside.querySelector(".explorer-up") as HTMLElement;
    clickItem(up);
    await flush();
    expect(header.textContent).toBe("탐색기");
  });
});

// I. onRootChange — the single observation point for the tree's live root ------
describe("explorer: onRootChange fires once per renderTree (I)", () => {
  it("fires with the canonicalized baseDir on open()", async () => {
    const onRootChange = vi.fn();
    const panel = createExplorerPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root/child/",
      onOpenFile: vi.fn(),
      onRootChange,
    });
    host.append(panel.button, panel.aside);
    panel.button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(onRootChange).toHaveBeenCalledWith("/root/child");
  });

  it("fires again with the parent path on `..`", async () => {
    const onRootChange = vi.fn();
    const panel = createExplorerPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root/child",
      onOpenFile: vi.fn(),
      onRootChange,
    });
    host.append(panel.button, panel.aside);
    panel.button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    onRootChange.mockClear();

    clickItem(panel.aside.querySelector(".explorer-up") as HTMLElement);
    await flush();
    expect(onRootChange).toHaveBeenCalledWith("/root");
  });

  it("fires with the jump target on jumpToRoot", async () => {
    const onRootChange = vi.fn();
    const panel = createExplorerPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile: vi.fn(),
      onRootChange,
    });
    host.append(panel.button, panel.aside);
    panel.button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    onRootChange.mockClear();

    panel.jumpToRoot("/root/child");
    await flush();
    expect(onRootChange).toHaveBeenCalledWith("/root/child");
  });
});

// J. jumpToRoot ------------------------------------------------------------------
describe("explorer: jumpToRoot (J)", () => {
  it("on a CLOSED panel: reveals the shell (onOpen fires) and renders the target — not baseDir", async () => {
    const onOpen = vi.fn();
    const panel = createExplorerPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile: vi.fn(),
      onOpen,
    });
    host.append(panel.button, panel.aside);
    expect(panel.aside.hidden).toBe(true);

    panel.jumpToRoot("/root/child");
    await flush();

    expect(panel.aside.hidden).toBe(false);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(names(panel.aside)).toEqual(["..", "c.md"]);
  });

  it("on an OPEN panel: rebuilds at the target in place (root changes to the jump target)", async () => {
    const listDir = vi.fn(fakeTree());
    const panel = await openPanel({ listDir, getBaseDir: () => "/root", onOpenFile: vi.fn() });
    expect(names(panel.aside)).toEqual(["..", "sub", "a.md", "pic.png"]);

    panel.jumpToRoot("/root/child");
    await flush();
    expect(panel.aside.hidden).toBe(false);
    expect(names(panel.aside)).toEqual(["..", "c.md"]);
  });
});

// H. Root path stays canonical across up-navigation (bugfix regression) --------
// The `…/../../..` over-summarization bug: a literal `..` used to accumulate in
// the stored rootPath across repeated up-navigation. renderTree now
// canonicalizes on every entry, so it can never accumulate past one shot. The
// header no longer carries the path (M3 staticized it — see section D), so
// this now observes canonicalization through onRootChange (the single
// observation point renderTree fires from) and the up-entry's dataset.
describe("explorer: root path stays canonical", () => {
  it("a single up-navigation leaves a canonical root everywhere it's used", async () => {
    const onRootChange = vi.fn();
    const listDir = vi.fn(fakeTree());
    const panel = createExplorerPanel({ listDir, getBaseDir: () => "/root/child", onOpenFile: vi.fn(), onRootChange });
    host.append(panel.button, panel.aside);
    panel.button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    onRootChange.mockClear();

    const up = panel.aside.querySelector(".explorer-up") as HTMLElement;
    clickItem(up);
    await flush();

    expect(onRootChange).toHaveBeenLastCalledWith("/root");
    // The up-entry re-renders with a fresh ONE-SHOT `/..` instruction off the
    // now-canonical root — it never carries the old accumulated literal.
    const newUp = panel.aside.querySelector(".explorer-up") as HTMLElement;
    expect(newUp.dataset.path).toBe("/root/..");
  });

  it("multiple up-navigations never accumulate literal `..` — the `…/../../..` bug case", async () => {
    const onRootChange = vi.fn();
    const listDir = vi.fn(fakeTree());
    const panel = createExplorerPanel({ listDir, getBaseDir: () => "/root/sub", onOpenFile: vi.fn(), onRootChange });
    host.append(panel.button, panel.aside);
    panel.button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    clickItem(panel.aside.querySelector(".explorer-up") as HTMLElement); // -> /root
    await flush();
    clickItem(panel.aside.querySelector(".explorer-up") as HTMLElement); // -> /
    await flush();

    expect(onRootChange).toHaveBeenLastCalledWith("/");
    const newUp = panel.aside.querySelector(".explorer-up") as HTMLElement;
    expect(newUp.dataset.path).toBe("//..");
  });

  it("tree content after up-navigation stays correct (display fix doesn't break navigation)", async () => {
    const listDir = vi.fn(fakeTree());
    const panel = await openPanel({ listDir, getBaseDir: () => "/root/child", onOpenFile: vi.fn() });
    clickItem(panel.aside.querySelector(".explorer-up") as HTMLElement);
    await flush();
    expect(names(panel.aside)).toEqual(["..", "sub", "a.md", "pic.png"]);
  });
});

// 6. Only .md opens ------------------------------------------------------------
describe("explorer: opens markdown only (6)", () => {
  it("md click → onOpenFile(absPath); non-md click + Enter are no-ops", async () => {
    const onOpenFile = vi.fn();
    const panel = await openPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root", onOpenFile });

    const md = items(panel.aside).find((e) => nameOf(e) === "a.md") as HTMLElement;
    clickItem(md);
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledWith("/root/a.md");

    const png = panel.aside.querySelector(".explorer-file.is-nonmd") as HTMLElement;
    expect(nameOf(png)).toBe("pic.png");
    clickItem(png);
    expect(onOpenFile).toHaveBeenCalledTimes(1); // inert
    press(panel.aside, "End"); // focus pic.png
    expect(nameOf(focusedItem(panel.aside))).toBe("pic.png");
    press(panel.aside, "Enter");
    expect(onOpenFile).toHaveBeenCalledTimes(1); // Enter on non-md is inert too
  });
});

// K. Image entries open via the gated onOpenImage handler (image viewer) -------
// Same gating shape as isFavorite/onToggleFavorite: onOpenImage injected → an
// image row loses `.is-nonmd` and becomes openable; omitted → pre-viewer
// behavior (image row stays greyed + inert) is preserved exactly, which the
// "6. Only .md opens" describe above already guards.
describe("explorer: image entries open via onOpenImage when injected (K)", () => {
  it("injected: image row is NOT .is-nonmd, click selects + calls onOpenImage(absPath), never onOpenFile", async () => {
    const onOpenFile = vi.fn();
    const onOpenImage = vi.fn();
    const panel = await openPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile,
      onOpenImage,
    });

    const png = items(panel.aside).find((e) => nameOf(e) === "pic.png") as HTMLElement;
    expect(png.classList.contains("is-nonmd")).toBe(false);

    clickItem(png);
    expect(onOpenImage).toHaveBeenCalledTimes(1);
    expect(onOpenImage).toHaveBeenCalledWith("/root/pic.png");
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(png.getAttribute("aria-selected")).toBe("true"); // selectItem still runs
  });

  it("injected: Enter on a focused image row is equivalent to click (single activateItem path)", async () => {
    const onOpenImage = vi.fn();
    const panel = await openPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile: vi.fn(),
      onOpenImage,
    });

    press(panel.aside, "End"); // focus pic.png (last visible)
    expect(nameOf(focusedItem(panel.aside))).toBe("pic.png");
    press(panel.aside, "Enter");
    expect(onOpenImage).toHaveBeenCalledTimes(1);
    expect(onOpenImage).toHaveBeenCalledWith("/root/pic.png");
  });

  it("md rows still route to onOpenFile even when onOpenImage is injected (no cross-wiring)", async () => {
    const onOpenFile = vi.fn();
    const onOpenImage = vi.fn();
    const panel = await openPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile,
      onOpenImage,
    });

    const md = items(panel.aside).find((e) => nameOf(e) === "a.md") as HTMLElement;
    clickItem(md);
    expect(onOpenFile).toHaveBeenCalledWith("/root/a.md");
    expect(onOpenImage).not.toHaveBeenCalled();
  });
});

// G. Folder/file icons: extension glyphs + folder open/close swap --------------
// The row glyph reflects the entry KIND (folder / file family), the folder glyph
// swaps with open state, and the `..` glyph is untouched. SVGs carry the
// `icon icon-<name>` class from icons.ts, so we assert by that selector.
const glyphIcon = (item: HTMLElement) =>
  item.querySelector(":scope > .explorer-label > .explorer-glyph > svg");
describe("explorer: file/folder icons + open-state swap (G)", () => {
  it("file rows carry an extension-specific glyph; folder is closed by default", async () => {
    const listDir = vi.fn((path: string) =>
      Promise.resolve(
        path === "/root"
          ? [dir("sub", "/root/sub"), file("a.md", "/root/a.md"), file("pic.png", "/root/pic.png"), file("data.json", "/root/data.json"), file("app.ts", "/root/app.ts")]
          : []
      )
    );
    const panel = await openPanel({ listDir, getBaseDir: () => "/root", onOpenFile: vi.fn() });
    const at = (n: string) => items(panel.aside).find((e) => nameOf(e) === n) as HTMLElement;

    expect(glyphIcon(at("a.md"))?.classList.contains("icon-file-text")).toBe(true);
    expect(glyphIcon(at("pic.png"))?.classList.contains("icon-file-image")).toBe(true);
    expect(glyphIcon(at("data.json"))?.classList.contains("icon-braces")).toBe(true);
    expect(glyphIcon(at("app.ts"))?.classList.contains("icon-file-code")).toBe(true);
    expect(glyphIcon(at("sub"))?.classList.contains("icon-folder")).toBe(true);
  });

  it("the `..` up entry keeps its corner-left-up glyph (regression)", async () => {
    const panel = await openPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root", onOpenFile: vi.fn() });
    const up = panel.aside.querySelector(".explorer-up") as HTMLElement;
    expect(glyphIcon(up)?.classList.contains("icon-corner-left-up")).toBe(true);
  });

  it("non-md file keeps .is-nonmd AND gets its extension glyph (icon = type, dim = openability)", async () => {
    const panel = await openPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root", onOpenFile: vi.fn() });
    const png = panel.aside.querySelector(".explorer-file.is-nonmd") as HTMLElement;
    expect(nameOf(png)).toBe("pic.png");
    expect(glyphIcon(png)?.classList.contains("icon-file-image")).toBe(true);
  });

  it("folder glyph swaps folder → folder-open on expand and back on collapse (click)", async () => {
    const panel = await openPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root", onOpenFile: vi.fn() });
    const sub = panel.aside.querySelector(".explorer-dir") as HTMLElement;
    expect(glyphIcon(sub)?.classList.contains("icon-folder")).toBe(true);

    clickItem(sub); // expand
    await flush();
    expect(sub.getAttribute("aria-expanded")).toBe("true");
    expect(glyphIcon(sub)?.classList.contains("icon-folder-open")).toBe(true);

    clickItem(sub); // collapse
    expect(sub.getAttribute("aria-expanded")).toBe("false");
    expect(glyphIcon(sub)?.classList.contains("icon-folder")).toBe(true);
  });

  it("keyboard →/← swaps the folder glyph too (shared expand/collapse command)", async () => {
    const panel = await openPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root", onOpenFile: vi.fn() });
    press(panel.aside, "ArrowDown"); // focus "sub"
    const sub = panel.aside.querySelector(".explorer-dir") as HTMLElement;
    press(panel.aside, "ArrowRight"); // expand
    await flush();
    expect(glyphIcon(sub)?.classList.contains("icon-folder-open")).toBe(true);
    // step back onto the folder, then collapse it
    press(panel.aside, "ArrowLeft"); // open folder → collapse
    expect(sub.getAttribute("aria-expanded")).toBe("false");
    expect(glyphIcon(sub)?.classList.contains("icon-folder")).toBe(true);
  });
});

// 7. Sidebar shell interface ---------------------------------------------------
describe("explorer: sidebar shell interface (7)", () => {
  it("exposes aside/button/resetToBaseDir; button toggles; aside starts hidden", async () => {
    const panel = createExplorerPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root", onOpenFile: vi.fn() });
    host.append(panel.button, panel.aside);

    expect(panel.aside.tagName).toBe("ASIDE");
    expect(panel.aside.hidden).toBe(true);

    panel.button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(panel.aside.hidden).toBe(false);
    panel.button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panel.aside.hidden).toBe(true);
  });

  it("aside carries a stable id + shared sidebar shell class", async () => {
    const panel = createExplorerPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root", onOpenFile: vi.fn() });
    host.append(panel.button, panel.aside);
    expect(panel.aside.id).toBe("explorer-aside");
    expect(panel.aside.classList.contains("sidebar-aside")).toBe(true);
  });

  it("close() hides the aside (idempotent, for the sidebar coordinator)", async () => {
    const panel = await openPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root", onOpenFile: vi.fn() });
    expect(panel.aside.hidden).toBe(false);
    panel.close();
    expect(panel.aside.hidden).toBe(true);
    panel.close();
    expect(panel.aside.hidden).toBe(true);
  });

  it("fires onOpen only when opening (mutual-exclusion hook)", async () => {
    const onOpen = vi.fn();
    const panel = createExplorerPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root", onOpenFile: vi.fn(), onOpen });
    host.append(panel.button, panel.aside);
    panel.button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(onOpen).toHaveBeenCalledOnce();
    panel.button.dispatchEvent(new MouseEvent("click", { bubbles: true })); // close
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("toggle button keeps a fixed folder identity icon, aria-expanded tracks open state (N)", async () => {
    const panel = createExplorerPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root", onOpenFile: vi.fn() });
    host.append(panel.button, panel.aside);
    expect(panel.button.querySelector(".icon-folder")).toBeTruthy();
    expect(panel.button.getAttribute("aria-expanded")).toBe("false");
    expect(panel.button.getAttribute("aria-controls")).toBe("explorer-aside");
    panel.button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(panel.button.querySelector(".icon-folder")).toBeTruthy(); // no icon swap
    expect(panel.button.getAttribute("aria-expanded")).toBe("true");
    expect(panel.button.querySelector(".chrome-btn-label")?.textContent).toBe("탐색기");
  });

  it("never renders a panel-left icon on the toggle button (N)", async () => {
    const panel = createExplorerPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root", onOpenFile: vi.fn() });
    host.append(panel.button, panel.aside);
    expect(panel.button.querySelector(".icon-panel-left-open")).toBeNull();
    expect(panel.button.querySelector(".icon-panel-left-close")).toBeNull();
  });

  it("favoritesSlot is appended below the tree at creation", async () => {
    const slot = document.createElement("div");
    slot.className = "explorer-favorites-test-slot";
    const panel = createExplorerPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile: vi.fn(),
      favoritesSlot: slot,
    });
    host.append(panel.button, panel.aside);
    expect(panel.aside.contains(slot)).toBe(true);
    // it must come AFTER the tree (split-pane: tree on top, favorites below).
    const tree = treeOf(panel.aside);
    expect(tree.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("revealFavorites opens the explorer, scrolls the slot into view, and DELEGATES landing to the injected focusFavorites (no reimplemented focus logic)", async () => {
    const slot = document.createElement("div");
    slot.className = "explorer-favorites-test-slot";
    slot.scrollIntoView = vi.fn();
    const focusFavorites = vi.fn();
    const panel = createExplorerPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile: vi.fn(),
      favoritesSlot: slot,
      focusFavorites,
    });
    host.append(panel.button, panel.aside);
    expect(panel.aside.hidden).toBe(true);

    panel.revealFavorites();
    await flush();

    expect(panel.aside.hidden).toBe(false); // opened as a side effect
    expect(slot.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(focusFavorites).toHaveBeenCalledOnce(); // landing rule delegated, not re-derived
  });

  it("revealFavorites is a no-op on the scroll/focus half when favoritesSlot/focusFavorites weren't injected", async () => {
    const panel = createExplorerPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root", onOpenFile: vi.fn() });
    host.append(panel.button, panel.aside);
    expect(() => panel.revealFavorites()).not.toThrow();
    await flush();
    expect(panel.aside.hidden).toBe(false); // still opens the shell
  });

  it("resetToBaseDir rebuilds when open, no-ops when hidden", async () => {
    let base = "/root";
    const listDir = vi.fn(fakeTree());
    const panel = await openPanel({ listDir, getBaseDir: () => base, onOpenFile: vi.fn() });
    expect(names(panel.aside)).toEqual(["..", "sub", "a.md", "pic.png"]);

    base = "/root/child";
    panel.resetToBaseDir();
    await flush();
    expect(names(panel.aside)).toEqual(["..", "c.md"]);

    // Hidden → resetToBaseDir is a no-op (reseeds on next open).
    panel.button.dispatchEvent(new MouseEvent("click", { bubbles: true })); // close
    const callsBefore = listDir.mock.calls.length;
    base = "/root";
    panel.resetToBaseDir();
    await flush();
    expect(listDir.mock.calls.length).toBe(callsBefore);
  });
});

// M5: folder-row favorite star (design 분기5, plan Phase B) -------------------
// Gated on BOTH isFavorite + onToggleFavorite being injected. Renders on
// .explorer-dir rows only (never .explorer-file/.explorer-up), tabindex=-1
// (out of roving-tabindex), star click pre-empts folder activation (early
// return), Space toggles the star on a focused folder, and
// refreshFavoriteStars() re-syncs every row from a fresh isFavorite() read.
describe("explorer: folder-row favorite star (M5)", () => {
  it("renders .explorer-star on folder rows only (not files, not `..`) when both handlers are injected", async () => {
    const panel = createExplorerPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile: vi.fn(),
      isFavorite: () => false,
      onToggleFavorite: vi.fn(),
    });
    host.append(panel.button, panel.aside);
    panel.button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    const sub = panel.aside.querySelector(".explorer-dir") as HTMLElement;
    expect(sub.querySelector(":scope > .explorer-label > .explorer-star")).toBeTruthy();

    const md = items(panel.aside).find((e) => nameOf(e) === "a.md") as HTMLElement;
    expect(md.querySelector(".explorer-star")).toBeNull();

    const up = panel.aside.querySelector(".explorer-up") as HTMLElement;
    expect(up.querySelector(".explorer-star")).toBeNull();
  });

  it("star carries tabindex=-1 (out of the roving-tabindex race) and aria-pressed reflects isFavorite", async () => {
    const favorites = new Set(["/root/sub"]);
    const panel = createExplorerPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile: vi.fn(),
      isFavorite: (p) => favorites.has(p),
      onToggleFavorite: vi.fn(),
    });
    host.append(panel.button, panel.aside);
    panel.button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    const sub = panel.aside.querySelector(".explorer-dir") as HTMLElement;
    const star = sub.querySelector(".explorer-star") as HTMLButtonElement;
    expect(star.tabIndex).toBe(-1);
    expect(star.getAttribute("aria-pressed")).toBe("true");
  });

  it("no handlers injected → no star anywhere, roving-tabindex count unchanged (regression guard)", async () => {
    const panel = await openPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root", onOpenFile: vi.fn() });
    expect(panel.aside.querySelector(".explorer-star")).toBeNull();
    expect(items(panel.aside).filter((e) => e.tabIndex === 0)).toHaveLength(1);
  });

  it("clicking the star calls onToggleFavorite(path) once and does NOT toggle the folder open (early return)", async () => {
    const onToggleFavorite = vi.fn();
    const panel = createExplorerPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile: vi.fn(),
      isFavorite: () => false,
      onToggleFavorite,
    });
    host.append(panel.button, panel.aside);
    panel.button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    const sub = panel.aside.querySelector(".explorer-dir") as HTMLElement;
    const star = sub.querySelector(".explorer-star") as HTMLButtonElement;
    star.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onToggleFavorite).toHaveBeenCalledWith("/root/sub");
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    expect(sub.getAttribute("aria-expanded")).toBe("false"); // folder did NOT open
    expect(sub.dataset.loaded).toBeUndefined(); // children were never loaded
  });

  it("Space toggles the focused folder's star; no-op on files/`..`", async () => {
    const onToggleFavorite = vi.fn();
    const panel = createExplorerPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile: vi.fn(),
      isFavorite: () => false,
      onToggleFavorite,
    });
    host.append(panel.button, panel.aside);
    panel.button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    // initial focus is `..` — Space there is a no-op.
    treeOf(panel.aside).dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
    expect(onToggleFavorite).not.toHaveBeenCalled();

    press(panel.aside, "ArrowDown"); // focus "sub" (a folder)
    treeOf(panel.aside).dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
    expect(onToggleFavorite).toHaveBeenCalledWith("/root/sub");
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);

    press(panel.aside, "ArrowDown"); // focus "a.md" (a file)
    treeOf(panel.aside).dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
    expect(onToggleFavorite).toHaveBeenCalledTimes(1); // still 1 — file Space is a no-op
  });

  it("refreshFavoriteStars() re-syncs aria-pressed/.is-favorite from a fresh isFavorite() read", async () => {
    const favorites = new Set<string>();
    const panel = createExplorerPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile: vi.fn(),
      isFavorite: (p) => favorites.has(p),
      onToggleFavorite: vi.fn(),
    });
    host.append(panel.button, panel.aside);
    panel.button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    const sub = panel.aside.querySelector(".explorer-dir") as HTMLElement;
    const star = sub.querySelector(".explorer-star") as HTMLButtonElement;
    expect(star.getAttribute("aria-pressed")).toBe("false");
    expect(star.classList.contains("is-favorite")).toBe(false);

    favorites.add("/root/sub");
    panel.refreshFavoriteStars();
    expect(star.getAttribute("aria-pressed")).toBe("true");
    expect(star.classList.contains("is-favorite")).toBe(true);
  });
});
