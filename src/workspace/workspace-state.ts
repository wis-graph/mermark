import { normalizePath } from "../document/path";

export const GLOBAL_VAULT_ID = "vault-global";
export const GLOBAL_VAULT_NAME = "글로벌 볼트";

export type PersistenceKind = "permanent" | "global" | "remote";
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
export interface RemoteVault extends VaultBase {
  readonly rootPath: null;
  readonly persistenceKind: "remote";
  readonly explorerRoot: string;
  /** `wis-macmini` 또는 `wis-macmini:9000` 또는 `ssh://user@host`. */
  readonly host: string;
  /** 호스트가 공유 목록에서 이 볼트에 붙인 안정 id. */
  readonly remoteVaultId: string;
}
export type Vault = PermanentVault | GlobalVault | RemoteVault;
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

/** Whether any *remaining* remote vault is still registered against `host`
 *  — the SSH tunnel for a host (`remote_ssh.rs`, Task 12) is per-HOST, not
 *  per-vault: `registerRemoteVault` above dedupes on `(host, remoteVaultId)`
 *  only, so two vaults from the same host's share list CAN legitimately
 *  coexist. Fix round 2, Important B: removing one must not tear the
 *  tunnel down while a sibling vault on the same host is still registered
 *  (the caller checks this *after* the removal it's guarding, against
 *  `vaults` post-removal — see workspace-sidebar.ts's remote "해제" button). */
