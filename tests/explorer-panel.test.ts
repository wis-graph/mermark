import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createExplorerPanel, type DirEntry, type ExplorerHandlers } from "../src/sidebar/explorer/explorer-panel";
import { WorkspaceStore } from "../src/workspace/workspace-state";

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

/** A tree with a .txt and a .markdown row alongside a.md, isolated from
 *  fakeTree() above so the "6. Only .md opens" describe's baselines stay
 *  untouched (its ordering/count assertions must not shift). */
function fakeTreeWithTxt(): (path: string) => Promise<DirEntry[]> {
  const TREE: Record<string, DirEntry[]> = {
    "/root": [
      file("a.md", "/root/a.md"),
      file("plain.txt", "/root/plain.txt"),
      file("legacy.markdown", "/root/legacy.markdown"),
    ],
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
/** ⌘+<key> — used for the new-window Enter activation (metaKey only, no ctrlKey
 *  equivalent per design: keyboard is ⌘+Enter, mouse is ⌘/Ctrl+click). */
const pressMeta = (aside: HTMLElement, key: string) =>
  treeOf(aside).dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true }));
const clickItem = (item: HTMLElement) =>
  item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
/** ⌘/Ctrl+click — the new-window modifier. `mod` selects which key is held so
 *  both mac (meta) and other platforms (ctrl) are covered by the same helper. */
