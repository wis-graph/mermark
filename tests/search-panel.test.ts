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

function mount(overrides: Partial<SearchHandlers> = {}, scanImpl?: (root: string) => Promise<unknown>) {
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

type DeferredScan = {
  readonly resolve: (result: ScanResult) => void;
  readonly reject: (reason: Error) => void;
};

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
    expect(err?.querySelector(".search-state-message")).not.toBeNull();
    expect(panel.aside.querySelector(".search-empty")).toBeNull();
  });

  it("a malformed scan result renders a distinct error row", async () => {
    const { panel } = mount({}, () => Promise.resolve({ files: [], truncated: "not a boolean" }));
    panel.revealSearch();
    await flush();
    expect(panel.aside.querySelector(".search-error")).not.toBeNull();
    expect(panel.aside.querySelector(".search-empty")).toBeNull();
  });

  it("keeps a newer same-root scan error after an older scan resolves late", async () => {
    // Given: two deferred opens of the same root.
    const pending: DeferredScan[] = [];
    const { panel } = mount({}, () =>
      new Promise<ScanResult>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
    );

    // When: the later scan rejects before the older one succeeds.
    panel.button.click();
    panel.button.click();
    panel.button.click();
    const older = pending[0];
    const newer = pending[1];
    if (!older || !newer) throw new Error("two scan requests were not created");
    newer.reject(new Error("newer scan failed"));
    await flush();
    older.resolve({ files: [hit("stale.md", "/root/stale.md", "stale.md")], truncated: false });
    await flush();

    // Then: the later error remains authoritative and stale results are absent.
    expect(panel.aside.querySelector(".search-error")).not.toBeNull();
    expect(panel.aside.querySelector(".search-item[data-path='/root/stale.md']")).toBeNull();
  });

  it("keeps newer same-root scan results after an older scan rejects late", async () => {
    // Given: two deferred opens of the same root.
    const pending: DeferredScan[] = [];
    const { panel } = mount({}, () =>
      new Promise<ScanResult>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
    );

    // When: the later scan succeeds before the older one rejects.
    panel.button.click();
    panel.button.click();
    panel.button.click();
    const older = pending[0];
    const newer = pending[1];
    if (!older || !newer) throw new Error("two scan requests were not created");
    newer.resolve({ files: [hit("fresh.md", "/root/fresh.md", "fresh.md")], truncated: false });
    await flush();
    older.reject(new Error("older scan failed"));
    await flush();

    // Then: the later results remain authoritative and no error is rendered.
    expect(panel.aside.querySelector(".search-error")).toBeNull();
    expect(panel.aside.querySelector(".search-item[data-path='/root/fresh.md']")).not.toBeNull();
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

  // txt-as-md (_workspace/01_architect_design_txt.md): .txt is openable via
  // the SSOT with no canOpenWithViewer injection needed; .log stays inert.
  it(".txt row is openable (isEditableTextFile SSOT), no canOpenWithViewer needed", async () => {
    const { panel, onOpenFile } = mount({ canOpenWithViewer: () => false }, () =>
      Promise.resolve({
        files: [
          hit("a.md", "/root/a.md", "a.md"),
          hit("plain.txt", "/root/plain.txt", "plain.txt"),
          hit("notes.log", "/root/notes.log", "notes.log"),
        ],
        truncated: false,
      }),
    );
    panel.revealSearch();
    await flush();

    const txtRow = rows(panel.aside).find((r) => r.dataset.path === "/root/plain.txt")!;
    expect(txtRow.classList.contains("is-nonmd")).toBe(false);
    txtRow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpenFile).toHaveBeenCalledWith("/root/plain.txt");

    const logRow = rows(panel.aside).find((r) => r.dataset.path === "/root/notes.log")!;
    expect(logRow.classList.contains("is-nonmd")).toBe(true);
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
