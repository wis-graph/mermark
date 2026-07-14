// Generates the Excel-viewer golden's POSITIVE fixture (R11,
// _workspace/01_r11.md §9 Step 5): mock-assets/mock/vault/report.xlsx.
// Deterministic content — two sheets, sparse cells (blank rows/columns on
// purpose, exercising sheetToRows's sparse-walk path) — with known values
// scripts/viewer-golden.mjs asserts against directly (G3). Run once (or
// whenever the fixture needs regenerating):
//
//   node scripts/lib/make-excel-fixture.mjs
//
// Requires the `xlsx` package (package.json: SheetJS CDN tarball, NOT the
// abandoned npm registry package — see package.json / excel-viewer/index.ts
// for why). This script itself only runs at fixture-authoring time; it is
// never imported by app code or tests.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_RENDERED_ROWS } from "../../src/extensions/excel-viewer/sheet-to-rows.ts";

const OUT = fileURLToPath(new URL("../../mock-assets/mock/vault/report.xlsx", import.meta.url));

const XLSX = await import("xlsx").catch(() => {
  console.error(
    "make-excel-fixture: `xlsx` is not installed. Run `npm install` first " +
      "(package.json's xlsx dependency is a SheetJS CDN tarball, not npm).",
  );
  process.exit(1);
});

// Sheet 1 "Data": sparse on purpose — a gap between row 2 and row 5, and
// column C left empty — so sheetToRows's cell-key walk (not the declared
// !ref range) is what the golden is really exercising.
const dataSheet = XLSX.utils.aoa_to_sheet([]);
XLSX.utils.sheet_add_aoa(dataSheet, [["ID", "Name"]], { origin: "A1" });
XLSX.utils.sheet_add_aoa(dataSheet, [[1, "Alice"]], { origin: "A2" });
XLSX.utils.sheet_add_aoa(dataSheet, [[5, "Eve"]], { origin: "A5" });

// Sheet 2 "Notes": a single cell, so the golden can assert a sheet-tab
// switch actually swaps the rendered table.
const notesSheet = XLSX.utils.aoa_to_sheet([["note"]]);

// Sheet 3 "Big": exactly MAX_RENDERED_ROWS + 5 rows — the audit's cap+5
// sacred-cow case (04_audit_report.md 🟠), kept to the SMALLEST size that
// actually triggers truncatedForRender's cap so this golden fixture stays
// small (single int column, no formatting). Without this sheet, no golden
// run ever exercised the truncation caption at all — a guard that never
// fires isn't a guard (this session's recurring lesson).
const bigRows = Array.from({ length: MAX_RENDERED_ROWS + 5 }, (_, i) => [i + 1]);
const bigSheet = XLSX.utils.aoa_to_sheet(bigRows);

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, dataSheet, "Data");
XLSX.utils.book_append_sheet(wb, notesSheet, "Notes");
XLSX.utils.book_append_sheet(wb, bigSheet, "Big");

mkdirSync(dirname(OUT), { recursive: true });
const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
writeFileSync(OUT, buf);
console.log("wrote", OUT, `(${buf.length} bytes)`);
