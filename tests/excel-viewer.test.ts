import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import * as XLSX from "xlsx";
import type { WorkSheet } from "xlsx";
import {
  sheetToRows,
  truncatedForRender,
  looksLikeHeaderRow,
  MAX_RENDERED_ROWS,
} from "../src/extensions/excel-viewer/sheet-to-rows";
import { isTextSpreadsheet, decodeSpreadsheetInput } from "../src/extensions/excel-viewer/decode-input";

// R11 (_workspace/01_r11.md §9 RED-4): pure functions only, no DOM. Cases
// ported from the reference implementation's XlsxView.test.ts (sparse-sheet
// handling, stale !ref ranges) plus this repo's own cap/truncation contract
// (design §8).

describe("sheetToRows", () => {
  it("does not expand stale XLSX ranges into blank rows", () => {
    const table = sheetToRows(XLSX, {
      "!ref": "B2:AQ1048571",
      B2: { t: "s", v: "사업명" },
      AQ37: { t: "n", v: 1 },
      E1048571: { t: "s", v: "A1" },
    });

    expect(table.rows).toHaveLength(3);
    expect(table.rowNumbers).toEqual([2, 37, 1048571]);
    expect(table.rows[0][0]).toBe("사업명");
    expect(table.rows[1][41]).toBe(1);
    expect(table.rows[2][3]).toBe("A1");
  });

  it("prefers the formatted value (w), falls back to raw (v), then formula (=f)", () => {
    const table = sheetToRows(XLSX, {
      "!ref": "A1:C1",
      A1: { t: "n", v: 0.5, w: "50%" },
      B1: { t: "s", v: "raw" },
      C1: { t: "n", f: "SUM(A1:A2)" },
    });
    expect(table.rows[0]).toEqual(["50%", "raw", "=SUM(A1:A2)"]);
  });

  it("returns no rows for sheets with no populated cells", () => {
    expect(sheetToRows(XLSX, { "!ref": "A1:C1048576" })).toEqual({
      rows: [],
      rowNumbers: [],
    });
  });

  it("does not truncate legitimate sheets beyond the display row limit (that's truncatedForRender's job)", () => {
    const sheet: WorkSheet = { "!ref": "A1:A2505" };
    for (let row = 1; row <= 2505; row += 1) {
      sheet[`A${row}`] = { t: "n", v: row };
    }

    const table = sheetToRows(XLSX, sheet);

    expect(table.rows).toHaveLength(2505);
    expect(table.rowNumbers[2504]).toBe(2505);
  });
});

describe("truncatedForRender (design §8 — named cap, never a silent cut, never a WRONG count)", () => {
  it("passes rows through unchanged when at or under the cap", () => {
    const rows = Array.from({ length: MAX_RENDERED_ROWS }, (_, i) => [i]);
    const result = truncatedForRender(rows);
    expect(result.truncated).toBe(false);
    expect(result.rows).toHaveLength(MAX_RENDERED_ROWS);
    expect(result.rows).toBe(rows); // no copy needed on the fast path
    expect(result.totalRows).toBe(MAX_RENDERED_ROWS);
  });

  it("caps and flags truncated when the sheet exceeds MAX_RENDERED_ROWS", () => {
    const rows = Array.from({ length: MAX_RENDERED_ROWS + 500 }, (_, i) => [i]);
    const result = truncatedForRender(rows);
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(MAX_RENDERED_ROWS);
    expect(result.rows[0]).toEqual([0]);
    expect(result.totalRows).toBe(MAX_RENDERED_ROWS + 500);
  });

  // team-lead audit finding (04_audit_report.md 🟠): the caption used to
  // derive "total rows" from `rows.length + (truncated ? 1 : 0)` — a capped
  // sheet's `rows.length` is ALWAYS MAX_RENDERED_ROWS, so that expression is
  // a constant (MAX_RENDERED_ROWS + 1) no matter how large the real sheet
  // is. A 500,000-row sheet and a 10,001-row sheet produced the IDENTICAL,
  // wrong caption. `totalRows` must reflect the REAL input size for any
  // overage, not just "one more than the cap".
  it("totalRows reflects the TRUE original size, not a constant derived from the cap", () => {
    const rows = Array.from({ length: MAX_RENDERED_ROWS + 5 }, (_, i) => [i]);
    const result = truncatedForRender(rows);
    expect(result.totalRows).toBe(MAX_RENDERED_ROWS + 5);
    expect(result.rows).toHaveLength(MAX_RENDERED_ROWS);
    // The regression this guards: reverting totalRows to `rows.length + 1`
    // would silently pass a "+1"-shaped total (MAX_RENDERED_ROWS + 1) here
    // instead of the true MAX_RENDERED_ROWS + 5 — this assertion is what
    // turns red under that mutation (verified manually, see
    // _workspace/02_r11_changes.md).
    expect(result.totalRows).not.toBe(MAX_RENDERED_ROWS + 1);
  });
});

