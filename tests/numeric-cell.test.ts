import { describe, it, expect } from "vitest";
import { looksNumeric } from "../src/text/numeric-cell";

// Report-style table auto-align (team-lead spec, 2026-07-20): the single
// "does this cell read as a number" rule shared by table-widget.ts (markdown
// tables) and the Excel viewer (via ../api). Deliberately narrow — a date or
// phone number keeps its dashes and must stay false, or every date column in
// every sheet would right-align as if it were a number.

describe("looksNumeric", () => {
  it("blank/whitespace-only text is false", () => {
    expect(looksNumeric("")).toBe(false);
    expect(looksNumeric("   ")).toBe(false);
  });

  it("plain integers and decimals are true", () => {
    expect(looksNumeric("0")).toBe(true);
    expect(looksNumeric("42")).toBe(true);
    expect(looksNumeric("3.14")).toBe(true);
    expect(looksNumeric("  100  ")).toBe(true); // trimmed first
  });

  it("thousands-comma numbers are true", () => {
    expect(looksNumeric("1,234")).toBe(true);
    expect(looksNumeric("12,345,678")).toBe(true);
    expect(looksNumeric("1,234.56")).toBe(true);
  });

  it("a leading sign is stripped", () => {
    expect(looksNumeric("-5")).toBe(true);
    expect(looksNumeric("+5")).toBe(true);
    expect(looksNumeric("-1,234.5")).toBe(true);
  });

  it("a leading currency symbol is stripped", () => {
    expect(looksNumeric("₩1,000")).toBe(true);
    expect(looksNumeric("$9.99")).toBe(true);
    expect(looksNumeric("€100")).toBe(true);
    expect(looksNumeric("¥500")).toBe(true);
    expect(looksNumeric("￦1000")).toBe(true);
  });

  it("a trailing percent is stripped", () => {
    expect(looksNumeric("12.5%")).toBe(true);
    expect(looksNumeric("100%")).toBe(true);
  });

  it("sign + currency + percent can combine", () => {
    expect(looksNumeric("-$1,234.56")).toBe(true);
  });

  it("a date keeps its dashes and is false (not a number, even though it's all digits/dashes)", () => {
    expect(looksNumeric("1986-01-01")).toBe(false);
    expect(looksNumeric("2026-07-20")).toBe(false);
  });

  it("a phone number keeps its dashes and is false", () => {
    expect(looksNumeric("010-1234-5678")).toBe(false);
    expect(looksNumeric("02-123-4567")).toBe(false);
  });

  it("plain non-numeric text is false", () => {
    expect(looksNumeric("Kim")).toBe(false);
    expect(looksNumeric("카테고리")).toBe(false);
    expect(looksNumeric("**bold**")).toBe(false); // raw markdown, not rendered text
  });

  it("a malformed thousands grouping (wrong digit count) is false", () => {
    expect(looksNumeric("1,23")).toBe(false);
    expect(looksNumeric("12,3456")).toBe(false);
  });

  it("text that is ONLY a currency symbol or sign is false (nothing numeric left after stripping)", () => {
    expect(looksNumeric("₩")).toBe(false);
    expect(looksNumeric("-")).toBe(false);
    expect(looksNumeric("%")).toBe(false);
  });
});
