// The SQLite (.sqlite/.db/.sqlite3/.db3) viewer — a BUILT-IN viewer (like
// image/hwp), not an extension: it reads through 3 new Tauri commands
// (sqlite_tables/sqlite_table_info/sqlite_rows), and R11's extension
// contract is "frontend only, zero new IPC" (hwp-viewer.ts's header comment
// — the same reasoning applies here). Registers through the SAME
// `registerViewer` every other viewer uses, so opening a non-markdown file
// has exactly one dispatch path regardless of built-in vs. extension.
//
// READ-ONLY, always: this viewer never calls any write-shaped command — it
// only ever fetches table/view lists, column metadata, and row pages. A
// table's rows arrive from the backend ALREADY as display strings
// (`(string | null)[][]` — NULL vs. every other value pre-formatted, BLOBs
// as a `"BLOB (N bytes)"` placeholder), so there is no client-side type
// decoding to get wrong here, unlike the Excel viewer's SheetJS cell shapes.
//
// PAGINATION (the core design constraint): a table can have millions of
// rows, so `sqlite_rows` is always called with a `limit`/`offset` page
// rather than "give me everything". Rows load 100 at a time, appended to
// the bottom of the table as the user scrolls near the end of the scroll
// container — see `nearScrollEnd`/`shouldLoadNextPage` below. A per-open-
// viewer generation counter (`makeGenerationGuard`) invalidates any in-
// flight fetch the instant the user switches tabs, so a slow response for a
// table the user has since left never clobbers the tab now on screen.
import { invoke } from "@tauri-apps/api/core";
import { registerViewer, type Viewer, type ViewerHandle } from "./registry";
import { openViewerShell } from "./shell";
import { looksNumeric } from "../../text/numeric-cell";

/** One entry from `sqlite_tables` — a table or a view, already sorted
 *  tables-first-then-views by the backend (this module trusts that order
 *  and never re-sorts it — the backend is the single source of truth for
 *  tab order, same posture list_dir's callers take toward its own sort). */
interface SqliteTableEntry {
  name: string;
  kind: "table" | "view";
}

/** `sqlite_table_info`'s response shape: parallel `columns`/`columnTypes`
 *  arrays (same length, same order) plus the table's total row count
 *  (BEFORE any pagination — the number the caption and `shouldLoadNextPage`
 *  both measure loaded-row progress against). */
interface SqliteTableInfo {
  columns: string[];
  columnTypes: string[];
  rowCount: number;
}

/** One page of row data — each row's cells already in column order, each
 *  cell either `null` (SQL NULL) or a ready-to-display string (numbers,
 *  text, and the `"BLOB (N bytes)"` placeholder all arrive pre-formatted). */
type SqliteRow = (string | null)[];

/** Rows fetched per page (`sqlite_rows`'s `limit`). Fixed rather than
 *  viewport-derived — a constant page size keeps `shouldLoadNextPage`'s
 *  progress math (`loadedRows < rowCount`) simple and matches the design's
 *  explicit "100행 페이지네이션" contract. */
const SQLITE_PAGE_SIZE = 100;

/** How close (px) the scroll container's bottom edge must be before the
 *  next page is requested — mirrors the spirit of hwp/pdf-viewer's
 *  `rootMargin: "200% 0px"` IntersectionObserver headroom (start the next
 *  fetch before the user actually hits the wall, so scrolling never
 *  outpaces loading), just measured directly off scroll geometry instead of
 *  an observer (a table's rows are cheap, already-visible DOM — there is no
 *  placeholder to lazily construct BEFORE it's in view, only the NEXT PAGE
 *  of rows to defer). */
const SCROLL_LOAD_THRESHOLD_PX = 200;

/** Whether `el`'s scroll position is within `SCROLL_LOAD_THRESHOLD_PX` of its
 *  bottom edge — the single "is the user near the end of what's loaded"
 *  rule `onScroll` below checks before firing a page fetch. Also true
 *  (harmlessly) when `el` isn't scrollable at all yet (`scrollHeight ===
 *  clientHeight`), which is the correct answer: a short first page in a
 *  tall panel has nothing left to scroll, so the very next scroll/mount
 *  check should still be allowed to ask for more. Pure query. */
