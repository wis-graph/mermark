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
});
