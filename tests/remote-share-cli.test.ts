import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => mockInvoke(...a) }));

import {
  chooseBindMode,
  handleCliShareRequest,
  matchVaultArg,
  resolveShareTargets,
} from "../src/settings/remote-share-cli";
import type { VaultOption } from "../src/settings/remote-share-panel";
import { shareStartCliErrorMessage } from "../src/settings/remote-share-port";

const v = (id: string, displayName: string, root: string): VaultOption => ({ id, displayName, root });
const NOTES = v("v1", "노트", "/u/notes");
const WORK = v("v2", "Work", "/u/work");

describe("matchVaultArg", () => {
  it("정확 일치", () => expect(matchVaultArg("Work", [NOTES, WORK])).toEqual({ ok: true, vault: WORK }));
  it("대소문자만 다른 일치", () => expect(matchVaultArg("work", [NOTES, WORK])).toEqual({ ok: true, vault: WORK }));
  it("NFD displayName을 NFC 입력으로 찾는다", () => {
    const nfd = v("v3", "노트".normalize("NFD"), "/u/n");
    expect(matchVaultArg("노트".normalize("NFC"), [nfd])).toEqual({ ok: true, vault: nfd });
  });
  it("앞뒤 공백 무시", () => expect(matchVaultArg("  Work ", [WORK]).ok).toBe(true));
  it("정확 일치 하나가 대소문자 다수보다 우선", () => {
    const a = v("a", "Notes", "/a");
    const b = v("b", "notes", "/b");
    expect(matchVaultArg("notes", [a, b])).toEqual({ ok: true, vault: b });
  });
  it("대소문자 다수만 있으면 ambiguous", () => {
    const a = v("a", "Notes", "/a");
    const b = v("b", "NOTES", "/b");
    expect(matchVaultArg("notes", [a, b])).toMatchObject({ ok: false, reason: "ambiguous" });
  });
  it("not-found", () => expect(matchVaultArg("없음", [NOTES])).toMatchObject({ ok: false, reason: "not-found" }));
  it("같은 id 중복은 dedupe되어 성공", () => expect(matchVaultArg("노트", [NOTES, NOTES]).ok).toBe(true));
  it("경로형은 등록 루트와 정확 일치만", () => {
    expect(matchVaultArg("/u/notes", [NOTES]).ok).toBe(true);
    expect(matchVaultArg("/u/notes/sub", [NOTES])).toMatchObject({ ok: false, reason: "not-found" });
    expect(matchVaultArg("/etc", [NOTES])).toMatchObject({ ok: false, reason: "not-found" });
  });
  it("후보에 없는(원격/글로벌) 볼트는 not-found", () => expect(matchVaultArg("remote", [NOTES]).ok).toBe(false));
});

