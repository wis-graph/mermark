import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// invoke() is mocked directly per-test via a controllable fn — the panel talks
// to six host commands (remote_share_status/start/stop, remote_issue_code,
// remote_revoke_device, remote_tailscale_available); no real Tauri runtime
// exists under jsdom.
const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { createSettingsButton } from "../src/settings/panel/modal";
import { registerSetting } from "../src/settings/registry";
import {
  PAIRING_TTL_MS,
  codeRemainingMs,
  codeExpired,
  formatCountdown,
  canEnableSharing,
  toggleVaultId,
  buildVaultsToArm,
  armedIdsFromStatus,
  shareableVaultsFrom,
  type VaultOption,
  type ShareStatus,
} from "../src/settings/remote-share-panel";
import type { WorkspaceState } from "../src/workspace/workspace-state";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── 순수 함수 ────────────────────────────────────────────────────────────

describe("remote-share-panel — 순수 함수", () => {
  it("코드는 5분(300000ms) 뒤 만료로 표시된다", () => {
    expect(PAIRING_TTL_MS).toBe(300_000);
    expect(codeRemainingMs(0, 0)).toBe(300_000);
    expect(codeRemainingMs(299_999, 0)).toBe(1);
    expect(codeRemainingMs(300_000, 0)).toBe(0);
    expect(codeExpired(300_000, 0)).toBe(true);
    expect(codeExpired(299_999, 0)).toBe(false);
  });

  it("카운트다운을 mm:ss로 표시한다", () => {
    expect(formatCountdown(300_000)).toBe("5:00");
    expect(formatCountdown(61_000)).toBe("1:01");
    expect(formatCountdown(500)).toBe("0:01"); // ceil이라 0으로 스냅되기 전 최소 1초 보임
    expect(formatCountdown(0)).toBe("0:00");
  });

  it("볼트를 하나도 고르지 않으면 켤 수 없다", () => {
    expect(canEnableSharing([])).toBe(false);
    expect(canEnableSharing(["v1"])).toBe(true);
  });

  it("토글은 집합을 뒤집은 새 배열을 반환한다(원본 불변)", () => {
    const armed = ["v1"];
    const next = toggleVaultId(armed, "v2");
    expect(next).toEqual(["v1", "v2"]);
    expect(armed).toEqual(["v1"]); // 원본 mutate 안 함
    expect(toggleVaultId(next, "v1")).toEqual(["v2"]);
  });

  it("armed 볼트를 wire shape(VaultToArm, display_name snake_case)로 직렬화한다", () => {
    const options: VaultOption[] = [
      { id: "v1", displayName: "노트", root: "/Users/x/notes" },
      { id: "v2", displayName: "일기", root: "/Users/x/diary" },
    ];
    const result = buildVaultsToArm(options, ["v2"]);
    expect(result).toEqual([{ id: "v2", display_name: "일기", root: "/Users/x/diary" }]);
    // camelCase로 새면 안 된다 — 백엔드 VaultToArm은 rename_all이 없다.
    expect(Object.keys(result[0])).not.toContain("displayName");
  });

  it("ShareStatus.vaults에서 armed id만 뽑는다", () => {
    const status: Pick<ShareStatus, "vaults"> = { vaults: [{ id: "v1", display_name: "노트" }] };
    expect(armedIdsFromStatus(status)).toEqual(["v1"]);
  });

  it("permanent 볼트만 공유 후보로 남기고 global/remote는 제외한다", () => {
    const state: WorkspaceState = {
      currentWorkspaceId: "w1",
      workspaces: [],
      vaults: [
        { vaultId: "v1", workspaceId: "w1", displayName: "노트", rootPath: "/a", persistenceKind: "permanent", explorerRoot: "/a" },
        { vaultId: "vault-global", workspaceId: "w1", displayName: "글로벌", rootPath: null, persistenceKind: "global", explorerRoot: null },
        {
          vaultId: "v2",
          workspaceId: "w1",
          displayName: "원격볼트",
          rootPath: null,
          persistenceKind: "remote",
          explorerRoot: "/",
          host: "h",
          remoteVaultId: "rv1",
        },
      ],
    };
    expect(shareableVaultsFrom(state)).toEqual([{ id: "v1", displayName: "노트", root: "/a" }]);
  });
});

// ── DOM: 설정 패널 통합 ─────────────────────────────────────────────────────

const VAULTS: VaultOption[] = [{ id: "v1", displayName: "노트", root: "/Users/x/notes" }];