describe(".excel-viewer-table CSS: viewer-local zoom via var(--viewer-zoom) (JS-zero, design §B)", () => {
  // Excel's zoom behavior is CSS-only — the shell projects its zoom factor
  // onto the pane root as --viewer-zoom (shell.ts's applyZoomFactor), and
  // this table's font-size multiplies by it, with zero JS in this viewer
  // (design §B's BEHAVIOR table: "CSS 변수 소비"). Style-contract sweep, same
  // technique tests/viewer-zoom.test.ts/viewer-size-envelope.test.ts use:
  // extract the injected <style> template literal and assert on its text —
  // no DOM/layout needed.
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(join(ROOT, "src", "extensions", "excel-viewer", "index.ts"), "utf8");
  const match = src.match(/\.excel-viewer-table\s*\{([^}]*)\}/);

  it("declares font-size: calc(12.5em / 13 * var(--viewer-zoom, 1)) — the zoom multiply exists", () => {
    expect(match).toBeTruthy();
    expect(match![1]).toMatch(/font-size:\s*calc\(\s*12\.5em\s*\/\s*13\s*\*\s*var\(--viewer-zoom,\s*1\)\s*\)/);
  });

  it("no bare px literal on the zoomed rule (JS-zero contract — CSS var does the multiply, not a computed px)", () => {
    expect(match![1]).not.toMatch(/\dpx/);
  });
});

// CSV rides the SAME viewer as Excel (2026-07-20): SheetJS parses it into the
// identical WorkSheet shape, so a separate viewer would duplicate the whole
// pipeline. These pin the registry claim AND the two properties that make
// sharing safe for real Korean CSVs — a UTF-8 BOM must not leak into the first
// header cell, and a date column must display formatted (the viewer's
// `cellValue` prefers `w`), not as a raw Excel serial like 31413.
describe("CSV support (shares the Excel viewer)", () => {
  it("registerExcelViewer claims csv alongside xlsx/xls, all resolving to ext.excel", async () => {
    const { registerExcelViewer } = await import("../src/extensions/excel-viewer/index");
    const { viewerFor } = await import("../src/chrome/viewer/registry");
    registerExcelViewer();
    for (const ext of ["xlsx", "xls", "csv"]) {
      expect(viewerFor(ext)?.id).toBe("ext.excel");
    }
  });

  it("a UTF-8 BOM CSV parses with a clean first header (no BOM leaking into the cell)", () => {
    const csv = "﻿서포터,후원금액\n달리는감자,145000\n";
    const wb = XLSX.read(new TextEncoder().encode(csv), { type: "array" });
    const rows = sheetToRows(XLSX, wb.Sheets[wb.SheetNames[0]]).rows;
    expect(rows[0][0]).toBe("서포터"); // NOT "﻿서포터"
    expect(rows[1][0]).toBe("달리는감자");
  });

  it("a date column renders formatted, not as an Excel serial number", () => {
    const csv = "observation_date,price\n1986-01-01,22.93\n";
    const wb = XLSX.read(new TextEncoder().encode(csv), { type: "array" });
    const rows = sheetToRows(XLSX, wb.Sheets[wb.SheetNames[0]]).rows;
    expect(rows[1][0]).toBe("1986-01-01");
    expect(String(rows[1][0])).not.toMatch(/^\d{5}$/); // e.g. "31413"
  });
});