function nearScrollEnd(el: HTMLElement, thresholdPx: number = SCROLL_LOAD_THRESHOLD_PX): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= thresholdPx;
}

/** "Should a next-page fetch go out right now" — false while a fetch for
 *  this table is already in flight (the concurrent-request guard the design
 *  calls for) or once every row has already loaded. Pure query. */
function shouldLoadNextPage(loadedRows: number, rowCount: number, loading: boolean): boolean {
  return !loading && loadedRows < rowCount;
}

/** A per-open-viewer generation counter: `bump()` marks a NEW active tab and
 *  returns its stamp; `isCurrent(stamp)` tells a fetch that started under an
 *  older stamp whether it's still safe to touch the DOM. Every await point
 *  inside `mountTableSession` re-checks this before writing anything, so a
 *  slow `sqlite_table_info`/`sqlite_rows` response for a table the user has
 *  since switched away from is silently dropped instead of overwriting the
 *  tab now on screen (the same class of race hwp/pdf-viewer's in-flight
 *  guards prevent for page renders, generalized to tab switches here). */
function makeGenerationGuard(): { bump(): number; isCurrent(stamp: number): boolean } {
  let current = 0;
  return {
    bump: () => ++current,
    isCurrent: (stamp) => stamp === current,
  };
}

/** SQLite freely allows an untyped column (`CREATE TABLE t(x)` — no type
 *  after the column name), so `columnTypes[i]` can be `""`. This is a
 *  literal substring match on the DECLARED type text the design calls out
 *  ("INTEGER/REAL/NUMERIC 계열"), not SQLite's own 5-branch column-affinity
 *  algorithm — that algorithm's "otherwise NUMERIC" default would also
 *  right-align a bare `BOOLEAN` or `DATE` column (types SQLite quietly
 *  assigns NUMERIC affinity to for lack of a recognized substring), which
 *  reads as data to a person browsing the table, not a number.
 *  DECIMAL/DOUB/FLOA ride along with INT/REAL/NUMERIC — real schemas spell
 *  a numeric column all five ways. Pure query. */
const NUMERIC_COLUMN_TYPE_RE = /INT|REAL|NUMERIC|DECIMAL|DOUB|FLOA/i;

/** Exported for direct unit testing — the single "does this declared SQLite
 *  type read as a number" rule. Pure query. */
export function isNumericColumnType(declaredType: string): boolean {
  return NUMERIC_COLUMN_TYPE_RE.test(declaredType);
}

/** Per-COLUMN "right-align + tabular-nums" decision (unlike the Excel
 *  viewer's per-CELL `looksNumeric` judgment — this viewer has a declared
 *  type to prefer, a signal a spreadsheet cell never carries). The declared
 *  type always wins when non-empty; an untyped column falls back to
 *  requiring EVERY non-null sample cell (the first page) to look numeric
 *  (`values.every(looksNumeric)` — unanimous, not a majority: one stray
 *  non-numeric cell makes the column text, the conservative choice for a
 *  column with no declared type), computed ONCE per table load and reused
 *  for every later page so alignment never flips mid-scroll. Pure query. */
function columnIsNumeric(declaredType: string, sampleCells: readonly (string | null)[]): boolean {
  if (declaredType.trim() !== "") return isNumericColumnType(declaredType);
  const values = sampleCells.filter((c): c is string => c !== null);
  return values.length > 0 && values.every(looksNumeric);
}

/** One boolean per column, in column order — computed once from
 *  `columnTypes` + a sample page and threaded into every row builder
 *  (`buildRow`/`buildHeaderRow`) so a column's alignment is a single
 *  decision, not re-derived per cell. Pure query. */
function numericColumnFlags(columnTypes: readonly string[], sampleRows: readonly SqliteRow[]): boolean[] {
  return columnTypes.map((type, i) => columnIsNumeric(type, sampleRows.map((row) => row[i] ?? null)));
}

/** The backend's BLOB placeholder shape ("BLOB (N bytes)") — the single rule
 *  deciding the `.sqlite-viewer-blob` (monospace, muted) styling class, so a
 *  BLOB cell reads as "this is opaque binary data", not as ordinary text
 *  that happens to start with the word BLOB. Pure query. */
