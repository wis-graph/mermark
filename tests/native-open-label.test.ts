import { describe, it, expect } from "vitest";
import { nativeOpenLabel } from "../src/sidebar/explorer/native-open-label";

describe("nativeOpenLabel", () => {
  it("파일 종류로 문구를 고른다 — 호출은 항상 openPath 하나다", () => {
    expect(nativeOpenLabel("a.html")).toBe("기본 브라우저에서 열기");
    expect(nativeOpenLabel("a.HTM")).toBe("기본 브라우저에서 열기"); // 대소문자 무관
    expect(nativeOpenLabel("a.svg")).toBe("기본 브라우저에서 열기");
    expect(nativeOpenLabel("a.pdf")).toBe("미리보기에서 열기");
    expect(nativeOpenLabel("a.xlsx")).toBe("기본 앱에서 열기");
    expect(nativeOpenLabel("확장자없음")).toBe("기본 앱에서 열기");
    expect(nativeOpenLabel("a.tar.gz")).toBe("기본 앱에서 열기"); // 마지막 확장자만 본다
  });
});
