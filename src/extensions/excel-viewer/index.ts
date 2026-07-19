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
  looksNumeric,
  type Viewer,
  type ViewerHandle,
} from "../../api";
import {
  sheetToRows,
  truncatedForRender,
  cellDisplayText,
  looksLikeHeaderRow,
  MAX_RENDERED_ROWS,
} from "./sheet-to-rows";
import { decodeSpreadsheetInput } from "./decode-input";

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
/* position: relative makes this the offsetParent/containing block for the
 * single column-highlight overlay (.excel-viewer-colhl) — an absolutely
 * positioned child of a SCROLL container scrolls with the content, which is
 * exactly what a column highlight must do. It also makes every cell's
 * 'offsetLeft' resolve against this box, so highlightCellColumn can place
 * the overlay with no rect arithmetic. */
.excel-viewer-sheet {
  position: relative;
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
/* Report-style table (team-lead spec, 2026-07-20): border-collapse: separate
 * (not collapse) is REQUIRED here, unlike .cm-table — collapse is a known
 * breaker of sticky positioning (a collapsed border "belongs" to neither
 * cell, so it doesn't scroll with a sticky cell correctly), which this table
 * needs for the gutter/header sticky tiers below. border-spacing: 0 keeps
 * separate from opening any visible gap between cells. */
.excel-viewer-table { border-collapse: separate; border-spacing: 0; font-size: calc(12.5em / 13 * var(--viewer-zoom, 1)); width: 100%; }
/* No vertical gridlines — horizontal rules only, drawn with box-shadow
 * (not border-bottom): border-collapse: separate means each cell owns its
 * own border box, so a border-bottom would double up at every row boundary
 * (bottom of row N + top-adjacent gap before row N+1); an inset box-shadow
 * paints exactly one line per cell with no doubling. */
.excel-viewer-table th, .excel-viewer-table td {
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--fg) 8%, transparent);
  padding: 5px 10px; text-align: left; white-space: pre;
}
.excel-viewer-table th { background: var(--surface); color: var(--muted); font-weight: 500; }
/* Numeric auto right-align (src/text/numeric-cell.ts's looksNumeric, applied
 * per-cell by renderSheetTable below) — same class/rule as .cm-table's, so
 * the viewer and the markdown table read as one system. */
.excel-viewer-table .is-num { text-align: right; font-variant-numeric: tabular-nums; }
/* Zebra striping on even DATA rows (tbody only — a detected header row lives
 * in <thead>, out of scope). The sticky gutter/col0 tint below mixes the
 * SAME 3% over --surface instead of transparent, since those cells need an
 * OPAQUE background regardless (see the sticky-tier comment) — mixing over
 * --surface keeps the stripe visually continuous across the sticky boundary
 * instead of jumping to a flat, untinted --surface. */
