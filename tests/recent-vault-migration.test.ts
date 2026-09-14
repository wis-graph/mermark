import { beforeEach, describe, expect, it } from "vitest";
import { WorkspaceStore } from "../src/workspace/workspace-state";
import { migrateLegacyRecentPaths, readLegacyRecentDocPaths, recentDocsStorageKey } from "../src/sidebar/recent/recent-vault-migration";

// Task 11 fix round 3: recentDocsSetting used to be a bare string[] with no
// vault identity. These pin the migration that attaches each legacy entry to
// the LOCAL vault that owns it, purely (no `store.selectVault` side effect),
// and the legacy-reader's self-terminating idempotency (no separate
// "completed" flag — see recent-vault-migration.ts's own header).

describe("readLegacyRecentDocPaths", () => {
  beforeEach(() => localStorage.clear());

  it("returns [] when nothing is stored", () => {
    expect(readLegacyRecentDocPaths()).toEqual([]);
  });

  it("reads a legacy flat string[]", () => {
    localStorage.setItem(recentDocsStorageKey, JSON.stringify(["/A/a.md", "/B/b.md"]));
    expect(readLegacyRecentDocPaths()).toEqual(["/A/a.md", "/B/b.md"]);
  });

  it("returns [] once the stored value is already the NEW {path,vaultId} shape (self-terminating)", () => {
    localStorage.setItem(recentDocsStorageKey, JSON.stringify([{ path: "/A/a.md", vaultId: "vault-A" }]));
    expect(readLegacyRecentDocPaths()).toEqual([]);
  });

  it("tolerates corrupt JSON (returns [])", () => {
    localStorage.setItem(recentDocsStorageKey, "{not json");
    expect(readLegacyRecentDocPaths()).toEqual([]);
  });
});

describe("migrateLegacyRecentPaths", () => {
  beforeEach(() => localStorage.clear());

  it("attaches a path under a registered permanent vault's root to that vault", () => {
    const store = new WorkspaceStore();
    const vault = store.registerCanonicalVault("/A", "A");
    const migrated = migrateLegacyRecentPaths(store, ["/A/note.md"]);
    expect(migrated).toEqual([{ path: "/A/note.md", vaultId: vault.vaultId }]);
  });

  it("falls back to the Global Vault for a path under no registered permanent vault", () => {
    const store = new WorkspaceStore();
    const migrated = migrateLegacyRecentPaths(store, ["/nowhere/note.md"]);
    expect(migrated).toEqual([{ path: "/nowhere/note.md", vaultId: store.getGlobalVault().vaultId }]);
  });

  it("picks the longest (most specific) matching permanent vault root", () => {
    const store = new WorkspaceStore();
    store.registerCanonicalVault("/A", "A");
    const nested = store.registerCanonicalVault("/A/B", "A/B");
    const migrated = migrateLegacyRecentPaths(store, ["/A/B/note.md"]);
    expect(migrated).toEqual([{ path: "/A/B/note.md", vaultId: nested.vaultId }]);
  });

  it("never calls store.selectVault as a side effect (batch migration must not flip the current selection)", () => {
    const store = new WorkspaceStore();
    store.registerCanonicalVault("/A", "A");
    const before = store.get().workspaces[0]?.currentVaultId;
    migrateLegacyRecentPaths(store, ["/A/one.md", "/A/two.md", "/elsewhere/three.md"]);
    expect(store.get().workspaces[0]?.currentVaultId).toBe(before);
  });
});