const OFF_STATUS: ShareStatus = { running: false, bind_mode: "tailscale", port: 8787, vaults: [], devices: [] };

const RUNNING_STATUS: ShareStatus = {
  running: true,
  bind_mode: "tailscale",
  port: 8787,
  vaults: [{ id: "v1", display_name: "노트" }],
  devices: [],
};

describe("remote-share-panel — 설정 패널 통합", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    mockInvoke.mockReset();
    registerSetting<string>({
      key: "m.x",
      default: "a",
      ui: { label: "X", group: "테마", control: { kind: "segmented", options: [{ value: "a", label: "A" }] } },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  /** 라우팅 기본값: 명시적으로 오버라이드하지 않은 커맨드는 "꺼짐 상태 +
   *  Tailscale 감지됨"으로 응답한다 — 대부분의 테스트가 신경 쓰지 않는
   *  두 커맨드(remote_share_status, remote_tailscale_available)를 매번
   *  손으로 채우지 않게 한다. */
  function mockRoutes(overrides: Partial<Record<string, () => Promise<unknown>>>): void {
    mockInvoke.mockImplementation((cmd: string) => {
      const handler = overrides[cmd];
      if (handler) return handler();
      if (cmd === "remote_share_status") return Promise.resolve(OFF_STATUS);
      if (cmd === "remote_tailscale_available") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
  }

  function openModal(getVaults: () => readonly VaultOption[] = () => VAULTS): HTMLElement {
    const bar = document.createElement("div");
    document.body.appendChild(bar);
    bar.append(createSettingsButton(getVaults));
    (bar.querySelector(".settings-btn") as HTMLButtonElement).click();
    return document.querySelector(".settings-backdrop") as HTMLElement;
  }

  function openRemoteShareTab(backdrop: HTMLElement): void {
    const cats = [...backdrop.querySelectorAll<HTMLElement>(".settings-cat")];
    const tab = cats.find((c) => c.textContent === "원격 공유");
    tab?.click();
  }

  const segBtn = (backdrop: HTMLElement, text: string): HTMLButtonElement =>
    [...backdrop.querySelectorAll<HTMLButtonElement>(".settings-seg-btn")].find((b) => b.textContent === text)!;

  it("사이드바에 원격 공유 카테고리가 있다", () => {
    mockRoutes({});
    const backdrop = openModal();
    const cats = [...backdrop.querySelectorAll<HTMLElement>(".settings-cat")].map((c) => c.textContent);
    expect(cats).toContain("원격 공유");
  });

  it("볼트가 없으면 켜기 버튼이 비활성 + 안내 문구", async () => {
    mockRoutes({});
    const backdrop = openModal(() => []);
    openRemoteShareTab(backdrop);
    await flush();
    expect(segBtn(backdrop, "켜기").disabled).toBe(true);
    expect(backdrop.textContent).toContain("공유할 볼트를 먼저 선택하세요");
  });

  it("볼트 체크 → 켜기 클릭 시 remote_share_start를 올바른 wire shape으로 호출한다", async () => {
    mockRoutes({});
    const backdrop = openModal();
    openRemoteShareTab(backdrop);
    await flush();

    backdrop.querySelector<HTMLInputElement>(".remote-share-checkbox")!.click();
    await flush();

    const onBtn = segBtn(backdrop, "켜기");
    expect(onBtn.disabled).toBe(false);
    onBtn.click();
    await flush();

    const startCall = mockInvoke.mock.calls.find((c) => c[0] === "remote_share_start");
    expect(startCall).toBeTruthy();
    expect(startCall![1]).toEqual({
      bindMode: "tailscale",
      port: 8787,
      vaults: [{ id: "v1", display_name: "노트", root: "/Users/x/notes" }],
    });
  });

  it("재시작 실패 시 에러 메시지를 그대로 보여주고 remote_share_status로 재동기화한다", async () => {
    mockRoutes({ remote_share_start: () => Promise.reject("포트가 이미 사용 중입니다") });
    const backdrop = openModal();
    openRemoteShareTab(backdrop);
    await flush();
    backdrop.querySelector<HTMLInputElement>(".remote-share-checkbox")!.click();
    await flush();
    segBtn(backdrop, "켜기").click();
    await flush();
    await flush();

    expect(backdrop.querySelector(".remote-share-error")?.textContent).toContain("포트가 이미 사용 중입니다");
    // 실패했으니 status가 다시 조회됐어야 한다(낙관적 running=true로 남지 않음).
    const statusCalls = mockInvoke.mock.calls.filter((c) => c[0] === "remote_share_status").length;
    expect(statusCalls).toBeGreaterThanOrEqual(2); // mount + 실패 후 재조회
  });

  // fix round 1, finding 3: Tailscale 감지는 이제 시작 실패 메시지를 매칭하는
  // 반응형이 아니라, 마운트 시 remote_tailscale_available을 미리 묻는 능동형.
  it("Tailscale이 감지되지 않으면 마운트 시점부터 라디오가 비활성 + 로컬호스트로 기본 선택된다", async () => {
    mockRoutes({ remote_tailscale_available: () => Promise.resolve(false) });
    const backdrop = openModal();
    openRemoteShareTab(backdrop);
    await flush();
    await flush(); // refreshStatus와 refreshTailscaleAvailability 둘 다 settle

    const tailscaleBtn = segBtn(backdrop, "Tailscale");
    const localhostBtn = segBtn(backdrop, "로컬호스트만 (SSH 터널)");
    expect(tailscaleBtn.disabled).toBe(true);
    expect(tailscaleBtn.getAttribute("aria-pressed")).toBe("false");
    expect(localhostBtn.getAttribute("aria-pressed")).toBe("true"); // finding 1: 더 이상 disabled+selected로 어긋나지 않는다
    expect(backdrop.textContent).toContain("Tailscale이 감지되지 않았습니다");
  });

  it("이미 Tailscale로 실행 중이면 감지 실패가 와도 현재 선택을 강제로 바꾸지 않는다", async () => {
    mockRoutes({ remote_share_status: () => Promise.resolve(RUNNING_STATUS), remote_tailscale_available: () => Promise.resolve(false) });
    const backdrop = openModal();
    openRemoteShareTab(backdrop);
    await flush();
    await flush();

    const tailscaleBtn = segBtn(backdrop, "Tailscale");
    expect(tailscaleBtn.disabled).toBe(true); // 더 이상 고를 순 없지만
    expect(tailscaleBtn.getAttribute("aria-pressed")).toBe("true"); // 이미 실행 중인 세션의 선택은 그대로 보여준다
  });

  it("공유 중이면 페어링 코드 발급 버튼이 활성화되고, 코드는 남은 시간과 함께 표시된다", async () => {
    mockRoutes({
      remote_share_status: () => Promise.resolve(RUNNING_STATUS),
      remote_issue_code: () => Promise.resolve({ code: "123456", issued_at_ms: Date.now() }),
    });
    const backdrop = openModal();
    openRemoteShareTab(backdrop);
    await flush();

    const issueBtn = backdrop.querySelector<HTMLButtonElement>(".remote-share-issue-btn")!;
    expect(issueBtn.disabled).toBe(false);
    issueBtn.click();
    await flush();

    expect(backdrop.querySelector(".remote-share-code")?.textContent).toContain("123456");
  });

  // fix round 1, finding 2 (일부): 만료돼도 코드가 조용히 사라지지 않고 명시적
  // "만료됨" 상태를 보여준다.
  it("이미 만료된 채로 코드를 받으면 조용히 사라지지 않고 '만료됨'을 보여준다", async () => {
    mockRoutes({
      remote_share_status: () => Promise.resolve(RUNNING_STATUS),
      remote_issue_code: () => Promise.resolve({ code: "999999", issued_at_ms: Date.now() - PAIRING_TTL_MS - 1000 }),
    });
    const backdrop = openModal();
    openRemoteShareTab(backdrop);
    await flush();
    backdrop.querySelector<HTMLButtonElement>(".remote-share-issue-btn")!.click();
    await flush();

    const codeDisplay = backdrop.querySelector<HTMLElement>(".remote-share-code")!;
    expect(codeDisplay.hidden).toBe(false);
    expect(codeDisplay.textContent).toContain("999999");
    expect(codeDisplay.textContent).toContain("만료됨");
  });

  // fix round 1, finding 2: 재시작(볼트 토글 → stop→start)이 이전에 발급된
  // 페어링 코드를 죽은 채 카운트다운시키지 않고 즉시 지운다.
  it("실행 중 볼트를 토글해 재시작하면 이전에 발급된 페어링 코드가 사라진다", async () => {
    const twoVaults: VaultOption[] = [
      { id: "v1", displayName: "노트", root: "/Users/x/notes" },
      { id: "v2", displayName: "일기", root: "/Users/x/diary" },
    ];
    mockRoutes({
      remote_share_status: () => Promise.resolve(RUNNING_STATUS), // v1만 armed
      remote_issue_code: () => Promise.resolve({ code: "123456", issued_at_ms: Date.now() }),
      remote_share_start: () => Promise.resolve(undefined),
    });
    const backdrop = openModal(() => twoVaults);
    openRemoteShareTab(backdrop);
    await flush();

    backdrop.querySelector<HTMLButtonElement>(".remote-share-issue-btn")!.click();
    await flush();
    expect(backdrop.querySelector(".remote-share-code")?.textContent).toContain("123456");

    // v2를 체크 → 이미 running이므로 applyStart(재시작)를 즉시 트리거한다.
    const v2Checkbox = [...backdrop.querySelectorAll<HTMLInputElement>(".remote-share-checkbox")][1];
    v2Checkbox.click();
    await flush();
    await flush();

    const codeDisplay = backdrop.querySelector<HTMLElement>(".remote-share-code")!;
    expect(codeDisplay.hidden).toBe(true);
  });

  it("공유를 끄면 페어링 코드가 사라진다", async () => {
    mockRoutes({
      remote_share_status: () => Promise.resolve(RUNNING_STATUS),
      remote_issue_code: () => Promise.resolve({ code: "123456", issued_at_ms: Date.now() }),
      remote_share_stop: () => Promise.resolve(undefined),
    });
    const backdrop = openModal();
    openRemoteShareTab(backdrop);
    await flush();

    backdrop.querySelector<HTMLButtonElement>(".remote-share-issue-btn")!.click();
    await flush();
    expect(backdrop.querySelector(".remote-share-code")?.textContent).toContain("123456");

    segBtn(backdrop, "끄기").click();
    await flush();
    await flush();

    const codeDisplay = backdrop.querySelector<HTMLElement>(".remote-share-code")!;
    expect(codeDisplay.hidden).toBe(true);
  });

  // fix round 1, finding 4: 공유가 꺼진 동안의 기기 철회(remote_share_status
  // 재조회를 일으킴)가 아직 적용하지 않은 볼트 체크박스 선택을 지우면 안 된다.
  it("공유가 꺼진 상태에서 기기 연결 해제를 눌러도 미적용 볼트 선택은 지워지지 않는다", async () => {
    const offWithDevice: ShareStatus = { ...OFF_STATUS, devices: [{ id: "dev-1", label: "맥북", paired_at_ms: 1 }] };
    mockRoutes({
      remote_share_status: () => Promise.resolve(offWithDevice),
      remote_revoke_device: () => Promise.resolve(true),
    });
    const backdrop = openModal();
    openRemoteShareTab(backdrop);
    await flush();

    const checkbox = backdrop.querySelector<HTMLInputElement>(".remote-share-checkbox")!;
    checkbox.click(); // 아직 적용 안 한 pending 선택
    await flush();
    expect(checkbox.checked).toBe(true);

    backdrop.querySelector<HTMLButtonElement>(".remote-share-revoke-btn")!.click();
    await flush();
    await flush();

    expect(checkbox.checked).toBe(true); // finding 4: 여전히 체크돼 있어야 한다
    const revokeCall = mockInvoke.mock.calls.find((c) => c[0] === "remote_revoke_device");
    expect(revokeCall![1]).toEqual({ id: "dev-1" });
  });

  it("기기 목록에서 연결 해제를 누르면 remote_revoke_device(id)를 호출한다", async () => {
    const runningWithDevice: ShareStatus = { ...RUNNING_STATUS, devices: [{ id: "dev-1", label: "맥북", paired_at_ms: 1 }] };
    mockRoutes({
      remote_share_status: () => Promise.resolve(runningWithDevice),
      remote_revoke_device: () => Promise.resolve(true),
    });
    const backdrop = openModal();
    openRemoteShareTab(backdrop);
    await flush();

    backdrop.querySelector<HTMLButtonElement>(".remote-share-revoke-btn")!.click();
    await flush();

    const revokeCall = mockInvoke.mock.calls.find((c) => c[0] === "remote_revoke_device");
    expect(revokeCall![1]).toEqual({ id: "dev-1" });
  });

  it("토큰이나 볼트의 로컬 파일시스템 root를 절대 렌더하지 않는다", async () => {
    const runningWithDevice: ShareStatus = { ...RUNNING_STATUS, devices: [{ id: "dev-1", label: "맥북", paired_at_ms: 1 }] };
    mockRoutes({ remote_share_status: () => Promise.resolve(runningWithDevice) });
    const backdrop = openModal();
    openRemoteShareTab(backdrop);
    await flush();
    expect(backdrop.textContent).not.toContain("/Users/x/notes"); // VAULTS[0].root
  });
});
