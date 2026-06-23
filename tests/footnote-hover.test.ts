import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { footnoteDefinitionText, isPreviewModifier } from "../src/markdown/footnote-hover";

// footnoteDefinitionText is a pure doc scan (it leans on findFootnoteDef), so no
// markdown language extension is needed — same setup as footnote-nav.test.ts.
const state = (doc: string) => EditorState.create({ doc });

describe("footnoteDefinitionText", () => {
  it("returns the single-line definition with the [^label]: marker stripped", () => {
    const s = state("본문 [^1].\n\n[^1]: 한 줄 정의.");
    expect(footnoteDefinitionText(s, "1")).toBe("한 줄 정의.");
  });

  it("joins indented continuation lines, preserving newlines, and stops at a blank line", () => {
    const doc =
      "본문 [^1].\n\n[^1]: 첫 줄\n    이어지는 들여쓴 줄\n    또 한 줄\n\n다음 문단";
    const s = state(doc);
    const out = footnoteDefinitionText(s, "1");
    expect(out).toBe("첫 줄\n이어지는 들여쓴 줄\n또 한 줄");
    // the trailing blank line stops the block — the next paragraph is excluded
    expect(out).not.toContain("다음 문단");
  });

  it("returns null when the reference has no definition (popup no-op)", () => {
    const s = state("본문 [^x] 만 있고 정의 없음.");
    expect(footnoteDefinitionText(s, "x")).toBeNull();
  });

  it("matches a label containing regex-special characters literally", () => {
    // an unescaped `a.b*c` regex could mis-match e.g. `aXbc` — escaping pins it.
    const s = state("본문 [^a.b*c]\n\n[^a.b*c]: 이스케이프 정의.");
    expect(footnoteDefinitionText(s, "a.b*c")).toBe("이스케이프 정의.");
  });

  it("returns the FIRST definition's text when a label is defined twice", () => {
    const doc = "[^1]: 첫 정의\n\n[^1]: 둘째 정의";
    const s = state(doc);
    expect(footnoteDefinitionText(s, "1")).toBe("첫 정의");
  });

  it("does not treat a following non-indented definition as a continuation", () => {
    const doc = "[^1]: 정의 일\n[^2]: 정의 이";
    const s = state(doc);
    expect(footnoteDefinitionText(s, "1")).toBe("정의 일"); // [^2] is its own def, not a continuation
  });
});

describe("isPreviewModifier", () => {
  it("is true for ⌘ (metaKey)", () => {
    expect(isPreviewModifier({ metaKey: true, ctrlKey: false })).toBe(true);
  });
  it("is true for Ctrl (ctrlKey)", () => {
    expect(isPreviewModifier({ metaKey: false, ctrlKey: true })).toBe(true);
  });
  it("is false when neither is held", () => {
    expect(isPreviewModifier({ metaKey: false, ctrlKey: false })).toBe(false);
  });
});
