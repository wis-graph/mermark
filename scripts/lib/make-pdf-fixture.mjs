// Generates the PDF-viewer golden's fixtures (scripts/viewer-golden.mjs):
//   - mock-assets/mock/vault/sample.pdf  (1 page,  G13 — basic render/text-layer)
//   - mock-assets/mock/vault/guide.pdf   (25 pages, G14 — lazy render + the
//     MAX_RENDERED_PAGES canvas-eviction cap). "guide.pdf" is also the mock
//     explorer tree's PRE-EXISTING dummy row (src/mocks/tauri-core.ts) that
//     predates the PDF viewer's existence and had no backing file — now that
//     registerPdfViewer() claims "pdf", that row needs REAL bytes behind it
//     or clicking it regresses to an error panel. Reusing it as the
//     multi-page fixture (rather than adding a THIRD tree row) fixes that
//     regression and gives G14 its fixture in one move.
//
// Hand-built PDF 1.4 bytes — no library dependency (unlike make-excel-fixture.mjs,
// which reuses the already-installed `xlsx` PRODUCTION dependency to WRITE a
// workbook; there is no equivalent "PDF-writing" capability anywhere in this
// repo's dependency tree — `pdfjs-dist` only READS PDFs — so adding a library
// such as pdf-lib as a devDependency purely to author two small fixture files
// would be a heavier footprint than emitting the PDF bytes directly).
//
// Run once (or whenever the fixtures need regenerating):
//   node scripts/lib/make-pdf-fixture.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLE_OUT = fileURLToPath(new URL("../../mock-assets/mock/vault/sample.pdf", import.meta.url));
const GUIDE_OUT = fileURLToPath(new URL("../../mock-assets/mock/vault/guide.pdf", import.meta.url));

const GUIDE_PAGE_COUNT = 25;

/** Build a minimal N-page PDF (US Letter, one Helvetica text run per page,
 *  ONE shared font object) as a Buffer, with a correctly-offset xref table —
 *  a PDF reader (pdf.js included) rejects a table whose byte offsets don't
 *  exactly match where each `N 0 obj` actually starts. Object numbering:
 *  1 = Catalog, 2 = Pages, then for page i (0-indexed) 3+2i = the Page
 *  object and 4+2i = its Content stream, and finally 3+2*pageTexts.length =
 *  the single shared Font object every page's `/Resources` points at. Pure
 *  query (returns bytes; no I/O itself) — this shape (raw PDF bytes) is
 *  never something the APP needs to produce, only read, so it stays fixture-
 *  authoring-script-local rather than app code. */
function buildMultiPagePdf(pageTexts) {
  const n = pageTexts.length;
  const fontObjNum = 3 + n * 2;
  const objects = {};
  const pageObjNums = [];
  for (let i = 0; i < n; i++) {
    const pageObjNum = 3 + i * 2;
    const contentObjNum = 4 + i * 2;
    pageObjNums.push(pageObjNum);
    objects[pageObjNum] =
      `${pageObjNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontObjNum} 0 R >> >> /Contents ${contentObjNum} 0 R >>\nendobj\n`;
    const stream = `BT /F1 24 Tf 72 700 Td (${pageTexts[i]}) Tj ET`;
    objects[contentObjNum] =
      `${contentObjNum} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`;
  }
  objects[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${pageObjNums.map((p) => `${p} 0 R`).join(" ")}] /Count ${n} >>\nendobj\n`;
  objects[fontObjNum] = `${fontObjNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`;

  const lastObjNum = fontObjNum;
  const header = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n"; // binary-marker comment (standard PDF idiom)
  let body = header;
  const offsets = new Array(lastObjNum + 1).fill(0);
  for (let num = 1; num <= lastObjNum; num++) {
    offsets[num] = Buffer.byteLength(body, "binary");
    body += objects[num];
  }
  const xrefOffset = Buffer.byteLength(body, "binary");

  const pad10 = (num) => String(num).padStart(10, "0");
  let xref = `xref\n0 ${lastObjNum + 1}\n0000000000 65535 f \r\n`;
  for (let num = 1; num <= lastObjNum; num++) xref += `${pad10(offsets[num])} 00000 n \r\n`;

  const trailer = `trailer\n<< /Size ${lastObjNum + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(body + xref + trailer, "binary");
}

const samplePdf = buildMultiPagePdf(["PDF-VIEWER-GOLDEN-MARKER"]);
mkdirSync(dirname(SAMPLE_OUT), { recursive: true });
writeFileSync(SAMPLE_OUT, samplePdf);
console.log("wrote", SAMPLE_OUT, `(${samplePdf.length} bytes, 1 page)`);

const guidePageTexts = Array.from({ length: GUIDE_PAGE_COUNT }, (_, i) => `PAGE ${i + 1}`);
const guidePdf = buildMultiPagePdf(guidePageTexts);
mkdirSync(dirname(GUIDE_OUT), { recursive: true });
writeFileSync(GUIDE_OUT, guidePdf);
console.log("wrote", GUIDE_OUT, `(${guidePdf.length} bytes, ${GUIDE_PAGE_COUNT} pages)`);