const BLOB_PLACEHOLDER_RE = /^BLOB \(\d+ bytes\)$/;

function isBlobPlaceholder(text: string): boolean {
  return BLOB_PLACEHOLDER_RE.test(text);
}

/** "파일명 — 테이블명 — 전체 N행" — mirrors the Excel viewer's per-sheet
 *  caption format (`파일명 — 시트명 — 행수`) so both table-browsing viewers
 *  read as one convention. Pure query. */
function sqliteCaption(fileName: string, tableName: string, rowCount: number): string {
  return `${fileName} — ${tableName} — 전체 ${rowCount.toLocaleString()}행`;
}

/** One `<th>` header row, columns in order, numeric columns flagged with
 *  `.is-num` (the SAME class `.cm-table`/`.excel-viewer-table` use — report-
 *  style tables across this app read as one system). Pure DOM builder. */
function buildHeaderRow(columns: readonly string[], numericCols: readonly boolean[]): HTMLTableRowElement {
  const tr = document.createElement("tr");
  columns.forEach((name, i) => {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = name;
    if (numericCols[i]) th.classList.add("is-num");
    tr.append(th);
  });
  return tr;
}

/** One `<tr>` of data cells: `null` renders as a muted/italic "NULL" token
 *  (`.sqlite-viewer-null`) distinct from an empty-string cell (which renders
 *  truly empty), a BLOB placeholder gets `.sqlite-viewer-blob`, and a
 *  numeric column's cells (INCLUDING its NULL cells, so the column stays
 *  visually aligned end to end) get `.is-num`. Pure DOM builder. */
function buildRow(row: SqliteRow, numericCols: readonly boolean[]): HTMLTableRowElement {
  const tr = document.createElement("tr");
  row.forEach((cell, i) => {
    const td = document.createElement("td");
    if (cell === null) {
      td.className = "sqlite-viewer-null";
      td.textContent = "NULL";
    } else {
      td.textContent = cell;
      if (isBlobPlaceholder(cell)) td.classList.add("sqlite-viewer-blob");
    }
    if (numericCols[i]) td.classList.add("is-num");
    tr.append(td);
  });
  return tr;
}

/** The bottom-of-table "로딩…" placeholder row, spanning every column so it
 *  reads as one continuous strip rather than a misaligned single cell. Pure
 *  DOM builder. */
function buildLoadingRow(colCount: number): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className = "sqlite-viewer-loading-row";
  const td = document.createElement("td");
  td.colSpan = colCount;
  td.textContent = "로딩…";
  tr.append(td);
  return tr;
}

/** Build the tab strip: one button per table/view, a view carrying a small
 *  muted "VIEW" badge alongside its name (design: "뷰는 시각적으로 살짝
 *  구분... 과하지 않게" — metadata, not a warning). `onSelect` is wired here
 *  once; `setActiveTab` below flips the active class in place afterward, so
 *  switching tabs never rebuilds (and re-binds) this strip. Pure DOM
 *  builder. */
function buildTabStrip(tables: readonly SqliteTableEntry[], onSelect: (i: number) => void): HTMLElement {
  const tabs = document.createElement("div");
  tabs.className = "sqlite-viewer-tabs";
  tabs.setAttribute("role", "tablist");
  tables.forEach((table, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sqlite-viewer-tab";
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(i === 0));
    if (i === 0) btn.classList.add("is-active");
    const label = document.createElement("span");
    label.textContent = table.name;
    btn.append(label);
    if (table.kind === "view") {
      const badge = document.createElement("span");
      badge.className = "sqlite-viewer-badge";
      badge.textContent = "VIEW";
      btn.append(badge);
    }
    btn.addEventListener("click", () => onSelect(i));
    tabs.append(btn);
  });
  return tabs;
}

/** Flip which tab reads as active — an in-place class/aria toggle (no
 *  rebuild, no re-binding click handlers) so `selectTable` can call this on
 *  every switch with no accumulating listeners. Command (void). */
function setActiveTab(tabs: HTMLElement, active: number): void {
  Array.from(tabs.children).forEach((child, i) => {
    child.classList.toggle("is-active", i === active);
    child.setAttribute("aria-selected", String(i === active));
  });
}

