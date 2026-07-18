// The Excel (.xlsx/.xls) viewer — R11's first real extension
// (_workspace/01_r11.md §6), living entirely behind the `../../api` facade
// (api-fence enforces this — tests/api-fence.test.ts). Registers through the
// same `registerViewer` the built-in image viewer uses (design §2/§4), so
// "open a non-markdown file" has exactly one dispatch path (main.ts's
// viewerForEntry/openWithViewer) regardless of built-in vs. extension.
//
// SheetJS is fetched from the OFFICIAL CDN tarball, not npm — see
// package.json's "xlsx" dependency comment for why (short version: the npm
// registry's `xlsx` package is abandoned at 0.18.5 with known
// prototype-pollution/ReDoS CVEs; SheetJS moved distribution to their own CDN
// years ago). Reason is intentionally duplicated here AND in
// docs/design/plugin-system.md's R11 section (design §6) — package.json
// can't carry a comment, so the next person who wonders "why a URL
// dependency?" needs to find this wherever they look first.
//
// COLD LOAD (design §7): `xlsx` (~1MB) is dynamic-imported ONLY inside
// open()'s handler — never at module load / registerExcelViewer() time — so
// activateExtensions() (main.ts boot) never pulls it into the initial bundle.
// scripts/viewer-golden.mjs's G2/G3 measure this via
// performance.getEntriesByType("resource").
import {
  registerViewer,
  openViewerShell,
  readLocalFileBytes,
  type Viewer,
  type ViewerHandle,
} from "../../api";
import { sheetToRows, truncatedForRender, MAX_RENDERED_ROWS } from "./sheet-to-rows";

const STYLE_ID = "ext-excel-viewer-style";

/** Inject this extension's own `<style>` once (idempotent) — extensions can't
 *  touch styles.css (design §6, fence spirit), and CSP `style-src 'self'
 *  'unsafe-inline'` (tauri.conf.json) already permits an inline element.
 *  Command (void). */