const clickItemMod = (item: HTMLElement, mod: "meta" | "ctrl" = "meta") =>
  item.dispatchEvent(
    new MouseEvent("click", { bubbles: true, metaKey: mod === "meta", ctrlKey: mod === "ctrl" })
  );

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

  // REVEAL-FOLLOWS-FOCUS: jumpToRoot moves DOM focus into the tree iff THIS
  // call is the one revealing the shell — not on every root change. These two
  // tests lock that rule down from both directions; the second is the
  // regression guard (a workspace-sidebar vault reselect on an ALREADY-open
  // explorer must never yank focus off whatever the user was doing).
  it("on a CLOSED panel: moves DOM focus into the tree once the target finishes rendering", async () => {
    const panel = createExplorerPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root", onOpenFile: vi.fn() });
    host.append(panel.button, panel.aside);
    expect(panel.aside.hidden).toBe(true);

    panel.jumpToRoot("/root/child");
    await flush();

    expect(panel.aside.hidden).toBe(false);
    expect(names(panel.aside)).toEqual(["..", "c.md"]);
    // The seeded roving-tabindex cursor AND real DOM focus land on the same
    // node — a closed-panel jump is a reveal, so it owes focus.
    expect(document.activeElement).toBe(focusedItem(panel.aside));
    expect(nameOf(focusedItem(panel.aside))).toBe("..");
  });

  it("on an OPEN panel: never steals focus from wherever the user already is", async () => {
    const listDir = vi.fn(fakeTree());
    const panel = await openPanel({ listDir, getBaseDir: () => "/root", onOpenFile: vi.fn() });
    // Simulate the real regression: focus is on some OTHER control entirely
    // (a workspace-sidebar vault-select button, in the real app) when a vault
    // reselect fires jumpToRoot against an already-open explorer.
    const external = document.createElement("button");
    host.append(external);
    external.focus();
    expect(document.activeElement).toBe(external);

    panel.jumpToRoot("/root/child");
    await flush();

    // The root still changes underneath (jumpToRoot's actual job)...
    expect(panel.aside.hidden).toBe(false);
    expect(names(panel.aside)).toEqual(["..", "c.md"]);
    // ...but DOM focus is untouched, because the panel was already open —
    // this call did not reveal it.
    expect(document.activeElement).toBe(external);
  });

  it("on a CLOSED, root-locked panel with an empty target folder: falls back to the tree container, not <body>", async () => {
    const listDir = vi.fn(async () => [] as DirEntry[]);
    const panel = createExplorerPanel({ listDir, getBaseDir: () => "/root", onOpenFile: vi.fn(), isRootLocked: () => true });
    host.append(panel.button, panel.aside);
    expect(panel.aside.hidden).toBe(true);

    panel.jumpToRoot("/root"); // root-locked jumpToRoot only proceeds when target === baseDir
    await flush();

    expect(panel.aside.hidden).toBe(false);
    expect(names(panel.aside)).toEqual([]); // locked (no `..`) + empty (no entries) — nothing to seed
    // No focusable tree item exists, but this render still owed focus (a
    // reveal) — land on the tree container itself rather than dropping to
    // <body> (tree.tabIndex = -1: programmatic-only, never a real Tab stop).
    expect(document.activeElement).toBe(treeOf(panel.aside));
  });

  // Focus-obligation succession (2026-08-17 bugfix): main.ts's vault-entry
  // path that ALSO opens a document calls jumpToRoot, then — same
  // synchronous tick, no await between them — resetToBaseDir fires a SECOND
  // renderTree at the same root. Reproduced directly here without main.ts:
  // jumpToRoot (reveal, owes focus) immediately followed by resetToBaseDir
  // (no reveal, doesn't itself ask for focus) before either has settled.
  // Before the fix, jumpToRoot's own render loses the renderGeneration race
  // and never reaches its focus-move code, and resetToBaseDir's render (the
  // one that actually wins) never asked for focus either — so the obligation
  // evaporates and focus lands on <body>. After the fix, the SECOND render
  // inherits and pays the first one's obligation.
  it("a reveal's focus obligation survives its own render losing the generation race to a same-tick resetToBaseDir", async () => {
    const listDir = vi.fn(fakeTree());
    const panel = createExplorerPanel({ listDir, getBaseDir: () => "/root/child", onOpenFile: vi.fn() });
    host.append(panel.button, panel.aside);
    expect(panel.aside.hidden).toBe(true);

    panel.jumpToRoot("/root/child"); // reveals — synchronously flips aside.hidden, owes focus
    panel.resetToBaseDir(); // fires immediately after, same root, same tick — no await in between
    await flush();

    expect(panel.aside.hidden).toBe(false);
    expect(names(panel.aside)).toEqual(["..", "c.md"]);
    // The obligation jumpToRoot raised is paid by whichever render actually
    // finishes — not lost, and not double-paid (exactly one call worth of
    // listDir per root: renderTree clears the tree at the start of each
    // call, so a leftover DOM fragment from the discarded render can't
    // masquerade as a second focus target either).
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(focusedItem(panel.aside));
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

describe("explorer: permanent vault root", () => {
  it("does not render or route parent navigation when the root is locked to a vault", async () => {
    const listDir = vi.fn(fakeTree());
    const panel = await openPanel({
      listDir,
      getBaseDir: () => "/root",
      onOpenFile: vi.fn(),
      isRootLocked: () => true,
    });

    expect(panel.aside.querySelector(".explorer-up")).toBeNull();
    panel.jumpToRoot("/root/..");
    await flush();

    expect(panel.currentRootPath()).toBe("/root");
    expect(listDir).toHaveBeenCalledTimes(1);
  });

  it("renders and routes parent navigation for the global vault", async () => {
    const listDir = vi.fn(fakeTree());
    const panel = await openPanel({
      listDir,
      getBaseDir: () => "/root/child",
      onOpenFile: vi.fn(),
      isRootLocked: () => false,
    });

    const up = panel.aside.querySelector(".explorer-up");
    expect(up).not.toBeNull();
    clickItem(up as HTMLElement);
    await flush();

    expect(panel.currentRootPath()).toBe("/root");
    expect(listDir).toHaveBeenLastCalledWith("/root");
  });

  it("keeps the vault root after selecting a child document", async () => {
    const listDir = vi.fn(fakeTree());
    const onOpenFile = vi.fn();
    const panel = await openPanel({
      listDir,
      getBaseDir: () => "/root",
      onOpenFile,
      isRootLocked: () => true,
    });

    const child = panel.aside.querySelector<HTMLElement>('[data-path="/root/a.md"]');
    expect(child).not.toBeNull();
    child?.click();
    await flush();

    expect(onOpenFile).toHaveBeenCalledWith("/root/a.md");
    expect(panel.currentRootPath()).toBe("/root");
  });
});

describe("explorer: per-folder permanent-vault toggle", () => {
  it("renders a folder toggle without a header add-vault action", async () => {
    const onToggleVault = vi.fn();
    const panel = await openPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile: vi.fn(),
      onToggleVault,
      isVaultRegistered: async () => false,
    });

    expect(panel.aside.querySelector(".explorer-add-vault")).toBeNull();
    expect(panel.aside.querySelector(".explorer-header")?.textContent).toBe("탐색기");
    const toggle = panel.aside.querySelector<HTMLButtonElement>(".explorer-vault-toggle");
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");
    expect(toggle?.querySelector(".icon-bookmark")).toBeTruthy();
  });

  it("toggles the canonical folder and does not activate the folder row", async () => {
    const onToggleVault = vi.fn();
    const panel = await openPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile: vi.fn(),
      onToggleVault,
      isVaultRegistered: async () => false,
    });

    const folder = panel.aside.querySelector<HTMLElement>('[data-path="/root/sub"]');
    const toggle = folder?.querySelector<HTMLButtonElement>(".explorer-vault-toggle");
    toggle?.click();

    expect(onToggleVault).toHaveBeenCalledWith("/root/sub");
    expect(folder?.getAttribute("aria-expanded")).toBe("false");
    expect(folder?.dataset.loaded).toBeUndefined();
  });

  it("reflects registered state and refreshes it without moving the tree", async () => {
    const registered = new Set(["/root/sub"]);
    const panel = await openPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile: vi.fn(),
      onToggleVault: vi.fn(),
      isVaultRegistered: async (path) => registered.has(path),
    });

    const toggle = panel.aside.querySelector<HTMLButtonElement>('[data-path="/root/sub"] .explorer-vault-toggle');
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    expect(toggle?.querySelector(".icon-bookmark-filled")).toBeTruthy();
    expect(panel.currentRootPath()).toBe("/root");

    registered.clear();
    await panel.refreshVaultToggles();
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");
    expect(toggle?.querySelector(".icon-bookmark")).toBeTruthy();
    expect(panel.currentRootPath()).toBe("/root");
  });

  it("awaits filesystem identity for alias state and canonical toggle action", async () => {
    const registered = new Set(["/real/sub"]);
    const canonicalize = async (path: string): Promise<string> => path.replace("/alias", "/real");
    const onToggleVault = (path: string): void => {
      void canonicalize(path).then((canonical) => {
        if (!registered.delete(canonical)) registered.add(canonical);
      });
    };
    const panel = await openPanel({
      listDir: vi.fn(async (path: string) => path === "/alias" ? [dir("sub", "/alias/sub")] : []),
      getBaseDir: () => "/alias",
      onOpenFile: vi.fn(),
      onToggleVault,
      isVaultRegistered: async (path) => registered.has(await canonicalize(path)),
    });

    const toggle = panel.aside.querySelector<HTMLButtonElement>('[data-path="/alias/sub"] .explorer-vault-toggle');
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");

    toggle?.click();
    await flush();
    await panel.refreshVaultToggles();

    expect(registered.has("/real/sub")).toBe(false);
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");
  });

  it("refreshes folder toggles after an external workspace-store mutation", async () => {
    localStorage.removeItem("mermark.workspaceState");
    const store = new WorkspaceStore();
    const vault = store.registerVault("/root/sub");
    let panel: ReturnType<typeof createExplorerPanel> | undefined;
    const unsubscribe = store.subscribe(() => { void panel?.refreshVaultToggles(); });
    try {
      panel = await openPanel({
        listDir: vi.fn(fakeTree()),
        getBaseDir: () => "/root",
        onOpenFile: vi.fn(),
        onToggleVault: vi.fn(),
        isVaultRegistered: async (path) => store.get().vaults.some((item) => item.rootPath === path),
      });
      const toggle = panel.aside.querySelector<HTMLButtonElement>('[data-path="/root/sub"] .explorer-vault-toggle');
      expect(toggle?.getAttribute("aria-pressed")).toBe("true");

      store.unregisterVault(vault.vaultId);
      await flush();

      expect(toggle?.getAttribute("aria-pressed")).toBe("false");
    } finally {
      unsubscribe();
      localStorage.removeItem("mermark.workspaceState");
    }
  });
});

