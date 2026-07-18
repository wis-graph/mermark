// The viewer SHELL every non-markdown viewer (image lightbox, Excel, HTML,
// HWP, PDF) shares — full-pane rewrite (_workspace/01_architect_design.md,
// 2026-07-18) of the R11 body-level backdrop/modal (git history:
// image-viewer.ts's original inline chrome → this shared shell). The product
// decision this round (user-confirmed, not up for re-litigation): a viewer
// occupies the EDITOR'S area inside `.main-column` — top-bar/sidebar/footer
// stay live — instead of floating a dialog over the whole app.
//
// Lives inside `.main-column`, as `.editor-host`'s sibling — never inside
// `.cm-content` — so it makes zero decorations: the render-smoke invariant
// ("block decorations come from a StateField") has no intersection here.
import { basename } from "../../document/path";
import { icon, type IconName } from "../../icons";

export interface ViewerZoom {
  /** Current zoom factor. 1.0 = fit (the default every open() starts at).
   *  Pure query. */
  get(): number;
  /** Apply `fn` once immediately with the CURRENT factor, then again on every
   *  future change (settings-store `bind` idiom — sink-friendly: a viewer
   *  wires this once at open() and is correctly zoomed from frame one).
   *  Returns an unsubscribe. */
  bind(fn: (factor: number) => void): () => void;
}

export interface ViewerShell {
  /** The header's filename slot — a viewer may overwrite `.textContent` with
   *  richer text (image's "name — WxH", Excel's per-sheet caption). Same
   *  contract the pre-rewrite shell made, only relocated (body → header). */
  caption: HTMLElement;
  /** The shell's zoom state machine — SINGLE WRITER (the header's −/+/label
   *  controls). A viewer only ever READS this (`.get()`/`.bind()`), never
   *  writes it — there is no `.set()` on this interface, by design (design
   *  §B: "셸이 줌 상태의 단일 작성자"). */
  zoom: ViewerZoom;
  /** Register a callback to run exactly once, inside close() — for a
   *  caller's own teardown (pan/zoom destroy, sheet worker cleanup, ...).
   *  Multiple registrations all run, in registration order. */
  onTeardown(cb: () => void): void;
  /** Idempotent close: removes the pane, restores `.editor-host` (clears
   *  `hidden`), and restores focus to whatever had it before open(). */
  close(): void;
}

/** The `.editor-host` element every markdown document mounts inside — the
 *  viewer pane's insertion anchor AND hide/show target. Pure query. */
function viewerMountPoint(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".editor-host");
}

/** The title-bar's document-title slot (chrome/title-bar.ts's
 *  `createTitleSlot`) — the viewer writes the open file's name here instead of
 *  rendering a header row of its own. Null in a minimal test fixture that
 *  never built a title-bar; every write below is optional-chained so the shell
 *  still works headless. Pure query. */
function titleBarTitleSlot(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".title-bar-doc-title");
}

/** The title-bar's viewer-controls slot (`createViewerSlot`) — the viewer's
 *  zoom/close buttons live here, as siblings of 모드/테마/설정. Pure query. */
function titleBarViewerSlot(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".title-bar-viewer-slot");
}

/** Insert `pane` right after `.editor-host` and hide the host via the
 *  `hidden` attribute (display:none) — NEVER `inert` (design §A/§D: display:
 *  none already removes the editor from the focus/AT tree; the top-bar/
 *  sidebar/footer are deliberately left alive, the whole point of a non-modal
 *  pane). The editor is never unmounted, so its document state, scroll
 *  position, and session all survive untouched (CM6 re-measures itself on
 *  the next `hidden` → visible transition — unverifiable in jsdom, see
 *  golden G-layout / real-app Stage 7).
 *
 *  Falls back to `document.body.append(pane)` when no `.editor-host` exists
 *  (a minimal test fixture) — mounting always succeeds, but only the real
 *  path hides anything, so `restore()` is correctly a no-op on that path.
 *  Command: returns the paired `restore()` that undoes exactly what this
 *  did — never more (a fallback mount must not clear `hidden` on some
 *  UNRELATED host it never touched). */
function mountViewerPane(pane: HTMLElement): { restore(): void } {
  const host = viewerMountPoint();
  if (host) {
    host.after(pane);
    host.hidden = true;
    return {
      restore() {
        host.hidden = false;
      },
    };
  }
  document.body.append(pane);
  return { restore() {} };
}

// The zoom ladder — the same rung set a browser's native ⌘±/pinch zoom uses,
// so the step feel is familiar. 1 (index 4) is the fit/default rung every
// open() starts at (design §B "매 open마다 fit(1.0)에서 시작").
const ZOOM_LADDER = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;
const ZOOM_DEFAULT = 1;

