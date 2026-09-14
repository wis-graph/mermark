import { describe, expect, it } from "vitest";
import { remoteCanOpen, remoteUnsupportedMessage } from "./remote-capability";

describe("remoteCanOpen / remoteUnsupportedMessage", () => {
  it("원격 볼트에서 아직 못 여는 확장자를 명시한다", () => {
    expect(remoteCanOpen("note.md")).toBe(true);
    expect(remoteCanOpen("그림.png")).toBe(true);
    for (const f of ["책.epub", "문서.pdf", "보고서.hwp", "db.sqlite"]) {
      expect(remoteCanOpen(f)).toBe(false);
      expect(remoteUnsupportedMessage(f)).toBe("원격 볼트에서는 아직 지원하지 않습니다");
    }
  });

  it("실제 등록된 모든 Viewer 확장자를 거부한다 (chrome/viewer + extensions)", () => {
    for (const f of [
      "메모.hwpx",
      "data.db",
      "backup.sqlite3",
      "old.db3",
      "표.xlsx",
      "표.xls",
      "표.csv",
      "문서.docx",
      "페이지.html",
      "페이지.htm",
    ]) {
      expect(remoteCanOpen(f)).toBe(false);
    }
  });

  it("마크다운/텍스트/이미지는 모두 허용한다", () => {
    for (const f of ["a.md", "a.txt", "a.png", "a.jpg", "a.jpeg", "a.gif", "a.svg", "a.webp"]) {
      expect(remoteCanOpen(f)).toBe(true);
    }
  });

  it("확장자가 없거나 대소문자가 섞여도 일관되게 판정한다", () => {
    expect(remoteCanOpen("README")).toBe(true); // no extension → not a claimed viewer type
    expect(remoteCanOpen("문서.PDF")).toBe(false); // extensionOf lowercases
  });
});