// currentRootPath — the ⌘⇧F file-finder panel's root SSOT (see
// _workspace/01_architect_design.md §루트 SSOT): a pure query exposing the
// SAME `currentRoot` renderTree canonicalizes, not a second copy of it.
describe("explorer: currentRootPath (SSOT for the search panel's root)", () => {
  it("is null before the first render, then the canonical root after opening", async () => {
    const listDir = vi.fn(fakeTree());
    const panel = createExplorerPanel({ listDir, getBaseDir: () => "/root", onOpenFile: vi.fn() });
    expect(panel.currentRootPath()).toBeNull();
    host.append(panel.button, panel.aside);
    panel.button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(panel.currentRootPath()).toBe("/root");
  });

  it("tracks `..` navigation to the new canonical root", async () => {
    const listDir = vi.fn(fakeTree());
    const panel = await openPanel({ listDir, getBaseDir: () => "/root/child", onOpenFile: vi.fn() });
    clickItem(panel.aside.querySelector(".explorer-up") as HTMLElement);
    await flush();
    expect(panel.currentRootPath()).toBe("/root");
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

// txt-as-md (_workspace/01_architect_design_txt.md): .txt opens exactly like
// .md; .markdown stays out of scope (inert, unlike the "6" describe above
// which only exercises pic.png).
describe("explorer: .txt opens like .md; .markdown stays out of scope (txt-as-md)", () => {
  it(".txt row is NOT .is-nonmd; click calls onOpenFile, never onOpenWithViewer", async () => {
    const onOpenFile = vi.fn();
    const panel = await openPanel({ listDir: vi.fn(fakeTreeWithTxt()), getBaseDir: () => "/root", onOpenFile });

    const txt = items(panel.aside).find((e) => nameOf(e) === "plain.txt") as HTMLElement;
    expect(txt.classList.contains("is-nonmd")).toBe(false);
    clickItem(txt);
    expect(onOpenFile).toHaveBeenCalledWith("/root/plain.txt");
  });

  it(".markdown row stays .is-nonmd and inert (out of scope)", async () => {
    const onOpenFile = vi.fn();
    const panel = await openPanel({ listDir: vi.fn(fakeTreeWithTxt()), getBaseDir: () => "/root", onOpenFile });

    const md = items(panel.aside).find((e) => nameOf(e) === "legacy.markdown") as HTMLElement;
    expect(md.classList.contains("is-nonmd")).toBe(true);
    clickItem(md);
    expect(onOpenFile).not.toHaveBeenCalled();
  });
});

// K. Non-md entries open via the gated canOpenWithViewer/onOpenWithViewer
// pair (R11, _workspace/01_r11.md §4/§9 RED-2) ---------------------------
// Same gating shape as isFavorite/onToggleFavorite: both injected AND the
// query claims the filename → a row loses `.is-nonmd` and becomes openable;
// either omitted, or the query returns false, → pre-R11 behavior (row stays
// greyed + inert) is preserved exactly, which the "6. Only .md opens" describe
// above already guards. `canOpenWithViewer` here stands in for a real
// `viewerFor(extensionOf(name)) != null` query — the panel never knows it's
// a "viewer" at all, it only calls the injected predicate.
const isPngName = (name: string) => name.endsWith(".png");

describe("explorer: non-md entries open via canOpenWithViewer/onOpenWithViewer when injected (K)", () => {
  it("injected + claimed: row is NOT .is-nonmd, click selects + calls onOpenWithViewer(absPath), never onOpenFile", async () => {
    const onOpenFile = vi.fn();
    const onOpenWithViewer = vi.fn();
    const panel = await openPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile,
      canOpenWithViewer: isPngName,
      onOpenWithViewer,
    });

    const png = items(panel.aside).find((e) => nameOf(e) === "pic.png") as HTMLElement;
    expect(png.classList.contains("is-nonmd")).toBe(false);

    clickItem(png);
    expect(onOpenWithViewer).toHaveBeenCalledTimes(1);
    expect(onOpenWithViewer).toHaveBeenCalledWith("/root/pic.png");
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(png.getAttribute("aria-selected")).toBe("true"); // selectItem still runs
  });

  it("injected: Enter on a focused claimed row is equivalent to click (single activateItem path)", async () => {
    const onOpenWithViewer = vi.fn();
    const panel = await openPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile: vi.fn(),
      canOpenWithViewer: isPngName,
      onOpenWithViewer,
    });

    press(panel.aside, "End"); // focus pic.png (last visible)
    expect(nameOf(focusedItem(panel.aside))).toBe("pic.png");
    press(panel.aside, "Enter");
    expect(onOpenWithViewer).toHaveBeenCalledTimes(1);
    expect(onOpenWithViewer).toHaveBeenCalledWith("/root/pic.png");
  });

  it("md rows still route to onOpenFile even when the viewer pair is injected (no cross-wiring)", async () => {
    const onOpenFile = vi.fn();
    const onOpenWithViewer = vi.fn();
    const panel = await openPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile,
      canOpenWithViewer: isPngName,
      onOpenWithViewer,
    });

    const md = items(panel.aside).find((e) => nameOf(e) === "a.md") as HTMLElement;
    clickItem(md);
    expect(onOpenFile).toHaveBeenCalledWith("/root/a.md");
    expect(onOpenWithViewer).not.toHaveBeenCalled();
  });

  it("injected but NOT claimed (canOpenWithViewer returns false): row stays .is-nonmd and inert (unregistered extension)", async () => {
    const onOpenFile = vi.fn();
    const onOpenWithViewer = vi.fn();
    const panel = await openPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile,
      canOpenWithViewer: () => false, // e.g. no viewer registered for this extension
      onOpenWithViewer,
    });

    const png = items(panel.aside).find((e) => nameOf(e) === "pic.png") as HTMLElement;
    expect(png.classList.contains("is-nonmd")).toBe(true);
    clickItem(png);
    expect(onOpenWithViewer).not.toHaveBeenCalled();
    expect(onOpenFile).not.toHaveBeenCalled();
  });
});

