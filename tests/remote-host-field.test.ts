import { describe, it, expect } from "vitest";
import { hostFieldProblem, sshHostSuffixProblem } from "../src/document/remote-host-field";
import { sharePortProblem } from "../src/document/share-port-rules";

describe("hostFieldProblem", () => {
  it("한글 호스트명을 페어링 전에 거절하고 무엇을 넣어야 하는지 말한다", () => {
    // 이번 사고의 본체: "맥미니" → 퓨니코드 xn--9i1bx8ksvb 로 나가 REMOTE:Unreachable.
    const problem = hostFieldProblem("맥미니");
    expect(problem).not.toBeNull();
    expect(problem).toContain("영문");
    expect(problem).toMatch(/100\.|Tailscale/); // 대안을 실제로 제시한다
  });

  it("빈 값·공백·경로·스킴을 각각 거절한다", () => {
    expect(hostFieldProblem("")).not.toBeNull();
    expect(hostFieldProblem("mac mini")).not.toBeNull();
    expect(hostFieldProblem("http://mac-mini")).not.toBeNull();
    expect(hostFieldProblem("mac-mini/vault")).not.toBeNull();
  });

  it("포트 범위를 검사한다", () => {
    expect(hostFieldProblem("mac-mini:0")).not.toBeNull();
    expect(hostFieldProblem("mac-mini:70000")).not.toBeNull();
    expect(hostFieldProblem("mac-mini:abc")).not.toBeNull();
    expect(hostFieldProblem("mac-mini:47878")).toBeNull();
  });

  it("실제로 닿을 수 있는 형식은 통과시킨다", () => {
    expect(hostFieldProblem("100.64.1.2")).toBeNull();
    expect(hostFieldProblem("mac-mini")).toBeNull();
    expect(hostFieldProblem("mac-mini.tail1234.ts.net")).toBeNull();
    expect(hostFieldProblem("ssh://mac-mini")).toBeNull(); // base_url이 지원하는 형식
  });

  it("거절 사유는 종류마다 다른 문구다 (뭉뚱그리지 않는다)", () => {
    const messages = ["맥미니", "", "http://x", "mac-mini:0"].map(hostFieldProblem);
    expect(new Set(messages).size).toBe(messages.length);
  });
});

// F1 (_workspace/01_architect_design.md §1.2/§2.1, 2026-09-26 47878 포트
// 변경): sshHostSuffixProblem mirrors Rust's `parse_ssh_suffix` rules ②③ —
// the `?share-port=` grammar and the `:port`-on-an-ssh-target rejection.
// Every row here also has a twin in tests/fixtures/remote-host-truth-table.json
// (checked via hostFieldProblem in remote-host-truth-table.test.ts); these
// are additionally unit-testing the exported function directly and its exact
// message text.
describe("sshHostSuffixProblem", () => {
  // 감사 🟡-2: the ?share-port= range check must reuse sharePortProblem's
  // range rule rather than re-implementing 1024<=n<=65535 inline — every
  // numeric value sharePortProblem rejects/accepts must agree here too, for
  // any digits string, not just the one row the shared fixture happens to
  // cover (that asymmetry was the audit's actual concern: SSH suffix rows
  // were thinner than the plain sharePortRows table).
  it("agrees with sharePortProblem's range rule for every numeric share-port value", () => {
    for (const n of [0, 1, 1023, 1024, 1025, 47878, 65534, 65535, 65536, 100000]) {
      const ssh = sshHostSuffixProblem(`ssh://h?share-port=${n}`);
      const plain = sharePortProblem(String(n));
      expect(ssh !== null).toBe(plain !== null);
    }
  });

  it("accepts a bare ssh target with no suffix", () => {
    expect(sshHostSuffixProblem("ssh://mac-mini")).toBeNull();
    expect(sshHostSuffixProblem("ssh://wis@mac-mini")).toBeNull();
  });

  it("accepts ?share-port=<1024-65535>", () => {
    expect(sshHostSuffixProblem("ssh://wis@mac-mini?share-port=47900")).toBeNull();
    expect(sshHostSuffixProblem("ssh://wis@mac-mini?share-port=1024")).toBeNull();
    expect(sshHostSuffixProblem("ssh://wis@mac-mini?share-port=65535")).toBeNull();
  });

  it("rejects a share-port outside 1024-65535, non-numeric, or an unknown key — same message for all three (Rust doesn't distinguish them either)", () => {
    const tooLow = sshHostSuffixProblem("ssh://wis@mac-mini?share-port=80");
    const nonNumeric = sshHostSuffixProblem("ssh://wis@mac-mini?share-port=abc");
    const unknownKey = sshHostSuffixProblem("ssh://wis@mac-mini?port=47900");
    expect(tooLow).not.toBeNull();
    expect(tooLow).toContain("share-port");
    expect(nonNumeric).toBe(tooLow);
    expect(unknownKey).toBe(tooLow);
  });

  it("rejects ':port' on the ssh target with guidance toward ?share-port= and ~/.ssh/config", () => {
    const problem = sshHostSuffixProblem("ssh://wis@mac-mini:47900");
    expect(problem).not.toBeNull();
    expect(problem).toContain("share-port");
    expect(problem).toContain(".ssh/config");
  });

  it("never rejects on target CHARACTER content (rule ④ stays Rust-only in tunnel_args) — matches the truth table's accepted non-ASCII ssh row", () => {
    expect(sshHostSuffixProblem("ssh://맥미니")).toBeNull();
  });

  it("hostFieldProblem delegates its ssh:// branch to sshHostSuffixProblem verbatim", () => {
    expect(hostFieldProblem("ssh://wis@mac-mini?share-port=80")).toBe(sshHostSuffixProblem("ssh://wis@mac-mini?share-port=80"));
    expect(hostFieldProblem("ssh://wis@mac-mini:47900")).toBe(sshHostSuffixProblem("ssh://wis@mac-mini:47900"));
  });
});
