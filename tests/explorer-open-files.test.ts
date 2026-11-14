import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExplorerPanel, type DirEntry } from "../src/sidebar/explorer/explorer-panel";
import { createOpenFilesView, type OpenFilesSnapshot } from "../src/sidebar/explorer/open-files-view";
import type { VaultTab } from "../src/workspace/vault-tabs";

const SEL = ".explorer-open-file-select";

function snap(tabs: VaultTab[], activeTabId: string | null, rootPath: string | null = "/notes/project", scopeId = "v1"): OpenFilesSnapshot {
  return { scopeId, tabs: { vaultId: scopeId, tabs, activeTabId }, rootPath };
}

function mount(initial: OpenFilesSnapshot) {
  let current = initial;
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const view = createOpenFilesView({ current: () => current, onSelect, onClose });
  document.body.replaceChildren(view.root);
  return { view, onSelect, onClose, set: (next: OpenFilesSnapshot) => { current = next; } };
}

describe("open files view", () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it("renders a list, marks only the active file", () => {
    const { view } = mount(snap([{ tabId: "a", path: "/notes/project/a.md" }, { tabId: "b", path: "/notes/project/b.md" }], "b"));
    view.render();
    expect(view.root.getAttribute("role")).toBe("list");
    expect(view.root.querySelectorAll(".explorer-open-file")).toHaveLength(2);
    expect(view.root.querySelector(".explorer-open-file")?.getAttribute("role")).toBe("listitem");
    const a = view.root.querySelector<HTMLElement>(`[data-tab-id="a"]`)!;
    const b = view.root.querySelector<HTMLElement>(`[data-tab-id="b"]`)!;
    expect(b.dataset.active).toBe("true");
    expect(b.getAttribute("aria-current")).toBe("page");
    expect(a.dataset.active).toBeUndefined();
    expect(a.hasAttribute("aria-current")).toBe(false);
    expect(a.title).toBe("/notes/project/a.md");
    expect(a.querySelector(".explorer-open-file-glyph")).toBeTruthy();
  });

  it("D5: strips the extension from the label but keeps the full path in the tooltip", () => {
    const { view } = mount(snap([{ tabId: "a", path: "/notes/project/README.md" }, { tabId: "b", path: "/notes/project/.gitignore" }, { tabId: "c", path: "/notes/project/README" }], "a"));
    view.render();
    const name = (id: string) => view.root.querySelector(`[data-tab-id="${id}"] .explorer-open-file-name`)?.textContent;
    expect(name("a")).toBe("README");
    expect(name("b")).toBe(".gitignore");
    expect(name("c")).toBe("README");
    expect(view.root.querySelector<HTMLElement>(`[data-tab-id="a"]`)?.title).toBe("/notes/project/README.md");
  });

  it("D6: folder prefix only after a folder change; none for root files", () => {
    const { view } = mount(snap([
      { tabId: "root", path: "/notes/project/index.md" },
      { tabId: "a1", path: "/notes/project/docs/alpha.md" },
      { tabId: "a2", path: "/notes/project/docs/beta.md" },
      { tabId: "b1", path: "/notes/project/scripts/run.md" },
    ], "root"));
    view.render();
    const prefix = (id: string) => view.root.querySelector(`[data-tab-id="${id}"] .explorer-open-file-prefix`)?.textContent ?? null;
    expect(prefix("root")).toBeNull();
    expect(prefix("a1")).toBe("docs/");
    expect(prefix("a2")).toBeNull();
    expect(prefix("b1")).toBe("scripts/");
  });

  it("D6: truncates long folder names, collapses depth to …/, and omits prefix without rootPath", () => {
    const tabs = [{ tabId: "long", path: "/notes/project/a-very-long-folder-name/note.md" }, { tabId: "deep", path: "/notes/project/a/b/deep.md" }];
    const { view, set } = mount(snap(tabs, "long"));
    view.render();
    const prefix = (id: string) => view.root.querySelector(`[data-tab-id="${id}"] .explorer-open-file-prefix`)?.textContent ?? null;
    expect(prefix("long")).toBe("a-very-lon…/");
    expect(prefix("deep")).toBe("…/");
    set(snap(tabs, "long", null));
    view.render();
    expect(prefix("long")).toBeNull();
    expect(prefix("deep")).toBeNull();
  });

  it("D7: displays in path order without touching the snapshot order", () => {
    const tabs = [{ tabId: "z", path: "/notes/project/zebra.md" }, { tabId: "a", path: "/notes/project/apple.md" }, { tabId: "m", path: "/notes/project/mango.md" }];
    const { view } = mount(snap(tabs, "z"));
    view.render();
    expect([...view.root.querySelectorAll<HTMLElement>(SEL)].map((el) => el.dataset.tabId)).toEqual(["a", "m", "z"]);
    expect(tabs.map((t) => t.tabId)).toEqual(["z", "a", "m"]);
  });

  it("select click calls onSelect with the render-time scopeId, even if current() changed since", () => {
    const tab = { tabId: "a", path: "/notes/project/a.md" };
    const { view, onSelect, set } = mount(snap([tab], "a", "/notes/project", "old-vault"));
    view.render();
    set(snap([tab], "a", "/other", "new-vault"));
    view.root.querySelector<HTMLButtonElement>(SEL)!.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("old-vault", tab);
  });

  it("close click calls onClose only, with an accessible label", () => {
    const tab = { tabId: "b", path: "/notes/project/b.md" };
    const { view, onSelect, onClose } = mount(snap([tab], "b"));
    view.render();
    const close = view.root.querySelector<HTMLButtonElement>(".explorer-open-file-close")!;
    expect(close.getAttribute("aria-label")).toBe("b.md 닫기");
    close.click();
    expect(onClose).toHaveBeenCalledWith("v1", tab);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows the empty state naming the next action when no files are open", () => {
    const { view } = mount(snap([], null));
    view.render();
    expect(view.root.querySelector(".explorer-empty")?.textContent).toBe("열린 파일이 없습니다. 트리에서 파일을 열면 여기에 표시됩니다.");
    expect(view.root.querySelectorAll(".explorer-open-file")).toHaveLength(0);
  });

  it("render() rebuilds from the latest current()", () => {
    const { view, set } = mount(snap([{ tabId: "a", path: "/notes/project/a.md" }], "a"));
    view.render();
    set(snap([{ tabId: "c", path: "/notes/project/c.md" }, { tabId: "d", path: "/notes/project/d.md" }], "d"));
    view.render();
    expect([...view.root.querySelectorAll<HTMLElement>(SEL)].map((el) => el.dataset.tabId)).toEqual(["c", "d"]);
  });

  it("focusPrimary: active row, else first row, else the root", () => {
    const tabs = [{ tabId: "a", path: "/notes/project/a.md" }, { tabId: "b", path: "/notes/project/b.md" }];
    const { view, set } = mount(snap(tabs, "b"));
    view.render();
    view.focusPrimary();
    expect((document.activeElement as HTMLElement).dataset.tabId).toBe("b");
    set(snap(tabs, null));
    view.render();
    view.focusPrimary();
    expect((document.activeElement as HTMLElement).dataset.tabId).toBe("a");
    set(snap([], null));
    view.render();
    view.focusPrimary();
    expect(document.activeElement).toBe(view.root);
  });
});

