import { icon } from "../icons";
import { renderSidebarButton } from "../sidebar/toggle";
import { canonicalRootPath, WorkspaceStateError, type Vault, type WorkspaceState, type WorkspaceStore } from "./workspace-state";
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
  readonly onSelectTab?: (vault: Vault, tab: VaultTabs["tabs"][number]) => void;
  onOpen?(): void;
  readonly promptForPath?: () => string | null;
  readonly promptForName?: (current: string) => string | null;
  readonly canonicalizePath?: (path: string) => Promise<string>;
  readonly getTabs?: (vaultId: string) => VaultTabs;
}

const create = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag); if (className) element.className = className; return element;
};

export function createWorkspaceSidebar({ store, onSelectVault, onSelectTab, onOpen, promptForPath = () => window.prompt("볼트 폴더 경로"), promptForName = (current) => window.prompt("볼트 이름", current), canonicalizePath, getTabs }: WorkspaceSidebarHandlers): WorkspaceSidebar {
  const button = create("button", "chrome-btn workspace-btn icon-only");
  const aside = create("aside", "workspace-aside sidebar-aside");
  aside.id = "workspace-aside"; aside.hidden = true;
  const header = create("div", "workspace-header sidebar-header"); header.append(icon("list-tree"));
  const title = create("span", "workspace-title"); title.textContent = "워크스페이스"; header.append(title);
  const workspaceLabel = create("div", "workspace-id");
  const list = create("div", "workspace-vault-list"); list.setAttribute("role", "list");
  const empty = create("div", "workspace-empty"); empty.textContent = "등록된 영구 볼트가 없습니다";
  const actions = create("div", "workspace-actions");
  const register = create("button", "workspace-action") as HTMLButtonElement; register.type = "button"; register.append(icon("plus"), document.createTextNode("볼트 등록"));
  actions.append(register); aside.append(header, workspaceLabel, list, empty, actions);

  const renderButton = (): void => renderSidebarButton(button, "list-tree", "워크스페이스", !aside.hidden, "workspace-aside");
  renderButton();
  const close = (): void => { aside.hidden = true; renderButton(); };
  button.addEventListener("click", () => { if (!aside.hidden) close(); else { aside.hidden = false; onOpen?.(); renderButton(); } });

  const showError = (error: unknown): void => { if (error instanceof WorkspaceStateError || typeof error === "string") { window.alert(error instanceof Error ? error.message : error); return; } throw error; };
  const render = (state: WorkspaceState): void => {
    const workspace = state.workspaces.find((item) => item.workspaceId === state.currentWorkspaceId);
    if (!workspace) return;
    workspaceLabel.textContent = `Workspace ${workspace.workspaceId}`;
    list.replaceChildren(); empty.hidden = workspace.vaultIds.length > 0;
    for (const vaultId of workspace.vaultIds) {
      const vault = state.vaults.find((item) => item.vaultId === vaultId); if (!vault) continue;
      const row = create("div", "workspace-vault-row"); row.setAttribute("role", "listitem"); row.dataset.vaultId = vault.vaultId;
      const select = create("button", "workspace-vault-select") as HTMLButtonElement; select.type = "button"; select.title = vault.rootPath; select.append(icon("folder"));
      const name = create("span", "workspace-vault-name"); name.textContent = vault.displayName; const path = create("span", "workspace-vault-path"); path.textContent = vault.rootPath; select.append(name, path);
      const tabList = create("div", "workspace-vault-tabs");
      const tabs = getTabs?.(vault.vaultId);
      if (tabs) for (const tab of tabs.tabs) {
        const tabEl = create("button", "workspace-vault-tab") as HTMLButtonElement; tabEl.type = "button"; tabEl.textContent = tab.path.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? tab.path; tabEl.dataset.tabId = tab.tabId; tabEl.title = tab.path;
        if (tab.tabId === tabs.activeTabId) tabEl.dataset.active = "true";
        tabEl.addEventListener("click", () => onSelectTab?.(vault, tab));
        tabList.append(tabEl);
      }
      select.setAttribute("aria-current", workspace.currentVaultId === vault.vaultId ? "true" : "false"); select.addEventListener("click", () => { try { onSelectVault(store.selectVault(vault.vaultId)); } catch (error) { showError(error); } });
      const rename = create("button", "workspace-vault-action") as HTMLButtonElement; rename.type = "button"; rename.title = "이름 변경"; rename.setAttribute("aria-label", `${vault.displayName} 이름 변경`); rename.append(icon("square-pen")); rename.addEventListener("click", () => { const next = promptForName(vault.displayName); if (next === null) return; try { store.renameVault(vault.vaultId, next); } catch (error) { showError(error); } });
      const remove = create("button", "workspace-vault-action") as HTMLButtonElement; remove.type = "button"; remove.title = "영구 해제"; remove.setAttribute("aria-label", `${vault.displayName} 영구 해제`); remove.append(icon("x")); remove.addEventListener("click", () => { if (!window.confirm("볼트를 워크스페이스에서 해제할까요? 파일과 폴더는 삭제되지 않습니다.")) return; try { store.unregisterVault(vault.vaultId); } catch (error) { showError(error); } });
      row.append(select, tabList, rename, remove); list.append(row);
    }
  };
  register.addEventListener("click", () => {
    const path = promptForPath();
    if (path === null || path.trim() === "") return;
    const register = async (): Promise<void> => {
      try {
        const canonical = canonicalizePath ? await canonicalizePath(path) : path;
        const vault = store.registerCanonicalVault(canonicalRootPath(canonical));
        onSelectVault(vault);
      } catch (error) { showError(error); }
    };
    void register();
  });
  store.subscribe(render); render(store.get());
  return { button, aside, close, refresh: () => render(store.get()) };
}
