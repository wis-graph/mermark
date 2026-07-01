import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createExplorerPanel, type DirEntry } from "../src/explorer/explorer-panel";

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

/** A fake backend list_dir over a fixed tree. Mirrors the real command's
 *  contract: parent (`${root}/..`) is resolved to the normalized parent, so a
 *  `..` from /root/child maps to the /root key. */
function fakeTree(): (path: string) => Promise<DirEntry[]> {
  const TREE: Record<string, DirEntry[]> = {
    "/root": [dir("sub", "/root/sub"), file("a.md", "/root/a.md"), file("pic.png", "/root/pic.png")],
    "/root/sub": [file("b.md", "/root/sub/b.md")],
    "/root/child": [file("c.md", "/root/child/c.md")],
  };
  return (path: string) => {
    // fake normalize: fold a trailing "/.." into the parent (backend's job).
    const norm = path.endsWith("/..") ? path.slice(0, path.lastIndexOf("/", path.length - 4)) : path;
    return Promise.resolve(TREE[norm] ?? []);
  };
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
async function openPanel(opts: {
  listDir: (p: string) => Promise<DirEntry[]>;
  getBaseDir: () => string;
  onOpenFile: (p: string) => void;
}) {
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

    expect(listDir).toHaveBeenLastCalledWith("/root/child/..");
    expect(names(panel.aside)).toEqual(["..", "sub", "a.md", "pic.png"]);
  });

  it("Enter on `..` also changes root", async () => {
    const listDir = vi.fn(fakeTree());
    const panel = await openPanel({ listDir, getBaseDir: () => "/root/child", onOpenFile: vi.fn() });
    press(panel.aside, "Enter"); // initial focus is `..`
    await flush();
    expect(listDir).toHaveBeenLastCalledWith("/root/child/..");
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
