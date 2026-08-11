import { describe, expect, it, vi } from "vitest";
import { defineSetting } from "../src/settings/store";
import { bindKeybindings, installDispatcher, registerHandler } from "../src/shortcuts/registry";
import { openConflictModal } from "../src/document/conflict/conflict-modal";
import {
  createConflictRecovery,
  mergeConflictText,
  sameConflictIdentity,
  type ConflictIdentity,
} from "../src/document/conflict/conflict-recovery";
import {
  createRecoveryState,
  RECOVERY_KINDS,
  settleRecoveryAction,
  type RecoveryKind,
} from "../src/document/recovery-contract";

const identity: ConflictIdentity = {
  vaultId: "vault-a",
  tabId: "vault-a-tab-doc",
  documentId: "document-/vault/doc.md",
};

describe("conflict recovery", () => {
  it("records applyExternal with the same identity and resolved version", () => {
    const recovery = createConflictRecovery();
    recovery.detect(identity, "mine", "external");

    const result = recovery.applyExternal(identity);

    expect(result).toMatchObject({ identity, status: "resolved", resolution: "external", resultContent: "external", resultVersion: 1 });
    expect(recovery.get(identity)).toEqual(result);
  });

  it("records keepMine without changing the conflict identity", () => {
    const recovery = createConflictRecovery();
    recovery.detect(identity, "mine", "external");

    expect(recovery.keepMine(identity)).toMatchObject({ identity, resolution: "mine", resultContent: "mine", status: "resolved" });
  });

  it("records a merged result and resolves the conflict", () => {
    const recovery = createConflictRecovery();
    recovery.detect(identity, "mine", "external");

    const merged = recovery.merge(identity);

    expect(merged).toMatchObject({ identity, resolution: "merged", resultContent: mergeConflictText("mine", "external"), status: "resolved", resultVersion: 1 });
  });

  it("does not accept a resolution for an unknown identity", () => {
    const recovery = createConflictRecovery();
    expect(() => recovery.applyExternal(identity)).toThrow("Unknown conflict");
  });

  it("keeps the live conflict pending when a resolution targets another identity", () => {
    const recovery = createConflictRecovery();
    const pending = recovery.detect(identity, "mine", "external");

    expect(() => recovery.applyExternal({ ...identity, tabId: "vault-a-tab-other" })).toThrow("Unknown conflict");
    expect(recovery.get(identity)).toEqual(pending);
  });

  it("does not treat a different vault or tab as the live conflict identity", () => {
    expect(sameConflictIdentity(identity, identity)).toBe(true);
    expect(sameConflictIdentity(identity, { ...identity, vaultId: "vault-b" })).toBe(false);
    expect(sameConflictIdentity(identity, { ...identity, tabId: "vault-a-tab-other" })).toBe(false);
  });

  it("keeps modal keystrokes from reaching the capture-phase global shortcuts", () => {
    const keybindings = defineSetting<Record<string, string>>({
      key: "kb.conflict-modal",
      default: {},
      parse: () => ({}),
      serialize: (value) => JSON.stringify(value),
    });
    const explorerShortcut = vi.fn();
    bindKeybindings(keybindings);
    registerHandler("explorer.toggle", explorerShortcut);
    installDispatcher();
    const handle = openConflictModal({
      local: "mine",
      external: "disk",
      onKeepLocal: vi.fn(),
      onUseExternal: vi.fn(),
      onMerge: vi.fn(),
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    dialog?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: "KeyB", metaKey: true }));

    expect(explorerShortcut).not.toHaveBeenCalled();
    handle.close();
  });

  it("allows native Tab movement and only traps when focus would leave the modal", () => {
    const handle = openConflictModal({
      local: "mine",
      external: "disk",
      onKeepLocal: vi.fn(),
      onUseExternal: vi.fn(),
      onMerge: vi.fn(),
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const buttons = dialog?.querySelectorAll<HTMLButtonElement>("button");
    expect(buttons).toHaveLength(3);
    const first = buttons?.[0];
    const last = buttons?.[2];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (!first || !last) return;

    first.focus();
    const forward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" });
    first.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(false);

    last.focus();
    const wrappedForward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" });
    last.dispatchEvent(wrappedForward);
    expect(wrappedForward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    first.focus();
    const wrappedBackward = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab", shiftKey: true });
    first.dispatchEvent(wrappedBackward);
    expect(wrappedBackward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);

    handle.close();
  });

  it("preserves native Enter and Space activation for modal buttons", () => {
    const onKeepLocal = vi.fn();
    const handle = openConflictModal({
      local: "mine",
      external: "disk",
      onKeepLocal,
      onUseExternal: vi.fn(),
      onMerge: vi.fn(),
    });
    const button = document.querySelector<HTMLButtonElement>(".conflict-keep-local");
    expect(button).not.toBeNull();
    if (!button) return;

    const enter = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" });
    const space = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: " " });
    button.dispatchEvent(enter);
    button.dispatchEvent(space);

    expect(enter.defaultPrevented).toBe(false);
    expect(space.defaultPrevented).toBe(false);
    button.click();
    expect(onKeepLocal).toHaveBeenCalledOnce();
    handle.close();
  });
});