/** The ladder rung nearest to `current` — snap-before-step (see
 *  `nextZoomFactor`) so a factor that ever drifts off-ladder still moves
 *  sanely rather than throwing/NaN-ing. Pure query. */
function nearestRungIndex(current: number): number {
  let idx = 0;
  let nearestDist = Infinity;
  for (let i = 0; i < ZOOM_LADDER.length; i += 1) {
    const dist = Math.abs(ZOOM_LADDER[i] - current);
    if (dist < nearestDist) {
      nearestDist = dist;
      idx = i;
    }
  }
  return idx;
}

/** The next zoom factor one step in `direction` from `current` — snaps to
 *  the nearest ladder rung first, then moves one rung, clamped at both ends
 *  (a click at the extreme is a no-op: the clamped index equals the current
 *  one, so the return value is unchanged). Pure query — the shell is the
 *  only writer that ever calls this; a viewer never does. */
export function nextZoomFactor(current: number, direction: "in" | "out"): number {
  const idx = nearestRungIndex(current);
  const step = direction === "in" ? 1 : -1;
  const nextIdx = Math.min(ZOOM_LADDER.length - 1, Math.max(0, idx + step));
  return ZOOM_LADDER[nextIdx];
}

/** "150%"-style zoom label text — rounds to the nearest whole percent, the
 *  standard browser zoom-label convention. Pure query. */
export function formatZoomLabel(factor: number): string {
  return `${Math.round(factor * 100)}%`;
}

/** The shell's zoom state machine: one writer (`applyZoomFactor`, called only
 *  from the header's own −/+/label handlers below), any number of readers
 *  (`zoom.get`/`zoom.bind`). Every write does all three of: update the
 *  in-memory factor, refresh the label text, and project the factor onto the
 *  pane root as `--viewer-zoom` — that CSS variable is NOT a second SSOT, it
 *  is this writer's own DOM projection (same posture as a settings-store
 *  cssVarSink), so a viewer that wants CSS-only zoom (Excel's table
 *  font-size) reads the var, and a viewer that wants JS control (PDF/HWP/
 *  image/HTML) calls `zoom.bind`. Command factory — the returned closures are
 *  what shell wiring below calls. */
function makeZoomController(
  paneEl: HTMLElement,
  labelEl: HTMLElement,
): { zoom: ViewerZoom; applyZoomFactor(factor: number): void } {
  let factor = ZOOM_DEFAULT;
  const listeners = new Set<(f: number) => void>();

  function applyZoomFactor(next: number): void {
    factor = next;
    labelEl.textContent = formatZoomLabel(factor);
    paneEl.style.setProperty("--viewer-zoom", String(factor));
    for (const fn of listeners) fn(factor);
  }

  const zoom: ViewerZoom = {
    get: () => factor,
    bind(fn) {
      listeners.add(fn);
      fn(factor); // apply-now half of the bind idiom
      return () => listeners.delete(fn);
    },
  };

  return { zoom, applyZoomFactor };
}

/** Open the viewer shell: an in-content pane (sibling of `.editor-host`,
 *  never a body-level overlay), a header (filename + zoom controls + close),
 *  and the caller's `content` in a scrollable body below it. Every viewer
 *  funnels through here so panel chrome, the hide/restore contract, Esc,
 *  focus management, and the zoom state machine are written exactly once.
 *
 *  `opts.paneClass` ("pdf-viewer", "excel-viewer", ...) is added to the pane
 *  root ALONGSIDE `.viewer-panel` (never instead of it) — a viewer's own
 *  injected CSS scopes to it for content that isn't shell chrome, the same
 *  contract the pre-rewrite `modalClass` made (renamed: this is no longer a
 *  modal, and a field name that still said so would be exactly the kind of
 *  drifted promise this codebase's naming discipline forbids). */
