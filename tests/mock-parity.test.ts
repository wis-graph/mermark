import { describe, it, expect } from "vitest";
import { invoke } from "../src/mocks/tauri-core";
import { isResolvedAbsolutePath } from "../src/document/path";
import type { DriveEntry } from "../src/document/types";

// T2 (0.17.1), 3경계 정합: the browser mock must reject the SAME inputs the
// real backend (`remote_client.rs`'s `base_url`) rejects, for the SAME
// reason — otherwise the test suite goes green on an input the real app
// would silently fail on (this repo has hit that exact class of bug twice
// already, per the plan's own warning).
describe("mock parity: remote_pair rejects what base_url rejects", () => {
  it("목도 실제 백엔드가 거절하는 호스트를 거절한다", async () => {
    await expect(invoke("remote_pair", { host: "맥미니", code: "123456", label: "맥북" })).rejects.toBeTruthy();
  });

  it("ASCII hosts remote_pair already accepted still succeed", async () => {
    await expect(invoke("remote_pair", { host: "mac-mini", code: "123456", label: "맥북" })).resolves.toBeUndefined();
  });

  // QA finding (03_qa_report.md): the mock covered base_url's non-ASCII
  // guard but missed its other two rejections (empty host, scheme/path) —
  // both reachable if hostFieldProblem's pre-flight gate is ever bypassed
  // or a future remote_* caller skips it.
  it("빈 호스트를 거절한다 (base_url의 host.is_empty() 가드)", async () => {
    await expect(invoke("remote_pair", { host: "", code: "123456", label: "맥북" })).rejects.toBeTruthy();
  });

  it("스킴·경로가 섞인 호스트를 거절한다 (ssh:// 제외, base_url의 contains(\"://\")||contains('/') 가드)", async () => {
    await expect(invoke("remote_pair", { host: "http://mac-mini", code: "123456", label: "맥북" })).rejects.toBeTruthy();
    await expect(invoke("remote_pair", { host: "mac-mini/vault", code: "123456", label: "맥북" })).rejects.toBeTruthy();
  });
});

// v0.18.2 windows 탐색기 루트 결함 fix, design §0/§5: `list_drives` — the
// browser mock's field names must match the Rust `DriveEntry` struct
// VERBATIM (no `rename_all`, so `display_name` stays snake_case on the
// wire) — a camelCase `displayName` here would pass every TS-side test
// while silently mismatching the real backend.
describe("mock parity: list_drives shape matches the Rust DriveEntry wire shape", () => {
  it("returns an array of {path, display_name} — exactly those two keys, snake_case", async () => {
    const drives = await invoke<DriveEntry[]>("list_drives");
    expect(Array.isArray(drives)).toBe(true);
    expect(drives.length).toBeGreaterThan(0);
    for (const drive of drives) {
      expect(Object.keys(drive).sort()).toEqual(["display_name", "path"]);
      expect(typeof drive.path).toBe("string");
      expect(typeof drive.display_name).toBe("string");
      expect(isResolvedAbsolutePath(drive.path)).toBe(true);
    }
  });
});

// `mermark share` (터미널 원격 공유): the mock must mirror the Rust
// `ShareStatus.last_selection` SSOT (remote_share.rs `record_share_selection`:
// written only by a successful start, kept across stop, untouched by a failed
// start), the `remote-share-changed` event the backend emits on start/stop,
// and the void `complete_cli_request` reply command (cli_control.rs).
describe("mock parity: remote share last_selection / change event / cli reply", () => {
  const vault = { id: "v1", display_name: "노트", root: "/mock/vault" };

  it("status wire keys are exactly the Rust ShareStatus fields; last_selection starts null", async () => {
    const status = (await invoke("remote_share_status")) as Record<string, unknown>;
    expect(Object.keys(status).sort()).toEqual(["bind_mode", "devices", "last_selection", "port", "running", "vaults"]);
    expect(status.last_selection).toBeNull();
  });

  it("a failed start leaves last_selection untouched (null)", async () => {
    await expect(invoke("remote_share_start", { bindMode: "localhost-only", port: 47878, vaults: [] })).rejects.toBeTruthy();
    const status = (await invoke("remote_share_status")) as { last_selection: unknown };
    expect(status.last_selection).toBeNull();
  });

  it("a successful start records {bind_mode, vaults:[{id, display_name}]} (snake_case, no root); stop keeps it", async () => {
    await invoke("remote_share_start", { bindMode: "localhost-only", port: 47878, vaults: [vault] });
    const want = { bind_mode: "localhost-only", vaults: [{ id: "v1", display_name: "노트" }] };
    expect(((await invoke("remote_share_status")) as { last_selection: unknown }).last_selection).toEqual(want);
    await invoke("remote_share_stop");
    const after = (await invoke("remote_share_status")) as { running: boolean; last_selection: unknown };
    expect(after.running).toBe(false);
    expect(after.last_selection).toEqual(want);
    // a later failed start still does not clobber it
    await expect(invoke("remote_share_start", { bindMode: "tailscale", port: 47878, vaults: [] })).rejects.toBeTruthy();
    expect(((await invoke("remote_share_status")) as { last_selection: unknown }).last_selection).toEqual(want);
  });

  it("start and stop fan `remote-share-changed` (and a failed start does not)", async () => {
    const { listen } = await import("../src/mocks/tauri-event");
    let n = 0;
    const un = await listen("remote-share-changed", () => {
      n += 1;
    });
    await expect(invoke("remote_share_start", { bindMode: "tailscale", port: 47878, vaults: [] })).rejects.toBeTruthy();
    expect(n).toBe(0);
    await invoke("remote_share_start", { bindMode: "localhost-only", port: 47878, vaults: [vault] });
    expect(n).toBe(1);
    await invoke("remote_share_stop");
    expect(n).toBe(2);
    un();
  });

  it("complete_cli_request takes {id, outcome} and resolves void", async () => {
    await expect(
      invoke("complete_cli_request", { id: 7, outcome: { kind: "started", warnings: [] } }),
    ).resolves.toBeUndefined();
  });

  it("__mockCliShareRequest fans `cli-share-request` with {id, names, remembered}", async () => {
    const { listen } = await import("../src/mocks/tauri-event");
    const seen: unknown[] = [];
    const un = await listen("cli-share-request", (e) => {
      seen.push(e.payload);
    });
    window.__mockCliShareRequest?.(["노트"]);
    un();
    expect(seen).toHaveLength(1);
    const p = seen[0] as { id: number; names: string[]; remembered: unknown };
    expect(p.names).toEqual(["노트"]);
    expect(typeof p.id).toBe("number");
    expect(p.remembered).toEqual({ bind_mode: "localhost-only", vaults: [{ id: "v1", display_name: "노트" }] });
  });
});