const expectedActions: Readonly<Record<RecoveryKind, readonly string[]>> = {
  "open-read": ["retry", "open-another"],
  "workspace-list": ["retry", "reselect-root"],
  "external-change": ["keep-buffer", "reload-from-disk", "merge"],
  deleted: ["retry", "save-recovered-copy", "save-as", "close-discard"],
  unreadable: ["retry", "save-recovered-copy", "save-as", "close-discard"],
  save: ["retry", "save-recovered-copy", "save-as", "close-discard"],
};

describe("typed filesystem recovery state/action matrix", () => {
  it("enumerates every recovery state with only its allowed actions", () => {
    expect(RECOVERY_KINDS).toEqual(Object.keys(expectedActions));

    for (const kind of RECOVERY_KINDS) {
      const state = createRecoveryState(kind, `detail:${kind}`);
      expect(state.allowedActions.map((action) => action.id)).toEqual(expectedActions[kind]);
      expect(state.title).toMatch(/[가-힣]/);
      expect(state.body).toMatch(/[가-힣]/);
      expect(state.diagnostic).toEqual({ policy: "collapsed", detail: `detail:${kind}` });
      expect(state.focusTarget).toBe(expectedActions[kind][0]);
      expect(state.preservation).toBe(kind === "workspace-list" ? "keep-workspace-and-selection" : "keep-buffer-and-tab");
      expect(state.allowedActions.map((action) => action.id)).not.toEqual(
        expect.arrayContaining(["overwrite-original", "recreate-original", "discard-buffer", "remove-tab"]),
      );
    }
  });

  it("defines the required Korean deletion actions and confirmation boundary", () => {
    const state = createRecoveryState("deleted", "ENOENT");

    expect(state.allowedActions.map((action) => action.label)).toEqual([
      "다시 시도",
      "복구 사본 저장",
      "다른 이름으로 저장",
      "닫기/버리기",
    ]);
    expect(state.allowedActions.find((action) => action.id === "close-discard")?.requiresConfirmation).toBe(true);
  });

  it.each(RECOVERY_KINDS)("preserves %s after every cancelled or failed allowed action", (kind) => {
    const original = createRecoveryState(kind, `detail:${kind}`);

    for (const action of original.allowedActions) {
      for (const outcome of ["cancelled", "failed"] as const) {
        expect(settleRecoveryAction(original, action.id, outcome)).toEqual({
          kind: "preserved",
          reason: outcome,
          state: { ...original, focusTarget: action.id },
        });
      }
    }
  });

  it("rejects an unknown action or outcome without changing the recovery state", () => {
    const original = createRecoveryState("deleted", "ENOENT");

    expect(settleRecoveryAction(original, "recreate-original", "succeeded")).toEqual({
      kind: "preserved",
      reason: "rejected",
      state: original,
    });
    expect(settleRecoveryAction(original, "retry", "unknown-error")).toEqual({
      kind: "preserved",
      reason: "rejected",
      state: original,
    });
  });

  it.each(RECOVERY_KINDS)("rejects runtime-unknown action and outcome for %s while retaining a viable focus target", (kind) => {
    const original = createRecoveryState(kind, `detail:${kind}`);

    expect(settleRecoveryAction(original, null, { code: "E_UNKNOWN" })).toEqual({
      kind: "preserved",
      reason: "rejected",
      state: original,
    });
    expect(original.allowedActions.some((action) => action.id === original.focusTarget)).toBe(true);
  });

  it("resolves only a recognized successful action", () => {
    const original = createRecoveryState("external-change", "mtime changed");

    expect(settleRecoveryAction(original, "merge", "succeeded")).toEqual({
      kind: "resolved",
      action: "merge",
    });
  });
});
