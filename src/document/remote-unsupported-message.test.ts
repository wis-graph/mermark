import { describe, expect, it } from "vitest";
import { remoteUnsupportedMessage } from "./remote-unsupported-message";

// T6 (0.18.0): `remoteCanOpen`/`REMOTE_UNSUPPORTED_EXTENSIONS` are gone — a
// registered Viewer's own `openRemote` (chrome/viewer/registry.ts) now
// answers "can this open remotely", exercised in
// tests/viewer-remote-contract.test.ts. This file only pins the remaining
// half: the per-kind refusal WORDING.
describe("remoteUnsupportedMessage", () => {
  it("sqlite 계열은 구조적 한계 문구를 낸다 — '아직'을 쓰지 않는다", () => {
    for (const f of ["data.sqlite", "backup.sqlite3", "old.db", "older.db3"]) {
      const msg = remoteUnsupportedMessage(f);
      expect(msg).toContain("데이터베이스");
      expect(msg).not.toContain("아직");
    }
  });

  it("epub/hwp는 이제 원격을 지원하므로 전용 문구가 없다 — 기본 문구로 fail-closed", () => {
    for (const f of ["book.epub", "doc.hwp", "doc.hwpx"]) {
      expect(remoteUnsupportedMessage(f)).toBe("원격 볼트에서는 아직 지원하지 않습니다");
    }
  });

  it("그 외(미래의 새 뷰어 포함)는 기본 문구로 fail-closed된다", () => {
    expect(remoteUnsupportedMessage("mystery.xyz")).toBe("원격 볼트에서는 아직 지원하지 않습니다");
  });

  it("대소문자·확장자 없음도 일관되게 판정한다", () => {
    expect(remoteUnsupportedMessage("DATA.SQLITE")).toContain("데이터베이스");
    expect(remoteUnsupportedMessage("README")).toBe("원격 볼트에서는 아직 지원하지 않습니다");
  });
});
