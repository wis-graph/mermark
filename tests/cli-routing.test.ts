import { beforeEach, describe, expect, it } from "vitest";
import { routeCliFile, routeCliFileResolved } from "../src/workspace/cli-routing";
import { WorkspaceStore } from "../src/workspace/workspace-state";

describe("routeCliFile", () => {
  beforeEach(() => localStorage.clear());

  it("selects the most specific permanent vault for a canonical descendant path", () => {
    const store = new WorkspaceStore();
    const parent = store.registerVault("/work/notes", "Notes");
    const nested = store.registerVault("/work/notes/project", "Project");

    const result = routeCliFile(store, "/work/notes/project/./draft.md");

    expect(result.kind).toBe("permanent");
    expect(result.path).toBe("/work/notes/project/draft.md");
    expect(result.vault.vaultId).toBe(nested.vaultId);
    expect(result.vault.vaultId).not.toBe(parent.vaultId);
    expect(store.get().workspaces[0]?.currentVaultId).toBe(nested.vaultId);
  });

  it("does not treat a similarly prefixed path as a child", () => {
    const store = new WorkspaceStore();
    store.registerVault("/work/notes", "Notes");

    const result = routeCliFile(store, "/work/notes-archive/draft.md");

    expect(result.kind).toBe("temporary");
    expect(result.path).toBe("/work/notes-archive/draft.md");
    expect(result.vault.persistenceKind).toBe("temporary");
    expect(localStorage.getItem("mermark.workspaceState")).not.toContain(result.vault.vaultId);
  });

  it("matches a vault root itself after canonicalization", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/work/notes", "Notes");

    const result = routeCliFile(store, "/work/notes/./");

    expect(result.kind).toBe("permanent");
    expect(result.path).toBe("/work/notes");
    expect(result.vault.vaultId).toBe(vault.vaultId);
  });

  it("uses the filesystem canonical path for symlink CLI aliases", async () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/real/notes", "Notes");

    const result = await routeCliFileResolved(store, "/alias/notes/draft.md", async () => "/real/notes/draft.md");

    expect(result.kind).toBe("permanent");
    expect(result.vault.vaultId).toBe(vault.vaultId);
  });

  it("canonicalizes the filesystem resolver result before routing and opening", async () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/real/notes", "Notes");

    const result = await routeCliFileResolved(store, "/alias/notes/./draft.md", async () => "/real/notes/project/../draft.md");

    expect(result.kind).toBe("permanent");
    expect(result.path).toBe("/real/notes/draft.md");
    expect(result.vault.vaultId).toBe(vault.vaultId);
  });

  it("falls back to the requested path when filesystem canonicalization is unavailable", async () => {
    const store = new WorkspaceStore();

    const result = await routeCliFileResolved(store, "/missing/draft.md", async () => {
      throw new Error("missing path");
    });

    expect(result.kind).toBe("temporary");
    expect(result.path).toBe("/missing/draft.md");
  });

  it("falls back when native canonicalization rejects a string for a missing file", async () => {
    const store = new WorkspaceStore();

    const result = await routeCliFileResolved(store, "/missing/draft.md", async () => {
      throw "path does not exist";
    });

    expect(result.kind).toBe("temporary");
    expect(result.path).toBe("/missing/draft.md");
  });
});
