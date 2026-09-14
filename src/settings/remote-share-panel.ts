// "원격 공유" 카테고리 — 이 mermark(호스트)가 자신의 볼트를 Tailscale/SSH로
// 다른 mermark(클라이언트)에 공유하도록 켜고 끄는 설정 패널. Task 9a
// (`.superpowers/sdd/remote-vault-plan/task-9a-report.md`)가 확정한 5개
// `#[tauri::command]`(remote_share_status/start/stop, remote_issue_code,
// remote_revoke_device)에 더해, 9b fix round 1(리뷰 finding 3)에서 추가한
// `remote_tailscale_available`을 소비한다 — Tailscale 감지를 시작 실패
// 메시지의 문자열 매칭(반응형)이 아니라 사전 프로브(능동형)로 한다.
//
// 카테고리 등록 방식: registry.ts의 registerSetting(단일 Setting<T> ↔ 컨트롤)
// 틀에 억지로 끼우지 않는다 — 여기서 편집하는 진짜 소스는 로컬 Setting이
// 아니라 백엔드의 ShareStatus다(9a 보고서: bind_mode/port/vaults는 서버가
// 꺼져 있어도 "마지막 구성값"으로 기억한다). 대신 "버전" 카테고리
// (panel/version-pane.ts)와 같은 패턴을 쓴다 — 로컬 클로저에 상태를 두고
// modal.ts가 groups() 밖에서 별도 사이드바 버튼으로 마운트한다.
//
// 도메인 규칙(카운트다운 만료, 볼트 선택 가능 여부, wire 직렬화)은 DOM과
// 분리된 순수 함수로 뽑아 vitest로 직접 검증한다(mermark-frontend 스킬 §7).
import { invoke } from "@tauri-apps/api/core";
import { attachTeardown } from "./panel/controls";
import type { Vault, WorkspaceState } from "../workspace/workspace-state";

// ── Wire types (Rust 구조체를 그대로 미러링 — task-9a-report.md 시그니처) ──

/** `remote_share.rs`의 `BindMode` — `#[serde(rename_all = "kebab-case")]`라
 *  wire 값은 "tailscale" | "localhost-only". */
export type BindMode = "tailscale" | "localhost-only";

/** 프론트가 아는 "공유 가능한 볼트" 1개(로컬 workspace state에서 뽑음). */
export interface VaultOption {
  readonly id: string;
  readonly displayName: string;
  readonly root: string;
}

/** `remote_share.rs::VaultToArm` — `#[serde(rename_all)]` 없음. Rust 필드명이
 *  그대로 wire JSON 키가 되므로 `display_name`은 절대 camelCase로 보내면 안
 *  된다(mocks/tauri-core.ts의 remote_vaults 주석과 동일한 함정). */
export interface VaultToArm {
  readonly id: string;
  readonly display_name: string;
  readonly root: string;
}

/** `remote_host.rs::ArmedVault` — `{id, display_name}`뿐, root는 `#[serde(skip)]`
 *  (호스트가 자기 파일시스템 절대경로를 클라이언트/설정 패널에 흘리지 않음). */
export interface ArmedVaultInfo {
  readonly id: string;
  readonly display_name: string;
}

/** `remote_share.rs::DeviceInfo` — 토큰은 절대 포함되지 않는다(백엔드가 이미
 *  거부). 이 패널도 토큰을 절대 렌더하지 않는다. */
export interface DeviceInfo {
  readonly id: string;
  readonly label: string;
  readonly paired_at_ms: number;
}

/** `remote_share.rs::ShareStatus`. */
export interface ShareStatus {
  readonly running: boolean;
  readonly bind_mode: BindMode;
  readonly port: number;
  readonly vaults: readonly ArmedVaultInfo[];
  readonly devices: readonly DeviceInfo[];
}

/** `remote_share.rs::IssuedCode`. */
export interface IssuedCode {
  readonly code: string;
  readonly issued_at_ms: number;
}

// ── 순수 함수(도메인 규칙) — DOM 없이 vitest로 직접 검증 ────────────────────

/** 페어링 코드 TTL. 백엔드가 `issued_at_ms`(발급 시각)를 권위 있게 주므로,
 *  클릭 시점에 프론트가 따로 로컬 타이머를 시작하지 않는다 — 두 시계는
 *  드리프트하고 백엔드가 만료의 유일한 근거다. */
export const PAIRING_TTL_MS = 300_000;