// L. ⌘/Ctrl+click and ⌘+Enter open a markdown file in a NEW WINDOW ------------
// Same gating shape as onOpenImage: onOpenFileNewWindow injected → a modifier'd
// activation on a markdown row calls it instead of onOpenFile; omitted →
// falls through to the plain onOpenFile (pre-existing behavior, unaffected by
// the modifier). Never applies to images or folders/`..` (only reached past
// the onOpenImage branch in activateItem).
describe("explorer: ⌘/Ctrl+click and ⌘+Enter open in a new window when injected (L)", () => {
  it("⌘+click on a markdown row calls onOpenFileNewWindow, never onOpenFile", async () => {
    const onOpenFile = vi.fn();
    const onOpenFileNewWindow = vi.fn();
    const panel = await openPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile,
      onOpenFileNewWindow,
    });

    const md = items(panel.aside).find((e) => nameOf(e) === "a.md") as HTMLElement;
    clickItemMod(md, "meta");
    expect(onOpenFileNewWindow).toHaveBeenCalledTimes(1);
    expect(onOpenFileNewWindow).toHaveBeenCalledWith("/root/a.md");
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("Ctrl+click on a markdown row also calls onOpenFileNewWindow (non-mac modifier)", async () => {
    const onOpenFile = vi.fn();
    const onOpenFileNewWindow = vi.fn();
    const panel = await openPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile,
      onOpenFileNewWindow,
    });

    const md = items(panel.aside).find((e) => nameOf(e) === "a.md") as HTMLElement;
    clickItemMod(md, "ctrl");
    expect(onOpenFileNewWindow).toHaveBeenCalledTimes(1);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("⌘+Enter on a focused markdown row calls onOpenFileNewWindow, never onOpenFile", async () => {
    const onOpenFile = vi.fn();
    const onOpenFileNewWindow = vi.fn();
    const panel = await openPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile,
      onOpenFileNewWindow,
    });

    press(panel.aside, "ArrowDown"); // ".." -> "sub"
    press(panel.aside, "ArrowDown"); // "sub" -> "a.md"
    expect(nameOf(focusedItem(panel.aside))).toBe("a.md");
    pressMeta(panel.aside, "Enter");
    expect(onOpenFileNewWindow).toHaveBeenCalledTimes(1);
    expect(onOpenFileNewWindow).toHaveBeenCalledWith("/root/a.md");
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("plain Enter/click on a markdown row still calls onOpenFile even when onOpenFileNewWindow is injected", async () => {
    const onOpenFile = vi.fn();
    const onOpenFileNewWindow = vi.fn();
    const panel = await openPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile,
      onOpenFileNewWindow,
    });

    const md = items(panel.aside).find((e) => nameOf(e) === "a.md") as HTMLElement;
    clickItem(md);
    expect(onOpenFile).toHaveBeenCalledWith("/root/a.md");
    expect(onOpenFileNewWindow).not.toHaveBeenCalled();
  });

  it("⌘+click falls through to onOpenFile when onOpenFileNewWindow is not injected (gated, no crash)", async () => {
    const onOpenFile = vi.fn();
    const panel = await openPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root", onOpenFile });

    const md = items(panel.aside).find((e) => nameOf(e) === "a.md") as HTMLElement;
    clickItemMod(md, "meta");
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledWith("/root/a.md");
  });

  it("⌘+click on a viewer-claimed row still calls onOpenWithViewer, never onOpenFileNewWindow (viewer rows excluded)", async () => {
    const onOpenFile = vi.fn();
    const onOpenWithViewer = vi.fn();
    const onOpenFileNewWindow = vi.fn();
    const panel = await openPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile,
      canOpenWithViewer: isPngName,
      onOpenWithViewer,
      onOpenFileNewWindow,
    });

    const png = items(panel.aside).find((e) => nameOf(e) === "pic.png") as HTMLElement;
    clickItemMod(png, "meta");
    expect(onOpenWithViewer).toHaveBeenCalledTimes(1);
    expect(onOpenWithViewer).toHaveBeenCalledWith("/root/pic.png");
    expect(onOpenFileNewWindow).not.toHaveBeenCalled();
    expect(onOpenFile).not.toHaveBeenCalled();
  });
});

