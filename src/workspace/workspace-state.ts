import { normalizePath } from "../document/path";

export type PersistenceKind = "permanent" | "temporary";
export interface Vault { readonly vaultId: string; readonly workspaceId: string; readonly rootPath: string; readonly displayName: string; readonly persistenceKind: PersistenceKind; readonly explorerRoot: string | null; }
export interface Workspace { readonly workspaceId: string; readonly vaultIds: readonly string[]; readonly currentVaultId: string | null; readonly lastSelectedPermanentVaultId: string | null; }
export interface WorkspaceState { readonly workspaces: readonly Workspace[]; readonly vaults: readonly Vault[]; readonly sessionTemporaryVaults: readonly Vault[]; readonly currentWorkspaceId: string; }
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

const initialState = (): WorkspaceState => ({ workspaces: [{ workspaceId: DEFAULT_WORKSPACE_ID, vaultIds: [], currentVaultId: null, lastSelectedPermanentVaultId: null }], vaults: [], sessionTemporaryVaults: [], currentWorkspaceId: DEFAULT_WORKSPACE_ID });

const readState = (): WorkspaceState => {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return initialState();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return initialState();
    const candidate = parsed as Partial<WorkspaceState>;
    if (!Array.isArray(candidate.workspaces) || !Array.isArray(candidate.vaults) || typeof candidate.currentWorkspaceId !== "string") return initialState();
    const workspaces = candidate.workspaces.filter((value): value is Workspace => {
      if (typeof value !== "object" || value === null) return false;
      const item = value as Partial<Workspace>;
      return typeof item.workspaceId === "string" && Array.isArray(item.vaultIds) && item.vaultIds.every((id) => typeof id === "string") && (typeof item.currentVaultId === "string" || item.currentVaultId === null) && (typeof item.lastSelectedPermanentVaultId === "string" || item.lastSelectedPermanentVaultId === null || item.lastSelectedPermanentVaultId === undefined);
    }).map((workspace) => ({ ...workspace, lastSelectedPermanentVaultId: workspace.lastSelectedPermanentVaultId ?? workspace.currentVaultId }));
    const vaults = candidate.vaults.filter((value): value is Vault => {
      if (typeof value !== "object" || value === null) return false;
      const item = value as Partial<Vault>;
      return typeof item.vaultId === "string" && typeof item.workspaceId === "string" && typeof item.rootPath === "string" && typeof item.displayName === "string" && item.persistenceKind === "permanent";
    }).map((vault) => ({ ...vault, rootPath: canonicalRootPath(vault.rootPath), explorerRoot: canonicalRootPath(vault.rootPath) }));
    return workspaces.length > 0 && workspaces.some((w) => w.workspaceId === candidate.currentWorkspaceId) ? { workspaces, vaults, sessionTemporaryVaults: [], currentWorkspaceId: candidate.currentWorkspaceId } : initialState();
  } catch (error) { if (error instanceof SyntaxError) return initialState(); throw error; }
};

const saveState = (state: WorkspaceState): void => { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); };
const makeVaultId = (rootPath: string): string => `vault-${encodeURIComponent(rootPath)}`;

