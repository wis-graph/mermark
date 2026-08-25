import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createWorkspaceSidebar } from "../src/workspace/workspace-sidebar";
import { GLOBAL_VAULT_ID, WorkspaceStateError, WorkspaceStore } from "../src/workspace/workspace-state";
import type { VaultTabs } from "../src/workspace/vault-tabs";

describe("workspace sidebar", () => {
  beforeEach(() => localStorage.clear());

  it("renders vault rows without global registration or rename controls", () => {
    const store = new WorkspaceStore();
    const onSelectVault = vi.fn();
    const vault = store.registerVault("/notes/project", "Project");
    const sidebar = createWorkspaceSidebar({ store, onSelectVault });
    document.body.append(sidebar.aside, sidebar.button);

    expect(sidebar.aside.querySelectorAll(".workspace-vault-row")).toHaveLength(2);
    expect(sidebar.aside.querySelector(".workspace-id")).toBeNull();
    expect(sidebar.aside.querySelector(".workspace-vault-group-label")).toBeNull();
    expect(sidebar.aside.querySelectorAll("[role=heading]")).toHaveLength(0);
    expect(sidebar.aside.querySelector(`[data-vault-id="${GLOBAL_VAULT_ID}"]`)).toBeTruthy();
    expect(sidebar.aside.textContent).toContain("글로벌 볼트");
    expect(sidebar.aside.querySelector(`[data-vault-id="${GLOBAL_VAULT_ID}"]`)?.compareDocumentPosition(sidebar.aside.querySelector(`[data-vault-id="${vault.vaultId}"]`) as Node) && Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sidebar.aside.querySelector(".workspace-vault-path")).toBeNull();
    const permanentRow = sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${vault.vaultId}"]`);
    expect(permanentRow?.querySelector<HTMLButtonElement>(".workspace-vault-select")?.title).toBe("/notes/project");
    permanentRow?.querySelector<HTMLButtonElement>(".workspace-vault-select")?.click();
    expect(onSelectVault).toHaveBeenCalledWith(vault);
    expect(sidebar.aside.querySelector(".workspace-action")).toBeNull();
    expect(sidebar.aside.querySelector(".icon-square-pen")).toBeNull();
    expect(sidebar.aside.textContent).not.toContain("볼트 등록");
    expect(sidebar.aside.textContent).not.toContain("이름 변경");
  });

  it("renders the selected vault tabs and marks the active tab", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const tabs: VaultTabs = { vaultId: vault.vaultId, tabs: [{ tabId: "tab-1", path: "/notes/readme.md" }], activeTabId: "tab-1" };
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), getTabs: () => tabs });
    document.body.append(sidebar.aside);

    // D5: the icon already says it's markdown — the label drops the
    // extension, but the full name/path stays reachable via the tooltip.
    expect(sidebar.aside.querySelector(".workspace-vault-tab-name")?.textContent).toBe("readme");
    expect(sidebar.aside.querySelector<HTMLButtonElement>(".workspace-vault-tab")?.title).toBe("/notes/readme.md");
    expect(sidebar.aside.querySelector(".workspace-vault-tab-glyph")).toBeTruthy();
    expect(sidebar.aside.querySelector(".workspace-vault-tab")?.getAttribute("data-active")).toBe("true");
    expect(sidebar.aside.querySelector(".workspace-vault-tabs-label")).toBeNull();
    expect(sidebar.aside.querySelector(".workspace-vault-tabs")?.getAttribute("role")).toBe("tablist");
    const permanentRow = sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${vault.vaultId}"]`);
    expect(permanentRow?.querySelector(".workspace-vault-tabs")?.getAttribute("aria-label")).toBe("Project 탭");
    expect(permanentRow?.querySelector(".workspace-vault-tab")?.getAttribute("role")).toBe("tab");
    expect(permanentRow?.querySelector(".workspace-vault-tab")?.getAttribute("aria-selected")).toBe("true");
    expect(permanentRow?.querySelector(".workspace-vault-tab")?.getAttribute("tabindex")).toBe("0");
    expect(permanentRow?.querySelector(".workspace-vault-tab")?.getAttribute("aria-current")).toBe("page");
  });

  it("moves the roving tab focus and activates the tab with horizontal keys, following D7's PATH order (not the stored open order)", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const onSelectTab = vi.fn();
    // Stored (open) order is one/two/three, but path order is one < three <
    // two ("three.md" < "two.md" — 'h' < 'w') — deliberately different from
    // stored order so a test that used stored-order indices would pass for
    // the wrong reason.
    const tabs: VaultTabs = {
      vaultId: vault.vaultId,
      tabs: [{ tabId: "tab-1", path: "/notes/one.md" }, { tabId: "tab-2", path: "/notes/two.md" }, { tabId: "tab-3", path: "/notes/three.md" }],
      activeTabId: "tab-1",
    };
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), getTabs: () => tabs, onSelectTab });
    document.body.append(sidebar.aside);
    const tab = sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] [data-tab-id="tab-1"]`);
    tab?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));

    // Right from one.md (rendered first) lands on three.md (rendered
    // second), not the stored-order neighbor two.md.
    expect(onSelectTab).toHaveBeenCalledWith(vault, tabs.tabs[2]);
    expect(sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] [data-tab-id="tab-3"]`)?.tabIndex).toBe(0);
    expect(sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] [data-tab-id="tab-1"]`)?.tabIndex).toBe(-1);

    sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] [data-tab-id="tab-3"]`)?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    // End lands on the LAST rendered (path-order) tab: two.md.
    expect(onSelectTab).toHaveBeenLastCalledWith(vault, tabs.tabs[1]);
    expect(sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] [data-tab-id="tab-2"]`)?.tabIndex).toBe(0);
    expect(sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] [data-tab-id="tab-3"]`)?.tabIndex).toBe(-1);
  });

  it("keeps the selected tab tabbable when keyboard activation is rejected", async () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const tabs: VaultTabs = {
      vaultId: vault.vaultId,
      tabs: [{ tabId: "tab-1", path: "/notes/one.md" }, { tabId: "tab-2", path: "/notes/two.md" }],
      activeTabId: "tab-1",
    };
    const sidebar = createWorkspaceSidebar({
      store,
      onSelectVault: vi.fn(),
      getTabs: () => tabs,
      onSelectTab: () => Promise.resolve(false),
    });
    document.body.append(sidebar.aside);
    const active = sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] [data-tab-id="tab-1"]`);
    active?.focus();
    active?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(active?.getAttribute("aria-selected")).toBe("true");
    expect(active?.tabIndex).toBe(0);
    expect(document.activeElement).toBe(active);
    expect(sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] [data-tab-id="tab-2"]`)?.tabIndex).toBe(-1);
  });

  it("opens a clicked vault tab through the injected document handler", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const onSelectTab = vi.fn();
    const tabs: VaultTabs = { vaultId: vault.vaultId, tabs: [{ tabId: "tab-1", path: "/notes/readme.md" }], activeTabId: "tab-1" };
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), getTabs: () => tabs, onSelectTab });
    document.body.append(sidebar.aside);

    sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${vault.vaultId}"]`)?.querySelector<HTMLButtonElement>(".workspace-vault-tab")?.click();

    expect(onSelectTab).toHaveBeenCalledWith(vault, tabs.tabs[0]);
    expect(store.get().workspaces[0]?.currentVaultId).toBe(vault.vaultId);
  });

  it("does not render temporary/session groups or per-document vault rows", () => {
    const store = new WorkspaceStore();
    store.registerVault("/notes/project", "Project");
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
    document.body.append(sidebar.aside);

    expect(sidebar.aside.querySelector(".workspace-vault-group--temporary")).toBeNull();
    expect(sidebar.aside.textContent).not.toContain("이번 세션");
  });

  it("exposes an accessible close action for each tab and delegates closing", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const tab = { tabId: "tab-1", path: "/notes/readme.md" };
    const onCloseTab = vi.fn();
    const sidebar = createWorkspaceSidebar({
      store,
      onSelectVault: vi.fn(),
      getTabs: () => ({ vaultId: vault.vaultId, tabs: [tab], activeTabId: tab.tabId }),
      onCloseTab,
    });
    document.body.append(sidebar.aside);

    const close = sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${vault.vaultId}"]`)?.querySelector<HTMLButtonElement>(".workspace-vault-tab-close");
    close?.click();

    expect(close?.getAttribute("aria-label")).toBe("readme.md 탭 닫기");
    expect(onCloseTab).toHaveBeenCalledWith(vault, tab);
  });

  it("unregisters a permanent vault immediately without a browser confirmation dialog", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
    document.body.append(sidebar.aside);

    expect(sidebar.aside.querySelector(`[data-vault-id="${vault.vaultId}"] .icon-bookmark-filled`)).toBeTruthy();
    sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] .workspace-vault-action`)?.click();

    expect(store.get().vaults).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
    expect(sidebar.aside.querySelector(`[data-vault-id="${vault.vaultId}"]`)).toBeNull();
  });

  // The unregister button is a one-way action (it removes its own row), not a
  // toggle — aria-pressed promises the wrong contract (a leftover from
  // copying the explorer's real bookmark toggle). Its title communicates the
  // one fact that makes the click safe to make lightly: tab state survives.
  it("the unregister button has no aria-pressed and its title/aria-label say the tab state is kept", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
    document.body.append(sidebar.aside);

    const remove = sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] .workspace-vault-action`);
    expect(remove?.hasAttribute("aria-pressed")).toBe(false);
    expect(remove?.title).toContain("보존");
    expect(remove?.getAttribute("aria-label")).toContain("보존");
  });

  // Disambiguation path label (P10): the shared .path-label component
  // (src/chrome/path-label.ts, same one recent-item uses) only when a
  // displayName collides with another vault ON SCREEN RIGHT NOW — collision
  // scope is every rendered vault including the global one, not just
  // same-group siblings.
  it("adds a path label only to vaults whose name collides with another on-screen vault", () => {
    const store = new WorkspaceStore();
    const dup1 = store.registerVault("/work/notes", "notes");
    const dup2 = store.registerVault("/home/notes", "notes");
    const unique = store.registerVault("/home/journal", "journal");
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
    document.body.append(sidebar.aside);

    const rowFor = (vaultId: string) => sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${vaultId}"]`);
    expect(rowFor(dup1.vaultId)?.querySelector(".path-label")).toBeTruthy();
    expect(rowFor(dup2.vaultId)?.querySelector(".path-label")).toBeTruthy();
    expect(rowFor(unique.vaultId)?.querySelector(".path-label")).toBeNull();
    // The global vault has no rootPath, so it never gets one even though
    // nothing here makes its name collide in this test — the row simply
    // has no path to show.
    expect(rowFor(GLOBAL_VAULT_ID)?.querySelector(".path-label")).toBeNull();
  });

  it("does not add a path label when every on-screen vault name is unique", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
    document.body.append(sidebar.aside);

    expect(sidebar.aside.querySelector(".path-label")).toBeNull();
    // The tooltip stays — the label is a supplement, not a replacement.
    expect(sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] .workspace-vault-select`)?.title).toBe("/notes/project");
  });

  // Inline error line (P11): WorkspaceStateError shows in the panel and
  // clears on the next successful render; anything else keeps propagating
  // instead of being silently swallowed. jsdom doesn't let a listener
  // exception propagate through .click() itself (matches real browsers —
  // dispatchEvent reports it via the global 'error' event rather than
  // throwing back at the caller), so that's what this test listens for.
  it("shows a WorkspaceStateError inline (no window.alert) and clears it on the next successful render", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const onSelectVault = vi.fn(() => { throw new WorkspaceStateError("missing-vault", "그 볼트를 찾을 수 없습니다"); });
    const sidebar = createWorkspaceSidebar({ store, onSelectVault });
    document.body.append(sidebar.aside);

    sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] .workspace-vault-select`)?.click();

    expect(alertSpy).not.toHaveBeenCalled();
    const errorEl = sidebar.aside.querySelector<HTMLElement>(".workspace-error");
    expect(errorEl?.hidden).toBe(false);
    expect(errorEl?.textContent).toContain("그 볼트를 찾을 수 없습니다");

    // Any subsequent successful render (a rename here, unrelated to the
    // failed selection) clears the stale line.
    store.renameVault(vault.vaultId, "Renamed");
    expect(sidebar.aside.querySelector<HTMLElement>(".workspace-error")?.hidden).toBe(true);
  });

  it("still throws a non-WorkspaceStateError instead of swallowing it", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const onSelectVault = vi.fn(() => { throw new Error("boom-unexpected"); });
    const sidebar = createWorkspaceSidebar({ store, onSelectVault });
    document.body.append(sidebar.aside);

    let captured: unknown = null;
    const onWindowError = (event: ErrorEvent) => { captured = event.error; event.preventDefault(); };
    window.addEventListener("error", onWindowError);
    sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] .workspace-vault-select`)?.click();
    window.removeEventListener("error", onWindowError);

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe("boom-unexpected");
    // Not swallowed into the inline error line either.
    expect(sidebar.aside.querySelector<HTMLElement>(".workspace-error")?.hidden).not.toBe(false);
  });

  // Collapse toggle (P12): clicking the glyph collapses/expands the tab strip
  // and must never enter the vault — the name (`select`) owns entry, the
  // glyph (`toggle`) owns collapse, and neither click may trigger the other's
  // effect. The four tests below assert `tabList.hidden` — that only proves
  // the JS wrote the attribute it intended to, not that the tab strip is
  // actually invisible (jsdom doesn't apply styles.css, and `[hidden]` alone
  // loses to an unconditional `display` in an author rule). The style-contract
  // test right after this block ("locks the CSS override...") is what actually
  // guards the visible behavior.
  it("clicking the collapse toggle hides the tab strip without entering the vault", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const tabs: VaultTabs = { vaultId: vault.vaultId, tabs: [{ tabId: "tab-1", path: "/notes/readme.md" }], activeTabId: "tab-1" };
    const onSelectVault = vi.fn();
    const sidebar = createWorkspaceSidebar({ store, onSelectVault, getTabs: () => tabs });
    document.body.append(sidebar.aside);

    const row = sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${vault.vaultId}"]`);
    const toggle = row?.querySelector<HTMLButtonElement>(".workspace-vault-toggle");
    const tabList = row?.querySelector<HTMLElement>(".workspace-vault-tabs");
    expect(tabList?.hidden).toBe(false);

    toggle?.click();

    expect(tabList?.hidden).toBe(true);
    expect(onSelectVault).not.toHaveBeenCalled();
  });

  it("clicking the vault name enters the vault without collapsing the tab strip", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const tabs: VaultTabs = { vaultId: vault.vaultId, tabs: [{ tabId: "tab-1", path: "/notes/readme.md" }], activeTabId: "tab-1" };
    const onSelectVault = vi.fn();
    const sidebar = createWorkspaceSidebar({ store, onSelectVault, getTabs: () => tabs });
    document.body.append(sidebar.aside);

    const row = sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${vault.vaultId}"]`);
    row?.querySelector<HTMLButtonElement>(".workspace-vault-select")?.click();

    expect(onSelectVault).toHaveBeenCalledWith(vault);
    expect(row?.querySelector<HTMLElement>(".workspace-vault-tabs")?.hidden).toBe(false);
    expect(row?.querySelector<HTMLButtonElement>(".workspace-vault-toggle")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("persists a vault's collapse state across sidebar instances and defaults to expanded", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const sidebarA = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
    document.body.append(sidebarA.aside);
    const rowA = sidebarA.aside.querySelector<HTMLElement>(`[data-vault-id="${vault.vaultId}"]`);
    expect(rowA?.querySelector<HTMLButtonElement>(".workspace-vault-toggle")?.getAttribute("aria-expanded")).toBe("true");
    rowA?.querySelector<HTMLButtonElement>(".workspace-vault-toggle")?.click();
    sidebarA.aside.remove();

    const sidebarB = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
    document.body.append(sidebarB.aside);
    const rowB = sidebarB.aside.querySelector<HTMLElement>(`[data-vault-id="${vault.vaultId}"]`);
    expect(rowB?.querySelector<HTMLButtonElement>(".workspace-vault-toggle")?.getAttribute("aria-expanded")).toBe("false");
    expect(rowB?.querySelector<HTMLElement>(".workspace-vault-tabs")?.hidden).toBe(true);
  });

  it("keeps aria-expanded in sync with the actual collapse state through repeated toggles", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
    document.body.append(sidebar.aside);
    const toggle = sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] .workspace-vault-toggle`);
    const tabList = sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${vault.vaultId}"] .workspace-vault-tabs`);

    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle?.querySelector(".icon-folder-open")).toBeTruthy();

    toggle?.click();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle?.querySelector(".icon-folder")).toBeTruthy();
    expect(tabList?.hidden).toBe(true);

    toggle?.click();
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle?.querySelector(".icon-folder-open")).toBeTruthy();
    expect(tabList?.hidden).toBe(false);
  });

  // Style contract: `.workspace-vault-tabs` declares `display: flex`
  // unconditionally, and an author rule always beats the UA's built-in
  // `[hidden] { display: none }` regardless of matching specificity — so
  // without its own `[hidden]` override, `tabList.hidden = true` (asserted
  // above) writes the attribute but a collapsed row still renders its tabs.
  // jsdom doesn't load styles.css into mounted nodes, so this reads the
  // stylesheet as text instead (same technique as tests/sidebar-zoom.test.ts's
  // ruleBlock helper) — the only way in this suite to actually lock the
  // visible behavior rather than the attribute the JS happens to set.
  it("locks the [hidden] override that actually hides a collapsed vault's tab strip", () => {
    const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles.css");
    const css = readFileSync(cssPath, "utf8");
    expect(css).toMatch(/\.workspace-vault-tabs\[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
  });

  // D5/D6/D7 (design_tabbar_visual.md §2.3, .omo/plans/workspace-tab-bar.md):
  // file icon, extension-stripped label with a full-path tooltip, one-level
  // folder prefix that only appears on a folder change, and path-order
  // rendering. The stored tab order (VaultTabs.tabs) is never touched by
  // any of this — only what gets rendered and in what sequence.
  it("D5: strips the extension from the tab label but keeps the full path in the tooltip", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const tabs: VaultTabs = {
      vaultId: vault.vaultId,
      tabs: [{ tabId: "a", path: "/notes/project/README.md" }, { tabId: "b", path: "/notes/project/.gitignore" }],
      activeTabId: "a",
    };
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), getTabs: () => tabs });
    document.body.append(sidebar.aside);

    const tabEls = [...sidebar.aside.querySelectorAll<HTMLButtonElement>(".workspace-vault-tab")];
    const readme = tabEls.find((el) => el.title === "/notes/project/README.md");
    const gitignore = tabEls.find((el) => el.title === "/notes/project/.gitignore");
    expect(readme?.querySelector(".workspace-vault-tab-name")?.textContent).toBe("README");
    expect(readme?.querySelector(".workspace-vault-tab-glyph")).toBeTruthy();
    // A dotfile has no extension per extensionOf's contract (the leading dot
    // isn't one) — nothing to strip, so the label stays the full name.
    expect(gitignore?.querySelector(".workspace-vault-tab-name")?.textContent).toBe(".gitignore");
  });

  it("D6: shows the folder prefix only on the first tab after a folder change, omits it on consecutive same-folder tabs, and omits it for root-level files", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const tabs: VaultTabs = {
      vaultId: vault.vaultId,
      tabs: [
        { tabId: "root", path: "/notes/project/index.md" },
        { tabId: "a1", path: "/notes/project/docs/alpha.md" },
        { tabId: "a2", path: "/notes/project/docs/beta.md" },
        { tabId: "b1", path: "/notes/project/scripts/run.md" },
      ],
      activeTabId: "root",
    };
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), getTabs: () => tabs });
    document.body.append(sidebar.aside);

    const prefixFor = (tabId: string) =>
      sidebar.aside.querySelector<HTMLElement>(`[data-tab-id="${tabId}"] .workspace-vault-tab-prefix`)?.textContent ?? null;
    // Path order: index.md (root), docs/alpha.md, docs/beta.md, scripts/run.md.
    expect(prefixFor("root")).toBeNull(); // directly under the vault root
    expect(prefixFor("a1")).toBe("docs/"); // folder just changed to docs/
    expect(prefixFor("a2")).toBeNull(); // still docs/ — same as the row above, omitted
    expect(prefixFor("b1")).toBe("scripts/"); // folder changed again
  });

  it("D6: truncates a folder name longer than the character cap and shows only \"…/\" two levels deep", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const tabs: VaultTabs = {
      vaultId: vault.vaultId,
      tabs: [
        { tabId: "long", path: "/notes/project/a-very-long-folder-name/note.md" },
        { tabId: "deep", path: "/notes/project/a/b/deep.md" },
      ],
      activeTabId: "long",
    };
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), getTabs: () => tabs });
    document.body.append(sidebar.aside);

    const prefixFor = (tabId: string) =>
      sidebar.aside.querySelector<HTMLElement>(`[data-tab-id="${tabId}"] .workspace-vault-tab-prefix`)?.textContent ?? null;
    expect(prefixFor("long")).toBe("a-very-lon…/"); // first 10 real chars of "a-very-long-folder-name" + "…/"
    expect(prefixFor("deep")).toBe("…/"); // two levels deep (a/b) — depth, not name, collapses
  });

  it("D7: renders tabs in path order without touching the stored (open) order", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const tabs: VaultTabs = {
      vaultId: vault.vaultId,
      // Opened in this order: zebra, apple, mango — deliberately NOT
      // alphabetical, so a render that just echoed tabs.tabs would fail.
      tabs: [{ tabId: "z", path: "/notes/project/zebra.md" }, { tabId: "a", path: "/notes/project/apple.md" }, { tabId: "m", path: "/notes/project/mango.md" }],
      activeTabId: "z",
    };
    const sidebar = createWorkspaceSidebar({
      store,
      onSelectVault: vi.fn(),
      getTabs: (vaultId) => (vaultId === vault.vaultId ? tabs : { vaultId, tabs: [], activeTabId: null }),
    });
    document.body.append(sidebar.aside);

    const renderedIds = [...sidebar.aside.querySelectorAll<HTMLElement>(".workspace-vault-tab")].map((el) => el.dataset.tabId);
    expect(renderedIds).toEqual(["a", "m", "z"]);
    // The stored order (what vaultTabs.ts owns) is untouched by rendering.
    expect(tabs.tabs.map((tab) => tab.tabId)).toEqual(["z", "a", "m"]);
  });

  it("fills the closed-folder glyph when a collapsed vault still has tabs, and leaves it unfilled when it doesn't", () => {
    const store = new WorkspaceStore();
    const withTabs = store.registerVault("/notes/full", "Full");
    const empty = store.registerVault("/notes/empty", "Empty");
    const tabs: VaultTabs = { vaultId: withTabs.vaultId, tabs: [{ tabId: "a", path: "/notes/full/a.md" }], activeTabId: "a" };
    const sidebar = createWorkspaceSidebar({
      store,
      onSelectVault: vi.fn(),
      getTabs: (vaultId) => (vaultId === withTabs.vaultId ? tabs : { vaultId, tabs: [], activeTabId: null }),
    });
    document.body.append(sidebar.aside);

    const glyphFor = (vaultId: string) => sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${vaultId}"] .workspace-vault-glyph`);
    // Collapse both — one has a tab, the other doesn't.
    sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${withTabs.vaultId}"] .workspace-vault-toggle`)?.click();
    sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${empty.vaultId}"] .workspace-vault-toggle`)?.click();

    expect(glyphFor(withTabs.vaultId)?.classList.contains("has-tabs")).toBe(true);
    expect(glyphFor(empty.vaultId)?.classList.contains("has-tabs")).toBe(false);

    // Expanding back drops the fill — "찬 폴더" is a COLLAPSED-only signal.
    sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${withTabs.vaultId}"] .workspace-vault-toggle`)?.click();
    expect(glyphFor(withTabs.vaultId)?.classList.contains("has-tabs")).toBe(false);
  });

  it("closes competing panels when workspace opens", () => {
    const store = new WorkspaceStore();
    const onOpen = vi.fn();
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), onOpen });

    sidebar.button.click();

    expect(onOpen).toHaveBeenCalledOnce();
  });

  // 볼트 목록 부모-자식 인덴트 (00_request.md #1): a child vault whose root sits
  // inside a registered parent vault's root renders one level deeper
  // (--level on the row), immediately after its parent — reusing isPathWithin
  // (path.ts), not a new predicate.
  describe("vault parent-child indent", () => {
    it("indents a child vault under its registered parent and places it immediately after", () => {
      const store = new WorkspaceStore();
      const parent = store.registerVault("/notes", "Notes");
      const child = store.registerVault("/notes/project", "Project");
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
      document.body.append(sidebar.aside);

      const parentRow = sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${parent.vaultId}"]`);
      const childRow = sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${child.vaultId}"]`);
      expect(parentRow?.style.getPropertyValue("--level")).toBe("1");
      expect(childRow?.style.getPropertyValue("--level")).toBe("2");
      // Parent immediately followed by its child.
      expect(parentRow?.compareDocumentPosition(childRow as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      const rows = [...sidebar.aside.querySelectorAll<HTMLElement>(".workspace-vault-group--permanent .workspace-vault-row")];
      expect(rows.indexOf(childRow as HTMLElement)).toBe(rows.indexOf(parentRow as HTMLElement) + 1);
    });

    it("attaches a 3-level-deep vault to its NEAREST registered ancestor only, not every ancestor", () => {
      const store = new WorkspaceStore();
      const grandparent = store.registerVault("/a", "A");
      const parent = store.registerVault("/a/b", "B");
      const child = store.registerVault("/a/b/c", "C");
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
      document.body.append(sidebar.aside);

      const rowFor = (id: string) => sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${id}"]`);
      expect(rowFor(grandparent.vaultId)?.style.getPropertyValue("--level")).toBe("1");
      expect(rowFor(parent.vaultId)?.style.getPropertyValue("--level")).toBe("2");
      expect(rowFor(child.vaultId)?.style.getPropertyValue("--level")).toBe("3");
    });

    it("does not indent unrelated top-level vaults", () => {
      const store = new WorkspaceStore();
      const first = store.registerVault("/work/one", "One");
      const second = store.registerVault("/home/two", "Two");
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
      document.body.append(sidebar.aside);

      const rowFor = (id: string) => sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${id}"]`);
      expect(rowFor(first.vaultId)?.style.getPropertyValue("--level")).toBe("1");
      expect(rowFor(second.vaultId)?.style.getPropertyValue("--level")).toBe("1");
    });

    it("never lets a collapsed parent hide its child vault's row (child is an independent registration, not nested content)", () => {
      const store = new WorkspaceStore();
      const parent = store.registerVault("/notes", "Notes");
      const child = store.registerVault("/notes/project", "Project");
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
      document.body.append(sidebar.aside);

      sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${parent.vaultId}"] .workspace-vault-toggle`)?.click();

      const childRow = sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${child.vaultId}"]`);
      expect(childRow).toBeTruthy();
      expect(childRow?.hidden).toBe(false);
      // Only the parent's own tab strip collapses — the child row/select stays reachable.
      expect(childRow?.querySelector<HTMLButtonElement>(".workspace-vault-select")).toBeTruthy();
    });

    it("keeps the global vault outside the hierarchy (no rootPath, no --level bump)", () => {
      const store = new WorkspaceStore();
      store.registerVault("/notes", "Notes");
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
      document.body.append(sidebar.aside);

      const globalRow = sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${GLOBAL_VAULT_ID}"]`);
      expect(globalRow?.style.getPropertyValue("--level")).toBe("1");
    });
  });
});
