import { afterEach, describe, expect, it, vi } from "vitest";
import { openRecoveryModal } from "../src/document/recovery-modal";
import { createRecoveryState } from "../src/document/recovery-contract";

describe("recovery modal", () => {
  afterEach(() => {
    document.querySelectorAll(".recovery-backdrop").forEach((node) => node.remove());
    document.querySelector<HTMLElement>(".editor-host")?.removeAttribute("inert");
  });

  it("keeps the modal and focuses the failed action so the buffer remains recoverable", async () => {
    const host = document.createElement("div");
    host.className = "editor-host";
    document.body.append(host);
    const onAction = vi.fn(() => Promise.resolve("failed" as const));
    const handle = openRecoveryModal({ state: createRecoveryState("deleted", "ENOENT"), onAction });

    document.querySelector<HTMLButtonElement>(".recovery-action-retry")?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(onAction).toHaveBeenCalledWith("retry");
    expect(document.querySelector(".recovery-backdrop")).toBeTruthy();
    expect(document.activeElement?.className).toContain("recovery-action-retry");
    expect(host.hasAttribute("inert")).toBe(true);
    handle.close();
  });

  it("cancels without invoking a destructive action and restores editor focusability", () => {
    const host = document.createElement("div");
    host.className = "editor-host";
    document.body.append(host);
    const onAction = vi.fn(() => "succeeded" as const);
    const onCancel = vi.fn();
    const prior = document.createElement("button");
    document.body.append(prior);
    prior.focus();
    openRecoveryModal({ state: createRecoveryState("unreadable", "EACCES"), onAction, onCancel });

    document.querySelector<HTMLButtonElement>(".recovery-cancel")?.click();

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onAction).not.toHaveBeenCalled();
    expect(document.querySelector(".recovery-backdrop")).toBeNull();
    expect(host.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(prior);
    prior.remove();
  });

  it("keeps the mounted recovery state after a failed save-as action", async () => {
    document.querySelectorAll(".editor-host").forEach((node) => node.remove());
    const host = document.createElement("div");
    host.className = "editor-host";
    document.body.append(host);
    const onAction = vi.fn(() => Promise.resolve("failed" as const));
    const handle = openRecoveryModal({ state: createRecoveryState("deleted", "ENOENT"), onAction });

    document.querySelector<HTMLButtonElement>(".recovery-action-save-as")?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(onAction).toHaveBeenCalledWith("save-as");
    expect(document.querySelector(".recovery-backdrop")).toBeTruthy();
    expect(document.activeElement?.className).toContain("recovery-action-save-as");
    expect(host.hasAttribute("inert")).toBe(true);
    handle.close();
  });
});