export const anyVaultStillUsesHost = (vaults: readonly Vault[], host: string): boolean =>
  vaults.some((v) => v.persistenceKind === "remote" && v.host === host);

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
    // Permanent and remote are the two persisted kinds (global is
    // runtime-only, see globalVaultForWorkspace — it's never in this array to
    // begin with). A remote vault has no rootPath (`null`, unlike a
    // permanent's string), so the guard can't reuse the permanent branch's
    // `typeof rootPath === "string"` check — it must recognize the shape by
    // `persistenceKind` first, THEN validate the fields that kind actually
    // carries (Ruling 21).
    const vaults = candidate.vaults.flatMap((value): Vault[] => {
      if (typeof value !== "object" || value === null) return [];
      const item = value as Record<string, unknown>;
      if (typeof item.vaultId !== "string" || typeof item.workspaceId !== "string" || typeof item.displayName !== "string") return [];
      if (item.persistenceKind === "permanent" && typeof item.rootPath === "string") {
        return [{ vaultId: item.vaultId, workspaceId: item.workspaceId, displayName: item.displayName, persistenceKind: "permanent", rootPath: canonicalRootPath(item.rootPath), explorerRoot: canonicalRootPath(item.rootPath) }];
      }
      if (item.persistenceKind === "remote" && typeof item.host === "string" && typeof item.remoteVaultId === "string") {
        return [{ vaultId: item.vaultId, workspaceId: item.workspaceId, displayName: item.displayName, persistenceKind: "remote", rootPath: null, explorerRoot: "/", host: item.host, remoteVaultId: item.remoteVaultId }];
      }
      return [];
    });
    const validVaultIds = new Set(vaults.map((vault) => vault.vaultId));
    // Only permanent vaults may ever populate lastSelectedPermanentVaultId
    // (its name is the contract) — the fallback below must pick among THESE,
    // never among validVaultIds at large, or a reload whose last registered
    // vault happens to be remote would launder a remote id into this field.
    const validPermanentVaultIds = new Set(vaults.filter((vault) => vault.persistenceKind === "permanent").map((vault) => vault.vaultId));
    const workspaces = candidate.workspaces.filter((value): value is Workspace => {
      if (typeof value !== "object" || value === null) return false;
      const item = value as Partial<Workspace>;
      return typeof item.workspaceId === "string" && Array.isArray(item.vaultIds) && item.vaultIds.every((id) => typeof id === "string") && (typeof item.currentVaultId === "string" || item.currentVaultId === null) && (typeof item.lastSelectedPermanentVaultId === "string" || item.lastSelectedPermanentVaultId === null || item.lastSelectedPermanentVaultId === undefined);
    }).map((workspace) => {
      const vaultIds = workspace.vaultIds.filter((vaultId) => validVaultIds.has(vaultId));
      const lastSelectedPermanentVaultId = workspace.lastSelectedPermanentVaultId && validPermanentVaultIds.has(workspace.lastSelectedPermanentVaultId)
        ? workspace.lastSelectedPermanentVaultId
        : [...vaultIds].reverse().find((id) => validPermanentVaultIds.has(id)) ?? null;
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

/** The two kinds this store persists to localStorage across restarts (Ruling
 *  21 — global is runtime-only and never reaches `state.vaults` to begin
 *  with, see `globalVaultForWorkspace`). Every place that used to hardcode
 *  `persistenceKind === "permanent"` as a stand-in for "is this vault
 *  persisted" now goes through this one predicate, so remote joining the
 *  persisted tier only needed a change HERE, not at each call site. */
const isPersistedVaultKind = (kind: PersistenceKind): boolean => kind === "permanent" || kind === "remote";
const makeRemoteVaultId = (host: string, remoteVaultId: string): string => `vault-remote-${encodeURIComponent(host)}-${encodeURIComponent(remoteVaultId)}`;

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
  /** Registers a paired remote vault (Task 10) — the client-side counterpart
   *  of a permanent registration, except there is no local `rootPath` to
   *  canonicalize: identity is `(host, remoteVaultId)`, the pair the host
   *  itself hands back from `remote_vaults`. Deliberately does NOT touch
   *  `lastSelectedPermanentVaultId` (unlike `registerCanonicalVault` above) —
   *  that field's name is load-bearing: only a PERMANENT selection may write
   *  it (selectVault mirrors this), so a freshly-paired remote vault becomes
   *  current without being remembered as "the" vault to restore to after a
   *  global excursion. */
  registerRemoteVault(host: string, remoteVaultId: string, displayName: string): Vault {
    const workspace = this.currentWorkspace();
    if (workspace.vaultIds.some((id) => { const v = this.vaultById(id); return v?.persistenceKind === "remote" && v.host === host && v.remoteVaultId === remoteVaultId; }))
      throw new WorkspaceStateError("duplicate-root", `A vault is already registered for ${host}/${remoteVaultId}`);
    const vault: Vault = { vaultId: makeRemoteVaultId(host, remoteVaultId), workspaceId: workspace.workspaceId, rootPath: null, displayName: displayName.trim() || remoteVaultId, persistenceKind: "remote", explorerRoot: "/", host, remoteVaultId };
    const nextWorkspace = { ...workspace, vaultIds: [...workspace.vaultIds, vault.vaultId], currentVaultId: vault.vaultId };
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
    if (!vault || !isPersistedVaultKind(vault.persistenceKind) || vault.workspaceId !== workspace.workspaceId) throw new WorkspaceStateError("missing-vault", `Unknown vault: ${vaultId}`);
    // Only a PERMANENT selection writes lastSelectedPermanentVaultId — that
    // field is specifically "the permanent vault to return to after a global
    // excursion" (see its declaration site), so a remote selection must not
    // overwrite it, exactly like the pre-existing global branch above never did.
    const touchesLastSelected = vault.persistenceKind === "permanent";
    if (selectionIsNoop(workspace, vaultId, touchesLastSelected)) return vault;
    const nextWorkspace = touchesLastSelected
      ? { ...workspace, currentVaultId: vaultId, lastSelectedPermanentVaultId: vaultId }
      : { ...workspace, currentVaultId: vaultId };
    this.commit({ ...this.state, workspaces: this.state.workspaces.map((item) => item.workspaceId === vault.workspaceId ? nextWorkspace : item) });
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
    if (!vault || !isPersistedVaultKind(vault.persistenceKind)) throw new WorkspaceStateError("missing-vault", `Unknown vault: ${vaultId}`);
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
    // persistentIds: BOTH persisted kinds (permanent + remote) — a vaultIds
    // entry or currentVaultId pointing at either must survive the save.
    // permanentIds: PERMANENT ONLY — lastSelectedPermanentVaultId's own name
    // is the contract (selectVault never lets a remote selection write it),
    // so its persisted-side repair must not launder a remote id into it via
    // the `: currentVaultId` fallback below.
    const persistentIds = new Set(state.vaults.filter((vault) => isPersistedVaultKind(vault.persistenceKind)).map((vault) => vault.vaultId));
    const permanentIds = new Set(state.vaults.filter((vault) => vault.persistenceKind === "permanent").map((vault) => vault.vaultId));
    const persistentWorkspaces = state.workspaces.map((workspace) => {
      const vaultIds = workspace.vaultIds.filter((vaultId) => persistentIds.has(vaultId));
      const currentVaultId = workspace.currentVaultId && persistentIds.has(workspace.currentVaultId)
        ? workspace.currentVaultId
        : workspace.lastSelectedPermanentVaultId && permanentIds.has(workspace.lastSelectedPermanentVaultId)
          ? workspace.lastSelectedPermanentVaultId
          : vaultIds[vaultIds.length - 1] ?? null;
      const lastSelectedPermanentVaultId = workspace.lastSelectedPermanentVaultId && permanentIds.has(workspace.lastSelectedPermanentVaultId)
        ? workspace.lastSelectedPermanentVaultId
        : (currentVaultId && permanentIds.has(currentVaultId) ? currentVaultId : null);
      return { ...workspace, vaultIds, currentVaultId, lastSelectedPermanentVaultId };
    });
    saveState({ ...state, vaults: state.vaults.filter((vault) => isPersistedVaultKind(vault.persistenceKind)), workspaces: persistentWorkspaces });
    this.notify();
  }
  private notify(): void { for (const listener of this.listeners) listener(this.state); }
}
