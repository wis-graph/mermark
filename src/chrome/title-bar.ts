// Custom title-bar chrome strip — the plain-DOM crown of .main-column, sitting
// above .editor-host (see main.ts boot: #app = row(.sidebar-aside*, sash,
// .main-column = column(.title-bar, .editor-host, .status-bar))). Same shape
// as chrome/status-bar/index.ts: no framework, no reactive plumbing, cold-load ~0.
//
// Platform contract (design M1): macOS keeps the native traffic lights via the
// Rust-side Overlay title-bar style (with_document_chrome in lib.rs) — this
// strip only reserves an inset so the lights don't collide with content. Every
// other OS gets `decorations(false)` on the Rust side, so this strip supplies
// the only window chrome: minimize / toggle-maximize / close buttons.
//
// Drag vs click: `data-tauri-drag-region` is set on the `.title-bar` container
// ONLY. Tauri's drag-region handling looks at the mousedown target's own
// attribute, so the window-control buttons (which don't carry the attribute)
// receive their clicks normally — the drag region doesn't swallow them. M2
// note: any filler/spacer element added between the buttons later needs the
// same attribute, or that strip of pixels stops being draggable — see
// createDragSpacer below, which is exactly that filler.
//
// M2: the title-bar is now also the LEFT-command-group + right-cluster home
// (sidebar toggles, open-path, mode/theme/settings) — arrangeTitleBar owns
// that left→right order, the same "single named ordering function" contract
// arrangeStatusBar (chrome/status-bar/index.ts) already established.
//
// M6 (_workspace/01_architect_design.md, rehome): when a sidebar rail is
// open, the left command group moves OUT of the title-bar and into that
// rail's own window-chrome band (.sidebar-top-strip) instead — the rail is
// exactly as tall as the title-bar and sits at the same window edge, so it's
// a second valid home for the same group, not a second bar.
// rehomeLeftCommandGroup is the single domain rule for "which home wins";
// the rail set + the MutationObserver watching each aside's `hidden`
// attribute now live in sidebar/registry.ts (R9, _workspace/01_architecture.md)
// since the rail set is dynamic (panels register at runtime) — this module
// only keeps the pure placement rule.
//
// D1 (2026-10-18, 디자인 리뷰 🔴3): the left command group now holds ONLY the
// registered panel toggles (탐색기·최근·목차·워크스페이스·검색 — appended by
// sidebar/registry.ts in registration order). `openPath` is title-bar-owned and
// never rehomed: it sits right after the group, because it turns the title-bar
// ITSELF into the path input (.title-bar.path-editing). The rail only receives
// the group when it FITS the strip (leftGroupFitsStrip) — a 160px rail, a
// 300% zoom or many extension panels used to clip it.

import { isMac } from "../shortcuts/keys";
import { basename } from "../document/path";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface TitleBar {
  el: HTMLElement;
}

/** The chrome parts arrangeTitleBar lays out, left→right: `leftGroup` (the
 *  panel-toggle command group — empty from createLeftCommandGroup,
 *  sidebar/registry.ts appends the toggles in registration order), `openPath`
 *  (D1: title-bar-owned), the viewer caption `titleSlot`, the document name
 *  `docName`, a drag spacer, then the `viewerSlot`/`mode`/`theme`/`settings`
 *  right cluster.
 *
 *  M6: the panel toggles are `leftGroup`'s job because the group rehomes as
 *  ONE element (rehomeLeftCommandGroup); R9: they moved into
 *  sidebar/registry.ts's registration order. D1: `openPath` came back OUT of
 *  the group so the group's width is just the toggles (see header comment). */
