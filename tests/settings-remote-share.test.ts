import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// invoke() is mocked directly per-test via a controllable fn — the panel talks
// to five host commands (remote_share_status/start/stop, remote_issue_code,
// remote_revoke_device); no real Tauri runtime exists under jsdom.
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
  looksLikeTailscaleUnavailable,
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

  it("Tailscale 미감지는 실패 메시지에 'tailscale'이 언급될 때만 반응형으로 판정한다", () => {
    expect(looksLikeTailscaleUnavailable("Tailscale 주소를 찾을 수 없습니다")).toBe(true);
    expect(looksLikeTailscaleUnavailable("tailscale ip -4 실패")).toBe(true);
    expect(looksLikeTailscaleUnavailable("포트가 이미 사용 중입니다")).toBe(false);
  });
});

// ── DOM: 설정 패널 통합 ─────────────────────────────────────────────────────

const VAULTS: VaultOption[] = [{ id: "v1", displayName: "노트", root: "/Users/x/notes" }];

const OFF_STATUS: ShareStatus = { running: false, bind_mode: "tailscale", port: 8787, vaults: [], devices: [] };

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

  it("사이드바에 원격 공유 카테고리가 있다", () => {
    mockInvoke.mockResolvedValue(OFF_STATUS);
    const backdrop = openModal();
    const cats = [...backdrop.querySelectorAll<HTMLElement>(".settings-cat")].map((c) => c.textContent);
    expect(cats).toContain("원격 공유");
  });

  it("볼트가 없으면 켜기 버튼이 비활성 + 안내 문구", async () => {
    mockInvoke.mockResolvedValue(OFF_STATUS);
    const backdrop = openModal(() => []);
    openRemoteShareTab(backdrop);
    await flush();
    const onBtn = [...backdrop.querySelectorAll<HTMLButtonElement>(".settings-seg-btn")].find((b) => b.textContent === "켜기")!;
    expect(onBtn.disabled).toBe(true);
    expect(backdrop.textContent).toContain("공유할 볼트를 먼저 선택하세요");
  });

  it("볼트 체크 → 켜기 클릭 시 remote_share_start를 올바른 wire shape으로 호출한다", async () => {
    mockInvoke.mockImplementation((cmd: string) => (cmd === "remote_share_status" ? Promise.resolve(OFF_STATUS) : Promise.resolve(undefined)));
    const backdrop = openModal();
    openRemoteShareTab(backdrop);
    await flush();

    const checkbox = backdrop.querySelector<HTMLInputElement>(".remote-share-checkbox")!;
    checkbox.click();
    await flush();

    const onBtn = [...backdrop.querySelectorAll<HTMLButtonElement>(".settings-seg-btn")].find((b) => b.textContent === "켜기")!;
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
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "remote_share_status") return Promise.resolve(OFF_STATUS);
      if (cmd === "remote_share_start") return Promise.reject("포트가 이미 사용 중입니다");
      return Promise.resolve(undefined);
    });
    const backdrop = openModal();
    openRemoteShareTab(backdrop);
    await flush();
    backdrop.querySelector<HTMLInputElement>(".remote-share-checkbox")!.click();
    await flush();
    const onBtn = [...backdrop.querySelectorAll<HTMLButtonElement>(".settings-seg-btn")].find((b) => b.textContent === "켜기")!;
    onBtn.click();
    await flush();
    await flush();

    expect(backdrop.querySelector(".remote-share-error")?.textContent).toContain("포트가 이미 사용 중입니다");
    // 실패했으니 status가 다시 조회됐어야 한다(낙관적 running=true로 남지 않음).
    const statusCalls = mockInvoke.mock.calls.filter((c) => c[0] === "remote_share_status").length;
    expect(statusCalls).toBeGreaterThanOrEqual(2); // mount + 실패 후 재조회
  });

  it("Tailscale 실패 메시지를 받으면 Tailscale 라디오를 비활성화하고 안내를 보여준다", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "remote_share_status") return Promise.resolve(OFF_STATUS);
      if (cmd === "remote_share_start") return Promise.reject("Tailscale 주소를 찾을 수 없습니다");
      return Promise.resolve(undefined);
    });
    const backdrop = openModal();
    openRemoteShareTab(backdrop);
    await flush();
    backdrop.querySelector<HTMLInputElement>(".remote-share-checkbox")!.click();
    await flush();
    const onBtn = [...backdrop.querySelectorAll<HTMLButtonElement>(".settings-seg-btn")].find((b) => b.textContent === "켜기")!;
    onBtn.click();
    await flush();
    await flush();

    const tailscaleBtn = [...backdrop.querySelectorAll<HTMLButtonElement>(".settings-seg-btn")].find((b) => b.textContent === "Tailscale")!;
    expect(tailscaleBtn.disabled).toBe(true);
    expect(backdrop.textContent).toContain("Tailscale이 감지되지 않았습니다");
  });

  it("공유 중이면 페어링 코드 발급 버튼이 활성화되고, 코드는 남은 시간과 함께 표시된다", async () => {
    const runningStatus: ShareStatus = { running: true, bind_mode: "tailscale", port: 8787, vaults: [{ id: "v1", display_name: "노트" }], devices: [] };
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "remote_share_status") return Promise.resolve(runningStatus);
      if (cmd === "remote_issue_code") return Promise.resolve({ code: "123456", issued_at_ms: Date.now() });
      return Promise.resolve(undefined);
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

  it("기기 목록에서 연결 해제를 누르면 remote_revoke_device(id)를 호출한다", async () => {
    const runningStatus: ShareStatus = {
      running: true,
      bind_mode: "tailscale",
      port: 8787,
      vaults: [{ id: "v1", display_name: "노트" }],
      devices: [{ id: "dev-1", label: "맥북", paired_at_ms: 1 }],
    };
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "remote_share_status") return Promise.resolve(runningStatus);
      if (cmd === "remote_revoke_device") return Promise.resolve(true);
      return Promise.resolve(undefined);
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
    const runningStatus: ShareStatus = {
      running: true,
      bind_mode: "tailscale",
      port: 8787,
      vaults: [{ id: "v1", display_name: "노트" }],
      devices: [{ id: "dev-1", label: "맥북", paired_at_ms: 1 }],
    };
    mockInvoke.mockResolvedValue(runningStatus);
    const backdrop = openModal();
    openRemoteShareTab(backdrop);
    await flush();
    expect(backdrop.textContent).not.toContain("/Users/x/notes"); // VAULTS[0].root
  });
});
