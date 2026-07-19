// Pure functions for turning a SheetJS worksheet into a plain rows table.
// Ported from the reference implementation (smilekyra/md-viewer's
// XlsxView.tsx `sheetToRows`/`cellValue`) with React removed — see
// _workspace/01_r11.md §6/§9 (RED-4). No DOM, no SheetJS import at the
// module level beyond the `xlsx` TYPES (the runtime library itself is
// dynamic-imported by ./index.ts only inside open() — see that file's
// comment on why).
import type { CellObject, WorkSheet } from "xlsx";
import { looksNumeric } from "../../api";

/** A worksheet cell address, e.g. "AQ37" — SheetJS's own key format for a
 *  non-metadata cell in a WorkSheet object (metadata keys like "!ref" start
 *  with "!" and never match this). */
const CELL_ADDRESS_RE = /^[A-Z]+[1-9]\d*$/;

/** The single "what does this cell display" rule: formatted value (`w`,
 *  Excel's own number/date/percent formatting) wins when present, else the
 *  raw value (`v`), else a formula string echoed as `=formula` (no
 *  recalculation — out of scope, design §6). A cell with none of these (or
 *  `t === "z"`, SheetJS's "blank"/stub marker) contributes nothing. Pure
 *  query. */
function cellValue(cell: CellObject | undefined): unknown | undefined {
  if (!cell || cell.t === "z") return undefined;
  if (typeof cell.w === "string" && cell.w.length > 0) return cell.w;
  if (cell.v != null && !(typeof cell.v === "string" && cell.v.length === 0)) {
    return cell.v;
  }
  if (typeof cell.f === "string" && cell.f.length > 0) return `=${cell.f}`;
  return undefined;
}

/** A sheet's populated cells as a dense rows table, sparse rows/columns
 *  skipped entirely (a sheet's `!ref` range can be stale/oversized — e.g.
 *  "B2:AQ1048571" with three actual cells — so this walks the CELL KEYS
 *  present on the object, never the declared range, and reports only the
 *  rows/columns that actually hold a value). `rowNumbers` is 1-based
 *  (spreadsheet row numbers, not array indices) so a caller can render the
 *  gutter faithfully even across a gap. Pure query — `XLSX` is passed in
 *  (not imported here) so this module has zero runtime dependency on the
 *  ~1MB library, keeping it usable from a plain vitest unit test. */
export function sheetToRows(
  XLSX: typeof import("xlsx"),
  sheet: WorkSheet,
): { rows: unknown[][]; rowNumbers: number[] } {
  const rowsByIndex = new Map<number, Map<number, unknown>>();
  let minCol = Number.POSITIVE_INFINITY;
  let maxCol = -1;

  for (const key of Object.keys(sheet)) {
    if (!CELL_ADDRESS_RE.test(key)) continue;
    const value = cellValue(sheet[key] as CellObject | undefined);
    if (value == null) continue;

    const address = XLSX.utils.decode_cell(key);
    minCol = Math.min(minCol, address.c);
    maxCol = Math.max(maxCol, address.c);
    const row = rowsByIndex.get(address.r) ?? new Map<number, unknown>();
    row.set(address.c, value);
    rowsByIndex.set(address.r, row);
  }

  if (maxCol < 0) return { rows: [], rowNumbers: [] };

  const rowIndexes = Array.from(rowsByIndex.keys()).sort((a, b) => a - b);
  const rows = rowIndexes.map((rowIndex) => {
    const row = rowsByIndex.get(rowIndex);
    return Array.from({ length: maxCol - minCol + 1 }, (_, offset) => row?.get(minCol + offset) ?? "");
  });

  return { rows, rowNumbers: rowIndexes.map((rowIndex) => rowIndex + 1) };
}

/** The hard cap on rendered rows (design §8): the viewer is read-only and
 *  DOM cost — not virtualization — is out of scope for v1, but an unbounded
 *  table would still let a huge sheet freeze the webview. Named constant so
 *  the number has exactly one home (this file, and the caption string that
 *  quotes it). */
export const MAX_RENDERED_ROWS = 10_000;

/** Cap `rows` at MAX_RENDERED_ROWS, reporting whether it truncated AND the
 *  real original row count so the caller can caption "showing N of M rows"
 *  with a TRUE M (design §8 — "잘리면 캡션에 고지", never a silent cut —
 *  and never a GUESSED count either: a caption that states a wrong total is
 *  worse than a silent cut, because a wrong number is *believed* instead of
 *  questioned). `totalRows` is `rows.length` BEFORE capping — the caller
 *  must not need to keep the uncapped array around just to know its size.
 *  Pure query. */
export function truncatedForRender(
  rows: unknown[][],
): { rows: unknown[][]; truncated: boolean; totalRows: number } {
  const totalRows = rows.length;
  if (totalRows <= MAX_RENDERED_ROWS) return { rows, truncated: false, totalRows };
  return { rows: rows.slice(0, MAX_RENDERED_ROWS), truncated: true, totalRows };
}

/** A cell's display text — `""` for an empty/missing cell (a hole `sheetToRows`
 *  fills with `""`, but `null`/`undefined` are guarded too for safety). The
 *  single "what do I show/compare for this cell" rule, shared by
 *  `looksLikeHeaderRow` below and the viewer's own row renderer
 *  (`index.ts`) so that logic has exactly one home. Pure query. */
export function cellDisplayText(cell: unknown): string {
  return cell === "" || cell == null ? "" : String(cell);
}

/** How many data rows below a candidate header row to scan for a numeric
 *  match (row-2000 in a huge sheet shouldn't have to be read for this). */
const HEADER_DETECTION_SCAN_ROWS = 20;

/** Row 0 reads as a "column names" row rather than a data row — a signal-based
 *  judgment, not a guess, since CSV carries no header concept of its own
 *  (design 2026-07-20). False when there are fewer than 2 rows (nothing to
 *  compare against) or when row 0 itself contains a numeric cell (a header
 *  row is never numeric). Otherwise true when at least one column has a
 *  non-empty, non-numeric row-0 cell whose same column holds a numeric value
 *  somewhere in the next `HEADER_DETECTION_SCAN_ROWS` data rows — the
 *  "label above a number column" shape a real header has. Pure query. */
export function looksLikeHeaderRow(rows: unknown[][]): boolean {
  if (rows.length < 2) return false;
  const header = rows[0];
  if (header.some((cell) => looksNumeric(cellDisplayText(cell)))) return false;

  const dataRows = rows.slice(1, 1 + HEADER_DETECTION_SCAN_ROWS);
  return header.some((cell, col) => {
    const text = cellDisplayText(cell);
    if (text === "" || looksNumeric(text)) return false;
    return dataRows.some((row) => looksNumeric(cellDisplayText(row[col])));
  });
}
