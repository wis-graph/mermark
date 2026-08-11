import { icon } from "../../icons";
import { iconNameForEntry, isEditableTextFile } from "../explorer/file-icons";
import { renderSidebarButton } from "../toggle";
import { rankHits, MAX_RESULTS, type FuzzyMatch } from "./fuzzy";

// ---------------------------------------------------------------------------
// File-finder LEFT SIDEBAR panel (⌘⇧F) — VS Code ⌘P-style quick open: one
// recursive scan of the current explorer root, then pure client-side fuzzy
// filtering on every keystroke (zero IPC per keystroke — see
// _workspace/01_architect_design.md §캐시 전략). Editor-adjacent chrome, same
// shape as explorer/recent/outline: mounted as a sibling of the editor host
// (never inside .cm-content/.cm-line), so it makes ZERO block/inline
// decorations and has no intersection with the live-preview pipeline or the
// render-smoke invariant.
//
// The backend scan (`list_files_recursive`) and the file-open path
// (read_file → commitBeforeSwitch → openInWindow) are INJECTED, exactly like
// explorer's listDir/onOpenFile — this panel never imports Tauri or the
// viewer registry directly, so it unit-tests with a fake scan and reuses
// main's existing open code with zero duplication.
// ---------------------------------------------------------------------------

const SEARCH_ASIDE_ID = "search-aside";

/** One file hit from the backend recursive scan — mirrors the Rust `FileHit`
 *  struct verbatim (serde field names, snake_case `rel_path`) so the 3-way
 *  boundary (Rust ↔ this interface ↔ tauri-core mock) stays parity-checked,
 *  same contract as explorer-panel.ts's `DirEntry`. */
export interface FileHit {
  name: string;
  path: string;
  rel_path: string;
}

/** The recursive scan's result — mirrors the Rust `ScanResult` struct.
 *  `truncated` is surfaced to the user (a silently-clipped result set would
 *  be a lie about what's actually on disk). */