/** Swap `host`'s content for a status message (loading/empty/error) — the
 *  same "one content element toggles between a `-status` class and its
 *  loaded shape" idiom hwp/excel/pdf-viewer all use. Command (void). */
function showStatus(host: HTMLElement, statusClass: string, text: string): void {
  host.className = statusClass;
  host.textContent = text;
}

/** Load one table's column info + first page and render it into `host`,
 *  replacing whatever was there. Returns a teardown that removes the scroll
 *  listener this call installs — `selectTable` runs the PREVIOUS session's
 *  teardown before calling this again, so a tab switch never leaves two
 *  scroll listeners racing on the same element. `stamp`/`guard` are this
 *  call's generation stamp and the shared guard (`makeGenerationGuard`) —
 *  checked before every DOM write past an `await`, so a slow response for a
 *  table the user has since left is dropped instead of overwriting the tab
 *  now on screen. Command. */
async function mountTableSession(
  absPath: string,
  table: SqliteTableEntry,
  host: HTMLElement,
  caption: HTMLElement,
  fileName: string,
  stamp: number,
  guard: { isCurrent(stamp: number): boolean },
): Promise<() => void> {
  const noop = () => {};
  showStatus(host, "sqlite-viewer-status", "불러오는 중…");

  let info: SqliteTableInfo;
  try {
    info = await invoke<SqliteTableInfo>("sqlite_table_info", { path: absPath, table: table.name });
  } catch (err: unknown) {
    if (!guard.isCurrent(stamp)) return noop;
    showStatus(host, "sqlite-viewer-status", `테이블을 불러올 수 없습니다: ${err instanceof Error ? err.message : String(err)}`);
    return noop;
  }
  if (!guard.isCurrent(stamp)) return noop;

  if (info.rowCount === 0) {
    showStatus(host, "sqlite-viewer-status", "행 없음");
    caption.textContent = sqliteCaption(fileName, table.name, 0);
    return noop;
  }

  let firstPage: SqliteRow[];
  try {
    firstPage = await invoke<SqliteRow[]>("sqlite_rows", {
      path: absPath,
      table: table.name,
      limit: SQLITE_PAGE_SIZE,
      offset: 0,
    });
  } catch (err: unknown) {
    if (!guard.isCurrent(stamp)) return noop;
    showStatus(host, "sqlite-viewer-status", `테이블을 불러올 수 없습니다: ${err instanceof Error ? err.message : String(err)}`);
    return noop;
  }
  if (!guard.isCurrent(stamp)) return noop;

  const numericCols = numericColumnFlags(info.columnTypes, firstPage);
  const loadedRows = firstPage.slice();
  let loading = false;
  let pageFailed = false; // a failed page fetch is terminal — never auto-retried (hwp/pdf-viewer convention)

  host.className = "sqlite-viewer-sheet";
  const tableEl = document.createElement("table");
  tableEl.className = "sqlite-viewer-table";
  const thead = document.createElement("thead");
  thead.append(buildHeaderRow(info.columns, numericCols));
  const tbody = document.createElement("tbody");
  for (const row of loadedRows) tbody.append(buildRow(row, numericCols));
  tableEl.append(thead, tbody);
  host.replaceChildren(tableEl);
  caption.textContent = sqliteCaption(fileName, table.name, info.rowCount);

  const loadNextPage = async (): Promise<void> => {
    if (!shouldLoadNextPage(loadedRows.length, info.rowCount, loading)) return;
    loading = true;
    const loadingRow = buildLoadingRow(info.columns.length);
    tbody.append(loadingRow);
    try {
      const next = await invoke<SqliteRow[]>("sqlite_rows", {
        path: absPath,
        table: table.name,
        limit: SQLITE_PAGE_SIZE,
        offset: loadedRows.length,
      });
      if (!guard.isCurrent(stamp)) return;
      loadingRow.remove();
      for (const row of next) tbody.append(buildRow(row, numericCols));
      loadedRows.push(...next);
    } catch (err: unknown) {
      if (!guard.isCurrent(stamp)) return;
      pageFailed = true;
      loadingRow.className = "sqlite-viewer-page-error-row";
      loadingRow.textContent = "";
      const td = document.createElement("td");
      td.colSpan = info.columns.length;
      td.textContent = `다음 페이지를 불러올 수 없습니다: ${err instanceof Error ? err.message : String(err)}`;
      loadingRow.append(td);
    } finally {
      loading = false;
    }
  };

  const onScroll = (): void => {
    if (pageFailed) return;
    if (nearScrollEnd(host) && shouldLoadNextPage(loadedRows.length, info.rowCount, loading)) void loadNextPage();
  };
  host.addEventListener("scroll", onScroll);

  return () => host.removeEventListener("scroll", onScroll);
}

