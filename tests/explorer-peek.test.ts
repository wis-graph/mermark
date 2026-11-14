import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createExplorerPanel, type DirEntry, type ExplorerHandlers } from "../src/sidebar/explorer/explorer-panel";

// Explorer pinned / peek modes (design: _workspace/01_architect_design.md).
const dir = (name: string, path: string): DirEntry => ({ name, path, is_dir: true });
const file = (name: string, path: string): DirEntry => ({ name, path, is_dir: false });
const TREE: Record<string, DirEntry[]> = {
  "/root": [dir("sub", "/root/sub"), file("a.md", "/root/a.md"), file("pic.png", "/root/pic.png")],
  "/root/sub": [file("b.md", "/root/sub/b.md")],
};
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const click = (el: Element, init: MouseEventInit = {}) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init }));

let outside: HTMLInputElement;
beforeEach(() => {
  outside = document.createElement("input");
  document.body.append(outside);
});
afterEach(() => document.body.replaceChildren());

function mount(extra: Partial<ExplorerHandlers> = {}) {
  const listDir = vi.fn((p: string) => Promise.resolve(TREE[p] ?? []));
  const onOpenFile = vi.fn();
  const panel = createExplorerPanel({ listDir, getBaseDir: () => "/root", onOpenFile, ...extra });
  document.body.append(panel.button, panel.aside);
  const dock = () => panel.aside.querySelector<HTMLButtonElement>(".explorer-dock-btn")!;
  const row = (name: string) =>
    [...panel.aside.querySelectorAll<HTMLElement>(".explorer-item")].find((r) => r.textContent?.includes(name))!;
  return { panel, listDir, onOpenFile, dock, row };
}
const hasPath = (el: Element, d: string) => el.innerHTML.includes(d);
const RIGHT = 'd="m6 17 5-5-5-5"';
const LEFT = 'd="m11 17-5-5 5-5"';