export interface ScanResult {
  files: FileHit[];
  truncated: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const isValidFileHit = (hit: unknown): hit is FileHit =>
  isRecord(hit) && typeof hit.name === "string" && typeof hit.path === "string" && typeof hit.rel_path === "string";

const isValidScanResult = (result: unknown): result is ScanResult =>
  isRecord(result) && Array.isArray(result.files) && typeof result.truncated === "boolean" && result.files.every(isValidFileHit);

export interface SearchPanel {
  readonly button: HTMLButtonElement;
  readonly aside: HTMLElement;
  /** Hide the sidebar. Idempotent — the mutual-exclusion coordinator calls
   *  this on every panel but the one staying open. Command (void). */
  close(): void;
  /** ⌘⇧F's handler: open the panel if it's closed (which triggers exactly
   *  one scan — see the interface doc on `scan`) and focus the query input.
   *  Named `reveal` (not `toggle`) to match the panel reveal convention — the action
   *  id `search.files` is a storage key only, this name is the actual
   *  contract. Command (void). */
  revealSearch(): void;
}

export interface SearchHandlers {
  /** Recursively scan `root` for files. Injected so the panel stays
   *  backend-blind (main wires `(root) => invoke<ScanResult>("list_files_recursive",
   *  { root, showHidden: … })`) and unit-tests with a fake tree. Called
   *  exactly once per panel-open (see §캐시 전략 in the design doc) — never
   *  per keystroke. */
  scan(root: string): Promise<unknown>;
  /** The folder to scan: the live explorer root, or a fallback when the
   *  explorer has never been opened. A closure (read at open time, not
   *  subscribed) — main wires `() => explorer.currentRootPath() ?? currentBaseDir`. */
  getRoot(): string;
  /** Open `absPath` in the current window. Injected so this panel reuses
   *  main's existing read_file → commitBeforeSwitch → openInWindow path
   *  (the same closure explorer's onOpenFile uses) — no new open code. */
  onOpenFile(absPath: string): void;
  /** Open `absPath` in a brand-new window (⌘Enter). Optional — omitted
   *  callers keep ⌘Enter behaving like a plain Enter (same gating shape as
   *  explorer's onOpenFileNewWindow). */
  onOpenFileNewWindow?(absPath: string): void;
  /** Is a viewer registered for this filename? Optional — gates a non-
   *  markdown row open/inert exactly like explorer's `canOpenWithViewer`
   *  (same injected rule, same closure main shares with explorer so the two
   *  panels can never disagree about what's openable). */
  canOpenWithViewer?(name: string): boolean;
  /** Called when this panel opens, so main can close the other left
   *  sidebars (mutual exclusion). Optional — omitted in unit tests. */
  onOpen?(): void;
}

const create = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

/** True while an IME composition (e.g. Korean) is in progress — an Enter
 *  that CONFIRMS the composition must not also activate the selected row
 *  (mermark-frontend §7: name the domain rule, don't bury it in an inline
 *  `if` inside the keydown handler). Pure query. */
function isImeComposing(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}

/** Wrap the character ranges in `match.positions` with `<mark>` inside a text
 *  node's worth of `text`, appended to `parent`. Command (void) — the only
 *  DOM-building helper in this file that isn't a plain `create()` call,
 *  because highlighting requires splicing text/mark nodes rather than
 *  setting `.textContent` once. A `null` match (empty-query listing) renders
 *  plain text — no highlight to show. */
function appendHighlighted(parent: HTMLElement, text: string, match: FuzzyMatch | null): void {
  if (!match || match.positions.length === 0) {
    parent.append(document.createTextNode(text));
    return;
  }
  const hit = new Set(match.positions);
  let i = 0;
  while (i < text.length) {
    const start = i;
    const marked = hit.has(i);
    while (i < text.length && hit.has(i) === marked) i++;
    const chunk = text.slice(start, i);
    if (marked) {
      const mark = create("mark", "search-hit-mark");
      mark.textContent = chunk;
      parent.append(mark);
    } else {
      parent.append(document.createTextNode(chunk));
    }
  }
}

export function createSearchPanel({
  scan,
  getRoot,
  onOpenFile,
  onOpenFileNewWindow,
  canOpenWithViewer,
  onOpen,
}: SearchHandlers): SearchPanel {
  // isEditableTextFile is the SSOT (file-icons.ts) both this panel and
  // explorer-panel.ts derive from — no duplicated ".md-only" rule to drift.
  const isOpenableEntry = (name: string): boolean => isEditableTextFile(name) || !!canOpenWithViewer?.(name);

  const button = create("button", "chrome-btn search-btn icon-only") as HTMLButtonElement;
  button.title = "파일 찾기 (⌘⇧F · 퍼지 검색 · ↑↓ 이동 · Enter 열기 · ⌘Enter 새 창)";

  const aside = create("aside", "search-aside sidebar-aside");
  aside.id = SEARCH_ASIDE_ID;
  aside.hidden = true;
  const header = create("div", "search-header sidebar-header");
  header.textContent = "파일 찾기";

  const input = create("input", "search-input") as HTMLInputElement;
  input.type = "text";
  input.placeholder = "파일명으로 찾기…";
  input.setAttribute("aria-label", "파일 찾기");
  input.autocomplete = "off";
  input.spellcheck = false;

  const status = create("div", "search-status");
  status.hidden = true;
  const resultsEl = create("div", "search-results");
  resultsEl.setAttribute("role", "listbox");
  resultsEl.setAttribute("aria-label", "파일 찾기 결과");

  aside.append(header, input, status, resultsEl);

  const renderButton = (): void =>
    renderSidebarButton(button, "search", "파일 찾기", !aside.hidden, SEARCH_ASIDE_ID);
  renderButton();

  // Per-open scan cache (§캐시 전략): scanned once when the panel opens, held
  // in memory while it stays open, invalidated only by the NEXT open (a fresh
  // scan) — never by a keystroke. `scanError` renders a distinct row from
  // "no matches" so the user can tell a broken scan from an empty result.
  let cachedRoot: string | null = null;
  let cachedFiles: FileHit[] = [];
  let truncated = false;
  let scanError: string | null = null;
  let scanGeneration = 0;

  let highlighted = -1; // index into the currently-rendered row list

  const rows = (): HTMLElement[] => [...resultsEl.querySelectorAll<HTMLElement>(".search-item")];

  /** Move the highlighted-row cursor and reflect it in the DOM (`.is-highlighted`
   *  + `aria-selected` + `scrollIntoView`). Command (void) — the single place
   *  "which row is the keyboard cursor on" is set, so ↑↓ and a fresh render
   *  can't disagree. */
  const setHighlighted = (i: number): void => {
    const list = rows();
    if (list.length === 0) {
      highlighted = -1;
      return;
    }
    highlighted = Math.max(0, Math.min(list.length - 1, i));
    for (const [idx, row] of list.entries()) {
      const on = idx === highlighted;
      row.classList.toggle("is-highlighted", on);
      row.setAttribute("aria-selected", String(on));
    }
    // Optional call (not just optional chaining on the element): jsdom's
    // Element doesn't implement scrollIntoView at all (unlike a real
    // browser), so this guards test environments the same way explorer's
    list[highlighted]?.scrollIntoView?.({ block: "nearest" });
  };

  /** Render the results list for the current input value, from the CACHED
   *  scan (no IPC here — see the cache-strategy comment above `cachedFiles`).
   *  Command (void). */
  const renderResults = (): void => {
    resultsEl.replaceChildren();
    if (scanError) {
      const row = create("div", "search-error");
      const message = create("span", "search-state-message");
      message.textContent = `폴더를 읽을 수 없습니다: ${scanError}`;
      row.append(message);
      resultsEl.append(row);
      highlighted = -1;
      return;
    }
    if (truncated) {
      const banner = create("div", "search-truncated-banner");
      // "표시 상한"이 아니라 "스캔 자체가 중단됐다"는 사실을 정직하게 전달—
      // 잘린 것은 렌더 목록이 아니라 백엔드 walk(list_files_recursive의
      // MAX_SCAN_DEPTH/MAX_SCAN_FILES)이다 (audit 04, nit #4).
      const message = create("span", "search-state-message");
      message.textContent = "폴더가 너무 커서 일부 파일은 스캔되지 않았습니다";
      banner.append(message);
      resultsEl.append(banner);
    }
    const query = input.value;
    const ranked = rankHits(query, cachedFiles, (f) => f.rel_path, MAX_RESULTS);
    if (ranked.length === 0) {
      const empty = create("div", "search-empty");
      empty.textContent = query ? "일치하는 파일이 없습니다" : "표시할 파일이 없습니다";
      resultsEl.append(empty);
      highlighted = -1;
      return;
    }
    for (const { hit, match } of ranked) {
      const openable = isOpenableEntry(hit.name);
      const row = create("div", `search-item${openable ? "" : " is-nonmd"}`);
      row.setAttribute("role", "option");
      row.dataset.path = hit.path;
      const glyph = create("span", "search-item-glyph");
      glyph.append(icon(iconNameForEntry(hit.name, false, false)));
      const label = create("span", "search-item-label");
      appendHighlighted(label, hit.rel_path, match);
      row.append(glyph, label);
      resultsEl.append(row);
    }
    setHighlighted(0);
  };

  /** Activate the row at `index`: openable → open (⌘/Ctrl → new window when
   *  injected), non-openable → no-op (mirrors explorer's `.is-nonmd` gate).
   *  Command (void) — the single activation path shared by Enter and click,
   *  so the two can never diverge (explorer's `activateItem` precedent). */
  const activate = (index: number, newWindow: boolean): void => {
    const row = rows()[index];
    const path = row?.dataset.path;
    if (!row || !path || row.classList.contains("is-nonmd")) return;
    if (newWindow && onOpenFileNewWindow) onOpenFileNewWindow(path);
    else onOpenFile(path);
    close();
  };

  /** Run one scan against the current root, cache it, and (re)render. Command
   *  (void). The ONLY place `cachedFiles`/`truncated`/`scanError` are
   *  written — open() and revealSearch() both funnel through this, so the
   *  cache can never hold a stale root's results under a mismatched key. */
  const runScan = (): void => {
    const root = getRoot();
    const generation = ++scanGeneration;
    cachedRoot = root;
    scanError = null;
    // Reset synchronously (not just on resolve): while this scan is
    // in-flight, cachedFiles must not still hold the PREVIOUS open's
    // results — otherwise a keystroke during that window would render
    // matches from a possibly different root (audit 04, minor #1). The
    // renderResults() call below shows this reset immediately (an empty
    // list, not a flash of stale files), and the resolved/rejected branches
    // below still hold "no request-mismatched write" (the root-and-generation
    // guard) as the second half of the contract.
    cachedFiles = [];
    truncated = false;
    renderResults();
    scan(root)
      .then((result) => {
        if (cachedRoot !== root || scanGeneration !== generation) return;
        if (!isValidScanResult(result)) throw new Error("검색 결과 형식이 올바르지 않습니다");
        cachedFiles = result.files;
        truncated = result.truncated;
        renderResults();
      })
      .catch((err) => {
        if (cachedRoot !== root || scanGeneration !== generation) return;
        cachedFiles = [];
        truncated = false;
        scanError = err instanceof Error && err.message.length > 0 ? err.message : "알 수 없는 오류";
        renderResults();
      });
  };

  const open = (): void => {
    aside.hidden = false;
    onOpen?.();
    renderButton();
    input.value = "";
    runScan(); // exactly one scan per open — see §캐시 전략 (clears+renders synchronously, then resolves)
    input.focus();
  };
  const close = (): void => {
    aside.hidden = true;
    renderButton();
  };
  /** Reveal the panel and focus the input, whether it was already open (⌘⇧F
   *  pressed twice) or closed — unlike `open()`, this does NOT re-scan when
   *  already open (re-scanning on every ⌘⇧F press would defeat the
   *  once-per-open cache). Command (void). */
  const revealSearch = (): void => {
    if (aside.hidden) open();
    else input.focus();
  };

  button.addEventListener("click", () => {
    if (aside.hidden) open();
    else close();
  });

  input.addEventListener("input", renderResults);

  input.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlighted(highlighted + 1);
        return;
      case "ArrowUp":
        e.preventDefault();
        setHighlighted(highlighted - 1);
        return;
      case "Enter":
        if (isImeComposing(e)) return; // let the IME confirm; don't also activate
        e.preventDefault();
        if (highlighted >= 0) activate(highlighted, e.metaKey || e.ctrlKey);
        return;
      case "Escape":
        e.preventDefault();
        close();
        return;
    }
  });

  resultsEl.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest(".search-item") as HTMLElement | null;
    if (!row) return;
    const idx = rows().indexOf(row);
    if (idx >= 0) activate(idx, e.metaKey || e.ctrlKey);
  });

  return { button, aside, close, revealSearch };
}
