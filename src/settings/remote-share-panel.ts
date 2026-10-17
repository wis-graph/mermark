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
import { listen } from "@tauri-apps/api/event";
import { attachTeardown } from "./panel/controls";
import { DEFAULT_SHARE_PORT, remoteSharePortSetting, shareStartErrorMessage, sharePortProblem } from "./remote-share-port";
import type { Vault, WorkspaceState } from "../workspace/workspace-state";
import {
  checkTailscaleAvailable,
  fetchStatus,
  issueCode,
  revokeDevice,
  startShare,
  stopShare,
  type BindMode,
  type DeviceInfo,
  type IssuedCode,
  type ShareStatus,
  type VaultToArm,
} from "./remote-share-ipc";

// ── Wire types는 remote-share-ipc.ts가 소유 — 기존 import 경로 보존용 re-export ──
export type { BindMode, VaultToArm, ArmedVaultInfo, DeviceInfo, ShareStatus, IssuedCode } from "./remote-share-ipc";

/** 프론트가 아는 "공유 가능한 볼트" 1개(로컬 workspace state에서 뽑음). */
export interface VaultOption {
  readonly id: string;
  readonly displayName: string;
  readonly root: string;
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

/** 패널의 pending 선택(체크박스·바인드 방식)을 백엔드 상태에서 되돌린다.
 *  `last_selection`(Rust가 소유한 "마지막 선택")이 있으면 그것 — CLI가 이름 없이 켤 때
 *  쓰는 값과 같아서, 재시작 직후에도 패널이 CLI와 같은 선택을 보여준다. 없으면 현재 armed.
 *  Pure query — 이 패널은 기억값을 쓰지 않는다(writer는 Rust share_start 하나). */
export function pendingSelectionFrom(status: Pick<ShareStatus, "vaults" | "bind_mode" | "last_selection">): { armedVaultIds: string[]; bindMode: BindMode } {
  if (status.last_selection) {
    return { armedVaultIds: status.last_selection.vaults.map((v) => v.id), bindMode: status.last_selection.bind_mode };
  }
  return { armedVaultIds: armedIdsFromStatus(status), bindMode: status.bind_mode };
}

/** `ShareStatus.vaults`에서 armed id 목록만 뽑는다 — 재시작 실패 후 백엔드
 *  진실로 되돌아갈 때(`remote_share_status` 재조회) 이 함수로 로컬 pending
 *  선택을 다시 맞춘다. */
export function armedIdsFromStatus(status: Pick<ShareStatus, "vaults">): string[] {
  return status.vaults.map((v) => v.id);
}

/** 실패 메시지 추출 — invoke가 던지는 값은 Tauri에서 보통 문자열(`Result<_,
 *  String>`이 그대로 reject됨)이지만 Error 인스턴스일 수도 있어 방어적으로
 *  통일한다. */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

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

  // ── 3b. 공유 포트 (2026-09-26, _workspace/00_request.md — 8787이 사용자의
  //    맥미니에서 다른 서비스와 충돌해 공유를 켤 수 없었다) ──────────────────
  // SSOT는 remoteSharePortSetting(설정)이다 — status.port는 "지금 도는 포트"
  // (표시용)일 뿐, 이 입력의 진짜 값은 절대 아니다(pitfall 1: syncRunningAndDevices
  // 참고).
  const { row: portRowEl, cell: portCell } = labeledRow("공유 포트");
  const portInput = document.createElement("input");
  portInput.type = "text";
  portInput.inputMode = "numeric";
  portInput.className = "settings-text remote-share-port-input"; // .settings-text = 패널 공용 텍스트 입력 스타일(controls.ts의 renderText와 동일)
  portCell.appendChild(portInput);
  const portError = document.createElement("div");
  portError.className = "remote-share-port-error";
  portError.hidden = true;
  portCell.appendChild(portError);
  const portNotice = document.createElement("div");
  portNotice.className = "remote-share-hint remote-share-port-notice";
  portCell.appendChild(portNotice);
  root.appendChild(portRowEl);

