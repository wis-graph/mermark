import { canonicalRootPath, type Vault, type WorkspaceState, WorkspaceStore } from "./workspace-state";

export type CliRouteKind = "permanent" | "temporary";

export interface CliRoute {
  readonly kind: CliRouteKind;
  readonly path: string;
  readonly vault: Vault;
}

const isWithinRoot = (path: string, root: string): boolean => {
  if (path === root) return true;
  return path.startsWith(`${root}/`) || path.startsWith(`${root}\\`);
};

const currentWorkspace = (state: WorkspaceState) =>
  state.workspaces.find((workspace) => workspace.workspaceId === state.currentWorkspaceId);

const permanentVaultForPath = (state: WorkspaceState, path: string): Vault | undefined => {
  const workspace = currentWorkspace(state);
  if (!workspace) return undefined;
  return state.vaults
    .filter((vault) => vault.workspaceId === workspace.workspaceId && vault.persistenceKind === "permanent")
    .filter((vault) => isWithinRoot(path, vault.rootPath))
    .sort((left, right) => right.rootPath.length - left.rootPath.length)[0];
};

export const routeCliFile = (store: WorkspaceStore, rawPath: string): CliRoute => {
  const path = canonicalRootPath(rawPath);
  return routeCanonicalPath(store, path);
};

const routeCanonicalPath = (store: WorkspaceStore, path: string): CliRoute => {
  const canonical = canonicalRootPath(path);
  const permanent = permanentVaultForPath(store.get(), canonical);
  if (permanent) {
    const vault = store.selectVault(permanent.vaultId);
    return { kind: "permanent", path: canonical, vault };
  }
  return { kind: "temporary", path: canonical, vault: store.createTemporaryVault(canonical) };
};

export const routeCliFileResolved = async (store: WorkspaceStore, rawPath: string, resolvePath: (path: string) => Promise<string>): Promise<CliRoute> => {
  let resolvedPath: string;
  try {
    resolvedPath = await resolvePath(rawPath);
  } catch (error) {
    if (error instanceof Error || typeof error === "string") resolvedPath = rawPath;
    else throw error;
  }
  return routeCanonicalPath(store, resolvedPath);
};