.excel-viewer-table tbody tr:nth-child(even) td,
.excel-viewer-table tbody tr:nth-child(even) th {
  background: color-mix(in srgb, var(--fg) 3%, transparent);
}
.excel-viewer-table tbody tr:nth-child(even) .excel-viewer-gutter,
.excel-viewer-table tbody tr:nth-child(even) .excel-viewer-col0 {
  background: color-mix(in srgb, var(--fg) 3%, var(--surface));
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
/* LEFT-STICKY tier (07-20): the gutter AND the first data column both pin
 * while scrolling horizontally. --sheet-gutter-w is the gutter's OWN
 * rendered width, written by a ResizeObserver in index.ts (renderWorkbook) —
 * a literal px constant would drift the instant the gutter's content
 * (digit count) or --viewer-zoom changes, landing col0 either overlapping
 * the gutter or leaving a gap. Sticky cells need an OPAQUE background (an
 * unset one lets scrolled-past content show through) — --surface here, same
 * as the plain th rule above, so the gutter/col0 columns read as one
 * continuous "pinned" band. */
.excel-viewer-table .excel-viewer-gutter, .excel-viewer-table .excel-viewer-col0 {
  position: sticky; left: 0; z-index: 2; background: var(--surface);
}
.excel-viewer-table .excel-viewer-col0 { left: var(--sheet-gutter-w, 0px); }
.excel-viewer-table .excel-viewer-gutter { width: 1%; white-space: nowrap; text-align: right; }
/* TOP-STICKY tier: the detected header row (looksLikeHeaderRow) pins while
 * scrolling vertically. Only fires when renderSheetTable actually emitted a
 * <thead> — a sheet with no header row has no thead th's to match. */
.excel-viewer-table thead th { position: sticky; top: 0; z-index: 3; font-weight: 700; color: var(--fg); text-align: left; }
/* CORNER tier: cells sticky on BOTH axes at once — the header row's gutter
 * cell (top-left corner) and the header row's first data cell (the same
 * "col0" logic, just also inside <thead>). Each already gets its "left"/
 * "top" offset from the two rules above (different properties, both apply to
 * the same element); this just settles the z-index fight between them so
 * neither tier's OWN plain member ever outranks a doubly-sticky cell
 * (spec order: corner > header > gutter/col0 > body). The gutter corner also
 * restores the gutter's own look (muted/right-aligned row number) since
 * "thead th" above would otherwise paint it as a bold column-name cell. */
.excel-viewer-table thead th.excel-viewer-gutter, .excel-viewer-table thead th.excel-viewer-col0 {
  z-index: 4; background: var(--surface);
}
.excel-viewer-table thead th.excel-viewer-gutter { font-weight: 500; color: var(--muted); text-align: right; }
/* HOVER crosshair (07-20): the hovered cell's row AND column both highlight.
 * The ROW half is pure CSS (tr:hover, below). The COLUMN half is ONE shared
 * overlay element repositioned by JS (highlightCellColumn) — deliberately
 * NOT either of the two obvious alternatives, both of which were tried and
 * rejected for measured reasons:
 *   (a) mousemove→classList on every cell of the column: a 10,000-row sheet
 *       means 10,000 DOM writes per pointer move, the exact jank this
 *       viewer's row cap (truncatedForRender) exists to avoid.
 *   (b) a CSS-only 'td:hover::after' spanning -100vh..+100vh: correct on
 *       screen, but an absolutely positioned box CONTRIBUTES to its scroll
 *       container's scrollable overflow in the block-end direction —
 *       'overflow: auto' clips what is PAINTED, not what is SCROLLABLE. Real
 *       measurement (Chrome, report.xlsx, 2026-07-20): .excel-viewer-sheet's
 *       scrollHeight jumped 75px → 875px the moment a cell was hovered, so a
 *       vertical scrollbar appeared and the sheet scrolled into 800px of
 *       nothing. scripts/viewer-golden.mjs's hoverDoesNotGrowScrollArea pins
 *       this — vitest CANNOT (jsdom does no layout).
 * Moving one overlay is a single DOM write per cell ENTRY (mouseover, not
 * mousemove), and its height is the table's own height, so it adds no
 * scrollable overflow at all. Source order matters below (not just
 * specificity — the hover and zebra rules are equal-specificity and hover
 * must WIN the tie), so this block sits AFTER the zebra rules. */
.excel-viewer-colhl {
  position: absolute; top: 0; z-index: 1; pointer-events: none;
  background: color-mix(in srgb, var(--fg) 4%, transparent);
}
.excel-viewer-colhl[hidden] { display: none; }
.excel-viewer-table tbody tr:hover td, .excel-viewer-table tbody tr:hover th {
  background: color-mix(in srgb, var(--fg) 6%, transparent);
}
.excel-viewer-table tbody tr:hover .excel-viewer-gutter, .excel-viewer-table tbody tr:hover .excel-viewer-col0 {
  background: color-mix(in srgb, var(--fg) 6%, var(--surface));
}
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

/** One `<tr>`: a row-number gutter `<th>` (always "N", spreadsheet-faithful
 *  even when this row lives in `<thead>` — see `renderSheetTable`) followed
 *  by `row`'s cells as `cellTag` elements. The first data cell (index 0)
 *  gets `excel-viewer-col0` (the SECOND sticky-left column, styles.css) and
 *  any cell whose display text `looksNumeric` gets `is-num` (report-style
 *  auto right-align, same class/rule `.cm-table` uses). Pure DOM builder —
 *  no side effect beyond the returned element. */
function buildSheetRow(row: unknown[], rowNumber: number, cellTag: "td" | "th"): HTMLTableRowElement {
  const tr = document.createElement("tr");
  const gutter = document.createElement("th");
  gutter.className = "excel-viewer-gutter";
  gutter.scope = "row";
  gutter.textContent = String(rowNumber);
  tr.append(gutter);
  row.forEach((cell, i) => {
    const el = document.createElement(cellTag);
    const text = cellDisplayText(cell);
    el.textContent = text;
    if (i === 0) el.classList.add("excel-viewer-col0");
    if (looksNumeric(text)) el.classList.add("is-num");
    if (cellTag === "th") el.scope = "col";
    tr.append(el);
  });
  return tr;
}

/** Render one sheet's rows as a <table>: a row-number gutter column on every
 *  row, plus a `<thead>` for row 0 IFF `looksLikeHeaderRow` reads it as
 *  column names (CSV/XLSX carry no header concept of their own — this is a
 *  signal-based judgment, sheet-to-rows.ts). Command (void): mutates `host`
 *  in place so switching tabs doesn't rebuild the surrounding shell. Returns
 *  the gutter `<th>` of the FIRST rendered row (header's if present, else
 *  the first body row's) so the caller can measure its real width for the
 *  `--sheet-gutter-w` sticky-offset var — `null` for an empty sheet. */
function renderSheetTable(host: HTMLElement, sheet: RenderedSheet): HTMLElement | null {
  host.replaceChildren();
  const table = document.createElement("table");
  table.className = "excel-viewer-table";

  const hasHeaderRow = looksLikeHeaderRow(sheet.rows);
  let bodyStart = 0;
  let firstGutter: HTMLElement | null = null;

  if (hasHeaderRow) {
    const thead = document.createElement("thead");
    const headRow = buildSheetRow(sheet.rows[0], sheet.rowNumbers[0], "th");
    thead.append(headRow);
    table.append(thead);
    firstGutter = headRow.querySelector<HTMLElement>(".excel-viewer-gutter");
    bodyStart = 1;
  }

  const tbody = document.createElement("tbody");
  for (let i = bodyStart; i < sheet.rows.length; i++) {
    const tr = buildSheetRow(sheet.rows[i], sheet.rowNumbers[i], "td");
    if (!firstGutter) firstGutter = tr.querySelector<HTMLElement>(".excel-viewer-gutter");
    tbody.append(tr);
  }
  table.append(tbody);
  host.append(table);
  return firstGutter;
}

/** The gutter width that the NEXT column's `left` sticky offset must equal —
 *  i.e. the gutter cell's BORDER-box width, not its content-box width. This
 *  distinction is the whole point of the function: a ResizeObserver entry's
 *  `contentRect` reports the CONTENT box, which excludes the cell's own
 *  padding, so using it pins the first data column too far left by exactly
 *  the horizontal padding and it overlaps the row numbers. Measured (Chrome,
 *  report.xlsx, 2026-07-20): contentRect 7.7px vs. real 27.7px — a 20px
 *  overlap (padding 10px × 2) once the sheet is scrolled horizontally.
 *  `borderBoxSize` is the box we want; `getBoundingClientRect()` is the
 *  fallback for any engine that omits it. Pure query. */
function gutterStickyWidth(entry: ResizeObserverEntry | undefined): number | null {
  if (!entry) return null;
  const borderBox = entry.borderBoxSize?.[0]?.inlineSize;
  if (borderBox != null) return borderBox;
  return entry.target.getBoundingClientRect().width;
}

/** Place the single column-highlight overlay over `cell`'s column, or hide it
 *  when there is no column to highlight (pointer left the cells, or landed on
 *  the row-number gutter — highlighting the gutter would mark "the row
 *  numbers", which is not a data column). The overlay spans the TABLE's full
 *  height, deliberately not the viewport's: a viewport-sized box would inflate
 *  the scroll container's scrollable overflow (see the .excel-viewer-colhl
 *  style comment). Command (void). */
function highlightCellColumn(overlay: HTMLElement, table: HTMLElement | null, cell: HTMLElement | null): void {
  if (!cell || !table || cell.classList.contains("excel-viewer-gutter")) {
    overlay.hidden = true;
    return;
  }
  overlay.style.left = `${cell.offsetLeft}px`;
  overlay.style.width = `${cell.offsetWidth}px`;
  overlay.style.height = `${table.offsetHeight}px`;
  overlay.hidden = false;
}

/** Re-point `observer` at `gutter`'s current DOM element so its width keeps
 *  driving `--sheet-gutter-w` (styles.css's LEFT-STICKY tier — the first
 *  data column's sticky offset). `disconnect()` first because a tab switch
 *  tears down and rebuilds the whole `<table>` (`renderSheetTable`
 *  `replaceChildren`s the host), so the PREVIOUS gutter cell this observer
 *  was watching no longer exists; `observe`-ing without disconnecting first
 *  would silently keep watching a detached, frozen-size element forever. A
 *  literal px constant instead of measuring would drift the instant digit
 *  count (row "1" vs "10,000") or `--viewer-zoom` changes the gutter's real
 *  width. `null` (an empty sheet has no gutter cell) leaves the observer
 *  idle — the CSS `var(--sheet-gutter-w, 0px)` fallback covers that case.
 *  The TABLE is watched by the same observer for a different reason: the
 *  column-highlight overlay's geometry is a snapshot of the columns as they
 *  were when the pointer entered a cell, so ANY table resize (a ⌘±/viewer-zoom
 *  change, a window resize) staled it. A stale overlay isn't just misaligned —
 *  if it now reaches past the table's right edge it ADDS inline-end scrollable
 *  overflow and a phantom horizontal scrollbar appears, the same class of bug
 *  as the -100vh overlay this design replaced. Hiding it on resize costs
 *  nothing: the next pointer move re-fires mouseover and re-places it.
 *  Command (void); caller owns `observer`'s lifetime (disconnect on
 *  teardown). */
function trackSheetGeometry(
  observer: ResizeObserver,
  gutter: HTMLElement | null,
  table: HTMLElement | null,
): void {
  observer.disconnect();
  if (gutter) observer.observe(gutter);
  if (table) observer.observe(table);
}

/** Build the tab strip + active sheet's table inside `content`, wiring tab
 *  clicks to swap the active sheet. `fileName` keeps the caption's file
 *  identity across the loading→loaded swap — the image viewer's caption
 *  format is `파일명 — 가로×세로` (image-viewer.ts's `loadedCaption`); this
 *  viewer's is `파일명 — 시트명 — 행수`, same "filename always leads"
 *  contract across viewers. `onTeardown` is `ViewerShell.onTeardown` narrowed
 *  to just the one capability this function needs (register a close-time
 *  cleanup), not the whole shell — the gutter-width ResizeObserver must stop
 *  when the viewer closes, same as any other subscription this codebase
 *  wires up (shell.ts's own doc comment: "for a caller's own teardown ...
 *  sheet worker cleanup"). Command (void). */
function renderWorkbook(
  content: HTMLElement,
  sheets: RenderedSheet[],
  caption: HTMLElement,
  fileName: string,
  onTeardown: (cb: () => void) => void,
): void {
  content.className = "excel-viewer-body"; // was "excel-viewer-status" (loading) — see that class's comment
  content.replaceChildren();
  let active = 0;

  const sheetHost = document.createElement("div");
  sheetHost.className = "excel-viewer-sheet";

  // The ONE column-highlight overlay (see .excel-viewer-colhl's style
  // comment). It is owned here rather than by renderSheetTable because that
  // function `replaceChildren`s the host on every tab switch — an overlay
  // created in there would be destroyed and its listeners orphaned each time.
  // Listeners likewise attach ONCE to sheetHost (which outlives every table)
  // and reach the current cells by delegation, so switching sheets needs no
  // re-wiring at all.
  const columnHighlight = document.createElement("div");
  columnHighlight.className = "excel-viewer-colhl";
  columnHighlight.hidden = true;
  sheetHost.addEventListener("mouseover", (e) => {
    const cell = (e.target as HTMLElement | null)?.closest<HTMLElement>("td, th") ?? null;
    highlightCellColumn(columnHighlight, sheetHost.querySelector("table"), cell);
  });
  sheetHost.addEventListener("mouseleave", () => {
    columnHighlight.hidden = true;
  });

  // jsdom (unit tests) has no ResizeObserver — guarded rather than polyfilled
  // so a test that opens this viewer degrades to the CSS var's own `0px`
  // fallback instead of throwing; a real WKWebView/Chromium always has it.
  const sheetGeometryObserver =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
          for (const entry of entries) {
            // Two watched targets, told apart by what they ARE rather than by
            // a captured reference — the gutter cell is replaced on every tab
            // switch, so a captured one would go stale (trackSheetGeometry).
            if ((entry.target as HTMLElement).classList.contains("excel-viewer-gutter")) {
              const width = gutterStickyWidth(entry);
              if (width != null) sheetHost.style.setProperty("--sheet-gutter-w", `${width}px`);
            } else {
              columnHighlight.hidden = true; // table resized → overlay geometry is stale
            }
          }
        });
  if (sheetGeometryObserver) onTeardown(() => sheetGeometryObserver.disconnect());

  const renderActive = () => {
    const sheet = sheets[active];
    const gutter = renderSheetTable(sheetHost, sheet);
    if (sheetGeometryObserver) {
      trackSheetGeometry(sheetGeometryObserver, gutter, sheetHost.querySelector("table"));
    }
    // renderSheetTable cleared the host, so the overlay has to be re-attached
    // (and re-hidden — its old geometry belongs to the previous sheet).
    columnHighlight.hidden = true;
    sheetHost.append(columnHighlight);
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
    // csv = text, xlsx/xls = binary (decode-input.ts's isTextSpreadsheet) —
    // SheetJS needs a DIFFERENT `type` for each, or a BOM-less UTF-8 CSV
    // mojibakes (it reads the raw bytes as latin1 — real bug, real file, see
    // decode-input.ts's header comment).
    const input = decodeSpreadsheetInput(absPath, bytes);
    const wb = XLSX.read(input, { type: typeof input === "string" ? "string" : "array" });
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
    renderWorkbook(content, sheets, shell.caption, fileName, shell.onTeardown);
  })().catch((err) => {
    content.replaceChildren();
    content.className = "excel-viewer-status";
    content.textContent = `문서를 열 수 없습니다: ${err instanceof Error ? err.message : String(err)}`;
  });

  // onClose forwards the shell teardown so the OPENER learns about closes
  // it did not initiate (Esc / header ✕) — see ViewerHandle.onClose.
  return { close: () => shell.close(), onClose: (cb) => shell.onTeardown(cb) };
}