/** 코드가 `nowMs` 시점에 남은 유효시간(ms). 발급 시각 기준 뺄셈만 하는 순수
 *  쿼리 — 로컬 setInterval은 이 함수를 반복 호출해 표시만 갱신한다. */
export function codeRemainingMs(nowMs: number, issuedAtMs: number): number {
  return Math.max(0, PAIRING_TTL_MS - (nowMs - issuedAtMs));
}

/** `codeRemainingMs`가 0이 됐는지 — 만료 여부를 인라인 비교로 흩뿌리지 않고
 *  이름으로 약속한다. */
export function codeExpired(nowMs: number, issuedAtMs: number): boolean {
  return codeRemainingMs(nowMs, issuedAtMs) <= 0;
}

/** 남은 ms를 "4:32" 형태의 mm:ss로. 코드가 사람이 6자리를 불러주는 동안
 *  카운트다운을 읽는 용도라 올림(ceil)해 0초로 스냅되기 전 "0:01"이 최소 1초
 *  보이도록 한다. */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 백엔드가 볼트 0개로는 시작을 거부하므로(task-9a-report.md), "공유 켜기"
 *  토글을 활성화해도 되는지는 armed 집합의 존재 여부 하나로 결정된다. */
export function canEnableSharing(armedVaultIds: readonly string[]): boolean {
  return armedVaultIds.length > 0;
}

/** 체크박스 한 번 클릭 = 집합에서 토글. 순수 함수 — 호출부가 결과를 다시
 *  set한다(CQS: 쿼리는 새 배열만 반환, 아무것도 mutate하지 않음). */
export function toggleVaultId(armedVaultIds: readonly string[], id: string): string[] {
  return armedVaultIds.includes(id) ? armedVaultIds.filter((v) => v !== id) : [...armedVaultIds, id];
}

/** 로컬 workspace state → 공유 후보 볼트 목록. 원격 볼트(`persistenceKind:
 *  "remote"`)는 root가 없어 재공유할 수 없고, 글로벌 볼트도 실제 파일시스템
 *  루트가 없으므로 "permanent"(로컬 루트가 있는 볼트)만 후보로 남긴다. */
export function shareableVaultsFrom(state: WorkspaceState): VaultOption[] {
  return state.vaults
    .filter((v): v is Extract<Vault, { persistenceKind: "permanent" }> => v.persistenceKind === "permanent")
    .map((v) => ({ id: v.vaultId, displayName: v.displayName, root: v.rootPath }));
}

/** 선택된 볼트들을 `remote_share_start`가 받는 정확한 wire shape으로 직렬화.
 *  `display_name` 필드명을 여기 한 곳에서만 조립해, camelCase로 새는 지점을
 *  하나로 막는다. */
export function buildVaultsToArm(options: readonly VaultOption[], armedVaultIds: readonly string[]): VaultToArm[] {
  const armed = new Set(armedVaultIds);
  return options.filter((o) => armed.has(o.id)).map((o) => ({ id: o.id, display_name: o.displayName, root: o.root }));
}

/** `ShareStatus.vaults`에서 armed id 목록만 뽑는다 — 재시작 실패 후 백엔드
 *  진실로 되돌아갈 때(`remote_share_status` 재조회) 이 함수로 로컬 pending
 *  선택을 다시 맞춘다. */
export function armedIdsFromStatus(status: Pick<ShareStatus, "vaults">): string[] {
  return status.vaults.map((v) => v.id);
}

// ── invoke 래퍼(경계면 — 실패는 절대 삼키지 않고 Error로 던진다) ───────────

async function fetchStatus(): Promise<ShareStatus> {
  return invoke<ShareStatus>("remote_share_status");
}

async function startShare(bindMode: BindMode, port: number, vaults: readonly VaultToArm[]): Promise<void> {
  await invoke<void>("remote_share_start", { bindMode, port, vaults });
}

async function stopShare(): Promise<void> {
  await invoke<void>("remote_share_stop");
}

async function issueCode(): Promise<IssuedCode> {
  return invoke<IssuedCode>("remote_issue_code");
}

async function revokeDevice(id: string): Promise<boolean> {
  return invoke<boolean>("remote_revoke_device", { id });
}

