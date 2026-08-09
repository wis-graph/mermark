import { beforeEach, describe, expect, it } from "vitest";
import { WorkspaceStore } from "../src/workspace/workspace-state";
import {
  defaultFavoriteInitializationKey,
  favoriteVaultMigrationKey,
  favoriteVaultMigrationStateKey,
  migrateFavoriteFoldersToVaults,
  shouldMigrateLegacyFavorites,
} from "../src/workspace/favorite-vault-migration";

describe("favorite folder vault migration", () => {
  beforeEach(() => localStorage.clear());

  it("migrates only existing canonical folders and ignores missing folders", async () => {
    const store = new WorkspaceStore();
    const result = await migrateFavoriteFoldersToVaults(store, ["/notes/./project/", "/gone"], async (path) => path === "/notes/project");

    expect(result.migrated.map((vault) => vault.rootPath)).toEqual(["/notes/project"]);
    expect(result.skipped).toEqual(["/gone"]);
    expect(store.get().vaults.map((vault) => vault.rootPath)).toEqual(["/notes/project"]);
  });

  it("adds parent context when favorite folder names collide", async () => {
    const store = new WorkspaceStore();
    const result = await migrateFavoriteFoldersToVaults(store, ["/team/a/docs", "/team/b/docs"], async () => true);

    expect(result.migrated.map((vault) => vault.displayName)).toEqual(["docs", "b / docs"]);
  });

  it("is idempotent and preserves the same vault set on rerun", async () => {
    const store = new WorkspaceStore();
    const exists = async () => true;
    await migrateFavoriteFoldersToVaults(store, ["/a", "/a/./"], exists);
    const second = await migrateFavoriteFoldersToVaults(store, ["/a", "/a/./"], exists);

    expect(second.migrated).toEqual([]);
    expect(store.get().vaults).toHaveLength(1);
    expect(localStorage.getItem(favoriteVaultMigrationKey)).toBe("1");
  });

  it("does not duplicate a canonical root that was registered before migration", async () => {
    const store = new WorkspaceStore();
    const existing = store.registerVault("/notes/./project", "Project");
    const result = await migrateFavoriteFoldersToVaults(store, ["/notes/project"], async () => true);

    expect(result.migrated).toEqual([]);
    expect(store.get().vaults).toEqual([existing]);
  });

  it("records a failed filesystem check as skipped without aborting boot", async () => {
    const store = new WorkspaceStore();
    const result = await migrateFavoriteFoldersToVaults(store, ["/a"], async () => { throw new Error("offline"); });
    expect(result.skipped).toEqual(["/a"]);
    expect(localStorage.getItem(favoriteVaultMigrationKey)).toBeNull();
  });

  it("skips a string rejection from native path checks without aborting migration", async () => {
    const store = new WorkspaceStore();

    const result = await migrateFavoriteFoldersToVaults(store, ["/missing"], async () => {
      throw "folder is unavailable";
    });

    expect(result.migrated).toEqual([]);
    expect(result.skipped).toEqual(["/missing"]);
    expect(localStorage.getItem(favoriteVaultMigrationKey)).toBeNull();
  });

  it("retries a legacy favorite after a transient canonicalization failure", async () => {
    const store = new WorkspaceStore();
    let attempts = 0;
    const canonicalize = async (): Promise<string> => {
      attempts += 1;
      if (attempts === 1) throw new Error("filesystem temporarily unavailable");
      return "/notes";
    };

    const first = await migrateFavoriteFoldersToVaults(store, ["/notes"], async () => true, canonicalize);
    expect(first.migrated).toEqual([]);
    expect(localStorage.getItem(favoriteVaultMigrationKey)).toBeNull();

    const second = await migrateFavoriteFoldersToVaults(store, ["/notes"], async () => true, canonicalize);
    expect(second.migrated.map((vault) => vault.rootPath)).toEqual(["/notes"]);
    expect(localStorage.getItem(favoriteVaultMigrationKey)).toBe("1");
  });

  it("retries a legacy favorite after a transient path existence failure", async () => {
    const store = new WorkspaceStore();
    let attempts = 0;
    const pathExists = async (): Promise<boolean> => {
      attempts += 1;
      if (attempts === 1) throw new Error("filesystem temporarily unavailable");
      return true;
    };

    const first = await migrateFavoriteFoldersToVaults(store, ["/notes"], pathExists);
    expect(first.migrated).toEqual([]);
    expect(localStorage.getItem(favoriteVaultMigrationKey)).toBeNull();

    const second = await migrateFavoriteFoldersToVaults(store, ["/notes"], pathExists);
    expect(second.migrated.map((vault) => vault.rootPath)).toEqual(["/notes"]);
    expect(localStorage.getItem(favoriteVaultMigrationKey)).toBe("1");
  });

  it("does not recreate a user-removed vault after migration completed", async () => {
    const store = new WorkspaceStore();
    const first = await migrateFavoriteFoldersToVaults(store, ["/notes"], async () => true);
    const vault = first.migrated[0];
    expect(vault).toBeDefined();
    if (!vault) return;

    store.unregisterVault(vault.vaultId);
    const second = await migrateFavoriteFoldersToVaults(store, ["/notes"], async () => true);

    expect(second.migrated).toEqual([]);
    expect(store.get().vaults).toEqual([]);
  });

  it("does not treat freshly generated default favorites as legacy migration input", () => {
    expect(shouldMigrateLegacyFavorites(false, false)).toBe(false);
    expect(shouldMigrateLegacyFavorites(true, true)).toBe(false);
    expect(defaultFavoriteInitializationKey).toBe("mermark.favoriteFolders.defaults.v1");
    expect(shouldMigrateLegacyFavorites(true, false)).toBe(true);
  });

  it("persists canonical mappings and reuses the vault after a display-name edit", async () => {
    const store = new WorkspaceStore();
    const canonicalize = async (path: string): Promise<string | null> =>
      path === "/alias/docs" ? "/team/docs" : null;

    const first = await migrateFavoriteFoldersToVaults(
      store,
      ["/alias/docs", "/team/docs"],
      async () => true,
      canonicalize,
    );
    const vault = first.migrated[0];
    expect(vault).toBeDefined();
    if (!vault) return;

    store.renameVault(vault.vaultId, "Renamed docs");
    const second = await migrateFavoriteFoldersToVaults(store, ["/alias/docs"], async () => true, canonicalize);

    expect(second.migrated).toEqual([]);
    expect(store.get().vaults).toEqual([expect.objectContaining({ vaultId: vault.vaultId, displayName: "Renamed docs" })]);
    expect(JSON.parse(localStorage.getItem(favoriteVaultMigrationStateKey) ?? "{}"))
      .toMatchObject({ completed: true, canonicalPathToVaultId: { "/team/docs": vault.vaultId }, mergedPaths: ["/team/docs"] });
  });

  it("records broken or missing canonical paths as excluded without registering them", async () => {
    const store = new WorkspaceStore();
    await migrateFavoriteFoldersToVaults(store, ["/broken"], async () => false, async () => null);

    expect(store.get().vaults).toEqual([]);
    expect(JSON.parse(localStorage.getItem(favoriteVaultMigrationStateKey) ?? "{}"))
      .toMatchObject({ completed: true, excludedPaths: ["/broken"] });
  });
});
