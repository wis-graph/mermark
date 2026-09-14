import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { documentVault, isRemoteVault, REMOTE_VAULT_READONLY_MESSAGE } from "./document-vault";
import type { RemoteVault, PermanentVault } from "../workspace/workspace-state";

const remoteVault: RemoteVault = {
  vaultId: "vault-remote-1",
  workspaceId: "workspace-default",
  displayName: "원격 볼트",
  rootPath: null,
  persistenceKind: "remote",
  explorerRoot: "remote://host/",
  host: "wis-macmini",
  remoteVaultId: "rv-1",
};

const permanentVault: PermanentVault = {
  vaultId: "vault-p",
  workspaceId: "workspace-default",
  displayName: "P",
  rootPath: "/P",
  persistenceKind: "permanent",
  explorerRoot: "/P",
};

describe("documentVault facet", () => {
  it("combines to undefined when no provider registered — the pre-existing 'local' default", () => {
    const state = EditorState.create({});
    expect(state.facet(documentVault)).toBeUndefined();
  });

  it("combines to the injected vault", () => {
    const state = EditorState.create({ extensions: [documentVault.of(remoteVault)] });
    expect(state.facet(documentVault)).toBe(remoteVault);
  });
});

describe("isRemoteVault", () => {
  it("true only for persistenceKind 'remote'", () => {
    expect(isRemoteVault(remoteVault)).toBe(true);
    expect(isRemoteVault(permanentVault)).toBe(false);
    expect(isRemoteVault(undefined)).toBe(false);
  });
});

describe("REMOTE_VAULT_READONLY_MESSAGE", () => {
  it("is the exact Korean read-only notice", () => {
    expect(REMOTE_VAULT_READONLY_MESSAGE).toBe("원격 볼트는 읽기 전용입니다");
  });
});
