import {
  sidebarWidthSetting,
  clampSidebarWidth,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX_ABS,
} from "../settings/app";

// ---------------------------------------------------------------------------
// Left-sidebar width sash: a thin draggable divider between the sidebar shell
// (.sidebar-aside, shared by the explorer + outline panels — one shell, one
// width) and the editor host. Visibility is CSS-only
// (`.sidebar-aside:not([hidden]) ~ .workspace-sash { display: block }` in
// styles.css) — this module never toggles visibility itself, so the sash
// auto-hides when both sidebars are closed and auto-shows when either opens,
// with zero DOM/observer wiring here and zero coupling to closeOtherSidebars.
//
// DRAG = PREVIEW, RELEASE = COMMIT: pointermove writes the width directly onto
// documentElement's --sidebar-width var (a transient visual value, NOT SSOT)
// so dragging never touches localStorage per-frame; pointerup commits exactly
// ONE write to sidebarWidthSetting, whose sink (cssVarSink, bound in main.ts)
// re-applies the same var — idempotent, so SSOT and the visible var always
// converge on release. Keyboard steps are single events, so they commit
// straight through the setting (no separate preview phase needed).
//
// ZOOM GUARD: this module imports ONLY settings/app — no editor, no `current`,
// no CM view. It adjusts a var that .sidebar-aside's width composes; the
// editor host absorbs the remaining space (`.editor-host { flex:1;
// min-width:0 }`) and CM6 re-measures itself via its own ResizeObserver.
// Nothing here ever touches .cm-content/.cm-line, so --measure/--font-scale
// (the reading-column zoom guard) are untouched.
// ---------------------------------------------------------------------------

// clampSidebarWidth lives in settings/app.ts (next to clampFontScale /
// clampReadingWidth) so the setting's own parse can clamp a hand-edited
// localStorage value at boot — it's the SSOT for "valid sidebar width", used by
// drag, keyboard, AND parse. This module imports it; the dependency direction is
// already sash → settings, so there's no cycle.

/** Keyboard step (px per arrow-key press). A named constant, not a setting —
 *  there's no product reason to make this user-configurable. */
const KEY_STEP = 16;

export interface SidebarSash {
  readonly el: HTMLDivElement;
}

/** Build the drag sash: a `role="separator"` div wired for pointer-drag
 *  (preview via CSS var, commit on release) and keyboard (Arrow Left/Right,
 *  step KEY_STEP, immediate commit). Command: constructs DOM + attaches
 *  handlers; the ONLY SSOT writer is sidebarWidthSetting.set — pointermove
 *  never calls it (see module doc). jsdom does not implement
 *  set/releasePointerCapture; the optional-chained calls below are therefore
 *  ALSO the test-environment no-op stub — no jsdom monkeypatching needed. */
export function createSidebarSash(): SidebarSash {
  const el = document.createElement("div");
  el.className = "workspace-sash";
  el.setAttribute("role", "separator");
  el.setAttribute("aria-orientation", "vertical");
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-label", "사이드바 폭 조절");
  el.setAttribute("aria-valuemin", String(SIDEBAR_WIDTH_MIN));
  el.setAttribute("aria-valuemax", String(SIDEBAR_WIDTH_MAX_ABS));

  // aria-valuenow tracks the SSOT directly (bind = apply now + on every
  // change), independent of the drag preview's transient var.
  sidebarWidthSetting.bind((px) => el.setAttribute("aria-valuenow", String(px)));

  let startX = 0;
  let startWidth = 0;

  const previewWidthAt = (clientX: number): number =>
    clampSidebarWidth(startWidth + (clientX - startX), window.innerWidth);

  const onPointerMove = (e: PointerEvent): void => {
    document.documentElement.style.setProperty("--sidebar-width", `${previewWidthAt(e.clientX)}px`);
  };
  const onPointerUp = (e: PointerEvent): void => {
    const committed = previewWidthAt(e.clientX);
    el.classList.remove("is-dragging");
    el.releasePointerCapture?.(e.pointerId);
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("pointerup", onPointerUp);
    sidebarWidthSetting.set(committed); // the ONE commit; sink re-writes the same var (idempotent)
  };
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return; // primary (left) button only — no right/middle-click drag
    startX = e.clientX;
    startWidth = sidebarWidthSetting.get();
    el.classList.add("is-dragging");
    el.setPointerCapture?.(e.pointerId);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
  });

  el.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const delta = e.key === "ArrowRight" ? KEY_STEP : -KEY_STEP;
    sidebarWidthSetting.set(clampSidebarWidth(sidebarWidthSetting.get() + delta, window.innerWidth));
  });

  return { el };
}
