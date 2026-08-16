import { icon } from "../icons";
import { renderSidebarButton } from "../sidebar/toggle";
import { redundantPathLabel, truncatedPathLabel } from "../chrome/path-label";
import { WorkspaceStateError, type Vault, type WorkspaceState, type WorkspaceStore } from "./workspace-state";
import type { VaultTabs } from "./vault-tabs";
import { isVaultCollapsed, setVaultCollapsed } from "./vault-collapse";

export interface WorkspaceSidebar {
  readonly button: HTMLButtonElement;
  readonly aside: HTMLElement;
  close(): void;
  refresh(): void;
}

export interface WorkspaceSidebarHandlers {
  readonly store: WorkspaceStore;
  readonly onSelectVault: (vault: Vault) => void;
  readonly onSelectTab?: (vault: Vault, tab: VaultTabs["tabs"][number]) => void | Promise<boolean>;
  readonly onCloseTab?: (vault: Vault, tab: VaultTabs["tabs"][number]) => void;
  onOpen?(): void;
  readonly getTabs?: (vaultId: string) => VaultTabs;
}

const create = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag); if (className) element.className = className; return element;
};

/** Sync a vault row's collapse toggle — glyph, aria-expanded, labels, and the
 *  tab strip's visibility — in one command so the picture and the state can
 *  never drift apart. Same discipline as the explorer's
 *  renderFolderGlyph/expandFolder/collapseFolder (explorer-panel.ts). */
function renderVaultCollapse(toggle: HTMLButtonElement, glyph: HTMLElement, tabList: HTMLElement, displayName: string, collapsed: boolean): void {
  glyph.replaceChildren(icon(collapsed ? "folder" : "folder-open"));
  toggle.setAttribute("aria-expanded", String(!collapsed));
  const label = `${displayName} 탭 ${collapsed ? "펼치기" : "접기"}`;
  toggle.title = label;
  toggle.setAttribute("aria-label", label);
  tabList.hidden = collapsed;
}