// G. Folder/file icons: extension glyphs + folder open/close swap --------------
// The row glyph reflects the entry KIND (folder / file family), the folder glyph
// swaps with open state, and the `..` glyph is untouched. Folders stay Lucide
// (`icon icon-<name>` class from icons.ts). Files resolve through the Material
// Icon Theme (material-icon-glyph.ts): by the time `openPanel`'s real-timer
// `flush()` has settled, the per-extension icon chunk has loaded and
// `renderMaterialFileGlyph` has stamped `data-material-icon="<id>"` on the
// glyph container — see that module's `materialIconIdFor` for the id lookup
// this test's expected ids are drawn from (verified against the vendored
// material-icons.generated.ts, e.g. md→"markdown", png→"image", json→"json",
// ts→"typescript").
const glyphIcon = (item: HTMLElement) =>
  item.querySelector(":scope > .explorer-label > .explorer-glyph > svg");
const glyphMaterialId = (item: HTMLElement) =>
  item.querySelector(":scope > .explorer-label > .explorer-glyph")?.getAttribute("data-material-icon");
/** A vitest worker's FIRST-ever dynamic import of a given
 *  ./material-icons/*.svg chunk (material-icon-glyph.ts's import.meta.glob)
 *  goes through real transform + module registration, which isn't always
 *  done within one `flush()` tick — unlike production, where it's a fetch of
 *  an already-built chunk. Poll (bounded, real timers) instead of assuming a
 *  single flush suffices; see tests/material-icon-glyph.test.ts for the same
 *  idiom applied directly to renderMaterialFileGlyph. */