/** Tailscale 감지 — 사전 프로브(9b fix round 1, finding 3). 이전 라운드는
 *  시작 실패 메시지를 `/tailscale/i`로 매칭하는 반응형 판정이었는데 리뷰에서
 *  세 갈래로 깨졌다: (a) Rust/mock/test 세 곳의 에러 문자열이 서로 안 맞아
 *  리워딩 한 번에 감지가 조용히 죽고, (b) 정규식이 에러 전체를 훑어서
 *  "Tailscale"이 들어간 이름의 볼트 하나가 라디오를 영구히 회색으로
 *  만들었고, (c) `bind 100.x…: Cannot assign requested address` 같은 진짜
 *  실패는 "tailscale"을 아예 언급하지 않아 놓쳤다. `remote_tailscale_available`
 *  (`remote_share.rs`)이 `resolve_bind_ip`와 정확히 같은 탐지 로직을 재사용해
 *  실패 없이도 미리 가부만 묻는다 — 여기 판정과 실제 바인드 시도가 절대
 *  어긋날 수 없다. */
async function checkTailscaleAvailable(): Promise<boolean> {
  return invoke<boolean>("remote_tailscale_available");
}

/** 실패 메시지 추출 — invoke가 던지는 값은 Tauri에서 보통 문자열(`Result<_,
 *  String>`이 그대로 reject됨)이지만 Error 인스턴스일 수도 있어 방어적으로
 *  통일한다. */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const DEFAULT_PORT = 8787;

// ── DOM 빌더 ────────────────────────────────────────────────────────────────

function labeledRow(label: string): { row: HTMLElement; cell: HTMLElement } {
  const row = document.createElement("div");
  row.className = "settings-row";
  const l = document.createElement("div");
  l.className = "settings-row-label";
  l.textContent = label;
  const cell = document.createElement("div");
  cell.className = "settings-row-control";
  row.append(l, cell);
  return { row, cell };
}

/** "원격 공유" 패널을 빌드한다. `getVaultOptions`는 마운트/새로고침 시점마다
 *  다시 호출되는 pull(살아있는 workspace 상태 — main.ts가 `workspaceStore`를
 *  쥐고 있다) — 여기서 구독하지 않는다(모달이 열릴 때마다 재마운트되므로
 *  fresh-per-open이면 충분, viewer-toggles의 `listViewers()`와 같은 pull
 *  패턴). 반환된 root는 modal.ts의 일반 teardown 경로(controls.ts의
 *  attachTeardown/runTeardown)로 정리된다 — interval 정리를 위해 반드시
 *  attachTeardown을 호출한다. */
