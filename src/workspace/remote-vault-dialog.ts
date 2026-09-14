// Task 10's "볼트 추가 › 원격 볼트" flow: pair (host + 6-digit code) then pick
// which of the host's shared vaults to register locally. `remote_pair`
// returns nothing on success (the device token never leaves Rust — see
// remote_client.rs's doc comment), so the vault list is fetched separately
// via `remote_vaults` right after a successful pair.
import { icon } from "../icons";
import { makeAddRemoteForm } from "./add-remote-vault";
import type { WorkspaceStore } from "./workspace-state";
import type { invoke } from "@tauri-apps/api/core";

/** The label this device registers itself under in the HOST's device list
 *  (remote-share-panel.ts's device management on the host side reads this
 *  back). Kept short, human-legible, and STABLE per browser profile — a
 *  random suffix distinguishes this device from another mermark install
 *  pairing to the same host, while `mermark-client` on its own would make
 *  every device pairing show up identically in the host's revoke list, ie.
 *  no way to tell which reused-token row corresponds to which physical
 *  machine. Persisted so re-pairing (e.g. after a code expires) reuses the
 *  SAME label instead of piling up "mermark-client-a1b2", "…-c3d4", … for one
 *  physical device. */
const DEVICE_LABEL_KEY = "mermark.remoteDeviceLabel";
export const deviceLabel = (): string => {
  const existing = localStorage.getItem(DEVICE_LABEL_KEY);
  if (existing) return existing;
  const suffix = Math.random().toString(36).slice(2, 6);
  const label = `mermark-client-${suffix}`;
  localStorage.setItem(DEVICE_LABEL_KEY, label);
  return label;
};

interface RemoteVaultListing {
  readonly id: string;
  readonly display_name: string;
}

export interface RemoteVaultDialogDeps {
  readonly store: WorkspaceStore;
  /** Swappable for a spy in tests — the real `invoke` value is supplied by
   *  the caller (workspace-sidebar.ts), never imported here directly. */
  readonly call: typeof invoke;
  onRegistered?(): void;
}

const create = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
};

export interface RemoteVaultDialog {
  readonly root: HTMLElement;
  open(): void;
  close(): void;
}

export function createRemoteVaultDialog({ store, call, onRegistered }: RemoteVaultDialogDeps): RemoteVaultDialog {
  const root = create("div", "remote-vault-dialog"); root.hidden = true;
  const heading = create("div", "remote-vault-dialog-title"); heading.textContent = "원격 볼트 추가";
  const closeBtn = create("button", "remote-vault-dialog-close") as HTMLButtonElement; closeBtn.type = "button"; closeBtn.setAttribute("aria-label", "닫기"); closeBtn.append(icon("x"));
  const header = create("div", "remote-vault-dialog-header"); header.append(heading, closeBtn);

  const errorEl = create("div", "remote-vault-dialog-error"); errorEl.hidden = true;
  const showError = (message: string): void => { errorEl.textContent = message; errorEl.hidden = false; };
  const clearError = (): void => { errorEl.hidden = true; };

  // ── Step 1: host + code ─────────────────────────────────────────────────
  const form = makeAddRemoteForm();
  const pairStep = create("div", "remote-vault-dialog-step");
  const hostInput = create("input", "remote-vault-dialog-input") as HTMLInputElement;
  hostInput.type = "text"; hostInput.placeholder = "호스트 (예: wis-macmini 또는 wis-macmini:9000)"; hostInput.autocomplete = "off";
  const codeInput = create("input", "remote-vault-dialog-input") as HTMLInputElement;
  codeInput.type = "text"; codeInput.inputMode = "numeric"; codeInput.maxLength = 6; codeInput.placeholder = "6자리 코드"; codeInput.autocomplete = "off";
  const pairBtn = create("button", "remote-vault-dialog-submit") as HTMLButtonElement; pairBtn.type = "button"; pairBtn.textContent = "페어링"; pairBtn.disabled = true;
  const syncSubmit = (): void => { pairBtn.disabled = !form.canSubmit(); };
  hostInput.addEventListener("input", () => { form.setHost(hostInput.value); syncSubmit(); });
  codeInput.addEventListener("input", () => { form.setCode(codeInput.value); syncSubmit(); });
  pairStep.append(hostInput, codeInput, pairBtn);

  // ── Step 2: pick which of the host's shared vaults to add ───────────────
  const pickStep = create("div", "remote-vault-dialog-step"); pickStep.hidden = true;
  const pickList = create("div", "remote-vault-dialog-list");
  pickStep.append(pickList);

  root.append(header, errorEl, pairStep, pickStep);

  const showPairStep = (): void => { pairStep.hidden = false; pickStep.hidden = true; };
  const showPickStep = (): void => { pairStep.hidden = true; pickStep.hidden = false; };

  const renderVaultList = (host: string, vaults: readonly RemoteVaultListing[]): void => {
    pickList.replaceChildren();
    if (vaults.length === 0) {
      const empty = create("div", "remote-vault-dialog-empty"); empty.textContent = "이 호스트가 공유 중인 볼트가 없습니다";
      pickList.append(empty);
      return;
    }
    for (const v of vaults) {
      const row = create("div", "remote-vault-dialog-row");
      const name = create("span", "remote-vault-dialog-row-name"); name.textContent = v.display_name;
      const addBtn = create("button", "remote-vault-dialog-row-add") as HTMLButtonElement; addBtn.type = "button"; addBtn.append(icon("plus"));
      addBtn.addEventListener("click", () => {
        try {
          store.registerRemoteVault(host, v.id, v.display_name);
          addBtn.disabled = true;
          addBtn.title = "추가됨";
          onRegistered?.();
        } catch (error) {
          showError(error instanceof Error ? error.message : String(error));
        }
      });
      row.append(name, addBtn);
      pickList.append(row);
    }
  };

  pairBtn.addEventListener("click", () => {
    if (!form.canSubmit()) return;
    clearError();
    pairBtn.disabled = true;
    const { host, code } = form.values();
    void (async (): Promise<void> => {
      try {
        await call("remote_pair", { host, code, label: deviceLabel() });
        const vaults = await call<RemoteVaultListing[]>("remote_vaults", { host });
        showPickStep();
        renderVaultList(host, vaults);
      } catch (error) {
        showError(error instanceof Error ? error.message : String(error));
      } finally {
        syncSubmit();
      }
    })();
  });

  const reset = (): void => {
    hostInput.value = ""; codeInput.value = "";
    form.setHost(""); form.setCode("");
    syncSubmit();
    clearError();
    showPairStep();
  };

  const close = (): void => { root.hidden = true; };
  const open = (): void => { reset(); root.hidden = false; hostInput.focus(); };
  closeBtn.addEventListener("click", () => close());

  return { root, open, close };
}
