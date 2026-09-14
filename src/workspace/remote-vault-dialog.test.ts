// Task 12 fix round 1 (reachability finding): nothing ever called
// `remote_ssh_connect`, so a user typing `ssh://user@host` got a silent
// "connection refused" — `remote_pair` dialing straight into a local port
// nobody was listening on. These tests pin the wiring that closes that gap:
// an `ssh://`-typed host establishes the tunnel before pairing; a plain
// Tailscale-style host never touches the ssh commands at all.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRemoteVaultDialog } from "./remote-vault-dialog";
import { WorkspaceStore, workspaceStorageKey } from "./workspace-state";

beforeEach(() => {
  localStorage.removeItem(workspaceStorageKey);
});

describe("remote vault dialog — ssh tunnel wiring", () => {
  it("connects the ssh tunnel before pairing when the host is ssh://", async () => {
    const calls: Array<{ cmd: string; args: unknown }> = [];
    const call = vi.fn(async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args });
      if (cmd === "remote_vaults") return [];
      return undefined;
    }) as unknown as typeof import("@tauri-apps/api/core").invoke;

    const dialog = createRemoteVaultDialog({ store: new WorkspaceStore(), call });
    dialog.open();

    const hostInput = dialog.root.querySelector<HTMLInputElement>(".remote-vault-dialog-input")!;
    const inputs = dialog.root.querySelectorAll<HTMLInputElement>(".remote-vault-dialog-input");
    const codeInput = inputs[1];
    hostInput.value = "ssh://wis@macmini";
    hostInput.dispatchEvent(new Event("input"));
    codeInput.value = "123456";
    codeInput.dispatchEvent(new Event("input"));

    const pairBtn = dialog.root.querySelector<HTMLButtonElement>(".remote-vault-dialog-submit")!;
    pairBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const cmds = calls.map((c) => c.cmd);
    expect(cmds.indexOf("remote_ssh_connect")).toBeGreaterThanOrEqual(0);
    expect(cmds.indexOf("remote_ssh_connect")).toBeLessThan(cmds.indexOf("remote_pair"));
    expect(calls[cmds.indexOf("remote_ssh_connect")].args).toEqual({ host: "ssh://wis@macmini" });
  });

  it("never calls remote_ssh_connect for a non-ssh (e.g. Tailscale) host", async () => {
    const calls: string[] = [];
    const call = vi.fn(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "remote_vaults") return [];
      return undefined;
    }) as unknown as typeof import("@tauri-apps/api/core").invoke;

    const dialog = createRemoteVaultDialog({ store: new WorkspaceStore(), call });
    dialog.open();

    const inputs = dialog.root.querySelectorAll<HTMLInputElement>(".remote-vault-dialog-input");
    inputs[0].value = "wis-macmini";
    inputs[0].dispatchEvent(new Event("input"));
    inputs[1].value = "123456";
    inputs[1].dispatchEvent(new Event("input"));

    dialog.root.querySelector<HTMLButtonElement>(".remote-vault-dialog-submit")!.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).not.toContain("remote_ssh_connect");
    expect(calls).toContain("remote_pair");
  });

  it("surfaces an ssh tunnel failure the same way a pairing failure is shown", async () => {
    const call = vi.fn(async (cmd: string) => {
      if (cmd === "remote_ssh_connect") throw "REMOTE:Unreachable: SSH 터널이 8초 내에 준비되지 않았습니다";
      return undefined;
    }) as unknown as typeof import("@tauri-apps/api/core").invoke;

    const dialog = createRemoteVaultDialog({ store: new WorkspaceStore(), call });
    dialog.open();

    const inputs = dialog.root.querySelectorAll<HTMLInputElement>(".remote-vault-dialog-input");
    inputs[0].value = "ssh://wis@macmini";
    inputs[0].dispatchEvent(new Event("input"));
    inputs[1].value = "123456";
    inputs[1].dispatchEvent(new Event("input"));

    dialog.root.querySelector<HTMLButtonElement>(".remote-vault-dialog-submit")!.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const errorEl = dialog.root.querySelector<HTMLElement>(".remote-vault-dialog-error")!;
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toContain("REMOTE:Unreachable");
  });
});
