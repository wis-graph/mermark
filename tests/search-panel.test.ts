import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSearchPanel, type FileHit, type ScanResult, type SearchHandlers } from "../src/sidebar/search/search-panel";

const hit = (name: string, path: string, relPath: string): FileHit => ({ name, path, rel_path: relPath });

function fakeResult(): ScanResult {
  return {
    files: [
      hit("a.md", "/root/a.md", "a.md"),
      hit("b.md", "/root/sub/b.md", "sub/b.md"),
      hit("pic.png", "/root/pic.png", "pic.png"),
    ],
    truncated: false,
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

function mount(overrides: Partial<SearchHandlers> = {}, scanImpl?: (root: string) => Promise<ScanResult>) {
  const scan = vi.fn(scanImpl ?? (() => Promise.resolve(fakeResult())));
  const onOpenFile = vi.fn();
  const onOpenFileNewWindow = vi.fn();
  const onOpen = vi.fn();
  const panel = createSearchPanel({
    scan,
    getRoot: () => "/root",
    onOpenFile,
    onOpenFileNewWindow,
    canOpenWithViewer: () => false,
    onOpen,
    ...overrides,
  });
  host.append(panel.button, panel.aside);
  return { panel, scan, onOpenFile, onOpenFileNewWindow, onOpen };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const input = (aside: HTMLElement) => aside.querySelector(".search-input") as HTMLInputElement;
const rows = (aside: HTMLElement) => [...aside.querySelectorAll<HTMLElement>(".search-item")];

describe("createSearchPanel", () => {
  it("revealSearch opens the aside, focuses the input, and fires onOpen", async () => {
    const { panel, onOpen } = mount();
    panel.revealSearch();
    await flush();
    expect(panel.aside.hidden).toBe(false);
    expect(document.activeElement).toBe(input(panel.aside));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("scans exactly once per open; typing filters with zero additional scan calls", async () => {
    const { panel, scan } = mount();
    panel.revealSearch();
    await flush();
    expect(scan).toHaveBeenCalledTimes(1);
    const inp = input(panel.aside);
    inp.value = "a";
    inp.dispatchEvent(new Event("input"));
    inp.value = "ab";
    inp.dispatchEvent(new Event("input"));
    inp.value = "";
    inp.dispatchEvent(new Event("input"));
    expect(scan).toHaveBeenCalledTimes(1); // pure client-side filtering, no IPC per keystroke
  });

  it("empty query lists the scanned files; a query fuzzy-ranks and highlights matches", async () => {
    const { panel } = mount();
    panel.revealSearch();
    await flush();
    expect(rows(panel.aside).map((r) => r.dataset.path)).toEqual([
      "/root/a.md",
      "/root/sub/b.md",
      "/root/pic.png",
    ]);

    const inp = input(panel.aside);
    inp.value = "bmd";
    inp.dispatchEvent(new Event("input"));
    const filtered = rows(panel.aside);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].dataset.path).toBe("/root/sub/b.md");
    expect(filtered[0].querySelector(".search-hit-mark")).not.toBeNull();
  });

  it("ArrowDown/ArrowUp move the highlight, Enter opens the highlighted row", async () => {
    const { panel, onOpenFile } = mount();
    panel.revealSearch();
    await flush();
    const inp = input(panel.aside);
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onOpenFile).toHaveBeenCalledWith("/root/sub/b.md");
  });

  it("Mod-Enter opens in a new window via onOpenFileNewWindow", async () => {
    const { panel, onOpenFileNewWindow, onOpenFile } = mount();
    panel.revealSearch();
    await flush();
    const inp = input(panel.aside);
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    expect(onOpenFileNewWindow).toHaveBeenCalledWith("/root/a.md");
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("an Enter that confirms IME composition does not activate a row", async () => {
    const { panel, onOpenFile } = mount();
    panel.revealSearch();
    await flush();
    const inp = input(panel.aside);
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("a scan rejection renders a distinct error row (not an empty-results row)", async () => {
    const { panel } = mount({}, () => Promise.reject(new Error("permission denied")));
    panel.revealSearch();
    await flush();
    const err = panel.aside.querySelector(".search-error");
    expect(err).not.toBeNull();
    expect(panel.aside.querySelector(".search-empty")).toBeNull();
  });

  it("truncated: true renders a banner row above the results", async () => {
    const { panel } = mount({}, () => Promise.resolve({ files: fakeResult().files, truncated: true }));
    panel.revealSearch();
    await flush();
    expect(panel.aside.querySelector(".search-truncated-banner")).not.toBeNull();
  });

  it("a non-markdown, non-viewer-claimed row is dimmed and inert", async () => {
    const { panel, onOpenFile } = mount({ canOpenWithViewer: () => false });
    panel.revealSearch();
    await flush();
    const pngRow = rows(panel.aside).find((r) => r.dataset.path === "/root/pic.png")!;
    expect(pngRow.classList.contains("is-nonmd")).toBe(true);
    pngRow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("a viewer-claimed non-markdown row IS openable when canOpenWithViewer says so", async () => {
    const { panel, onOpenFile } = mount({ canOpenWithViewer: (name) => name.endsWith(".png") });
    panel.revealSearch();
    await flush();
    const pngRow = rows(panel.aside).find((r) => r.dataset.path === "/root/pic.png")!;
    expect(pngRow.classList.contains("is-nonmd")).toBe(false);
    pngRow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpenFile).toHaveBeenCalledWith("/root/pic.png");
  });

  it("Escape closes the panel", async () => {
    const { panel } = mount();
    panel.revealSearch();
    await flush();
    const inp = input(panel.aside);
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.aside.hidden).toBe(true);
  });
});