export function createWorkspaceSidebar({ store, onSelectVault, onSelectTab, onCloseTab, onOpen, getTabs }: WorkspaceSidebarHandlers): WorkspaceSidebar {
  const button = create("button", "chrome-btn workspace-btn icon-only");
  const aside = create("aside", "workspace-aside sidebar-aside");
  aside.id = "workspace-aside"; aside.hidden = true;
  const header = create("div", "workspace-header sidebar-header");
  const title = create("span", "workspace-title"); title.textContent = "워크스페이스"; header.append(title);
  const list = create("div", "workspace-vault-list"); list.setAttribute("role", "list");
  // Names the registration path (the explorer's per-folder bookmark toggle)
  // instead of ending at "없습니다" with no next step. Text only — an "open the
  // explorer" button would need a new callback threaded through main.ts.
  // Lives INSIDE the permanent group (see renderGroup) so it aligns with that
  // group's label and rows, and so "the permanent group is empty" is what the
  // DOM actually says rather than something the reader infers from ordering.
  const empty = create("div", "workspace-empty"); empty.textContent = "등록된 영구 볼트가 없습니다. 탐색기에서 폴더 옆 북마크 아이콘으로 등록할 수 있습니다.";
  // Inline error line (explorer's root-error pattern, not an OS alert — this
  // panel was the one place still using window.alert). Sits above the list so
  // it's visible regardless of which row's action triggered it. A persistent
  // node toggled by `.hidden`, like `empty` above, rather than built fresh —
  // there's only ever one error showing at a time.
  const errorMessage = create("span", "workspace-error-message");
  const errorEl = create("div", "workspace-error"); errorEl.hidden = true; errorEl.append(errorMessage);
  aside.append(header, errorEl, list);

  const renderButton = (): void => renderSidebarButton(button, "list-tree", "워크스페이스", !aside.hidden, "workspace-aside");
  renderButton();
  const close = (): void => { aside.hidden = true; renderButton(); };
  button.addEventListener("click", () => { if (!aside.hidden) close(); else { aside.hidden = false; onOpen?.(); renderButton(); } });

  // WorkspaceStateError is a user-facing, expected failure (duplicate root,
  // missing vault) — shown inline, never thrown further. Anything else is
  // unexpected and must keep propagating: swallowing it here would hide a
  // real bug instead of surfacing it. The line clears on the next successful
  // render (see `render` below), not on a timer — a stale error outliving
  // the state that caused it would be worse than one that lingers a beat.
  const showError = (error: unknown): void => {
    if (error instanceof WorkspaceStateError || typeof error === "string") {
      errorMessage.textContent = error instanceof Error ? error.message : error;
      errorEl.hidden = false;
      return;
    }
    throw error;
  };
  const render = (state: WorkspaceState): void => {
    const workspace = state.workspaces.find((item) => item.workspaceId === state.currentWorkspaceId);
    if (!workspace) return;
    errorEl.hidden = true;
    list.replaceChildren();
    const permanentVaults = workspace.vaultIds.flatMap((vaultId) => {
      const vault = state.vaults.find((item) => item.vaultId === vaultId);
      return vault ? [vault] : [];
    });
    empty.hidden = permanentVaults.length > 0;
    // Every vault about to render, global included — a permanent vault named
    // the same as the global vault (or another permanent vault) is exactly
    // the case a per-group check would miss, since the two live in separate
    // groups. Counts, not identities: only a name shared by 2+ vaults gets a
    // path label; a lone vault reads fine by name alone (240px is no room for
    // a path nobody needs).
    const nameCounts = new Map<string, number>();
    for (const vault of [store.getGlobalVault(), ...permanentVaults]) nameCounts.set(vault.displayName, (nameCounts.get(vault.displayName) ?? 0) + 1);
    const hasNameCollision = (name: string): boolean => (nameCounts.get(name) ?? 0) > 1;

    // `label` names the group in the DOM (not via CSS `content:`, where the
    // string would be invisible to a grep of the other UI strings, unselectable,
    // and unreliably exposed to assistive tech). The global group stays
    // unlabelled on purpose: it's the single default row, and a second heading
    // above it would add chrome without adding a distinction.
    const renderGroup = (className: string, vaults: readonly Vault[], label?: string, emptyState?: HTMLElement): void => {
      const group = create("section", `workspace-vault-group ${className}`);
      if (label) {
        const heading = create("div", "workspace-group-label");
        heading.id = `${className}-label`; heading.textContent = label;
        group.setAttribute("aria-labelledby", heading.id);
        group.append(heading);
      }
      for (const vault of vaults) {
        const row = create("div", "workspace-vault-row"); row.setAttribute("role", "listitem"); row.dataset.vaultId = vault.vaultId;
        // Toggle is its own button, not nested inside `select` — a button
        // inside a button is invalid HTML, and it made the two controls'
        // hovers bleed into each other. Its click means collapse/expand;
        // `select`'s click means entry. `folder-open`/`folder` (the same pair
        // the explorer's directory rows use) now means expanded/collapsed
        // only — the old global-vs-permanent reading of this glyph is
        // dropped, since the "영구 볼트" group label already carries that
        // distinction.
        const toggle = create("button", "workspace-vault-toggle") as HTMLButtonElement; toggle.type = "button";
        const glyph = create("span", "workspace-vault-glyph"); toggle.append(glyph);
        const select = create("button", "workspace-vault-select") as HTMLButtonElement; select.type = "button"; select.title = vault.rootPath ?? vault.displayName;
        const name = create("span", "workspace-vault-name"); name.textContent = vault.displayName; select.append(name);
        // Path label only when this vault's name collides with another one
        // currently on screen — the shared left-truncating component
        // (src/chrome/path-label.ts), same as recent-item's disambiguation
        // row, never a fresh one. The global vault has no rootPath (nothing
        // to show), so it can never carry this even if its name collides.
        const pathLabel = vault.rootPath && hasNameCollision(vault.displayName) && !redundantPathLabel(vault.rootPath) ? truncatedPathLabel(vault.rootPath) : null;
        const tabList = create("div", "workspace-vault-tabs"); tabList.setAttribute("role", "tablist"); tabList.setAttribute("aria-orientation", "horizontal"); tabList.setAttribute("aria-label", `${vault.displayName} 탭`);
        const tabs = getTabs?.(vault.vaultId) ?? { vaultId: vault.vaultId, tabs: [], activeTabId: null };
        for (const tab of tabs.tabs) {
          const tabName = tab.path.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? tab.path;
          const tabRow = create("div", "workspace-vault-tab-row");
          const tabEl = create("button", "workspace-vault-tab") as HTMLButtonElement; tabEl.type = "button"; tabEl.textContent = tabName; tabEl.dataset.tabId = tab.tabId; tabEl.title = tab.path;
          const selected = tab.tabId === tabs.activeTabId;
          tabEl.setAttribute("role", "tab"); tabEl.setAttribute("aria-selected", String(selected)); tabEl.tabIndex = selected ? 0 : -1;
          if (selected) { tabEl.dataset.active = "true"; tabEl.setAttribute("aria-current", "page"); }
          const commitRoving = (target: VaultTabs["tabs"][number], focus: boolean): void => {
            const currentList = aside.querySelector<HTMLElement>(`[data-vault-id="${vault.vaultId}"] .workspace-vault-tabs`);
            const buttons = [...(currentList?.querySelectorAll<HTMLButtonElement>(".workspace-vault-tab") ?? [])];
            const targetButton = buttons.find((button) => button.dataset.tabId === target.tabId);
            for (const button of buttons) button.tabIndex = button === targetButton ? 0 : -1;
            if (focus) targetButton?.focus();
          };
          const activate = (target: VaultTabs["tabs"][number], focus: boolean): void => {
            try {
              const result = onSelectTab?.(vault, target);
              if (result && typeof result.then === "function") {
                void result.then((committed) => { if (committed) commitRoving(target, focus); }).catch(showError);
              } else {
                commitRoving(target, focus);
              }
            } catch (error) { showError(error); }
          };
          tabEl.addEventListener("click", () => activate(tab, false));
          tabEl.addEventListener("keydown", (event) => {
            const key = event.key;
            if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") return;
            event.preventDefault();
            const index = tabs.tabs.findIndex((candidate) => candidate.tabId === tab.tabId);
            const nextIndex = key === "Home" ? 0 : key === "End" ? tabs.tabs.length - 1 : (index + (key === "ArrowRight" ? 1 : -1) + tabs.tabs.length) % tabs.tabs.length;
            const target = tabs.tabs[nextIndex];
            if (target) activate(target, true);
          });
          const closeTab = create("button", "workspace-vault-tab-close") as HTMLButtonElement; closeTab.type = "button"; closeTab.title = "탭 닫기"; closeTab.setAttribute("aria-label", `${tabName} 탭 닫기`); closeTab.append(icon("x")); closeTab.addEventListener("click", (event) => { event.stopPropagation(); onCloseTab?.(vault, tab); });
          tabRow.append(tabEl, closeTab); tabList.append(tabRow);
        }
        select.setAttribute("aria-current", workspace.currentVaultId === vault.vaultId ? "true" : "false"); select.addEventListener("click", () => { try { onSelectVault(vault); } catch (error) { showError(error); } });
        // Collapse state is UI layout, not workspace state — it lives in its
        // own storage (vault-collapse.ts) and is applied/toggled in place
        // rather than through a full `render()`, so a keyboard user's focus
        // stays on the toggle after activating it.
        let collapsed = isVaultCollapsed(vault.vaultId);
        renderVaultCollapse(toggle, glyph, tabList, vault.displayName, collapsed);
        toggle.addEventListener("click", (event) => {
          event.stopPropagation();
          collapsed = !collapsed;
          setVaultCollapsed(vault.vaultId, collapsed);
          renderVaultCollapse(toggle, glyph, tabList, vault.displayName, collapsed);
        });
        row.append(toggle, select);
        if (pathLabel) row.append(pathLabel);
        row.append(tabList);
        if (vault.persistenceKind === "permanent") {
          // Reversible, so the title says so instead of reading like a
          // destructive one-way click: unregisterVault only drops the
          // vaultId/rootPath pairing from workspace state (workspace-state.ts)
          // — it never touches `mermark.vaultTabs.<id>`, and vaultId is
          // derived deterministically from the canonical rootPath
          // (`vault-${encodeURIComponent(path)}`), so re-registering the same
          // folder lands on the same id and its saved tabs are still there.
          // No `aria-pressed` — that promises a real toggle (press again to
          // undo in place), but this button removes itself on click; it's a
          // plain one-way action, not a toggle (unlike the explorer's own
          // bookmark toggle, which really does flip back and forth).
          const remove = create("button", "workspace-vault-action") as HTMLButtonElement; remove.type = "button"; remove.title = "영구 볼트 해제 — 탭 상태는 보존됩니다"; remove.setAttribute("aria-label", `${vault.displayName} 영구 볼트 해제 — 탭 상태는 보존됩니다`); remove.append(icon("bookmark-filled")); remove.addEventListener("click", () => { try { store.unregisterVault(vault.vaultId); } catch (error) { showError(error); } });
          row.append(remove);
        }
        group.append(row);
      }
      if (emptyState) group.append(emptyState);
      list.append(group);
    };
    renderGroup("workspace-vault-group--global", [store.getGlobalVault()]);
    renderGroup("workspace-vault-group--permanent", permanentVaults, "영구 볼트", empty);
  };
  store.subscribe(render); render(store.get());
  return { button, aside, close, refresh: () => render(store.get()) };
}