async function waitForMaterialIcon(item: HTMLElement, tries = 20): Promise<void> {
  for (let i = 0; i < tries && !glyphMaterialId(item); i++) await flush();
}
describe("explorer: file/folder icons + open-state swap (G)", () => {
  it("file rows carry an extension-specific Material glyph; folder is closed by default (Lucide)", async () => {
    const listDir = vi.fn((path: string) =>
      Promise.resolve(
        path === "/root"
          ? [dir("sub", "/root/sub"), file("a.md", "/root/a.md"), file("pic.png", "/root/pic.png"), file("data.json", "/root/data.json"), file("app.ts", "/root/app.ts")]
          : []
      )
    );
    const panel = await openPanel({ listDir, getBaseDir: () => "/root", onOpenFile: vi.fn() });
    const at = (n: string) => items(panel.aside).find((e) => nameOf(e) === n) as HTMLElement;
    await waitForMaterialIcon(at("a.md"));
    await waitForMaterialIcon(at("pic.png"));
    await waitForMaterialIcon(at("data.json"));
    await waitForMaterialIcon(at("app.ts"));

    expect(glyphMaterialId(at("a.md"))).toBe("markdown");
    expect(glyphMaterialId(at("pic.png"))).toBe("image");
    expect(glyphMaterialId(at("data.json"))).toBe("json");
    expect(glyphMaterialId(at("app.ts"))).toBe("typescript");
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
    await waitForMaterialIcon(png);
    expect(glyphMaterialId(png)).toBe("image");
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

// refreshListing (showHiddenFilesSetting sink, hidden-toggle design 분기3) —
// unlike resetToBaseDir (jumps to getBaseDir()) or refreshOpenability/
// refreshFavoriteStars (pure DOM refresh), refreshListing clears the children
// cache AND rebuilds at the CURRENT root — a listing-policy change (dotfiles
// on/off) invalidates cached content, but shouldn't discard navigation.
describe("explorer: refreshListing (showHiddenFiles setting sink)", () => {
  it("clears the children cache so both the root and an already-expanded folder are re-read", async () => {
    const listDir = vi.fn(fakeTree());
    const panel = await openPanel({ listDir, getBaseDir: () => "/root", onOpenFile: vi.fn() });
    expect(listDir).toHaveBeenCalledTimes(1); // root

    const sub = panel.aside.querySelector(".explorer-dir") as HTMLElement;
    clickItem(sub);
    await flush();
    expect(listDir).toHaveBeenCalledTimes(2); // root + sub

    panel.refreshListing();
    await flush();
    expect(listDir).toHaveBeenCalledTimes(3); // root re-read, not served from cache
    expect(listDir).toHaveBeenLastCalledWith("/root");
    expect(names(panel.aside)).toEqual(["..", "sub", "a.md", "pic.png"]); // fresh render, collapsed

    // Re-expand the (freshly rendered, collapsed) sub folder: a cache hit here
    // would mean refreshListing only cleared the ROOT's cache entry, not every
    // entry — it must clear the whole map.
    const subAgain = panel.aside.querySelector(".explorer-dir") as HTMLElement;
    clickItem(subAgain);
    await flush();
    expect(listDir).toHaveBeenCalledTimes(4);
    expect(listDir).toHaveBeenLastCalledWith("/root/sub");
  });

  it("rebuilds at the CURRENT root after a `..` navigation, not back at getBaseDir()", async () => {
    const listDir = vi.fn(fakeTree());
    const panel = await openPanel({ listDir, getBaseDir: () => "/root/child", onOpenFile: vi.fn() });
    expect(listDir).toHaveBeenLastCalledWith("/root/child");

    const up = panel.aside.querySelector(".explorer-up") as HTMLElement;
    clickItem(up);
    await flush();
    expect(listDir).toHaveBeenLastCalledWith("/root"); // changeRoot landed here

    panel.refreshListing();
    await flush();
    // getBaseDir() still answers "/root/child" — if refreshListing fell back to
    // it (like resetToBaseDir does), this would assert "/root/child" instead.
    expect(listDir).toHaveBeenLastCalledWith("/root");
    expect(names(panel.aside)).toEqual(["..", "sub", "a.md", "pic.png"]);
  });

  it("is a no-op while the panel is closed (listDir call count unchanged)", async () => {
    const listDir = vi.fn(fakeTree());
    const panel = await openPanel({ listDir, getBaseDir: () => "/root", onOpenFile: vi.fn() });
    panel.close();
    const callsBefore = listDir.mock.calls.length;

    panel.refreshListing();
    await flush();
    expect(listDir.mock.calls.length).toBe(callsBefore);
  });
});

describe("explorer: explicit filesystem states (task 5)", () => {
  it("renders a resolved empty root distinctly from a rejected root", async () => {
    const empty = await openPanel({
      listDir: vi.fn(async () => []),
      getBaseDir: () => "/empty",
      onOpenFile: vi.fn(),
    });
    expect(empty.aside.querySelector(".explorer-empty")).not.toBeNull();
    expect(empty.aside.querySelector(".explorer-root-error")).toBeNull();

    let rootAttempts = 0;
    const rootList = vi.fn(async (): Promise<DirEntry[]> => {
      rootAttempts += 1;
      if (rootAttempts === 1) throw new Error("permission denied");
      return [file("reselected.md", "/unreadable/reselected.md")];
    });
    const rejected = await openPanel({
      listDir: rootList,
      getBaseDir: () => "/unreadable",
      onOpenFile: vi.fn(),
    });
    expect(rejected.aside.querySelector(".explorer-root-error")).not.toBeNull();
    expect(rejected.aside.querySelector(".explorer-empty")).toBeNull();
    expect(rejected.aside.querySelector(".explorer-root-error .explorer-state-message")).not.toBeNull();
    const reselect = rejected.aside.querySelector<HTMLButtonElement>(".explorer-root-reselect");
    expect(reselect).not.toBeNull();
    reselect?.click();
    await flush();
    expect(rootList).toHaveBeenCalledTimes(2);
    expect(rejected.aside.querySelector(".explorer-root-error")).toBeNull();
    expect(rejected.aside.textContent).toContain("reselected.md");
  });

  it("renders only the affected child error and retries the real adapter without caching rejection", async () => {
    let childAttempts = 0;
    const listDir = vi.fn(async (path: string): Promise<DirEntry[]> => {
      if (path === "/root") return [dir("blocked", "/root/blocked"), dir("other", "/root/other")];
      if (path === "/root/blocked") {
        childAttempts += 1;
        if (childAttempts === 1) throw new Error("child denied");
        return [file("recovered.md", "/root/blocked/recovered.md")];
      }
      return [];
    });
    const panel = await openPanel({ listDir, getBaseDir: () => "/root", onOpenFile: vi.fn() });
    const blocked = items(panel.aside).find((item) => item.dataset.path === "/root/blocked") as HTMLElement;
    clickItem(blocked);
    await flush();

    expect(blocked.querySelector(".explorer-child-error")).not.toBeNull();
    expect(blocked.querySelector(".explorer-child-error .explorer-state-message")).not.toBeNull();
    expect(blocked.querySelector(".explorer-empty")).toBeNull();
    expect(panel.aside.querySelector(".explorer-root-error")).toBeNull();
    expect(items(panel.aside).find((item) => item.dataset.path === "/root/other")?.querySelector(".explorer-child-error")).toBeNull();

    const retry = blocked.querySelector<HTMLButtonElement>(".explorer-retry");
    expect(retry).not.toBeNull();
    retry?.click();
    await flush();
    expect(listDir).toHaveBeenLastCalledWith("/root/blocked");
    expect(childAttempts).toBe(2);
    expect(blocked.querySelector(".explorer-child-error")).toBeNull();
    expect(blocked.textContent).toContain("recovered.md");
  });

  it("exposes refresh through the existing invalidation path", async () => {
    const listDir = vi.fn(fakeTree());
    const panel = await openPanel({ listDir, getBaseDir: () => "/root", onOpenFile: vi.fn() });
    const refresh = panel.aside.querySelector<HTMLButtonElement>(".explorer-refresh");
    expect(refresh).not.toBeNull();
    refresh?.click();
    await flush();
    expect(listDir).toHaveBeenLastCalledWith("/root");
    expect(listDir).toHaveBeenCalledTimes(2);
  });
});

describe("explorer: viewer openability refresh", () => {
  // refreshOpenability() — the viewer-toggle mid-session bug guard. `.is-nonmd`
  // is baked in at row-creation time (K's tests above), so a live toggle of the
  // injected canOpenWithViewer answer needs an explicit refresh to reach
  // already-rendered rows. Two directions matter: re-enabling (row currently
  // .is-nonmd, should become openable) AND — the actual regression this closes
  // — disabling (row currently openable, must become .is-nonmd and STOP
  // falling through to onOpenFile as a markdown open).
  it("refreshOpenability() re-syncs .is-nonmd from a fresh canOpenWithViewer() read (re-enable direction)", async () => {
    let enabled = false;
    const onOpenWithViewer = vi.fn();
    const isPngName = (name: string) => enabled && name === "pic.png";
    const panel = await openPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile: vi.fn(),
      canOpenWithViewer: isPngName,
      onOpenWithViewer,
    });
    const png = panel.aside.querySelector(".explorer-file.is-nonmd") as HTMLElement;
    expect(png.classList.contains("is-nonmd")).toBe(true); // baked in disabled

    enabled = true; // e.g. the user re-enabled the viewer in settings
    panel.refreshOpenability();
    expect(png.classList.contains("is-nonmd")).toBe(false);

    clickItem(png);
    expect(onOpenWithViewer).toHaveBeenCalledWith("/root/pic.png");
  });

  it("refreshOpenability() re-syncs .is-nonmd on DISABLE, so a click stops opening the file as markdown (the mid-session regression)", async () => {
    let enabled = true;
    const onOpenFile = vi.fn();
    const onOpenWithViewer = vi.fn();
    const isPngName = (name: string) => enabled && name === "pic.png";
    const panel = await openPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile,
      canOpenWithViewer: isPngName,
      onOpenWithViewer,
    });
    const png = panel.aside.querySelector('.explorer-file[data-path="/root/pic.png"]') as HTMLElement;
    expect(png.classList.contains("is-nonmd")).toBe(false); // baked in enabled

    enabled = false; // the user disabled the viewer in settings, mid-session
    panel.refreshOpenability();
    expect(png.classList.contains("is-nonmd")).toBe(true);

    // Without the refresh above, this click would fall through activateItem's
    // now-false viewer branch straight into onOpenFile — a non-markdown file
    // opened as markdown. With the refresh, the row is inert: neither opener
    // fires at all.
    clickItem(png);
    expect(onOpenWithViewer).not.toHaveBeenCalled();
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("refreshOpenability() never touches folder/`..` rows (no .is-nonmd concept there)", async () => {
    const panel = await openPanel({
      listDir: vi.fn(fakeTree()),
      getBaseDir: () => "/root",
      onOpenFile: vi.fn(),
    });
    panel.refreshOpenability();
    const up = panel.aside.querySelector(".explorer-up") as HTMLElement;
    const sub = panel.aside.querySelector(".explorer-dir") as HTMLElement;
    expect(up.classList.contains("is-nonmd")).toBe(false);
    expect(sub.classList.contains("is-nonmd")).toBe(false);
  });
});
