import { basename, dirOf, normalizePath } from "../document/path";
import type { Vault, WorkspaceStore } from "./workspace-state";

export const favoriteVaultMigrationKey = "mermark.favoriteFoldersVaultMigration.v1";
export const favoriteVaultMigrationStateKey = "mermark.favoriteFoldersVaultMigration.state.v1";
export const favoriteFoldersStorageKey = "mermark.favoriteFolders";
export const defaultFavoriteInitializationKey = "mermark.favoriteFolders.defaults.v1";

export const shouldMigrateLegacyFavorites = (hasStoredFavorites: boolean, defaultsInitialized: boolean): boolean =>
  hasStoredFavorites && !defaultsInitialized;

export interface FavoriteVaultMigrationState {
  readonly migrationVersion: 1;
  readonly completed: boolean;
  readonly canonicalPathToVaultId: Readonly<Record<string, string>>;
  readonly excludedPaths: readonly string[];
  readonly mergedPaths: readonly string[];
}

export interface FavoriteVaultMigrationResult {
  readonly migrated: readonly Vault[];
  readonly skipped: readonly string[];
}

type PathExists = (canonicalPath: string) => Promise<boolean>;
type CanonicalizePath = (path: string) => Promise<string | null>;

const parentSegments = (path: string): readonly string[] => {
  const segments: string[] = [];
  let current = dirOf(path);
  while (current !== "") {
    const name = basename(current);
    if (name !== "") segments.push(name);
    const next = dirOf(current);
    if (next === current) break;
    current = next;
  }
  return segments;
};

const uniqueDisplayName = (rootPath: string, usedNames: ReadonlySet<string>): string => {
  const base = basename(rootPath) || rootPath;
  if (!usedNames.has(base)) return base;
  const parents = parentSegments(rootPath);
  for (let count = 1; count <= parents.length; count += 1) {
    const candidate = `${parents.slice(0, count).reverse().join(" / ")} / ${base}`;
    if (!usedNames.has(candidate)) return candidate;
  }
  let suffix = 2;
  while (usedNames.has(`${base} (${suffix})`)) suffix += 1;
  return `${base} (${suffix})`;
};

const initialMigrationState = (): FavoriteVaultMigrationState => ({
  migrationVersion: 1,
  completed: false,
  canonicalPathToVaultId: {},
  excludedPaths: [],
  mergedPaths: [],
});

const readMigrationState = (): FavoriteVaultMigrationState => {
  const raw = localStorage.getItem(favoriteVaultMigrationStateKey);
  if (!raw) return initialMigrationState();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return initialMigrationState();
    const candidate = parsed as Partial<FavoriteVaultMigrationState>;
    const mapping = candidate.canonicalPathToVaultId;
    if (candidate.migrationVersion !== 1 || typeof candidate.completed !== "boolean" || typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) return initialMigrationState();
    const canonicalPathToVaultId: Record<string, string> = {};
    for (const [path, vaultId] of Object.entries(mapping)) {
      if (typeof vaultId === "string") canonicalPathToVaultId[path] = vaultId;
    }
    const excludedPaths = Array.isArray(candidate.excludedPaths) ? candidate.excludedPaths.filter((path): path is string => typeof path === "string") : [];
    const mergedPaths = Array.isArray(candidate.mergedPaths) ? candidate.mergedPaths.filter((path): path is string => typeof path === "string") : [];
    return { migrationVersion: 1, completed: candidate.completed, canonicalPathToVaultId, excludedPaths, mergedPaths };
  } catch (error) {
    if (error instanceof SyntaxError) return initialMigrationState();
    throw error;
  }
};

const saveMigrationState = (state: FavoriteVaultMigrationState): void => {
  localStorage.setItem(favoriteVaultMigrationStateKey, JSON.stringify(state));
  localStorage.setItem(favoriteVaultMigrationKey, "1");
};

export async function migrateFavoriteFoldersToVaults(
  store: WorkspaceStore,
  favoriteFolders: readonly string[],
  pathExists: PathExists,
  canonicalize: CanonicalizePath = async (path) => normalizePath(path),
): Promise<FavoriteVaultMigrationResult> {
  const migrationState = readMigrationState();
  const canonicalFolders: string[] = [];
  const existingFolders: string[] = [];
  const skipped = [...migrationState.excludedPaths];
  const mergedPaths = new Set(migrationState.mergedPaths);
  const mapping = { ...migrationState.canonicalPathToVaultId };
  let transientFailure = false;
  for (const rawFolder of favoriteFolders) {
    let folder: string | null;
    try {
      folder = await canonicalize(rawFolder);
    } catch (error) {
      if (error instanceof Error || typeof error === "string") {
        transientFailure = true;
        folder = null;
      }
      else throw error;
    }
    if (folder === null) {
      skipped.push(normalizePath(rawFolder));
      continue;
    }
    const canonical = normalizePath(folder);
    if (canonicalFolders.includes(canonical)) {
      mergedPaths.add(canonical);
      continue;
    }
    canonicalFolders.push(canonical);
    try {
      if (await pathExists(canonical)) existingFolders.push(canonical);
      else skipped.push(canonical);
    } catch (error) {
      if (error instanceof Error || typeof error === "string") {
        transientFailure = true;
        skipped.push(canonical);
      }
      else throw error;
    }
  }

  const current = store.get();
  const workspace = current.workspaces.find((item) => item.workspaceId === current.currentWorkspaceId);
  const workspaceVaults = current.vaults.filter((vault) => vault.workspaceId === current.currentWorkspaceId);
  const knownRoots = new Set(workspaceVaults.map((vault) => vault.rootPath));
  const usedNames = new Set(workspaceVaults.map((vault) => vault.displayName));
  const migrated: Vault[] = [];

  for (const folder of existingFolders) {
    const existing = workspaceVaults.find((vault) => vault.rootPath === folder);
    if (existing) {
      mapping[folder] = existing.vaultId;
      mergedPaths.add(folder);
      continue;
    }
    if (migrationState.completed) continue;
    if (!workspace) break;
    const displayName = uniqueDisplayName(folder, usedNames);
    const vault = store.registerVault(folder, displayName);
    migrated.push(vault);
    mapping[folder] = vault.vaultId;
    knownRoots.add(folder);
    usedNames.add(displayName);
  }

  if (!transientFailure) {
    saveMigrationState({
      migrationVersion: 1,
      completed: true,
      canonicalPathToVaultId: mapping,
      excludedPaths: [...new Set(skipped)],
      mergedPaths: [...mergedPaths],
    });
  }
  return { migrated, skipped };
}