// Real bug, real file (team-lead spec, 2026-07-20): 정산표.csv is BOM-less
// UTF-8 and mojibaked ("카테고리" → "ì¹´í…Œê³ ë¦¬") because
// `XLSX.read(new Uint8Array(bytes), {type:"array"})` reads CSV bytes as
// latin1 when there's no BOM to hint UTF-8. decode-input.ts fixes this by
// decoding csv bytes to a STRING (strict UTF-8 first, CP949/EUC-KR fallback)
// before SheetJS ever sees them; xlsx/xls stay untouched (binary formats).
describe("isTextSpreadsheet / decodeSpreadsheetInput (2026-07-20 CSV encoding fix)", () => {
  it("isTextSpreadsheet is true only for .csv (case-insensitive), false for xlsx/xls", () => {
    expect(isTextSpreadsheet("/tmp/정산표.csv")).toBe(true);
    expect(isTextSpreadsheet("/tmp/report.CSV")).toBe(true);
    expect(isTextSpreadsheet("/tmp/book.xlsx")).toBe(false);
    expect(isTextSpreadsheet("/tmp/book.xls")).toBe(false);
  });

  it("a BOM-less UTF-8 csv decodes to a clean string (the exact bug: bytes read as latin1 without this)", () => {
    const bytes = new TextEncoder().encode("카테고리,금액\n식비,10000\n");
    const result = decodeSpreadsheetInput("/tmp/정산표.csv", bytes);
    expect(typeof result).toBe("string");
    expect(result).toContain("카테고리");
    expect(result).not.toContain("ì¹´í…Œê³ ë¦¬"); // the mojibake this fix closes
  });

  it("a BOM-prefixed UTF-8 csv decodes with the BOM removed (TextDecoder's own ignoreBOM:false default)", () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("서포터,금액\n")]);
    const result = decodeSpreadsheetInput("/tmp/후원.csv", withBom);
    expect(typeof result).toBe("string");
    expect((result as string).startsWith("서포터")).toBe(true); // no leading BOM char
  });

  it("CP949/EUC-KR csv bytes (invalid UTF-8) fall back to a correct decode, not mojibake or a throw", () => {
    // "카테고리" encoded as EUC-KR/CP949 (verified byte-for-byte against a real
    // iconv EUC-KR encoder) — NOT valid UTF-8, so the strict utf-8 attempt
    // must throw and this fallback must fire.
    const cp949Bytes = new Uint8Array([0xc4, 0xab, 0xc5, 0xd7, 0xb0, 0xed, 0xb8, 0xae]);
    const result = decodeSpreadsheetInput("/tmp/legacy.csv", cp949Bytes);
    expect(result).toBe("카테고리");
  });

  it("xlsx/xls bytes pass through unchanged as a Uint8Array (binary format — decode is a no-op)", () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // zip magic bytes
    const result = decodeSpreadsheetInput("/tmp/book.xlsx", bytes);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result).toEqual(bytes);
    const fromArrayBuffer = decodeSpreadsheetInput("/tmp/book.xls", bytes.buffer);
    expect(fromArrayBuffer).toBeInstanceOf(Uint8Array);
    expect(fromArrayBuffer).toEqual(bytes);
  });

  // The decode functions above are unit-level; THIS one walks the whole path
  // the viewer actually walks (bytes → decodeSpreadsheetInput → XLSX.read →
  // sheetToRows), because the shipped bug lived in the SEAM, not in either
  // side of it: decoding was never wrong, it simply wasn't happening — bytes
  // went straight to `XLSX.read(..., {type: "array"})`, which reads a BOM-less
  // CSV as latin1. A test that only checks the decoder would still pass with
  // the bug fully restored, so it would not be a regression test at all.
  it("a BOM-less UTF-8 Korean CSV survives the FULL path to rendered rows", () => {
    const csv = "카테고리,채널,판매수량\n클립,자사몰,25\n";
    const bytes = new TextEncoder().encode(csv);
    expect(bytes[0]).not.toBe(0xef); // no BOM — the exact shape that mojibaked

    const input = decodeSpreadsheetInput("/tmp/정산표.csv", bytes);
    const wb = XLSX.read(input, { type: typeof input === "string" ? "string" : "array" });
    const { rows } = sheetToRows(XLSX, wb.Sheets[wb.SheetNames[0]]);

    expect(rows[0]).toEqual(["카테고리", "채널", "판매수량"]);
    expect(rows[1]).toEqual(["클립", "자사몰", "25"]);
    expect(JSON.stringify(rows)).not.toContain("ì"); // the mojibake signature
  });
});

// looksLikeHeaderRow (team-lead spec, 2026-07-20): CSV/XLSX carry no header
// concept of their own, so "is row 0 a column-names row" is a SIGNAL-based
// judgment, not a guess — the row must be non-numeric AND at least one
// column must show the "label above a number" shape against the data below.
describe("looksLikeHeaderRow", () => {
  it("false when there are fewer than 2 rows (nothing to compare against)", () => {
    expect(looksLikeHeaderRow([])).toBe(false);
    expect(looksLikeHeaderRow([["a", "b"]])).toBe(false);
  });

  it("false when row 0 itself contains a numeric cell (a header row is never numeric)", () => {
    const rows = [
      ["1", "name"],
      ["2", "Kim"],
    ];
    expect(looksLikeHeaderRow(rows)).toBe(false);
  });

  it("false when row 0 is entirely numeric (plain data, no header)", () => {
    const rows = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    expect(looksLikeHeaderRow(rows)).toBe(false);
  });

  it("true when a non-numeric row-0 label sits above a numeric data column", () => {
    const rows = [
      ["category", "amount"],
      ["식비", "10000"],
      ["교통비", "5000"],
    ];
    expect(looksLikeHeaderRow(rows)).toBe(true);
  });

  it("false when row 0 is non-numeric but NO column below it ever turns out numeric (looks like a data row of labels, not a header)", () => {
    const rows = [
      ["Kim", "Seoul"],
      ["Lee", "Busan"],
    ];
    expect(looksLikeHeaderRow(rows)).toBe(false);
  });

  it("only scans the first 20 data rows for a numeric match — a numeric cell at row 25 does not count", () => {
    const rows: unknown[][] = [["label", "value"]];
    for (let i = 0; i < 19; i++) rows.push(["text", "text"]); // rows 1..19: still non-numeric
    rows.push(["text", "42"]); // row 20 (21st row overall, still within the 20-row scan window)
    expect(looksLikeHeaderRow(rows)).toBe(true);

    const tooFar: unknown[][] = [["label", "value"]];
    for (let i = 0; i < 20; i++) tooFar.push(["text", "text"]); // rows 1..20: non-numeric
    tooFar.push(["text", "42"]); // row 21 — outside the 20-row scan window
    expect(looksLikeHeaderRow(tooFar)).toBe(false);
  });

  it("an empty row-0 cell never counts as a header label (even with numeric data beneath it)", () => {
    const rows = [
      ["", ""],
      ["10000", "20000"],
    ];
    expect(looksLikeHeaderRow(rows)).toBe(false);
  });
});
