import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createExplorerPanel, type DirEntry } from "../src/explorer/explorer-panel";

// ---------------------------------------------------------------------------
// Explorer panel — a lazy folder tree built from an INJECTED listDir() (no real
// backend). We assert the three domain rules the panel owns:
//   B1: lazy hover fills children once (cache — re-hover never re-calls list_dir)
//   B2: `..` double-click changes the root (cache clear + tree rebuild)
//   B3: file click → onOpenFile(absPath); non-md file click is a no-op
// mouseenter is dispatched directly on the folder node; the panel listens on the
// capturing phase (mouseenter doesn't bubble), so a real DOM dispatch reaches it.
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
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => {
  vi.useRealTimers();
  host.remove();
});

/** Open the panel and flush the async initial renderTree (list_dir is a promise). */
async function openPanel(opts: {
  listDir: (p: string) => Promise<DirEntry[]>;
  getBaseDir: () => string;
  onOpenFile: (p: string) => void;
}) {
  const panel = createExplorerPanel(opts);
  host.append(panel.button, panel.row);
  panel.button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await vi.runAllTimersAsync(); // flush renderTree's awaited list_dir
  return panel;
}

const items = (row: HTMLElement) =>
  [...row.querySelectorAll(".explorer-item")].map((e) => e as HTMLElement);
const names = (row: HTMLElement) =>
  items(row).map((e) => e.querySelector(".explorer-name")?.textContent);

describe("explorer: lazy hover fills children (B1)", () => {
  it("initial open reads only the root; folder hover reads its children once", async () => {
    const listDir = vi.fn(fakeTree());
    const panel = await openPanel({ listDir, getBaseDir: () => "/root", onOpenFile: vi.fn() });

    // Root read exactly once; sub's children NOT read yet (lazy).
    expect(listDir).toHaveBeenCalledTimes(1);
    expect(listDir).toHaveBeenCalledWith("/root");
    expect(names(panel.row)).toEqual(["..", "sub", "a.md", "pic.png"]);

    const sub = panel.row.querySelector(".explorer-dir") as HTMLElement;
    sub.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    await vi.runAllTimersAsync(); // debounce + awaited list_dir

    expect(listDir).toHaveBeenCalledTimes(2);
    expect(listDir).toHaveBeenLastCalledWith("/root/sub");
    const kids = sub.querySelector(".explorer-children") as HTMLElement;
    expect(kids.hidden).toBe(false);
    expect(kids.textContent).toContain("b.md");

    // Re-hover the same folder → cache hit, no re-call.
    sub.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    await vi.runAllTimersAsync();
    expect(listDir).toHaveBeenCalledTimes(2);
  });
});

describe("explorer: `..` double-click changes root (B2)", () => {
  it("rebuilds the tree at the parent and clears prior expansion", async () => {
    const listDir = vi.fn(fakeTree());
    const panel = await openPanel({ listDir, getBaseDir: () => "/root/child", onOpenFile: vi.fn() });

    expect(names(panel.row)).toEqual(["..", "c.md"]);

    const up = panel.row.querySelector(".explorer-up") as HTMLElement;
    up.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await vi.runAllTimersAsync();

    // Root is now /root (parent of /root/child) — child's entries gone, root's shown.
    expect(listDir).toHaveBeenLastCalledWith("/root/child/..");
    expect(names(panel.row)).toEqual(["..", "sub", "a.md", "pic.png"]);
  });
});

describe("explorer: file click opens markdown only (B3)", () => {
  it("md file click → onOpenFile(absPath); non-md click is a no-op", async () => {
    const onOpenFile = vi.fn();
    const panel = await openPanel({ listDir: vi.fn(fakeTree()), getBaseDir: () => "/root", onOpenFile });

    const md = [...panel.row.querySelectorAll(".explorer-file")].find(
      (e) => e.querySelector(".explorer-name")?.textContent === "a.md",
    ) as HTMLElement;
    md.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledWith("/root/a.md");

    const png = panel.row.querySelector(".explorer-file.is-nonmd") as HTMLElement;
    expect(png.querySelector(".explorer-name")?.textContent).toBe("pic.png");
    png.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpenFile).toHaveBeenCalledTimes(1); // still 1 — non-md is inert
  });
});