export interface TitleBarParts {
  leftGroup: HTMLElement;
  /** The 경로 열기 button. Never rehomed — it stays in the title-bar even while
   *  a rail is open (D1 🔴3). */
  openPath: HTMLElement;
  /** Empty until a viewer opens, then the open file's name — the title-bar IS
   *  the viewer's title bar (사용자 지정 2026-07-19: "앱 헤더영역을 이용해서
   *  제목을 사용할 수 있고"). The viewer shell fills and clears it; nothing
   *  else writes here, so an empty slot means "no viewer open". */
  titleSlot: HTMLElement;
  /** The open DOCUMENT's filename (D1 🔴5) — written ONLY by main.ts's
   *  `session.readonlyView.subscribe` through renderDocName; hidden by CSS
   *  while a viewer owns `titleSlot`. Filename ONLY — no save-state marker of
   *  any kind (user decision: the app autosaves, a marker is noise). */
  docName: HTMLElement;
  /** Empty until a viewer opens, then the viewer's OWN controls (zoom −/%/+,
   *  close) — rendered as ordinary `.chrome-btn` siblings of mode/theme/
   *  settings so they read as one cluster, not a second, alien toolbar
   *  (사용자 지정 2026-07-19: "그 공간에 다른 버튼들 같은 포멧으로 들어오면
   *  전혀 이질적이지 않자나"). A `|` rule separates the two groups. */
  viewerSlot: HTMLElement;
  mode: HTMLElement;
  theme: HTMLElement;
  settings: HTMLElement;
}

/** The document-title slot (see TitleBarParts.titleSlot). Carries
 *  `data-tauri-drag-region` so the strip it occupies stays draggable while it
 *  is empty — the same rule createDragSpacer documents. Pure query. */
export function createTitleSlot(): HTMLElement {
  const el = document.createElement("div");
  el.className = "title-bar-doc-title";
  el.setAttribute("data-tauri-drag-region", "");
  return el;
}

/** The viewer-controls slot (see TitleBarParts.viewerSlot). No drag region —
 *  it holds buttons, and a drag region on their container would swallow their
 *  clicks. Pure query. */
export function createViewerSlot(): HTMLElement {
  const el = document.createElement("div");
  el.className = "title-bar-viewer-slot";
  return el;
}

/** The document-name label (see TitleBarParts.docName). Carries
 *  `data-tauri-drag-region` (same M1 rule as createTitleSlot). Pure creation. */
export function createDocName(): HTMLElement {
  const el = document.createElement("span");
  el.className = "title-bar-doc-name";
  el.setAttribute("data-tauri-drag-region", "");
  return el;
}

/** Show `file`'s basename (empty file → empty label); the full path is the
 *  tooltip. Command (void). Deliberately nothing but the name. */
export function renderDocName(el: HTMLElement, file: string): void {
  el.textContent = file ? basename(file) : "";
  el.title = file;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Build a minimal 10x10 line-glyph <svg> for a window-control button (minimize
 *  dash / maximize square / close X). Deliberately not routed through icons.ts:
 *  that registry is Lucide-24 iconography for content chrome, while these are
 *  OS-convention window-control glyphs at a different weight/size — a distinct
 *  vocabulary, so a parallel tiny factory here keeps icons.ts unchanged. */
function windowGlyph(paths: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "10");
  svg.setAttribute("height", "10");
  svg.setAttribute("viewBox", "0 0 10 10");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = paths;
  return svg;
}

/** Is this running inside a real Tauri webview? Names the
 *  `"__TAURI_INTERNALS__" in window` check main.ts:556 already uses, so
 *  dev:browser / CDP / vitest (none of which have window IPC) treat window
 *  control clicks as safe no-ops instead of throwing. Pure query. */
function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/** Minimize the current window. No-op outside a real Tauri runtime. Command (void). */
function minimizeWindow(): void {
  if (!isTauriRuntime()) return;
  void getCurrentWindow().minimize();
}

/** Toggle the current window between maximized and restored — one control does
 *  both directions, matching the single `toggleMaximize` JS API (there is no
 *  separate "maximize" to call). No-op outside a real Tauri runtime. Command (void). */
function toggleMaximizeWindow(): void {
  if (!isTauriRuntime()) return;
  void getCurrentWindow().toggleMaximize();
}

/** Close the current window. This is `close()`, not `destroy()` — it goes
 *  through the same window-close path main.ts's `onCloseRequested` intercepts
 *  to flush pending buffers before the window actually goes away. No-op
 *  outside a real Tauri runtime. Command (void). */
