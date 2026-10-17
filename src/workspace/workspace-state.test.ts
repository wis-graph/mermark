import { describe, expect, it, vi } from "vitest";
import { WorkspaceStore, readPersistedWorkspaceState, type RemoteVault } from "./workspace-state";

describe("RemoteVault", () => {
  it("원격 볼트는 rootPath가 없고 host로 식별된다", () => {
    const v: RemoteVault = {
      vaultId: "vault-remote-1",
      workspaceId: "workspace-default",
      displayName: "맥미니 노트",
      persistenceKind: "remote",
      rootPath: null,
      explorerRoot: "/",
      host: "wis-macmini:47878",
      remoteVaultId: "rv-abc",
    };
    expect(v.persistenceKind).toBe("remote");
    expect(v.rootPath).toBeNull();
  });
});

describe("readPersistedWorkspaceState", () => {
  it("다른 WorkspaceStore가 방금 등록한 볼트를 캐시가 아닌 localStorage에서 새로 읽는다", () => {
    localStorage.clear();
    const stale = new WorkspaceStore();
    const other = new WorkspaceStore();
    other.registerVault("/tmp/fresh-vault", "fresh");
    expect(stale.get().vaults.some((v) => v.displayName === "fresh")).toBe(false);
    expect(readPersistedWorkspaceState().vaults.some((v) => v.displayName === "fresh")).toBe(true);
  });

  it("읽기만 하고 localStorage에 쓰지 않는다", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem");
    readPersistedWorkspaceState();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