// --- ExplorerPanel integration ------------------------------------------------
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const TREE: Record<string, DirEntry[]> = {
  "/root": [{ name: "a.md", path: "/root/a.md", is_dir: false }],
  "/root/child": [{ name: "c.md", path: "/root/child/c.md", is_dir: false }],
};
const listDir = (path: string) => Promise.resolve(TREE[path] ?? []);

describe("explorer panel: open-files view switch", () => {
  beforeEach(() => { document.body.replaceChildren(); });

  const filesHandlers = (tabs: VaultTab[] = [{ tabId: "a", path: "/root/a.md" }], active: string | null = "a") => {
    let snapshot = snap(tabs, active, "/root");
    const handlers = { current: vi.fn(() => snapshot), onSelect: vi.fn(), onClose: vi.fn() };
    return { handlers, set: (next: OpenFilesSnapshot) => { snapshot = next; } };
  };
  const mountPanel = (extra: Partial<Parameters<typeof createExplorerPanel>[0]> = {}) => {
    const panel = createExplorerPanel({ listDir, getBaseDir: () => "/root", onOpenFile: vi.fn(), ...extra });
    document.body.append(panel.button, panel.aside);
    return panel;
  };

  it("renders no view switch when openFiles is not injected", () => {
    const panel = mountPanel();
    expect(panel.aside.querySelector(".explorer-view-switch")).toBeNull();
    expect(panel.aside.querySelector(".explorer-open-files")?.hasAttribute("hidden")).toBe(true);
  });

  it("renders the switch with tree pressed initially", () => {
    const panel = mountPanel({ openFiles: filesHandlers().handlers });
    const sw = panel.aside.querySelector(".explorer-view-switch")!;
    expect(sw.getAttribute("role")).toBe("group");
    expect(sw.getAttribute("aria-label")).toBe("탐색기 보기");
    const opts = [...sw.querySelectorAll<HTMLElement>(".explorer-view-option")];
    expect(opts.map((o) => o.dataset.view)).toEqual(["tree", "open-files"]);
    expect(opts[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(opts[1]!.getAttribute("aria-pressed")).toBe("false");
    expect(panel.aside.querySelector<HTMLElement>(".explorer-tree")!.hidden).toBe(false);
    expect(panel.aside.querySelector<HTMLElement>(".explorer-open-files")!.hidden).toBe(true);
  });

  it("toggle click only calls onViewChange (SSOT one-way); setView does the swap", () => {
    const onViewChange = vi.fn();
    const panel = mountPanel({ openFiles: filesHandlers().handlers, onViewChange });
    panel.aside.querySelector<HTMLButtonElement>('[data-view="open-files"]')!.click();
    expect(onViewChange).toHaveBeenCalledTimes(1);
    expect(onViewChange).toHaveBeenCalledWith("open-files");
    expect(panel.aside.querySelector<HTMLElement>(".explorer-tree")!.hidden).toBe(false);
    panel.setView("open-files");
    expect(panel.aside.querySelector<HTMLElement>(".explorer-tree")!.hidden).toBe(true);
    expect(panel.aside.querySelector<HTMLElement>(".explorer-open-files")!.hidden).toBe(false);
    expect(panel.aside.querySelector('[data-view="open-files"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(panel.aside.querySelector('[data-view="tree"]')!.getAttribute("aria-pressed")).toBe("false");
    expect(panel.aside.querySelector<HTMLElement>(".explorer-refresh")!.hidden).toBe(true);
    expect(panel.aside.querySelectorAll(".explorer-open-file")).toHaveLength(1);
    panel.setView("tree");
    expect(panel.aside.querySelector<HTMLElement>(".explorer-refresh")!.hidden).toBe(false);
  });

  it("without onViewChange the toggle switches by itself (standalone)", () => {
    const panel = mountPanel({ openFiles: filesHandlers().handlers });
    panel.aside.querySelector<HTMLButtonElement>('[data-view="open-files"]')!.click();
    expect(panel.aside.querySelector<HTMLElement>(".explorer-open-files")!.hidden).toBe(false);
  });

  it("refreshOpenFiles re-reads current() and repaints", () => {
    const { handlers, set } = filesHandlers();
    const panel = mountPanel({ openFiles: handlers });
    panel.setView("open-files");
    handlers.current.mockClear();
    set(snap([{ tabId: "x", path: "/root/x.md" }, { tabId: "y", path: "/root/y.md" }], "y", "/root"));
    panel.refreshOpenFiles();
    expect(handlers.current).toHaveBeenCalled();
    expect(panel.aside.querySelectorAll(".explorer-open-file")).toHaveLength(2);
  });

  it("owed focus lands on the visible open-files view, not the hidden tree", async () => {
    const panel = mountPanel({ openFiles: filesHandlers().handlers });
    panel.setView("open-files");
    panel.jumpToRoot("/root/child");
    await flush();
    const active = document.activeElement as HTMLElement;
    expect(active.classList.contains("explorer-open-file-select")).toBe(true);
    expect(active.dataset.active).toBe("true");
    expect(active.closest(".explorer-tree")).toBeNull();
  });

  it("owed focus with zero open files lands on the list root", async () => {
    const panel = mountPanel({ openFiles: filesHandlers([], null).handlers });
    panel.setView("open-files");
    panel.jumpToRoot("/root/child");
    await flush();
    expect(document.activeElement).toBe(panel.aside.querySelector(".explorer-open-files"));
  });

  it("regression: in tree view owed focus still goes to the first tree item", async () => {
    const panel = mountPanel({ openFiles: filesHandlers().handlers });
    panel.jumpToRoot("/root/child");
    await flush();
    expect((document.activeElement as HTMLElement).classList.contains("explorer-item")).toBe(true);
    expect(panel.aside.querySelector(".explorer-tree")!.contains(document.activeElement)).toBe(true);
  });

  it("onRootChange still fires for jumpToRoot while open-files is showing", async () => {
    const onRootChange = vi.fn();
    const panel = mountPanel({ openFiles: filesHandlers().handlers, onRootChange });
    panel.setView("open-files");
    panel.jumpToRoot("/root/child");
    await flush();
    expect(onRootChange).toHaveBeenCalledWith("/root/child");
  });
});