function closeWindow(): void {
  if (!isTauriRuntime()) return;
  void getCurrentWindow().close();
}

/** The three win/linux window-control buttons (minimize / maximize / close),
 *  right-aligned inside the title-bar via `margin-left: auto`. Pure creation —
 *  no drag-region attribute on any button, so clicks pass through the strip's
 *  drag region untouched. */
function createWindowControls(): HTMLElement {
  const controls = document.createElement("div");
  controls.className = "window-controls";

  const minimize = document.createElement("button");
  minimize.className = "window-btn window-btn-minimize";
  minimize.setAttribute("aria-label", "최소화");
  minimize.setAttribute("type", "button");
  minimize.append(windowGlyph('<path d="M1 5h8"/>'));
  minimize.addEventListener("click", minimizeWindow);

  const maximize = document.createElement("button");
  maximize.className = "window-btn window-btn-maximize";
  maximize.setAttribute("aria-label", "최대화");
  maximize.setAttribute("type", "button");
  maximize.append(windowGlyph('<rect x="1.5" y="1.5" width="7" height="7"/>'));
  maximize.addEventListener("click", toggleMaximizeWindow);

  const close = document.createElement("button");
  close.className = "window-btn window-btn-close";
  close.setAttribute("aria-label", "닫기");
  close.setAttribute("type", "button");
  close.append(windowGlyph('<path d="M1 1l8 8M9 1l-8 8"/>'));
  close.addEventListener("click", closeWindow);

  controls.append(minimize, maximize, close);
  return controls;
}

/** Build the top title-bar strip. `platform` is injectable for tests; the real
 *  default is the host's actual platform (`isMac()`). macOS renders an inset-only
 *  strip (native Overlay traffic lights sit on top, supplied by the Rust window
 *  builder) with no window-control buttons. Every other platform renders the
 *  custom minimize/maximize/close cluster. Command (creates a fresh DOM tree). */
export function createTitleBar(opts?: { platform?: "mac" | "other" }): TitleBar {
  const platform = opts?.platform ?? (isMac() ? "mac" : "other");
  const el = document.createElement("div");
  el.className = "title-bar";
  el.setAttribute("data-tauri-drag-region", "");

  if (platform === "mac") {
    el.classList.add("mac");
  } else {
    el.append(createWindowControls());
  }

  return { el };
}

/** Window controls (win/linux) must stay the LAST children of the title-bar —
 *  OS convention. Insert every arranged part before them; on mac (no controls)
 *  this degrades to a plain append. Private to title-bar.ts. */
function insertBeforeWindowControls(bar: HTMLElement, ...els: HTMLElement[]): void {
  const anchor = bar.querySelector(":scope > .window-controls");
  for (const el of els) bar.insertBefore(el, anchor); // anchor null → append
}

/** The flexible filler between the left command group and the right cluster.
 *  MUST carry data-tauri-drag-region — a child without the attribute is a dead
 *  zone for window dragging (M1 handoff rule, title-bar.ts header comment). */
function createDragSpacer(): HTMLElement {
  const s = document.createElement("span");
  s.className = "title-spacer";
  s.setAttribute("data-tauri-drag-region", "");
  return s;
}

/** Build the "왼쪽 커맨드 그룹" — the always-together unit that rehomes as ONE
 *  element (rehomeLeftCommandGroup). D1: EMPTY at creation; sidebar/registry.ts
 *  appends one toggle button per registered panel, so the toggle order IS the
 *  registration order and lives in exactly one place. Carries its own
 *  data-tauri-drag-region (M1 rule): the group can land inside either the
 *  title-bar or a rail's .sidebar-top-strip, and both need the gaps between its
 *  buttons to stay draggable. Pure creation. */
export function createLeftCommandGroup(): HTMLElement {
  const group = document.createElement("div");
  group.className = "left-command-group";
  group.setAttribute("data-tauri-drag-region", "");
  return group;
}