  // ── 4. 페어링 코드 ─────────────────────────────────────────────────────
  const { row: codeRowEl, cell: codeCell } = labeledRow("페어링 코드");
  const issueBtn = document.createElement("button");
  issueBtn.type = "button";
  issueBtn.className = "remote-share-issue-btn";
  issueBtn.textContent = "페어링 코드 만들기";
  const codeDisplay = document.createElement("div");
  codeDisplay.className = "remote-share-code";
  codeDisplay.hidden = true;
  // 공유 포트가 기본(DEFAULT_SHARE_PORT)이 아니면, 클라이언트는 호스트 칸에
  // `이름:포트`를 적어야 페어링이 된다(remote-vault-dialog.ts) — 코드를 발급받는
  // 그 순간 같이 알려준다.
  const codeClientHint = document.createElement("div");
  codeClientHint.className = "remote-share-hint remote-share-code-client-hint";
  codeCell.append(issueBtn, codeDisplay, codeClientHint);
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
  let port = remoteSharePortSetting.get(); // SSOT는 설정이다 — status.port로 절대 덮어쓰지 않는다(pitfall 1)
  // "지금 도는 포트"(표시용). syncRunningAndDevices에서만 갱신되고, 위 `port`
  // (설정 SSOT, "다음에 켤 포트")와는 별개다 — 이 둘을 섞으면 pitfall 1이 재발한다.
  let runningPort: number | null = null;
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
      codeClientHint.textContent = "";
      return;
    }
    codeDisplay.hidden = false;
    // 비기본 포트로 공유 중이면 클라이언트가 호스트 칸에 `이름:포트`를
    // 적어야 한다 — 코드가 만료됐어도 포트 자체는 안 바뀌므로 이 힌트는
    // 만료 분기 이전에 항상 채운다. 감사 🟡-3: localhost-only는 Tailscale
    // 주소가 없어 클라이언트가 SSH 터널로만 들어올 수 있으므로, 그 모드일
    // 땐 Tailscale 형식(`<이름>:포트`)이 아니라 새 SSH 문법
    // (`?share-port=`)을 안내해야 한다 — 옛 힌트는 정작 이 라운드가 만든
    // 문법을 호스트 UI가 안내하지 않는 공백이었다.
    codeClientHint.textContent =
      runningPort !== null && runningPort !== DEFAULT_SHARE_PORT
        ? bindMode === "localhost-only"
          ? `클라이언트 호스트 칸: ssh://사용자@호스트?share-port=${runningPort}`
          : `클라이언트 호스트 칸: <이름>:${runningPort}`
        : "";
    if (codeExpired(Date.now(), issuedCode.issued_at_ms)) {
      codeDisplay.textContent = `${issuedCode.code} — 만료됨`;
      stopCountdown();
      return;
    }
    const remaining = codeRemainingMs(Date.now(), issuedCode.issued_at_ms);
    codeDisplay.textContent = `${issuedCode.code} (${formatCountdown(remaining)} 남음)`;
  };

  /** "공유 포트" 행의 안내: 지금 실제로 도는 포트(`runningPort`, 표시용)와
   *  사용자가 방금 편집한 SSOT 포트(`port`)가 다르면, 다시 켤 때 뭐가
   *  바뀌는지 미리 알려준다. 둘 다 순수 표시 상태라 이 함수는 invoke를
   *  절대 부르지 않는다. */
  const renderPortNotice = (): void => {
    if (!(running && runningPort !== null && runningPort !== port)) {
      portNotice.textContent = "";
      return;
    }
    const base = `지금은 ${runningPort}에서 공유 중 — 다시 켜면 ${port}으로 바뀝니다`;
    // 감사 🟡-3: 페어링된 기기가 있으면 그 기기들은 지금 runningPort로만
    // 도달 가능하다 — 다시 켜서 port로 바뀌는 순간 전부 "연결 안 됨"이
    // 된다(토큰 키가 호스트 문자열이라 클라이언트가 새 포트로 볼트를
    // 다시 추가해야 함, README 참고). 기기가 없으면 그 위험이 없다.
    portNotice.textContent = devices.length > 0 ? `${base}. 기존 기기는 이 볼트를 새 포트로 다시 추가해야 합니다.` : base;
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

    renderPortNotice();

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

  /** running/runningPort/devices만 백엔드 진실로 맞춘다 — armedVaultIds/bindMode
   *  ("pending" 편집값)는 건드리지 않는다. 기기 목록만 바뀌는 새로고침
   *  (연결 해제)이 공유가 꺼져 있는 동안 사용자가 아직 적용하지 않은 볼트
   *  체크박스 선택을 지워버리는 걸 막는다(fix round 1 finding 4).
   *
   *  **pitfall 1 (47878 포트 변경 라운드)**: 여기서 `port = status.port`를
   *  했었다면, 앱을 재시작할 때마다 사용자가 "공유 포트"에 저장해 둔 값이
   *  백엔드의 마지막 실행값(또는 그 기본값)으로 조용히 지워졌을 것이다.
   *  `port`(설정 SSOT, "다음에 켤 포트")는 여기서 절대 대입하지 않는다 —
   *  status는 오직 `runningPort`(표시용, "지금 도는 포트")에만 흐른다. */
  const syncRunningAndDevices = (status: ShareStatus): void => {
    running = status.running;
    runningPort = status.port;
    devices = status.devices;
  };

  /** armedVaultIds/bindMode("pending" 편집값)를 백엔드 진실로 되돌린다.
   *  mount 시점(아직 아무것도 편집 안 함)과 start/stop 시도 직후(성공이든
   *  실패든 — 9b 브리프: "재시작 실패 시 remote_share_status를 다시 읽어
   *  그 결과로 렌더")에만 호출한다. 기기 목록만 갱신할 때는 호출하지
   *  않는다(위 syncRunningAndDevices와 분리한 이유). */
  const syncPendingFromStatus = (status: ShareStatus): void => {
    const pending = pendingSelectionFrom(status);
    bindMode = pending.bindMode;
    armedVaultIds = pending.armedVaultIds;
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
    // 감사 🟢(applyStart catch): portInput은 busy 중에도 비활성화되지
    // 않으므로, await 도중 사용자가 포트를 바꾸면 실패 메시지가 실제로
    // 시도한 포트가 아니라 그 사이 바뀐 값을 가리킬 수 있었다. await 전에
    // 캡처해 catch에서는 항상 이 시도의 포트를 쓴다.
    const attemptedPort = port;
    try {
      await startShare(bindMode, attemptedPort, vaults);
      if (!wasRunning) notice.hidden = false; // "처음 켤 때" 안내 — off→on 전환마다(이 방화벽 프롬프트는 매번 유효하다)
      await refreshStatus();
    } catch (err) {
      // shareStartErrorMessage (design §2.1): PORT_IN_USE:/PORT_INVALID:를
      // 사람이 읽을 안내로 바꾼다(그 외는 기존 errorText와 동일하게
      // 원문을 그대로 보여준다) — 이 catch만 해당, 다른 실패 경로
      // (issue/revoke/stop)는 여전히 errorText다.
      showError(shareStartErrorMessage(err, attemptedPort));
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

  // 공유 포트 입력: 유효한 값만 SSOT(remoteSharePortSetting)에 저장한다 —
  // 무효 입력은 인라인 오류만 보이고 설정/`port`는 그대로 남는다(design
  // §2.3 (c)). 적용은 기존 stop→start 경로를 그대로 쓴다(여기서 새로 켜지
  // 않는다) — 공유 중이면 `renderPortNotice`가 "다시 켜면 바뀐다"를 안내한다.
  portInput.value = String(port);
  portInput.addEventListener("input", () => {
    const raw = portInput.value;
    const problem = sharePortProblem(raw);
    if (problem) {
      portError.textContent = problem;
      portError.hidden = false;
      return;
    }
    portError.hidden = true;
    portError.textContent = "";
    port = Number(raw.trim());
    remoteSharePortSetting.set(port);
    renderPortNotice();
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

  // CLI(`mermark share on|off`)나 다른 창이 공유 상태를 바꾸면 Rust가
  // `remote-share-changed`를 emit한다 — 열려 있는 패널이 즉시 따라간다. 재시작마다
  // 백엔드가 페어링 코드를 무효화하므로 화면의 코드도 버린다. busy면 진행 중인 자기
  // 작업의 finally가 어차피 재동기화한다. listen은 Promise라 teardown이 먼저 올 수 있다.
  let tornDown = false;
  let unlisten: (() => void) | null = null;
  const onShareChanged = (): void => {
    if (tornDown) return;
    clearIssuedCode();
    if (busy) render();
    else void refreshStatus();
  };
  listen("remote-share-changed", onShareChanged)
    .then((off) => {
      if (tornDown) off();
      else unlisten = off;
    })
    .catch(() => {}); // 이벤트 버스가 없는 환경(테스트 등)에서는 라이브 갱신만 빠진다

  attachTeardown(root, [
    () => stopCountdown(),
    () => {
      tornDown = true;
      unlisten?.();
      unlisten = null;
    },
  ]);

  return root;
}