export function renderRemoteSharePane(getVaultOptions: () => readonly VaultOption[]): HTMLElement {
  const root = document.createElement("div");
  root.className = "remote-share-pane";

  const heading = document.createElement("div");
  heading.className = "remote-share-heading";
  heading.textContent = "원격 공유";
  root.appendChild(heading);

  const error = document.createElement("div");
  error.className = "remote-share-error";
  error.hidden = true;
  root.appendChild(error);

  const notice = document.createElement("div");
  notice.className = "remote-share-notice";
  notice.hidden = true;
  notice.textContent = "macOS가 네트워크 연결 수신을 허용할지 물어봅니다 — 허용해야 다른 기기에서 접속할 수 있습니다.";
  root.appendChild(notice);

  // ── 1. 공유 켜기 ───────────────────────────────────────────────────────
  const { row: enableRowEl, cell: enableCell } = labeledRow("공유 켜기");
  const enableGroup = document.createElement("div");
  enableGroup.className = "settings-segmented";
  const onBtn = document.createElement("button");
  onBtn.type = "button";
  onBtn.className = "settings-seg-btn";
  onBtn.textContent = "켜기";
  const offBtn = document.createElement("button");
  offBtn.type = "button";
  offBtn.className = "settings-seg-btn";
  offBtn.textContent = "끄기";
  enableGroup.append(onBtn, offBtn);
  enableCell.appendChild(enableGroup);
  const enableHint = document.createElement("div");
  enableHint.className = "remote-share-hint";
  enableCell.appendChild(enableHint);
  root.appendChild(enableRowEl);

  // ── 2. 볼트 체크박스 ───────────────────────────────────────────────────
  const { row: vaultsRowEl, cell: vaultsCell } = labeledRow("공유할 볼트");
  const vaultList = document.createElement("div");
  vaultList.className = "remote-share-vault-list";
  vaultsCell.appendChild(vaultList);
  root.appendChild(vaultsRowEl);

  // ── 3. 바인드 방식 ─────────────────────────────────────────────────────
  const { row: bindRowEl, cell: bindCell } = labeledRow("바인드 방식");
  const bindGroup = document.createElement("div");
  bindGroup.className = "settings-segmented";
  const tailscaleBtn = document.createElement("button");
  tailscaleBtn.type = "button";
  tailscaleBtn.className = "settings-seg-btn";
  tailscaleBtn.textContent = "Tailscale";
  const localhostBtn = document.createElement("button");
  localhostBtn.type = "button";
  localhostBtn.className = "settings-seg-btn";
  localhostBtn.textContent = "로컬호스트만 (SSH 터널)";
  bindGroup.append(tailscaleBtn, localhostBtn);
  bindCell.appendChild(bindGroup);
  const bindHint = document.createElement("div");
  bindHint.className = "remote-share-hint";
  bindCell.appendChild(bindHint);
  root.appendChild(bindRowEl);

  // ── 4. 페어링 코드 ─────────────────────────────────────────────────────
  const { row: codeRowEl, cell: codeCell } = labeledRow("페어링 코드");
  const issueBtn = document.createElement("button");
  issueBtn.type = "button";
  issueBtn.className = "remote-share-issue-btn";
  issueBtn.textContent = "페어링 코드 만들기";
  const codeDisplay = document.createElement("div");
  codeDisplay.className = "remote-share-code";
  codeDisplay.hidden = true;
  codeCell.append(issueBtn, codeDisplay);
  root.appendChild(codeRowEl);

  // ── 5. 페어링된 기기 ───────────────────────────────────────────────────
  const { row: devicesRowEl, cell: devicesCell } = labeledRow("페어링된 기기");
  const deviceList = document.createElement("div");
  deviceList.className = "remote-share-device-list";
  devicesCell.appendChild(deviceList);
  root.appendChild(devicesRowEl);

  // ── 로컬 상태(클로저 — 백엔드가 진실이고, 이건 "다음에 보낼 pending 값") ──
  let armedVaultIds: string[] = [];
  let bindMode: BindMode = "tailscale";
  let port = DEFAULT_PORT;
  let running = false;
  let devices: readonly DeviceInfo[] = [];
  let tailscaleAvailable = true; // refreshTailscaleAvailability의 프로브 결과가 오기 전까지는 낙관
  let issuedCode: IssuedCode | null = null;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;
  let busy = false; // 동시 invoke 중첩 방지(연타 가드)

  const showError = (msg: string): void => {
    error.textContent = msg;
    error.hidden = false;
  };
  const clearError = (): void => {
    error.hidden = true;
    error.textContent = "";
  };

  const stopCountdown = (): void => {
    if (countdownTimer !== null) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  };

  /** 발급된 코드를 지운다 — restart/stop 시도(성공이든 실패든)마다 반드시
   *  호출한다(fix round 1 finding 2). 백엔드는 매 재시작마다 이전 코드를
   *  `PairingState::unarmed()`로 무효화하고, stop은 `/pair`가 붙을 서버
   *  자체를 내린다 — 두 경우 다 화면의 코드가 더 이상 교환 가능하지 않다.
   *  볼트 체크박스 토글 하나가 실행 중 재시작을 트리거하므로 꽤 자주
   *  일어난다(예전엔 죽은 코드를 계속 카운트다운했다). */
  const clearIssuedCode = (): void => {
    issuedCode = null;
    stopCountdown();
  };

  /** 코드 표시를 갱신한다. 만료돼도 `issuedCode` 자체는 지우지 않고
   *  "만료됨"을 보여준다(fix round 1: 조용히 사라지던 예전 동작 대신 명시적
   *  상태) — 실제로 무효화되는 시점은 `clearIssuedCode`(재시작/정지 시도)뿐. */
  const renderCode = (): void => {
    if (!issuedCode) {
      codeDisplay.hidden = true;
      return;
    }
    codeDisplay.hidden = false;
    if (codeExpired(Date.now(), issuedCode.issued_at_ms)) {
      codeDisplay.textContent = `${issuedCode.code} — 만료됨`;
      stopCountdown();
      return;
    }
    const remaining = codeRemainingMs(Date.now(), issuedCode.issued_at_ms);
    codeDisplay.textContent = `${issuedCode.code} (${formatCountdown(remaining)} 남음)`;
  };

  const startCountdown = (): void => {
    stopCountdown();
    countdownTimer = setInterval(renderCode, 1000);
  };

  /** 화면 전체를 지금의 로컬 상태로 다시 그린다. DOM 그리기 전담 — invoke는
   *  절대 여기서 부르지 않는다(CQS: 이 함수는 command지만 IO는 없음). */
  const render = (): void => {
    onBtn.setAttribute("aria-pressed", String(running));
    offBtn.setAttribute("aria-pressed", String(!running));
    const canEnable = canEnableSharing(armedVaultIds);
    onBtn.disabled = !canEnable && !running;
    enableHint.textContent = canEnable || running ? "" : "공유할 볼트를 먼저 선택하세요";

    vaultList.replaceChildren();
    for (const opt of getVaultOptions()) {
      const item = document.createElement("label");
      item.className = "settings-vtoggle-item remote-share-vault-item";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "remote-share-checkbox";
      box.checked = armedVaultIds.includes(opt.id);
      box.addEventListener("change", () => void onToggleVault(opt.id));
      const name = document.createElement("span");
      name.className = "settings-vtoggle-label";
      name.textContent = opt.displayName;
      item.append(box, name);
      vaultList.appendChild(item);
    }

    tailscaleBtn.setAttribute("aria-pressed", String(bindMode === "tailscale"));
    localhostBtn.setAttribute("aria-pressed", String(bindMode === "localhost-only"));
    tailscaleBtn.disabled = !tailscaleAvailable;
    bindHint.textContent = tailscaleAvailable ? "" : "Tailscale이 감지되지 않았습니다";

    issueBtn.disabled = !running || busy;
    renderCode();

    deviceList.replaceChildren();
    if (devices.length === 0) {
      const empty = document.createElement("div");
      empty.className = "remote-share-empty";
      empty.textContent = "페어링된 기기가 없습니다.";
      deviceList.appendChild(empty);
    }
    for (const d of devices) {
      const item = document.createElement("div");
      item.className = "settings-vtoggle-item remote-share-device-item";
      const label = document.createElement("span");
      label.className = "settings-vtoggle-label";
      label.textContent = d.label;
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = "remote-share-revoke-btn";
      revoke.textContent = "연결 해제";
      revoke.addEventListener("click", () => void onRevokeDevice(d.id));
      item.append(label, revoke);
      deviceList.appendChild(item);
    }
  };

  /** running/port/devices만 백엔드 진실로 맞춘다 — armedVaultIds/bindMode
   *  ("pending" 편집값)는 건드리지 않는다. 기기 목록만 바뀌는 새로고침
   *  (연결 해제)이 공유가 꺼져 있는 동안 사용자가 아직 적용하지 않은 볼트
   *  체크박스 선택을 지워버리는 걸 막는다(fix round 1 finding 4). */
  const syncRunningAndDevices = (status: ShareStatus): void => {
    running = status.running;
    port = status.port;
    devices = status.devices;
  };

  /** armedVaultIds/bindMode("pending" 편집값)를 백엔드 진실로 되돌린다.
   *  mount 시점(아직 아무것도 편집 안 함)과 start/stop 시도 직후(성공이든
   *  실패든 — 9b 브리프: "재시작 실패 시 remote_share_status를 다시 읽어
   *  그 결과로 렌더")에만 호출한다. 기기 목록만 갱신할 때는 호출하지
   *  않는다(위 syncRunningAndDevices와 분리한 이유). */
  const syncPendingFromStatus = (status: ShareStatus): void => {
    bindMode = status.bind_mode;
    armedVaultIds = armedIdsFromStatus(status);
  };

  /** 전체 재동기화(running/port/devices + pending armedVaultIds/bindMode) —
   *  mount, applyStart/applyStop 직후에만 쓴다. */
  const refreshStatus = async (): Promise<void> => {
    try {
      const status = await fetchStatus();
      syncRunningAndDevices(status);
      syncPendingFromStatus(status);
    } catch (err) {
      showError(errorText(err));
    }
    render();
  };

  /** 부분 재동기화(running/port/devices만) — 기기 철회처럼 pending 편집값과
   *  무관한 변화를 반영할 때 쓴다. */
  const refreshRunningAndDevices = async (): Promise<void> => {
    try {
      syncRunningAndDevices(await fetchStatus());
    } catch (err) {
      showError(errorText(err));
    }
    render();
  };

  /** Tailscale 가용성을 사전 프로브로 확인한다(mount 시 1회). 프로브
   *  자체가 실패(IPC 에러)하면 사용자를 막지 않도록 낙관("available")으로
   *  둔다 — 실제 시작 시도가 진짜 에러를 보여줄 것이다. 아직 시작 전이고
   *  bindMode가 기본값 "tailscale"인데 감지가 false로 나오면, 적용된 적
   *  없는 pending 값이므로 로컬호스트로 미리 내려준다(선택된 채 비활성인
   *  모순된 화면을 피한다) — 이미 그 모드로 돌고 있는 세션(running=true)은
   *  건드리지 않는다. */
  const refreshTailscaleAvailability = async (): Promise<void> => {
    try {
      tailscaleAvailable = await checkTailscaleAvailable();
    } catch {
      tailscaleAvailable = true;
    }
    if (!tailscaleAvailable && bindMode === "tailscale" && !running) bindMode = "localhost-only";
    render();
  };

  /** 지금의 pending armedVaultIds/bindMode로 stop→start를 건다(백엔드가
   *  적용을 항상 전체 재시작으로 처리하므로 — task-9a-report.md). 실패하면
   *  서버는 이미 내려가 있을 수 있으니(9a: "재시작 실패 시 이전 서버는 이미
   *  사라졌다") 절대 낙관적으로 running=true를 유지하지 않고 반드시
   *  refreshStatus로 되돌아간다. */
  const applyStart = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    clearError();
    clearIssuedCode(); // 이번 시도가 성공하든 실패 후 서버가 내려가든, 이전 코드는 죽는다(finding 2)
    const vaults = buildVaultsToArm(getVaultOptions(), armedVaultIds);
    const wasRunning = running;
    try {
      await startShare(bindMode, port, vaults);
      if (!wasRunning) notice.hidden = false; // "처음 켤 때" 안내 — off→on 전환마다(이 방화벽 프롬프트는 매번 유효하다)
      await refreshStatus();
    } catch (err) {
      showError(errorText(err));
      await refreshStatus(); // 실패 후에도 항상 백엔드 진실로 재동기화
    } finally {
      busy = false;
      render();
    }
  };

  const applyStop = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    clearError();
    clearIssuedCode(); // 서버가 내려가면 /pair 자체가 없다 — 코드는 곧장 무효(finding 2)
    try {
      await stopShare();
      await refreshStatus();
    } catch (err) {
      showError(errorText(err));
      await refreshStatus();
    } finally {
      busy = false;
      render();
    }
  };

  onBtn.addEventListener("click", () => {
    if (running || !canEnableSharing(armedVaultIds)) return;
    void applyStart();
  });
  offBtn.addEventListener("click", () => {
    if (!running) return;
    void applyStop();
  });

  const onToggleVault = async (id: string): Promise<void> => {
    armedVaultIds = toggleVaultId(armedVaultIds, id);
    if (!running) {
      render();
      return;
    }
    if (!canEnableSharing(armedVaultIds)) {
      await applyStop(); // 마지막 볼트를 해제하면 백엔드가 어차피 빈 목록을 거부한다 — 미리 끈다
      return;
    }
    await applyStart(); // 실행 중 변경 = 즉시 재적용(stop→start)
  };

  tailscaleBtn.addEventListener("click", () => {
    if (bindMode === "tailscale" || !tailscaleAvailable) return;
    bindMode = "tailscale";
    if (running) void applyStart();
    else render();
  });
  localhostBtn.addEventListener("click", () => {
    if (bindMode === "localhost-only") return;
    bindMode = "localhost-only";
    if (running) void applyStart();
    else render();
  });

  issueBtn.addEventListener("click", () => void onIssueCode());
  const onIssueCode = async (): Promise<void> => {
    if (busy || !running) return;
    busy = true;
    clearError();
    try {
      issuedCode = await issueCode();
      startCountdown();
    } catch (err) {
      showError(errorText(err));
    } finally {
      busy = false;
      render();
    }
  };

  const onRevokeDevice = async (id: string): Promise<void> => {
    if (busy) return;
    busy = true;
    clearError();
    try {
      await revokeDevice(id);
      await refreshRunningAndDevices(); // pending armedVaultIds/bindMode는 건드리지 않는다(finding 4)
    } catch (err) {
      showError(errorText(err));
      await refreshRunningAndDevices();
    } finally {
      busy = false;
      render();
    }
  };

  render();
  void refreshStatus(); // 마운트 시 백엔드의 "마지막 구성값"으로 미리 채운다(9a 보고서 §2)
  void refreshTailscaleAvailability(); // 마운트 시 Tailscale 가용성을 사전 프로브(finding 3)

  attachTeardown(root, [() => stopCountdown()]);

  return root;
}
