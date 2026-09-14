import { describe, it, expect } from "vitest";
import { hostFieldProblem } from "../src/document/remote-host-field";

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
    expect(hostFieldProblem("mac-mini:8787")).toBeNull();
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
