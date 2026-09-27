import { describe, it, expect, vi } from "vitest";
import { createRemoteVaultDialog } from "../src/workspace/remote-vault-dialog";
import type { WorkspaceStore } from "../src/workspace/workspace-state";

// T2 (0.17.1): the pairing button must run `hostFieldProblem` BEFORE ever
// calling `remote_pair` — this is the wiring half of remote-host-field.ts's
// pure gate (the pure function itself is covered exhaustively in
// tests/remote-host-field.test.ts).
describe("createRemoteVaultDialog: host pre-flight gate (T2)", () => {
  it("an unreachable-shaped host (Korean) shows guidance and never calls remote_pair", () => {
    const call = vi.fn();
    const dialog = createRemoteVaultDialog({ store: {} as WorkspaceStore, call: call as unknown as typeof import("@tauri-apps/api/core").invoke });
    document.body.append(dialog.root);
    dialog.open();

    const hostInput = dialog.root.querySelector(".remote-vault-dialog-input") as HTMLInputElement;
    const codeInput = dialog.root.querySelectorAll(".remote-vault-dialog-input")[1] as HTMLInputElement;
    hostInput.value = "맥미니";
    hostInput.dispatchEvent(new Event("input"));
    codeInput.value = "123456";
    codeInput.dispatchEvent(new Event("input"));

    const pairBtn = dialog.root.querySelector(".remote-vault-dialog-submit") as HTMLButtonElement;
    pairBtn.click();

    expect(call).not.toHaveBeenCalled();
    const errorEl = dialog.root.querySelector(".remote-vault-dialog-error") as HTMLElement;
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toContain("영문");

    dialog.root.remove();
  });

  it("a valid host proceeds to call remote_pair", async () => {
    const call = vi.fn().mockResolvedValue([]);
    const dialog = createRemoteVaultDialog({ store: {} as WorkspaceStore, call: call as unknown as typeof import("@tauri-apps/api/core").invoke });
    document.body.append(dialog.root);
    dialog.open();

    const hostInput = dialog.root.querySelector(".remote-vault-dialog-input") as HTMLInputElement;
    const codeInput = dialog.root.querySelectorAll(".remote-vault-dialog-input")[1] as HTMLInputElement;
    hostInput.value = "mac-mini";
    hostInput.dispatchEvent(new Event("input"));
    codeInput.value = "123456";
    codeInput.dispatchEvent(new Event("input"));

    const pairBtn = dialog.root.querySelector(".remote-vault-dialog-submit") as HTMLButtonElement;
    pairBtn.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(call).toHaveBeenCalledWith("remote_pair", expect.objectContaining({ host: "mac-mini", code: "123456" }));

    dialog.root.remove();
  });

  // Audit re-review round 2 (`_workspace/04_audit_report.md`): this dialog
  // is the ONE place a user actually sees an `SSH_TUNNEL_PORT_IN_USE:`
  // failure (from `remote_ssh_connect`, called just above `remote_pair` for
  // an `ssh://` host) — it used to show the raw machine-prefixed string.
  // `shareStartErrorMessage` (settings/remote-share-port.ts) used to carry a
  // dead branch for this same prefix even though it can never receive it
  // (that's a different command, remote_share_start). The stripping moved
  // here, where the error actually reaches a user.
  it("an ssh:// pairing failure with SSH_TUNNEL_PORT_IN_USE: shows Rust's message with the machine prefix stripped", async () => {
    const rustLiteral = "SSH_TUNNEL_PORT_IN_USE: 이 기기의 127.0.0.1:47879를 다른 프로그램이 쓰고 있습니다 (이전 mermark의 ssh가 남아 있을 수 있습니다 — 종료 후 다시 시도).";
    const call = vi.fn((cmd: string) => (cmd === "remote_ssh_connect" ? Promise.reject(new Error(rustLiteral)) : Promise.resolve([])));
    const dialog = createRemoteVaultDialog({ store: {} as WorkspaceStore, call: call as unknown as typeof import("@tauri-apps/api/core").invoke });
    document.body.append(dialog.root);
    dialog.open();

    const hostInput = dialog.root.querySelector(".remote-vault-dialog-input") as HTMLInputElement;
    const codeInput = dialog.root.querySelectorAll(".remote-vault-dialog-input")[1] as HTMLInputElement;
    hostInput.value = "ssh://wis@mac-mini";
    hostInput.dispatchEvent(new Event("input"));
    codeInput.value = "123456";
    codeInput.dispatchEvent(new Event("input"));

    const pairBtn = dialog.root.querySelector(".remote-vault-dialog-submit") as HTMLButtonElement;
    pairBtn.click();
    await new Promise((r) => setTimeout(r, 0));

    const errorEl = dialog.root.querySelector(".remote-vault-dialog-error") as HTMLElement;
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).not.toContain("SSH_TUNNEL_PORT_IN_USE");
    expect(errorEl.textContent).toContain("127.0.0.1:47879");
    expect(errorEl.textContent).toContain("종료 후 다시 시도");

    dialog.root.remove();
  });
});