/** The window-chrome band at the top of the full-height sidebar rail (same
 *  36px height as .title-bar). Two jobs: (1) mac — the native Overlay traffic
 *  lights sit above this band, so it pushes rail content (.sidebar-header)
 *  below the lights instead of the title-bar (which no longer starts at the
 *  window's left edge once the rail is open); (2) every platform — a window
 *  drag region, same M1 rule as createDragSpacer. `platform` is injectable
 *  for tests, same shape as createTitleBar's opts; the real default is the
 *  host's actual platform (isMac()). Childless AT CREATION TIME only — M6:
 *  sidebar/registry.ts's rehoming observer later moves the left-command-group
 *  in at runtime (that group carries its own drag-region, so the strip
 *  gaining a child doesn't create a dead zone). Pure construction (no
 *  wiring) — sidebar/registry.ts prepends one per aside on mount. */
export function createSidebarTopStrip(opts?: { platform?: "mac" | "other" }): HTMLElement {
  const platform = opts?.platform ?? (isMac() ? "mac" : "other");
  const s = document.createElement("div");
  s.className = "sidebar-top-strip";
  s.setAttribute("data-tauri-drag-region", "");
  if (platform === "mac") s.classList.add("mac");
  return s;
}

/** Domain rule, pure: does a group of `groupWidth` px fit in `available` px? */
export function groupFitsWithin(groupWidth: number, available: number): boolean {
  return groupWidth <= available;
}

/** Layout query: does the left command group fit in `strip`'s content box?
 *  The group is `flex: none`, so its own box width IS its content width
 *  wherever it currently sits (title-bar or strip). jsdom reports 0 for both
 *  → true (the rehome tests that don't stub widths see "fits"). Pure query. */
export function leftGroupFitsStrip(group: HTMLElement, strip: HTMLElement): boolean {
  const cs = getComputedStyle(strip);
  const padding = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  return groupFitsWithin(group.getBoundingClientRect().width, strip.clientWidth - padding);
}

/** The one domain rule this feature has: the left command group lives in the
 *  open rail's strip if there is one (callers pass null when the group does not
 *  fit — leftGroupFitsStrip), otherwise it returns to the START of the
 *  title-bar's flow (D1: before openPath, which arrangeTitleBar places right
 *  after the group). Moving an element drops DOM focus, so a focused
 *  descendant is re-focused after the move. Idempotent — calling again with the
 *  group already in its target home is a no-op (no spurious focus churn).
 *  Command (void). */
export function rehomeLeftCommandGroup(group: HTMLElement, bar: HTMLElement, strip: HTMLElement | null): void {
  const focused = group.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
  if (strip) {
    if (group.parentElement !== strip) {
      strip.appendChild(group);
      focused?.focus();
    }
  } else {
    // The group is the FIRST thing in the bar's flow. (Anchoring on the title
    // slot or spacer re-inserted it AFTER openPath/the title — the 2026-07-19
    // "icons shoved past the filename" bug, then the D1 openPath variant.)
    if (bar.firstElementChild !== group) {
      bar.insertBefore(group, bar.firstElementChild);
      focused?.focus();
    }
  }
}

/** Arrange the title-bar chrome to the canonical order (design M2 §1, M5
 *  removed 즐겨찾기, M6 folded the panel toggles into `leftGroup`, D1 put
 *  `openPath` back after it and added the document name): leftGroup · openPath
 *  · titleSlot · docName · [drag spacer] · viewerSlot · 모드 · 테마 · ⚙ — the
 *  two viewer slots are empty until a viewer opens (2026-07-19: a viewer has no
 *  header row of its own; the title-bar is its title bar) — followed by the
 *  win/linux window-controls cluster (always last, already appended by
 *  createTitleBar). Every part is inserted via insertBeforeWindowControls, so
 *  the window-controls-last rule holds regardless of call order. Command (void). */
export function arrangeTitleBar(bar: HTMLElement, p: TitleBarParts): void {
  insertBeforeWindowControls(
    bar,
    p.leftGroup,
    p.openPath,
    p.titleSlot,
    p.docName,
    createDragSpacer(),
    p.viewerSlot,
    p.mode,
    p.theme,
    p.settings,
  );
}