/** Build the tab strip + mount the active table inside `content`, wiring tab
 *  clicks to switch tables. `onTeardown` is `ViewerShell.onTeardown`
 *  narrowed to the one capability this needs (mirrors excel-viewer.ts's
 *  `renderWorkbook` — a subscription must stop when the viewer closes).
 *  Command (void). */
function renderDatabase(
  absPath: string,
  content: HTMLElement,
  tables: readonly SqliteTableEntry[],
  caption: HTMLElement,
  fileName: string,
  onTeardown: (cb: () => void) => void,
): void {
  if (tables.length === 0) {
    showStatus(content, "sqlite-viewer-status", "테이블/뷰가 없습니다");
    return;
  }

  content.className = "sqlite-viewer-body";
  content.replaceChildren();

  const guard = makeGenerationGuard();
  let active = 0;
  let currentTeardown: () => void = () => {};

  const sheetHost = document.createElement("div");
  sheetHost.className = "sqlite-viewer-sheet";

  const selectTable = (i: number): void => {
    active = i;
    setActiveTab(tabsEl, active);
    const stamp = guard.bump();
    currentTeardown();
    currentTeardown = () => {};
    mountTableSession(absPath, tables[active], sheetHost, caption, fileName, stamp, guard).then((cleanup) => {
      if (guard.isCurrent(stamp)) currentTeardown = cleanup;
      else cleanup();
    });
  };

  const tabsEl = buildTabStrip(tables, selectTable);
  onTeardown(() => currentTeardown());

  content.append(tabsEl, sheetHost);
  selectTable(0);
}

/** Open `absPath` in the SQLite viewer: shell up immediately with a loading
 *  status, `sqlite_tables` in the background, then hand off to
 *  `renderDatabase` (or show an error status) once the table/view list is
 *  known. Mirrors hwp/excel-viewer's openXxxViewer shape. Command. */
function openSqliteViewer(absPath: string): ViewerHandle {
  const content = document.createElement("div");
  content.className = "sqlite-viewer-status";
  content.textContent = "불러오는 중…";

  const shell = openViewerShell({ absPath, paneClass: "sqlite-viewer", content });
  // openViewerShell seeds the caption with basename(absPath) — captured here
  // so renderDatabase/mountTableSession can keep the file identity once the
  // caption switches to per-table text (same convention excel-viewer.ts's
  // `fileName` capture uses).
  const fileName = shell.caption.textContent ?? absPath;

  (async () => {
    const tables = await invoke<SqliteTableEntry[]>("sqlite_tables", { path: absPath });
    renderDatabase(absPath, content, tables, shell.caption, fileName, shell.onTeardown);
  })().catch((err: unknown) => {
    content.replaceChildren();
    showStatus(content, "sqlite-viewer-status", `데이터베이스를 열 수 없습니다: ${err instanceof Error ? err.message : String(err)}`);
  });

  // onClose forwards the shell teardown so the OPENER learns about closes it
  // did not initiate (Esc / header ✕) — see ViewerHandle.onClose.
  return { close: () => shell.close(), onClose: (cb) => shell.onTeardown(cb) };
}

const SQLITE_VIEWER: Viewer = {
  id: "sqlite", // NEVER-RENAME (registry.ts) — disabledViewersSetting persists this id
  extensions: ["sqlite", "db", "sqlite3", "db3"],
  label: "SQLite 데이터베이스",
  open: openSqliteViewer,
};

/** Register the SQLite viewer. Called once from main.ts's boot registration
 *  block, alongside the image/HWP built-ins — registerViewer's own
 *  duplicate-id guard makes a second call a developer error, matching every
 *  other registry in this codebase. Command (void). */
export function registerSqliteViewer(): void {
  registerViewer(SQLITE_VIEWER);
}