describe("resolveShareTargets", () => {
  const rem = { bind_mode: "tailscale" as const, vaults: [{ id: "v1", display_name: "노트" }] };
  it("이름이 기억값보다 우선", () => {
    const r = resolveShareTargets({ names: ["Work"], remembered: rem }, [NOTES, WORK]);
    expect(r).toEqual({ ok: true, vaults: [WORK], warnings: [] });
  });
  it("하나라도 실패하면 전체 실패, 공유 가능 이름 나열", () => {
    const r = resolveShareTargets({ names: ["노트", "없음"], remembered: null }, [NOTES, WORK]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("노트, Work");
  });
  it("후보 0개 문구", () => {
    const r = resolveShareTargets({ names: ["x"], remembered: null }, []);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain("공유할 수 있는 로컬 볼트가 없습니다");
  });
  it("ambiguous 문구가 루트 경로를 나열", () => {
    const r = resolveShareTargets({ names: ["n"] , remembered: null }, [v("a", "n", "/a/n"), v("b", "n", "/b/n")]);
    if (r.ok) throw new Error("expected failure");
    expect(r.error).toContain("/a/n, /b/n");
  });
  it("기억값 일부 소실 → 나머지 + 경고", () => {
    const r = resolveShareTargets({ names: [], remembered: { bind_mode: "tailscale", vaults: [{ id: "v1", display_name: "노트" }, { id: "gone", display_name: "옛볼트" }] } }, [NOTES]);
    expect(r).toMatchObject({ ok: true, vaults: [NOTES] });
    if (r.ok) expect(r.warnings[0]).toContain("옛볼트");
  });
  it("기억값 전부 소실 → 오류", () => {
    expect(resolveShareTargets({ names: [], remembered: rem }, [WORK]).ok).toBe(false);
  });
  it("이름도 기억도 없음 → 오류", () => expect(resolveShareTargets({ names: [], remembered: null }, [NOTES]).ok).toBe(false));
});

describe("chooseBindMode", () => {
  it("기억값 우선", () => expect(chooseBindMode({ bind_mode: "localhost-only", vaults: [] }, true)).toBe("localhost-only"));
  it("없으면 감지 결과", () => {
    expect(chooseBindMode(null, true)).toBe("tailscale");
    expect(chooseBindMode(null, false)).toBe("localhost-only");
  });
});

describe("shareStartCliErrorMessage", () => {
  it("PORT_IN_USE는 포트와 대안을 담고 패널 문구('아래')를 쓰지 않는다", () => {
    const m = shareStartCliErrorMessage("PORT_IN_USE: x", 47878);
    expect(m).toContain("47878");
    expect(m).toContain("예:");
    expect(m).not.toContain("아래");
  });
  it("PORT_INVALID / 그 외 원문", () => {
    expect(shareStartCliErrorMessage("PORT_INVALID: x", 1)).toContain("포트");
    expect(shareStartCliErrorMessage(new Error("boom"), 1)).toBe("boom");
  });
});

describe("handleCliShareRequest", () => {
  const deps = { readOptions: () => [NOTES, WORK], port: () => 47878 };
  const calls = (cmd: string): unknown[][] => mockInvoke.mock.calls.filter((c) => c[0] === cmd);
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((cmd: string) => (cmd === "remote_tailscale_available" ? Promise.resolve(true) : Promise.resolve(undefined)));
  });

  it("성공: start 1회(snake_case) 후 started 회신 1회", async () => {
    await handleCliShareRequest({ id: 5, names: ["노트"], remembered: null }, deps);
    expect(calls("remote_share_start")).toEqual([
      ["remote_share_start", { bindMode: "tailscale", port: 47878, vaults: [{ id: "v1", display_name: "노트", root: "/u/notes" }] }],
    ]);
    expect(calls("complete_cli_request")).toEqual([["complete_cli_request", { id: 5, outcome: { kind: "started", warnings: [] } }]]);
  });
  it("해석 실패: start 0회, failed 회신 1회", async () => {
    await handleCliShareRequest({ id: 6, names: ["없음"], remembered: null }, deps);
    expect(calls("remote_share_start")).toHaveLength(0);
    const c = calls("complete_cli_request");
    expect(c).toHaveLength(1);
    expect((c[0][1] as { outcome: { kind: string } }).outcome.kind).toBe("failed");
  });
  it("start reject PORT_IN_USE → 포트 포함 failed", async () => {
    mockInvoke.mockImplementation((cmd: string) => (cmd === "remote_share_start" ? Promise.reject("PORT_IN_USE: busy") : Promise.resolve(true)));
    await handleCliShareRequest({ id: 7, names: ["노트"], remembered: null }, deps);
    const c = calls("complete_cli_request");
    expect(c).toHaveLength(1);
    const o = (c[0][1] as { outcome: { kind: string; error: string } }).outcome;
    expect(o.kind).toBe("failed");
    expect(o.error).toContain("47878");
  });
  it("tailscale 프로브는 기억값이 없을 때만", async () => {
    await handleCliShareRequest({ id: 8, names: ["노트"], remembered: { bind_mode: "localhost-only", vaults: [] } }, deps);
    expect(calls("remote_tailscale_available")).toHaveLength(0);
    mockInvoke.mockClear();
    await handleCliShareRequest({ id: 9, names: ["노트"], remembered: null }, deps);
    expect(calls("remote_tailscale_available")).toHaveLength(1);
  });
  it("readOptions가 throw해도 회신은 정확히 1회", async () => {
    await handleCliShareRequest({ id: 10, names: ["x"], remembered: null }, { ...deps, readOptions: () => { throw new Error("boom"); } });
    expect(calls("complete_cli_request")).toHaveLength(1);
    expect(calls("remote_share_start")).toHaveLength(0);
  });
});
