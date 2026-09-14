import { describe, expect, it } from "vitest";
import type { RemoteVault } from "./workspace-state";

describe("RemoteVault", () => {
  it("원격 볼트는 rootPath가 없고 host로 식별된다", () => {
    const v: RemoteVault = {
      vaultId: "vault-remote-1",
      workspaceId: "workspace-default",
      displayName: "맥미니 노트",
      persistenceKind: "remote",
      rootPath: null,
      explorerRoot: "/",
      host: "wis-macmini:8787",
      remoteVaultId: "rv-abc",
    };
    expect(v.persistenceKind).toBe("remote");
    expect(v.rootPath).toBeNull();
  });
});
