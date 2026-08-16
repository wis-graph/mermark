import { icon } from "../icons";
import { renderSidebarButton } from "../sidebar/toggle";
import { WorkspaceStateError, type Vault, type WorkspaceState, type WorkspaceStore } from "./workspace-state";
import type { VaultTabs } from "./vault-tabs";

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

export function createWorkspaceSidebar({ store, onSelectVault, onSelectTab, onCloseTab, onOpen, getTabs }: WorkspaceSidebarHandlers): WorkspaceSidebar {
  const button = create("button", "chrome-btn workspace-btn icon-only");
  const aside = create("aside", "workspace-aside sidebar-aside");
  aside.id = "workspace-aside"; aside.hidden = true;
  const header = create("div", "workspace-header sidebar-header");
  const title = create("span", "workspace-title"); title.textContent = "워크스페이스"; header.append(title);
  const list = create("div", "workspace-vault-list"); list.setAttribute("role", "list");
  const empty = create("div", "workspace-empty"); empty.textContent = "등록된 영구 볼트가 없습니다";
  aside.append(header, list, empty);

  const renderButton = (): void => renderSidebarButton(button, "list-tree", "워크스페이스", !aside.hidden, "workspace-aside");
  renderButton();
  const close = (): void => { aside.hidden = true; renderButton(); };
  button.addEventListener("click", () => { if (!aside.hidden) close(); else { aside.hidden = false; onOpen?.(); renderButton(); } });

  const showError = (error: unknown): void => { if (error instanceof WorkspaceStateError || typeof error === "string") { window.alert(error instanceof Error ? error.message : error); return; } throw error; };
  const render = (state: WorkspaceState): void => {
    const workspace = state.workspaces.find((item) => item.workspaceId === state.currentWorkspaceId);
    if (!workspace) return;
    list.replaceChildren();
    const permanentVaults = workspace.vaultIds.flatMap((vaultId) => {
      const vault = state.vaults.find((item) => item.vaultId === vaultId);
      return vault ? [vault] : [];
    });
    empty.hidden = permanentVaults.length > 0;

    const renderGroup = (className: string, vaults: readonly Vault[]): void => {
      const group = create("section", `workspace-vault-group ${className}`);
      for (const vault of vaults) {
        const row = create("div", "workspace-vault-row"); row.setAttribute("role", "listitem"); row.dataset.vaultId = vault.vaultId;
        const select = create("button", "workspace-vault-select") as HTMLButtonElement; select.type = "button"; select.title = vault.rootPath ?? vault.displayName;
        const glyph = create("span", "workspace-vault-glyph"); glyph.append(icon(vault.persistenceKind === "global" ? "folder-open" : "folder")); select.append(glyph);
        const name = create("span", "workspace-vault-name"); name.textContent = vault.displayName; select.append(name);
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
        row.append(select, tabList);
        if (vault.persistenceKind === "permanent") {
          const remove = create("button", "workspace-vault-action") as HTMLButtonElement; remove.type = "button"; remove.title = "영구 볼트 해제"; remove.setAttribute("aria-label", `${vault.displayName} 영구 볼트 해제`); remove.setAttribute("aria-pressed", "true"); remove.append(icon("bookmark-filled")); remove.addEventListener("click", () => { try { store.unregisterVault(vault.vaultId); } catch (error) { showError(error); } });
          row.append(remove);
        }
        group.append(row);
      }
      list.append(group);
    };
    renderGroup("workspace-vault-group--global", [store.getGlobalVault()]);
    renderGroup("workspace-vault-group--permanent", permanentVaults);
  };
  store.subscribe(render); render(store.get());
  return { button, aside, close, refresh: () => render(store.get()) };
}
