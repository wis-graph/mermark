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