export function openViewerShell(opts: {
  absPath: string;
  /** "pdf-viewer" | "excel-viewer" | ... — an existing or new CSS selector;
   *  paired with the shared `.viewer-panel*` classes below, so this only
   *  needs to carry a viewer's CONTENT-specific styling, not its chrome. */
  paneClass: string;
  content: HTMLElement;
}): ViewerShell {
  const lastFocused = document.activeElement;
  const name = basename(opts.absPath);
  const teardowns: (() => void)[] = [];

  const pane = document.createElement("div");
  pane.className = `${opts.paneClass} viewer-panel`;
  // NOT role=dialog/aria-modal (design §D): a non-modal pane telling
  // assistive tech "everything else is inert" would be a lie — the top-bar/
  // sidebar/footer are deliberately still live and operable.
  pane.setAttribute("role", "region");
  pane.setAttribute("aria-label", name);

  // The viewer has NO header row of its own: the app's title-bar IS its title
  // bar (사용자 지정 2026-07-19). A dedicated header row both wasted a whole
  // strip of vertical space and rendered its own bordered buttons, which read
  // as an alien second toolbar next to the app's flat icon chrome ("버튼디자인
  // 이거 뭐야, 왜이렇게 끔찍해"). Filename → titleSlot, controls → viewerSlot,
  // and the controls are ordinary `.chrome-btn.icon-only` buttons so they are
  // literally the same component as 모드/테마/설정 beside them.
  const caption = document.createElement("span");
  caption.className = `${opts.paneClass}-caption viewer-panel-caption`;
  caption.textContent = name;

  /** One title-bar control, built as the SAME `.chrome-btn` every other
   *  title-bar button uses — the point of this whole change is that a viewer
   *  button is not a special kind of button. Pure query. */
  const chromeButton = (cls: string, label: string, glyph: IconName): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `chrome-btn icon-only ${cls}`;
    b.setAttribute("aria-label", label);
    b.title = label;
    b.append(icon(glyph));
    return b;
  };

  const controls = document.createElement("div");
  controls.className = "viewer-panel-zoom";

  const zoomOutBtn = chromeButton("viewer-panel-zoom-out", "축소", "minus");
  // The label is itself a button — clicking it resets to fit (100%), the
  // standard "click the percentage to reset zoom" affordance. Not icon-only:
  // it carries text, so it keeps `.chrome-btn`'s padded (non-square) shape.
  const zoomLabel = document.createElement("button");
  zoomLabel.type = "button";
  zoomLabel.className = "chrome-btn viewer-panel-zoom-label";
  zoomLabel.setAttribute("aria-label", "100%로 재설정");
  zoomLabel.title = "100%로 재설정";
  const zoomInBtn = chromeButton("viewer-panel-zoom-in", "확대", "plus");
  const closeBtn = chromeButton(`${opts.paneClass}-close viewer-panel-close`, "닫기", "x");

  // The `|` rule the user asked for: separates the viewer's controls from the
  // app's own (모드·테마·설정) without turning them into two toolbars.
  const divider = document.createElement("span");
  divider.className = "title-bar-divider";
  divider.setAttribute("aria-hidden", "true");

  controls.append(zoomOutBtn, zoomLabel, zoomInBtn, closeBtn, divider);

  const titleSlot = titleBarTitleSlot();
  const viewerSlot = titleBarViewerSlot();
  titleSlot?.replaceChildren(caption);
  viewerSlot?.replaceChildren(controls);

  // Shell-owned scroll boundary (unchanged from the pre-rewrite shell) —
  // every viewer's content lands inside this, never directly as a flex item
  // of `pane`.
  const body = document.createElement("div");
  body.className = "viewer-panel-body";
  body.appendChild(opts.content);

  pane.append(body);

  const mount = mountViewerPane(pane);

  const { zoom, applyZoomFactor } = makeZoomController(pane, zoomLabel);
  applyZoomFactor(ZOOM_DEFAULT); // seed the label text + --viewer-zoom before first paint

  let closed = false;
  const handle: ViewerShell = {
    caption,
    zoom,
    onTeardown(cb) {
      teardowns.push(cb);
    },
    close() {
      if (closed) return; // idempotent — Esc + close-button can race
      closed = true;
      document.removeEventListener("keydown", onKeydown, true);
      for (const cb of teardowns) cb();
      pane.remove();
      // The title-bar slots are shell-owned while a viewer is open; emptying
      // them is what returns the title-bar to its no-viewer state.
      titleSlot?.replaceChildren();
      viewerSlot?.replaceChildren();
      mount.restore();
      (lastFocused as HTMLElement | null)?.focus?.();
    },
  };

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      handle.close();
    }
  };

  closeBtn.addEventListener("click", () => handle.close());
  zoomOutBtn.addEventListener("click", () => applyZoomFactor(nextZoomFactor(zoom.get(), "out")));
  zoomInBtn.addEventListener("click", () => applyZoomFactor(nextZoomFactor(zoom.get(), "in")));
  zoomLabel.addEventListener("click", () => applyZoomFactor(ZOOM_DEFAULT));
  document.addEventListener("keydown", onKeydown, true);

  closeBtn.focus(); // opened with focus on the close action (accessibility)
  return handle;
}