describe("explorer peek / pin", () => {
  it("초기 mode는 closed, 헤더 텍스트는 탐색기 그대로", () => {
    const { panel } = mount();
    expect(panel.mode()).toBe("closed");
    expect(panel.aside.querySelector(".explorer-header")!.textContent).toBe("탐색기");
  });

  it("peek(): mode peek, data-peek, aria-expanded true, dock = 고정(»), listDir는 getBaseDir로", async () => {
    const { panel, listDir, dock } = mount();
    panel.peek();
    await flush();
    expect(panel.mode()).toBe("peek");
    expect(panel.aside.hidden).toBe(false);
    expect(panel.aside.hasAttribute("data-peek")).toBe(true);
    expect(panel.button.getAttribute("aria-expanded")).toBe("true");
    expect(dock().getAttribute("aria-label")).toBe("사이드바 고정");
    expect(hasPath(dock(), RIGHT)).toBe(true);
    expect(listDir).toHaveBeenCalledWith("/root");
  });

  it("peek()는 포커스를 훔치지 않는다", async () => {
    const { panel } = mount();
    outside.focus();
    panel.peek();
    await flush();
    expect(document.activeElement).toBe(outside);
  });

  it("pinned·이미 peek에서 peek()는 no-op", async () => {
    const { panel, listDir } = mount();
    click(panel.button);
    await flush();
    panel.peek();
    expect(panel.aside.hasAttribute("data-peek")).toBe(false);
    panel.close();
    panel.peek();
    await flush();
    const n = listDir.mock.calls.length;
    panel.peek();
    await flush();
    expect(listDir.mock.calls.length).toBe(n);
  });

  it("토글 버튼: peek→pinned(재렌더 없음, 펼친 폴더 유지, dock «), closed→pinned, pinned→closed", async () => {
    const { panel, listDir, dock, row } = mount();
    panel.peek();
    await flush();
    click(row("sub"));
    await flush();
    expect(row("sub").getAttribute("aria-expanded")).toBe("true");
    const calls = listDir.mock.calls.length;
    click(panel.button);
    await flush();
    expect(panel.mode()).toBe("pinned");
    expect(panel.aside.hasAttribute("data-peek")).toBe(false);
    expect(listDir.mock.calls.length).toBe(calls);
    expect(row("sub").getAttribute("aria-expanded")).toBe("true");
    expect(dock().getAttribute("aria-label")).toBe("사이드바 접기");
    expect(hasPath(dock(), LEFT)).toBe(true);
    click(panel.button);
    expect(panel.mode()).toBe("closed");
    click(panel.button);
    expect(panel.mode()).toBe("pinned");
  });

  it("dock 클릭: peek→pinned, pinned→closed 후 포커스는 title-bar 토글 버튼", async () => {
    const { panel, dock } = mount();
    panel.peek();
    await flush();
    click(dock());
    expect(panel.mode()).toBe("pinned");
    dock().focus();
    click(dock());
    expect(panel.mode()).toBe("closed");
    await Promise.resolve();
    expect(document.activeElement).toBe(panel.button);
  });

  it("close()는 data-peek를 지운다", async () => {
    const { panel } = mount();
    panel.peek();
    panel.close();
    expect(panel.aside.hasAttribute("data-peek")).toBe(false);
    expect(panel.mode()).toBe("closed");
  });

  it("jumpToRoot from closed → pinned", async () => {
    const { panel } = mount();
    panel.jumpToRoot("/root");
    await flush();
    expect(panel.mode()).toBe("pinned");
  });

  it("peek 중 파일 행 클릭 → 열고 closed; 폴더는 peek 유지; pinned는 유지", async () => {
    const { panel, onOpenFile, row } = mount();
    panel.peek();
    await flush();
    click(row("sub"));
    await flush();
    expect(panel.mode()).toBe("peek");
    click(row("a.md"));
    expect(onOpenFile).toHaveBeenCalledWith("/root/a.md");
    expect(panel.mode()).toBe("closed");

    click(panel.button);
    await flush();
    click(row("a.md"));
    expect(panel.mode()).toBe("pinned");
  });

  it("viewer 행·새 창(⌘클릭) 행도 peek를 닫는다", async () => {
    const onOpenWithViewer = vi.fn();
    const onOpenFileNewWindow = vi.fn();
    const { panel, row } = mount({
      onOpenWithViewer, onOpenFileNewWindow, canOpenWithViewer: (n: string) => n.endsWith(".png"),
    });
    panel.peek();
    await flush();
    click(row("pic.png"));
    expect(onOpenWithViewer).toHaveBeenCalled();
    expect(panel.mode()).toBe("closed");
    panel.peek();
    await flush();
    click(row("a.md"), { metaKey: true });
    expect(onOpenFileNewWindow).toHaveBeenCalled();
    expect(panel.mode()).toBe("closed");
  });

  it("열린 파일 목록: onSelect는 peek를 닫고 onClose(탭 닫기)는 유지", async () => {
    const tab = { tabId: "a", path: "/root/a.md" };
    const openFiles = {
      current: () => ({ scopeId: "v1", tabs: { vaultId: "v1", tabs: [tab], activeTabId: "a" }, rootPath: "/root" }),
      onSelect: vi.fn(), onClose: vi.fn(),
    };
    const { panel } = mount({ openFiles });
    panel.setView("open-files");
    panel.peek();
    await flush();
    panel.aside.querySelector<HTMLButtonElement>(".explorer-open-file-close")!.click();
    expect(openFiles.onClose).toHaveBeenCalled();
    expect(panel.mode()).toBe("peek");
    panel.aside.querySelector<HTMLButtonElement>(".explorer-open-file-select")!.click();
    expect(openFiles.onSelect).toHaveBeenCalled();
    expect(panel.mode()).toBe("closed");
  });

  it("포커스 반환: 안으로 들어온 포커스는 close() 시 peek 직전 요소로, detach되면 무시", async () => {
    const { panel, row } = mount();
    outside.focus();
    panel.peek();
    await flush();
    (row("a.md") as HTMLElement).focus();
    expect(panel.aside.contains(document.activeElement)).toBe(true);
    panel.close();
    expect(document.activeElement).toBe(outside);

    panel.peek();
    await flush();
    (row("a.md") as HTMLElement).focus();
    outside.remove();
    expect(() => panel.close()).not.toThrow();
  });
});