function ensureStyleInjected(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
/* NO width/height/max-* rule on .excel-viewer itself (full-pane rewrite,
 * _workspace/01_architect_design.md §C: "콘텐츠 루트는 이제 아무 width/
 * height도 선언하지 않는다 — 셸 flex가 소유"). This selector used to carry a
 * fixed "width: 85vw" envelope of its own (a vw-fraction descendant of the
 * pre-rewrite body-level backdrop/modal — team-lead sizing fix, 2026-07);
 * now .viewer-panel's "flex:1; min-width:0; min-height:0" (styles.css) is
 * the SOLE size owner, and the close-button-overlap bug that motivated the
 * old 85vw cap (a narrow-content sheet's tab strip landing under the close
 * button) is closed at the root instead, independent of any viewer's width
 * — see .viewer-panel-body's chrome-gutter padding, styles.css. The height
 * fix below (.excel-viewer-body's flex, .excel-viewer-sheet's
 * flex: 0 1 auto) is UNRELATED to this width change and still shrinks
 * vertically to content — a small sheet stays small, by design (see
 * tests/viewer-size-envelope.test.ts's scope control: .excel-viewer is
 * deliberately content-driven, not envelope-driven like html/pdf-viewer). */
/* The LOADED state's content wrapper (renderWorkbook sets this class) — a
 * flex column so its own children (fixed-height tab strip, then the
 * flex:1/scrollable sheet) actually get flex treatment. Without this, this
 * div is a plain block and .excel-viewer-sheet's "flex: 1" below has no
 * flex ancestor to act against — the exact real-device regression this
 * comment guards (04_audit_report.md 재호출 2차: a 10,000+-row sheet
 * rendered past the panel's fixed height, uncontained). The OUTER scroll
 * boundary (.viewer-panel-body, styles.css) is shell-owned; this is the
 * viewer's OWN internal layout inside that boundary. */
.excel-viewer-body { display: flex; flex-direction: column; flex: 1; min-height: 0; gap: 8px; }
.excel-viewer-tabs { display: flex; gap: 4px; overflow-x: auto; flex: none; }
/* VIEWER ZOOM RULE exception 1 (styles.css anchor comment above
 * .viewer-panel): a <button> gets its own UA font-size unless it
 * re-inherits — font: inherit is REQUIRED here, not decorative, or this
 * tab's em fraction below silently stops tracking ⌘±. */
.excel-viewer-tab {
  padding: 4px 10px; font: inherit; font-size: calc(12.5em / 13); border-radius: var(--radius-sm, 6px);
  border: 1px solid color-mix(in srgb, var(--fg) 12%, transparent);
  background: var(--surface); color: var(--muted); cursor: pointer; white-space: nowrap;
}
.excel-viewer-tab.is-active { color: var(--fg); border-color: var(--accent, currentColor); }
/* flex: 1 -> flex: 0 1 auto (04_audit_report.md 재호출 4차): flex-grow: 1
 * FORCED this box to fill the panel's full height even for a 3-row sheet
 * (the empty-whitespace symptom, same root cause as the height->max-height
 * fix above — a fixed-size ancestor stretching to it). flex-shrink stays 1
 * + min-height: 0 (unchanged, still load-bearing — 재호출 3차's containment
 * fix: WITHOUT it, a flex child's automatic minimum size can exceed the
 * space available under max-height, defeating overflow: auto and letting a
 * huge sheet push past the panel again) so a large sheet still shrinks to
 * fit and scrolls internally. auto basis = "size to content by default,
 * shrink only when the panel's max-height forces it". */
.excel-viewer-sheet {
  flex: 0 1 auto; min-height: 0; overflow: auto;
  border: 1px solid color-mix(in srgb, var(--fg) 12%, transparent); border-radius: var(--radius-md, 8px);
}
/* Table text is this viewer's ONLY zoomable content (design §B's per-viewer
 * BEHAVIOR table: "CSS 변수 소비" — JS-zero. Tab strip/status text stay
 * chrome-scale, matching the VIEWER ZOOM RULE's --font-scale root above,
 * NOT --viewer-zoom, per design's 열린 질문 4). var(--viewer-zoom, 1) is the
 * shell's OWN DOM projection of its zoom writer (shell.ts's
 * applyZoomFactor, set on the .viewer-panel pane root this table is a
 * descendant of) — this file never writes that variable, only multiplies by
 * it, so there is exactly one writer. Fallback 1 keeps an unopened shell
 * (or a unit test that renders this CSS standalone) at the pre-zoom
 * baseline. */
.excel-viewer-table { border-collapse: collapse; font-size: calc(12.5em / 13 * var(--viewer-zoom, 1)); width: 100%; }
.excel-viewer-table th, .excel-viewer-table td {
  border: 1px solid color-mix(in srgb, var(--fg) 8%, transparent);
  padding: 3px 8px; text-align: left; white-space: pre;
}
/* Row-number gutter (04_audit_report.md 재호출 4차): a bare "width: 100%"
 * table let this <th> column stretch to match the widest DATA column, so a
 * "1/2/5" gutter rendered as wide as a "Name" column next to it — readable
 * as data, not as a row index. width: 1% is the standard HTML-table trick
 * for "shrink this column to its content, give everything else the rest"
 * (the browser can't compute intrinsic content width per column upfront, so
 * it treats 1% as "as small as possible" and redistributes the remainder to
 * the other cells). white-space: nowrap keeps a wide row number from
 * wrapping and defeating the point; text-align: right is the number
 * convention (matches a spreadsheet's own row gutter). */
.excel-viewer-table th { background: var(--surface); color: var(--muted); font-weight: 500; position: sticky; top: 0; width: 1%; white-space: nowrap; text-align: right; }
.excel-viewer-status { padding: 12px; color: var(--muted); font-size: 1em; }
`;
  document.head.appendChild(style);
}

/** One parsed sheet's display rows, already row-capped (design §8).
 *  `totalRows` is the sheet's REAL row count before capping — carried
 *  through from `truncatedForRender` so the caption never has to guess it
 *  back from `rows.length` (that guess is exactly the bug this shape fixes:
 *  a capped sheet's `rows.length` is always MAX_RENDERED_ROWS, so deriving
 *  the caption's "total" from it produced a constant, wrong number). */
interface RenderedSheet {
  name: string;
  rows: unknown[][];
  rowNumbers: number[];
  truncated: boolean;
  totalRows: number;
}

/** "Showing all N rows" vs. "showing the cap of the true total" — the single
 *  rule for the truncation caption text (design §8: never a silent cut, and
 *  never a WRONG cut either — a caption that states a false total is worse
 *  than silence because it's believed, not questioned). Pure query. */
function rowCountCaption(sheet: RenderedSheet): string {
  return sheet.truncated
    ? `전체 ${sheet.totalRows}행 중 ${MAX_RENDERED_ROWS.toLocaleString()}행 표시`
    : `${sheet.totalRows}행`;
}

/** Render one sheet's rows as a <table> (row-number gutter + cells, no
 *  header row — spreadsheets have none inherently). Command (void): mutates
 *  `host` in place so switching tabs doesn't rebuild the surrounding shell. */
function renderSheetTable(host: HTMLElement, sheet: RenderedSheet): void {
  host.replaceChildren();
  const table = document.createElement("table");
  table.className = "excel-viewer-table";
  const tbody = document.createElement("tbody");
  sheet.rows.forEach((row, i) => {
    const tr = document.createElement("tr");
    const gutter = document.createElement("th");
    gutter.textContent = String(sheet.rowNumbers[i]);
    tr.append(gutter);
    for (const cell of row) {
      const td = document.createElement("td");
      td.textContent = cell === "" || cell == null ? "" : String(cell);
      tr.append(td);
    }
    tbody.append(tr);
  });
  table.append(tbody);
  host.append(table);
}

/** Build the tab strip + active sheet's table inside `content`, wiring tab
 *  clicks to swap the active sheet. `fileName` keeps the caption's file
 *  identity across the loading→loaded swap — the image viewer's caption
 *  format is `파일명 — 가로×세로` (image-viewer.ts's `loadedCaption`); this
 *  viewer's is `파일명 — 시트명 — 행수`, same "filename always leads"
 *  contract across viewers. Command (void). */
function renderWorkbook(content: HTMLElement, sheets: RenderedSheet[], caption: HTMLElement, fileName: string): void {
  content.className = "excel-viewer-body"; // was "excel-viewer-status" (loading) — see that class's comment
  content.replaceChildren();
  let active = 0;

  const sheetHost = document.createElement("div");
  sheetHost.className = "excel-viewer-sheet";

  const renderActive = () => {
    const sheet = sheets[active];
    renderSheetTable(sheetHost, sheet);
    caption.textContent = `${fileName} — ${sheet.name} — ${rowCountCaption(sheet)}`;
  };

  if (sheets.length > 1) {
    const tabs = document.createElement("div");
    tabs.className = "excel-viewer-tabs";
    tabs.setAttribute("role", "tablist");
    sheets.forEach((sheet, i) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "excel-viewer-tab";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(i === active));
      tab.textContent = sheet.name;
      tab.addEventListener("click", () => {
        active = i;
        for (const [j, t] of [...tabs.children].entries()) {
          t.classList.toggle("is-active", j === active);
          t.setAttribute("aria-selected", String(j === active));
        }
        renderActive();
      });
      if (i === active) tab.classList.add("is-active");
      tabs.append(tab);
    });
    content.append(tabs);
  }

  content.append(sheetHost);
  renderActive();
}

/** Open `absPath` in the Excel viewer: shell up immediately with a loading
 *  status, then fetch bytes + dynamic-import xlsx + parse in the background
 *  and swap in the workbook (or an error status) when ready. Command. */
function openExcelViewer(absPath: string): ViewerHandle {
  ensureStyleInjected();
  const content = document.createElement("div");
  content.className = "excel-viewer-status";
  content.textContent = "문서 불러오는 중…";

  const shell = openViewerShell({ absPath, paneClass: "excel-viewer", content });
  // openViewerShell sets the caption to basename(absPath) initially (shell.ts
  // owns that computation, the single "compute a viewer's file identity"
  // rule) — captured here so renderWorkbook can keep it once the caption
  // switches to per-sheet text, without this module re-deriving a basename.
  const fileName = shell.caption.textContent ?? absPath;

  (async () => {
    const [bytes, XLSX] = await Promise.all([readLocalFileBytes(absPath), import("xlsx")]);
    const wb = XLSX.read(new Uint8Array(bytes), { type: "array" });
    const sheets: RenderedSheet[] = wb.SheetNames.map((name) => {
      const table = sheetToRows(XLSX, wb.Sheets[name]);
      const capped = truncatedForRender(table.rows);
      return {
        name,
        rows: capped.rows,
        rowNumbers: table.rowNumbers.slice(0, capped.rows.length),
        truncated: capped.truncated,
        totalRows: capped.totalRows,
      };
    });
    renderWorkbook(content, sheets, shell.caption, fileName);
  })().catch((err) => {
    content.replaceChildren();
    content.className = "excel-viewer-status";
    content.textContent = `문서를 열 수 없습니다: ${err instanceof Error ? err.message : String(err)}`;
  });

  return { close: () => shell.close() };
}

const EXCEL_VIEWER: Viewer = {
  id: "ext.excel",
  extensions: ["xlsx", "xls"],
  label: "Excel 스프레드시트",
  open: openExcelViewer,
};

/** Register the Excel viewer. Called once from activateExtensions() at boot
 *  (main.ts, before the first document mounts) — registerViewer's own
 *  duplicate-id guard makes a second call a developer error, matching every
 *  other registry in this codebase. Command (void). */
export function registerExcelViewer(): void {
  registerViewer(EXCEL_VIEWER);
}