export class WorkspaceStore {
  private state: WorkspaceState;
  private readonly listeners = new Set<(state: WorkspaceState) => void>();
  constructor() { this.state = readState(); }
  get(): WorkspaceState { return this.state; }
  subscribe(listener: (state: WorkspaceState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  registerVault(rootPath: string, displayName = rootPath.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? rootPath): Vault {
    return this.registerCanonicalVault(canonicalRootPath(rootPath), displayName);
  }
  registerCanonicalVault(canonical: string, displayName = canonical.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? canonical): Vault {
    const workspace = this.currentWorkspace();
    if (workspace.vaultIds.some((id) => this.vaultById(id)?.rootPath === canonical)) throw new WorkspaceStateError("duplicate-root", `A vault is already registered for ${canonical}`);
    const vault: Vault = { vaultId: makeVaultId(canonical), workspaceId: workspace.workspaceId, rootPath: canonical, displayName: displayName.trim() || canonical, persistenceKind: "permanent", explorerRoot: canonical };
    const nextWorkspace = { ...workspace, vaultIds: [...workspace.vaultIds, vault.vaultId], currentVaultId: vault.vaultId, lastSelectedPermanentVaultId: vault.vaultId };
    this.commit({ ...this.state, workspaces: this.state.workspaces.map((item) => item.workspaceId === workspace.workspaceId ? nextWorkspace : item), vaults: [...this.state.vaults, vault] }); return vault;
  }
  createTemporaryVault(rootPath: string, displayName = rootPath.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? rootPath): Vault {
    const canonical = canonicalRootPath(rootPath); const workspace = this.currentWorkspace();
    const vault: Vault = { vaultId: `session-${crypto.randomUUID()}`, workspaceId: workspace.workspaceId, rootPath: canonical, displayName: displayName.trim() || canonical, persistenceKind: "temporary", explorerRoot: null };
    this.state = { ...this.state, sessionTemporaryVaults: [...this.state.sessionTemporaryVaults, vault] };
    for (const listener of this.listeners) listener(this.state);
    return vault;
  }
  selectVault(vaultId: string): Vault {
    const temporary = this.state.sessionTemporaryVaults.find((item) => item.vaultId === vaultId);
    if (temporary) return temporary;
    const vault = this.vaultById(vaultId); if (!vault || vault.persistenceKind !== "permanent" || vault.workspaceId !== this.currentWorkspace().workspaceId) throw new WorkspaceStateError("missing-vault", `Unknown vault: ${vaultId}`);
    this.commit({ ...this.state, workspaces: this.state.workspaces.map((item) => item.workspaceId === vault.workspaceId ? { ...item, currentVaultId: vaultId, lastSelectedPermanentVaultId: vaultId } : item) }); return vault;
  }
  renameVault(vaultId: string, displayName: string): Vault {
    const vault = this.vaultById(vaultId); if (!vault) throw new WorkspaceStateError("missing-vault", `Unknown vault: ${vaultId}`);
    const renamed = { ...vault, displayName: displayName.trim() || vault.displayName }; this.commit({ ...this.state, vaults: this.state.vaults.map((item) => item.vaultId === vaultId ? renamed : item) }); return renamed;
  }
  unregisterVault(vaultId: string): Vault {
    const vault = this.vaultById(vaultId); if (!vault || vault.persistenceKind !== "permanent") throw new WorkspaceStateError("missing-vault", `Unknown vault: ${vaultId}`); const workspace = this.currentWorkspace();
    const remaining = workspace.vaultIds.filter((id) => id !== vaultId); const nextSelected = workspace.lastSelectedPermanentVaultId === vaultId ? (remaining[remaining.length - 1] ?? null) : workspace.lastSelectedPermanentVaultId;
    const nextWorkspace = { ...workspace, vaultIds: remaining, currentVaultId: workspace.currentVaultId === vaultId ? nextSelected : workspace.currentVaultId, lastSelectedPermanentVaultId: nextSelected };
    this.commit({ ...this.state, workspaces: this.state.workspaces.map((item) => item.workspaceId === workspace.workspaceId ? nextWorkspace : item), vaults: this.state.vaults.filter((item) => item.vaultId !== vaultId) }); return vault;
  }
  private currentWorkspace(): Workspace { const workspace = this.state.workspaces.find((item) => item.workspaceId === this.state.currentWorkspaceId); if (!workspace) throw new WorkspaceStateError("missing-vault", `Unknown workspace: ${this.state.currentWorkspaceId}`); return workspace; }
  private vaultById(vaultId: string): Vault | undefined { return this.state.vaults.find((item) => item.vaultId === vaultId); }
  private commit(state: WorkspaceState): void {
    this.state = state;
    const persistentVaults = state.vaults.filter((vault) => vault.persistenceKind === "permanent");
    const persistentIds = new Set(persistentVaults.map((vault) => vault.vaultId));
    const persistentWorkspaces = state.workspaces.map((workspace) => {
      const vaultIds = workspace.vaultIds.filter((vaultId) => persistentIds.has(vaultId));
      const currentVaultId = workspace.currentVaultId && persistentIds.has(workspace.currentVaultId)
        ? workspace.currentVaultId
        : vaultIds[vaultIds.length - 1] ?? null;
      const lastSelectedPermanentVaultId = workspace.lastSelectedPermanentVaultId && persistentIds.has(workspace.lastSelectedPermanentVaultId)
        ? workspace.lastSelectedPermanentVaultId
        : currentVaultId;
      return { ...workspace, vaultIds, currentVaultId, lastSelectedPermanentVaultId };
    });
    saveState({ ...state, vaults: persistentVaults, workspaces: persistentWorkspaces, sessionTemporaryVaults: [] });
    for (const listener of this.listeners) listener(state);
  }
}
