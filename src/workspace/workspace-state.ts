import { normalizePath } from "../document/path";

export const GLOBAL_VAULT_ID = "vault-global";
export const GLOBAL_VAULT_NAME = "글로벌 볼트";

export type PersistenceKind = "permanent" | "global";
interface VaultBase {
  readonly vaultId: string;
  readonly workspaceId: string;
  readonly displayName: string;
}
export interface PermanentVault extends VaultBase {
  readonly rootPath: string;
  readonly persistenceKind: "permanent";
  readonly explorerRoot: string;
}
export interface GlobalVault extends VaultBase {
  readonly rootPath: null;
  readonly persistenceKind: "global";
  readonly explorerRoot: string | null;
}
export type Vault = PermanentVault | GlobalVault;
export interface Workspace { readonly workspaceId: string; readonly vaultIds: readonly string[]; readonly currentVaultId: string | null; readonly lastSelectedPermanentVaultId: string | null; }
export interface WorkspaceState { readonly workspaces: readonly Workspace[]; readonly vaults: readonly Vault[]; readonly currentWorkspaceId: string; }
export type WorkspaceStateErrorCode = "duplicate-root" | "missing-vault" | "invalid-path";

export class WorkspaceStateError extends Error {
  readonly code: WorkspaceStateErrorCode;
  constructor(code: WorkspaceStateErrorCode, message: string) { super(message); this.name = "WorkspaceStateError"; this.code = code; }
}

const STORAGE_KEY = "mermark.workspaceState";
const DEFAULT_WORKSPACE_ID = "workspace-default";
export const workspaceStorageKey = STORAGE_KEY;
export const canonicalRootPath = (path: string): string => normalizePath(path);
export const canonicalPath = canonicalRootPath;

export const globalVaultForWorkspace = (workspaceId: string): Vault => ({
  vaultId: GLOBAL_VAULT_ID,
  workspaceId,
  rootPath: null,
  displayName: GLOBAL_VAULT_NAME,
  persistenceKind: "global",
  explorerRoot: null,
});

const initialState = (): WorkspaceState => ({
  workspaces: [{ workspaceId: DEFAULT_WORKSPACE_ID, vaultIds: [], currentVaultId: GLOBAL_VAULT_ID, lastSelectedPermanentVaultId: null }],
  vaults: [],
  currentWorkspaceId: DEFAULT_WORKSPACE_ID,
});

const readState = (): WorkspaceState => {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return initialState();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return initialState();
    const candidate = parsed as Partial<WorkspaceState>;
    if (!Array.isArray(candidate.workspaces) || !Array.isArray(candidate.vaults) || typeof candidate.currentWorkspaceId !== "string") return initialState();
    const vaults = candidate.vaults.filter((value): value is PermanentVault => {
      if (typeof value !== "object" || value === null) return false;
      const item = value as Partial<Vault>;
      return typeof item.vaultId === "string" && typeof item.workspaceId === "string" && typeof item.rootPath === "string" && typeof item.displayName === "string" && item.persistenceKind === "permanent";
    }).map((vault) => ({ ...vault, rootPath: canonicalRootPath(vault.rootPath), explorerRoot: canonicalRootPath(vault.rootPath) }));
    const validVaultIds = new Set(vaults.map((vault) => vault.vaultId));
    const workspaces = candidate.workspaces.filter((value): value is Workspace => {
      if (typeof value !== "object" || value === null) return false;
      const item = value as Partial<Workspace>;
      return typeof item.workspaceId === "string" && Array.isArray(item.vaultIds) && item.vaultIds.every((id) => typeof id === "string") && (typeof item.currentVaultId === "string" || item.currentVaultId === null) && (typeof item.lastSelectedPermanentVaultId === "string" || item.lastSelectedPermanentVaultId === null || item.lastSelectedPermanentVaultId === undefined);
    }).map((workspace) => {
      const vaultIds = workspace.vaultIds.filter((vaultId) => validVaultIds.has(vaultId));
      const lastSelectedPermanentVaultId = workspace.lastSelectedPermanentVaultId && validVaultIds.has(workspace.lastSelectedPermanentVaultId)
        ? workspace.lastSelectedPermanentVaultId
        : vaultIds[vaultIds.length - 1] ?? null;
      const currentVaultId = workspace.currentVaultId === GLOBAL_VAULT_ID
        ? GLOBAL_VAULT_ID
        : workspace.currentVaultId && validVaultIds.has(workspace.currentVaultId)
          ? workspace.currentVaultId
          : lastSelectedPermanentVaultId ?? GLOBAL_VAULT_ID;
      return { ...workspace, vaultIds, currentVaultId, lastSelectedPermanentVaultId };
    });
    return workspaces.length > 0 && workspaces.some((workspace) => workspace.workspaceId === candidate.currentWorkspaceId)
      ? { workspaces, vaults, currentWorkspaceId: candidate.currentWorkspaceId }
      : initialState();
  } catch (error) { if (error instanceof SyntaxError) return initialState(); throw error; }
};