const EXCEL_VIEWER: Viewer = {
  id: "ext.excel", // NEVER-RENAME (registry.ts) — disabledViewersSetting persists this id
  // `csv` rides the SAME viewer, not a new one: SheetJS parses CSV into the
  // identical WorkSheet shape this viewer already renders (one sheet named
  // "Sheet1"), so a separate viewer would be a second copy of the same
  // pipeline. Verified against this user's real corpus (59 CSVs: 34 us-ascii,
  // 25 UTF-8 incl. BOM — zero CP949 at the time): BOM is consumed, Korean
  // headers survive, and date columns render formatted ("1986-01-01") rather
  // than as Excel serials, because `cellValue` (sheet-to-rows.ts) prefers a
  // cell's `w` and SheetJS's CSV parser populates it.
  //
  // 2026-07-20 UPDATE: a BOM-less UTF-8 CSV ("카테고리" → "ì¹´í…Œê³ ë¦¬") turned up
  // as a real failing file — `XLSX.read(new Uint8Array(bytes), {type:
  // "array"})` reads CSV bytes as latin1 when there's no BOM to hint UTF-8,
  // so any non-ASCII text mojibaked. Root cause AND the CP949 case this
  // comment used to wave off as "revisit only with a real failing file" are
  // now BOTH closed by the same fix: `decodeSpreadsheetInput` (decode-input.ts)
  // decodes csv bytes to a STRING before handing them to SheetJS — strict
  // UTF-8 first (`fatal: true`, so a truly non-UTF-8 file throws instead of
  // silently mis-decoding), falling back to CP949/EUC-KR only on that throw.
  // xlsx/xls are untouched (`isTextSpreadsheet` is false for them) — they're
  // binary zip/OLE containers, never text, and always went through as bytes.
  extensions: ["xlsx", "xls", "csv"],
  label: "스프레드시트 (Excel·CSV)",
  open: openExcelViewer,
};

/** Register the Excel viewer. Called once from activateExtensions() at boot
 *  (main.ts, before the first document mounts) — registerViewer's own
 *  duplicate-id guard makes a second call a developer error, matching every
 *  other registry in this codebase. Command (void). */
export function registerExcelViewer(): void {
  registerViewer(EXCEL_VIEWER);
}
