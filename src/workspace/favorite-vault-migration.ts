import { basename, dirOf, normalizePath } from "../document/path";
import type { Vault, WorkspaceStore } from "./workspace-state";

export const favoriteVaultMigrationKey = "mermark.favoriteFoldersVaultMigration.v1";
export const favoriteVaultMigrationStateKey = "mermark.favoriteFoldersVaultMigration.state.v1";
export const favoriteFoldersStorageKey = "mermark.favoriteFolders";

export const shouldMigrateLegacyFavorites = (hasStoredFavorites: boolean, migrationCompleted: boolean): boolean =>
  hasStoredFavorites && !migrationCompleted;

export const readLegacyFavoriteFolders = (): readonly string[] => {
  const raw = localStorage.getItem(favoriteFoldersStorageKey);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
};

const clearLegacyFavoriteFolders = (): void => {
  localStorage.removeItem(favoriteFoldersStorageKey);
};

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
type CanonicalizeInvocation = (path: string) => Promise<unknown>;

export const canonicalizeLegacyFavoriteFolder = async (
  invokeCanonicalize: CanonicalizeInvocation,
  path: string,
): Promise<string | null> => {
  const resolved = await invokeCanonicalize(path);
  return typeof resolved === "string" ? resolved : null;
};

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
  if (state.completed) localStorage.setItem(favoriteVaultMigrationKey, "1");
  else localStorage.removeItem(favoriteVaultMigrationKey);
};

const saveLegacyFavoriteFolders = (folders: readonly string[]): void => {
  if (folders.length === 0) localStorage.removeItem(favoriteFoldersStorageKey);
  else localStorage.setItem(favoriteFoldersStorageKey, JSON.stringify(folders));
};

export async function migrateFavoriteFoldersToVaults(
  store: WorkspaceStore,
  favoriteFolders: readonly string[],
  pathExists: PathExists,
  canonicalize: CanonicalizePath = async (path) => normalizePath(path),
): Promise<FavoriteVaultMigrationResult> {
  const migrationState = readMigrationState();
  const skipped = new Set(migrationState.excludedPaths);
  const mergedPaths = new Set(migrationState.mergedPaths);
  const mapping = { ...migrationState.canonicalPathToVaultId };
  const unresolvedFolders: string[] = [];
  let transientFailure = false;
  const current = store.get();
  const workspace = current.workspaces.find((item) => item.workspaceId === current.currentWorkspaceId);
  const workspaceVaults = current.vaults.filter((vault) => vault.workspaceId === current.currentWorkspaceId);
  const usedNames = new Set(workspaceVaults.map((vault) => vault.displayName));
  const migrated: Vault[] = [];

  for (const rawFolder of favoriteFolders) {
    let folder: string | null;
    try {
      folder = await canonicalize(rawFolder);
    } catch (error) {
      if (error instanceof Error || typeof error === "string") {
        transientFailure = true;
        unresolvedFolders.push(rawFolder);
        continue;
      }
      else throw error;
    }
    if (folder === null) {
      skipped.add(normalizePath(rawFolder));
      continue;
    }
    const canonical = normalizePath(folder);
    if (Object.prototype.hasOwnProperty.call(mapping, canonical)) {
      mergedPaths.add(canonical);
      continue;
    }
    let exists: boolean;
    try {
      exists = await pathExists(canonical);
    } catch (error) {
      if (error instanceof Error || typeof error === "string") {
        transientFailure = true;
        unresolvedFolders.push(rawFolder);
        continue;
      }
      else throw error;
    }
    if (!exists) {
      skipped.add(canonical);
      continue;
    }
    const existing = store.get().vaults.find(
      (vault) => vault.workspaceId === current.currentWorkspaceId && vault.persistenceKind === "permanent" && normalizePath(vault.rootPath) === canonical,
    );
    if (existing) {
      mapping[canonical] = existing.vaultId;
      mergedPaths.add(canonical);
      continue;
    }
    if (migrationState.completed) continue;
    if (!workspace) {
      transientFailure = true;
      unresolvedFolders.push(rawFolder);
      continue;
    }
    const displayName = uniqueDisplayName(canonical, usedNames);
    const vault = store.registerVault(canonical, displayName);
    migrated.push(vault);
    mapping[canonical] = vault.vaultId;
    usedNames.add(displayName);
  }

  const completed = !transientFailure;
  saveMigrationState({
    migrationVersion: 1,
    completed,
    canonicalPathToVaultId: mapping,
    excludedPaths: [...skipped],
    mergedPaths: [...mergedPaths],
  });
  if (completed) clearLegacyFavoriteFolders();
  else saveLegacyFavoriteFolders(unresolvedFolders);
  return { migrated, skipped: [...skipped] };
}