const saveState = (state: WorkspaceState): void => { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); };
const makeVaultId = (rootPath: string): string => `vault-${encodeURIComponent(rootPath)}`;

/** True when selecting `vaultId` would leave every field that selection WRITES
 *  unchanged — i.e. the commit selectVault is about to make is a genuine
 *  no-op. Global selection only ever writes currentVaultId; permanent
 *  selection writes both currentVaultId AND lastSelectedPermanentVaultId, so
 *  a permanent reselect must check both — a state where currentVaultId
 *  already matches but lastSelectedPermanentVaultId drifted (restored state,
 *  or a permanent -> global -> same-permanent round trip) is NOT a no-op and
 *  must still commit to repair the drift. */
const selectionIsNoop = (workspace: Workspace, vaultId: string, touchesLastSelected: boolean): boolean =>
  workspace.currentVaultId === vaultId && (!touchesLastSelected || workspace.lastSelectedPermanentVaultId === vaultId);

export class WorkspaceStore {
  private state: WorkspaceState;
  private readonly listeners = new Set<(state: WorkspaceState) => void>();
  constructor() { this.state = readState(); }
  get(): WorkspaceState { return this.state; }
  getGlobalVault(): Vault { return globalVaultForWorkspace(this.state.currentWorkspaceId); }
  getVault(vaultId: string): Vault | undefined { return vaultId === GLOBAL_VAULT_ID ? this.getGlobalVault() : this.vaultById(vaultId); }
  subscribe(listener: (state: WorkspaceState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  registerVault(rootPath: string, displayName = rootPath.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? rootPath): Vault {
    return this.registerCanonicalVault(canonicalRootPath(rootPath), displayName);
  }
  registerCanonicalVault(canonical: string, displayName = canonical.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? canonical): Vault {
    const workspace = this.currentWorkspace();
    if (workspace.vaultIds.some((id) => this.vaultById(id)?.rootPath === canonical)) throw new WorkspaceStateError("duplicate-root", `A vault is already registered for ${canonical}`);
    const vault: Vault = { vaultId: makeVaultId(canonical), workspaceId: workspace.workspaceId, rootPath: canonical, displayName: displayName.trim() || canonical, persistenceKind: "permanent", explorerRoot: canonical };
    const nextWorkspace = { ...workspace, vaultIds: [...workspace.vaultIds, vault.vaultId], currentVaultId: vault.vaultId, lastSelectedPermanentVaultId: vault.vaultId };
    this.commit({ ...this.state, workspaces: this.state.workspaces.map((item) => item.workspaceId === workspace.workspaceId ? nextWorkspace : item), vaults: [...this.state.vaults, vault] });
    return vault;
  }
  selectVault(vaultId: string): Vault {
    const workspace = this.currentWorkspace();
    if (vaultId === GLOBAL_VAULT_ID) {
      const global = this.getGlobalVault();
      if (selectionIsNoop(workspace, GLOBAL_VAULT_ID, false)) return global;
      this.state = { ...this.state, workspaces: this.state.workspaces.map((item) => item.workspaceId === workspace.workspaceId ? { ...item, currentVaultId: GLOBAL_VAULT_ID } : item) };
      this.notify();
      return global;
    }
    const vault = this.vaultById(vaultId);
    if (!vault || vault.persistenceKind !== "permanent" || vault.workspaceId !== workspace.workspaceId) throw new WorkspaceStateError("missing-vault", `Unknown vault: ${vaultId}`);
    if (selectionIsNoop(workspace, vaultId, true)) return vault;
    this.commit({ ...this.state, workspaces: this.state.workspaces.map((item) => item.workspaceId === vault.workspaceId ? { ...item, currentVaultId: vaultId, lastSelectedPermanentVaultId: vaultId } : item) });
    return vault;
  }
  renameVault(vaultId: string, displayName: string): Vault {
    const vault = this.vaultById(vaultId);
    if (!vault) throw new WorkspaceStateError("missing-vault", `Unknown vault: ${vaultId}`);
    const renamed = { ...vault, displayName: displayName.trim() || vault.displayName };
    this.commit({ ...this.state, vaults: this.state.vaults.map((item) => item.vaultId === vaultId ? renamed : item) });
    return renamed;
  }
  unregisterVault(vaultId: string): Vault {
    const vault = this.vaultById(vaultId);
    if (!vault || vault.persistenceKind !== "permanent") throw new WorkspaceStateError("missing-vault", `Unknown vault: ${vaultId}`);
    const workspace = this.currentWorkspace();
    const remaining = workspace.vaultIds.filter((id) => id !== vaultId);
    const nextSelected = workspace.lastSelectedPermanentVaultId === vaultId ? (remaining[remaining.length - 1] ?? null) : workspace.lastSelectedPermanentVaultId;
    const nextCurrent = workspace.currentVaultId === vaultId ? nextSelected ?? GLOBAL_VAULT_ID : workspace.currentVaultId;
    const nextWorkspace = { ...workspace, vaultIds: remaining, currentVaultId: nextCurrent, lastSelectedPermanentVaultId: nextSelected };
    this.commit({ ...this.state, workspaces: this.state.workspaces.map((item) => item.workspaceId === workspace.workspaceId ? nextWorkspace : item), vaults: this.state.vaults.filter((item) => item.vaultId !== vaultId) });
    return vault;
  }
  private currentWorkspace(): Workspace { const workspace = this.state.workspaces.find((item) => item.workspaceId === this.state.currentWorkspaceId); if (!workspace) throw new WorkspaceStateError("missing-vault", `Unknown workspace: ${this.state.currentWorkspaceId}`); return workspace; }
  private vaultById(vaultId: string): Vault | undefined { return this.state.vaults.find((item) => item.vaultId === vaultId); }
  private commit(state: WorkspaceState): void {
    this.state = state;
    const persistentIds = new Set(state.vaults.filter((vault) => vault.persistenceKind === "permanent").map((vault) => vault.vaultId));
    const persistentWorkspaces = state.workspaces.map((workspace) => {
      const vaultIds = workspace.vaultIds.filter((vaultId) => persistentIds.has(vaultId));
      const currentVaultId = workspace.currentVaultId && persistentIds.has(workspace.currentVaultId)
        ? workspace.currentVaultId
        : workspace.lastSelectedPermanentVaultId && persistentIds.has(workspace.lastSelectedPermanentVaultId)
          ? workspace.lastSelectedPermanentVaultId
          : vaultIds[vaultIds.length - 1] ?? null;
      const lastSelectedPermanentVaultId = workspace.lastSelectedPermanentVaultId && persistentIds.has(workspace.lastSelectedPermanentVaultId)
        ? workspace.lastSelectedPermanentVaultId
        : currentVaultId;
      return { ...workspace, vaultIds, currentVaultId, lastSelectedPermanentVaultId };
    });
    saveState({ ...state, vaults: state.vaults.filter((vault) => vault.persistenceKind === "permanent"), workspaces: persistentWorkspaces });
    this.notify();
  }
  private notify(): void { for (const listener of this.listeners) listener(this.state); }
}
