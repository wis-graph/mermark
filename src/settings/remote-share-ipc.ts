// 원격 공유 IPC 경계 — Rust `remote_share.rs`/`cli_control.rs`의 wire 타입과 invoke
// 래퍼를 한 곳에 둔다. 설정 패널(remote-share-panel.ts)과 CLI 요청 핸들러
// (remote-share-cli.ts)가 같은 래퍼를 공유하므로, "패널로 켜기"와 "터미널로 켜기"가
// 구조적으로 같은 `remote_share_start` 경로를 지난다(마지막 선택 SSOT의 writer가
// Rust share_start 성공 분기 하나뿐인 이유). 이 모듈은 패널을 import하지 않는다(순환 금지).
import { invoke } from "@tauri-apps/api/core";

/** `remote_share.rs`의 `BindMode` — kebab-case. */
export type BindMode = "tailscale" | "localhost-only";

/** `remote_share.rs::VaultToArm` — `#[serde(rename_all)]` 없음: `display_name`은 snake_case 그대로. */
export interface VaultToArm {
  readonly id: string;
  readonly display_name: string;
  readonly root: string;
}

/** `remote_host.rs::ArmedVault` — root는 `#[serde(skip)]`. */
export interface ArmedVaultInfo {
  readonly id: string;
  readonly display_name: string;
}

/** `remote_share.rs::DeviceInfo` — 토큰 없음. */
export interface DeviceInfo {
  readonly id: string;
  readonly label: string;
  readonly paired_at_ms: number;
}

/** `remote_share.rs::RememberedVault` — 루트 경로는 저장되지 않는다. */
export interface RememberedVault {
  readonly id: string;
  readonly display_name: string;
}

/** `remote_share.rs::ShareSelection` — "마지막 선택"(Rust가 유일한 writer). */
export interface ShareSelection {
  readonly bind_mode: BindMode;
  readonly vaults: readonly RememberedVault[];
}

/** `remote_share.rs::ShareStatus`. */
export interface ShareStatus {
  readonly running: boolean;
  readonly bind_mode: BindMode;
  readonly port: number;
  readonly vaults: readonly ArmedVaultInfo[];
  readonly devices: readonly DeviceInfo[];
  readonly last_selection: ShareSelection | null;
}

/** `remote_share.rs::IssuedCode`. */
export interface IssuedCode {
  readonly code: string;
  readonly issued_at_ms: number;
}

/** `cli_control.rs::CliShareRequestPayload` — 이벤트 `cli-share-request`의 payload. */
export interface CliShareRequestPayload {
  readonly id: number;
  readonly names: readonly string[];
  readonly remembered: ShareSelection | null;
}

/** `cli_control.rs::CliShareOutcome` — `#[serde(tag = "kind")]`. */
export type CliShareOutcome =
  | { readonly kind: "started"; readonly warnings: readonly string[] }
  | { readonly kind: "failed"; readonly error: string };

export async function fetchStatus(): Promise<ShareStatus> {
  return invoke<ShareStatus>("remote_share_status");
}

export async function startShare(bindMode: BindMode, port: number, vaults: readonly VaultToArm[]): Promise<void> {
  await invoke<void>("remote_share_start", { bindMode, port, vaults });
}

export async function stopShare(): Promise<void> {
  await invoke<void>("remote_share_stop");
}

export async function issueCode(): Promise<IssuedCode> {
  return invoke<IssuedCode>("remote_issue_code");
}

export async function revokeDevice(id: string): Promise<boolean> {
  return invoke<boolean>("remote_revoke_device", { id });
}

/** Tailscale 사전 프로브 — `resolve_bind_ip`와 같은 탐지 로직(패널 doc 참고). */
export async function checkTailscaleAvailable(): Promise<boolean> {
  return invoke<boolean>("remote_tailscale_available");
}

/** CLI 요청에 대한 회신 — 요청당 정확히 1번 호출해야 한다(미회신이면 CLI가 타임아웃까지 매달림). */
export async function completeCliRequest(id: number, outcome: CliShareOutcome): Promise<void> {
  await invoke<void>("complete_cli_request", { id, outcome });
}
