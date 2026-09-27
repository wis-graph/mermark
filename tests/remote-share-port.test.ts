// F1 (_workspace/01_architect_design.md §2.1, §00_request.md — the real bug:
// 8787 collided with another service on the user's Mac mini and blocked
// sharing). Pins the pure host-side "공유 포트" rules against the shared
// 3-경계 fixture (tests/fixtures/remote-host-truth-table.json's
// `defaultPort`/`sharePortRows`) so Rust `DEFAULT_PORT`/`validate_share_port`,
// this module, and the browser mock's `remote_share_start` can never drift
// from each other silently.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import truthTable from "./fixtures/remote-host-truth-table.json";
import { DEFAULT_SHARE_PORT, remoteSharePortSetting, shareStartErrorMessage, sharePortProblem } from "../src/settings/remote-share-port";
import { defineSetting } from "../src/settings/store";

const STORAGE_KEY = "mermark.remoteShare.port";

/** `defineSetting` reads localStorage once, at CONSTRUCTION time (store.ts) —
 *  not on every `.get()` — so testing "what does a fresh boot see" means
 *  constructing a new instance after seeding localStorage, exactly the
 *  pattern tests/settings-store.test.ts uses for defineSetting's generic
 *  contract. This mirrors remote-share-port.ts's own wiring so the test
 *  proves that module's specific `parse` (gated by `sharePortProblem`), not
 *  just defineSetting in the abstract. */
function freshPortSetting() {
  return defineSetting<number>({
    key: STORAGE_KEY,
    default: DEFAULT_SHARE_PORT,
    parse: (raw) => (raw !== null && sharePortProblem(raw) === null ? Number(raw) : null),
  });
}

describe("DEFAULT_SHARE_PORT", () => {
  it("equals the fixture's defaultPort (the SAME value Rust's DEFAULT_PORT and the mock must use)", () => {
    expect(DEFAULT_SHARE_PORT).toBe(truthTable.defaultPort);
  });
});

describe("sharePortProblem — every row of the shared sharePortRows fixture", () => {
  for (const row of truthTable.sharePortRows) {
    it(`"${row.input}" → ${row.rejected ? "rejected" : "accepted"}`, () => {
      expect(sharePortProblem(row.input) !== null).toBe(row.rejected);
    });
  }
});

describe("remoteSharePortSetting", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("defaults to DEFAULT_SHARE_PORT on a fresh boot with nothing stored", () => {
    expect(freshPortSetting().get()).toBe(DEFAULT_SHARE_PORT);
  });

  it("falls back to the default when localStorage holds a corrupted/out-of-range value (store.ts's parse-returns-null contract)", () => {
    localStorage.setItem(STORAGE_KEY, "not-a-port");
    expect(freshPortSetting().get()).toBe(DEFAULT_SHARE_PORT);
  });

  it("reads back a valid persisted value on a fresh boot", () => {
    localStorage.setItem(STORAGE_KEY, "50000");
    expect(freshPortSetting().get()).toBe(50000);
  });

  it("the exported singleton's set() round-trips to localStorage (the panel's write path)", () => {
    remoteSharePortSetting.set(50000);
    expect(remoteSharePortSetting.get()).toBe(50000);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("50000");
    remoteSharePortSetting.set(DEFAULT_SHARE_PORT); // restore — this instance stays alive for the rest of the suite
  });
});

describe("shareStartErrorMessage", () => {
  it("PORT_IN_USE: names the port and offers a concrete next number", () => {
    const msg = shareStartErrorMessage(new Error("PORT_IN_USE: 127.0.0.1:47878 포트를 이미 다른 프로그램이 쓰고 있습니다"), 47878);
    expect(msg).toContain("47878");
    expect(msg).toContain("47879");
    expect(msg).toContain("공유 포트");
  });

  it("PORT_INVALID: reuses the exact sharePortProblem range message", () => {
    const msg = shareStartErrorMessage(new Error("PORT_INVALID: 공유 포트는 1024~65535 사이여야 합니다 (받은 값 80)"), 80);
    expect(msg).toBe(sharePortProblem("80"));
  });

  it("falls back to the raw error text for anything else", () => {
    const msg = shareStartErrorMessage(new Error("Tailscale 주소를 찾을 수 없습니다"), 47878);
    expect(msg).toBe("Tailscale 주소를 찾을 수 없습니다");
  });
});
