import { describe, it, expect } from "vitest";
import { invoke } from "../src/mocks/tauri-core";

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
});
