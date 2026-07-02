// Custom title-bar chrome strip — the plain-DOM crown of #app, sitting above
// .workspace (see main.ts boot: #app = column(.title-bar, .workspace, .status-bar)).
// Same shape as status-bar.ts: no framework, no reactive plumbing, cold-load ~0.
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
// same attribute, or that strip of pixels stops being draggable.

import { isMac } from "./shortcuts/keys";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface TitleBar {
  el: HTMLElement;
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
 *  to flush unsaved buffers before the window actually goes away. No-op
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
