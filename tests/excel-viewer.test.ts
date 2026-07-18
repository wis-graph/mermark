import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import * as XLSX from "xlsx";
import type { WorkSheet } from "xlsx";
import { sheetToRows, truncatedForRender, MAX_RENDERED_ROWS } from "../src/extensions/excel-viewer/sheet-to-rows";

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
