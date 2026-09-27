// F1 (_workspace/01_architect_design.md §2.1, §00_request.md — the real bug:
// 8787 collided with another service on the user's Mac mini and blocked
// sharing). Pins the pure host-side "공유 포트" rules against the shared
// 3-경계 fixture (tests/fixtures/remote-host-truth-table.json's
// `defaultPort`/`sharePortRows`) so Rust `DEFAULT_PORT`/`validate_share_port`,
// this module, and the browser mock's `remote_share_start` can never drift
// from each other silently.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import truthTable from "./fixtures/remote-host-truth-table.json";
import { DEFAULT_SHARE_PORT, SSH_TUNNEL_LOCAL_PORT, remoteSharePortSetting, shareStartErrorMessage, sharePortProblem, suggestAlternativeSharePort } from "../src/settings/remote-share-port";
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

// Deferred in cebda68 (audit 🟡-1) until backend committed the fixture's
// sshTunnelLocalPort field — backend's 8fadf3f did. Same SSOT-by-fixture
// pattern as DEFAULT_SHARE_PORT above: this pins the exported constant
// against Rust's SSH_TUNNEL_LOCAL_PORT (remote_client.rs) so
// suggestAlternativeSharePort can never silently start recommending the
// wrong "port to avoid" if either side's constant changes alone.
describe("SSH_TUNNEL_LOCAL_PORT", () => {
  it("equals the fixture's sshTunnelLocalPort (the SAME value Rust's SSH_TUNNEL_LOCAL_PORT uses)", () => {
    expect(SSH_TUNNEL_LOCAL_PORT).toBe(truthTable.sshTunnelLocalPort);
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

// 감사 🟡-1 (`_workspace/04_audit_report.md`): a suggestion must never equal
// SSH_TUNNEL_LOCAL_PORT (47879 — the exact self-collision this port-conflict
// round exists to prevent) and must always stay in 1024–65535. No literal
// "47879" is pinned here — the invariant is checked against the exported
// constant, so it can't silently drift back to "correct by coincidence".
describe("suggestAlternativeSharePort", () => {
  it("never suggests SSH_TUNNEL_LOCAL_PORT, even from one below it", () => {
    expect(suggestAlternativeSharePort(SSH_TUNNEL_LOCAL_PORT - 1)).not.toBe(SSH_TUNNEL_LOCAL_PORT);
  });

  it("wraps 65535 back to 1024 instead of overflowing past the valid range", () => {
    const suggestion = suggestAlternativeSharePort(65535);
    expect(suggestion).toBeGreaterThanOrEqual(1024);
    expect(suggestion).toBeLessThanOrEqual(65535);
  });

  it("always returns a value inside 1024-65535 and different from the input, for a range of inputs", () => {
    for (const port of [1024, 47877, 47878, SSH_TUNNEL_LOCAL_PORT - 1, SSH_TUNNEL_LOCAL_PORT, 65534, 65535]) {
      const suggestion = suggestAlternativeSharePort(port);
      expect(suggestion).toBeGreaterThanOrEqual(1024);
      expect(suggestion).toBeLessThanOrEqual(65535);
      expect(suggestion).not.toBe(SSH_TUNNEL_LOCAL_PORT);
      expect(suggestion).not.toBe(port);
    }
  });
});

describe("shareStartErrorMessage", () => {
  it("PORT_IN_USE: names the port and offers a valid alternative that is not the SSH tunnel's local port", () => {
    const msg = shareStartErrorMessage(new Error("PORT_IN_USE: 127.0.0.1:47878 포트를 이미 다른 프로그램이 쓰고 있습니다"), 47878);
    expect(msg).toContain("47878");
    expect(msg).toContain(String(suggestAlternativeSharePort(47878)));
    expect(msg).not.toContain(String(SSH_TUNNEL_LOCAL_PORT));
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

  // Audit re-review round 2 (`_workspace/04_audit_report.md` item 1): this
  // function used to ALSO strip SSH_TUNNEL_PORT_IN_USE: — dead code, since
  // that prefix can only come from remote_ssh_connect (remote_ssh.rs's
  // connect_with), a different command than this function's only caller
  // (remote-share-panel.ts's applyStart, which only ever calls
  // remote_share_start) can ever touch. This confirms the branch is
  // actually gone: the message now falls through raw, same as any other
  // prefix this function doesn't own. remote-vault-dialog.ts's
  // pairingErrorMessage (tests/remote-vault-dialog.test.ts) is where this
  // prefix is actually stripped — the one place it reaches a user.
  it("SSH_TUNNEL_PORT_IN_USE: is not this function's concern anymore — falls through raw", () => {
    const rustLiteral = "SSH_TUNNEL_PORT_IN_USE: 이 기기의 127.0.0.1:47879를 다른 프로그램이 쓰고 있습니다 (이전 mermark의 ssh가 남아 있을 수 있습니다 — 종료 후 다시 시도).";
    const msg = shareStartErrorMessage(new Error(rustLiteral), 47878);
    expect(msg).toBe(rustLiteral);
  });
});

// 3-경계 parity: the mock's remote_ssh_connect must reproduce the EXACT
// SSH_TUNNEL_PORT_IN_USE: string remote_ssh.rs's connect_with produces
// (byte-for-byte, per team-lead's 2026-09-27 review of _workspace/02_backend_changes.md).
describe("mock remote_ssh_connect — SSH_TUNNEL_PORT_IN_USE reproduction hook", () => {
  it("the magic host string throws the exact Rust literal, prefix included", async () => {
    const { invoke } = await import("../src/mocks/tauri-core");
    await expect(invoke("remote_ssh_connect", { host: "ssh://mock-error-tunnel-port-busy" })).rejects.toBe(
      "SSH_TUNNEL_PORT_IN_USE: 이 기기의 127.0.0.1:47879를 다른 프로그램이 쓰고 있습니다 (이전 mermark의 ssh가 남아 있을 수 있습니다 — 종료 후 다시 시도).",
    );
  });
});
