// Edge-hover "peek" gesture controller: a short dwell on the window's left
// edge asks a panel to float open; leaving / Esc / outside click closes it.
//
// This module owns ONLY the gesture's transient values (timers, `armed`,
// last pointer buttons). The open/closed/peek STATE lives in the panel's DOM
// (sidebar/registry.ts railModeOf) and its single writer (explorer-panel.ts)
// — the controller just calls peek()/dismiss(). It is generic: it imports
// neither the explorer, the settings, nor the registry (all injected).

import { isContextMenuOpen } from "../chrome/context-menu";
import { isImeComposing } from "../shortcuts/keys";

export const EDGE_ZONE_PX = 6;
/** .title-bar height (styles.css) — the traffic-light / button band is excluded. */
export const EDGE_ZONE_TOP_PX = 36;
export const PEEK_DWELL_MS = 200;
export const PEEK_LEAVE_GRACE_MS = 300;

/** Is a client point inside the trigger strip? Pure query. */
export function inEdgeZone(x: number, y: number): boolean {
  return x < EDGE_ZONE_PX && y >= EDGE_ZONE_TOP_PX;
}

export interface EdgePeekOptions {
  /** A pointer target outside this (modal, context menu, backdrop) never starts a dwell. */
  workspace: HTMLElement;
  /** The peeking panel — inside/outside judgement for leave and outside-press. */
  aside: HTMLElement;
  /** Presses on these never dismiss (the toggle button must pin, not close-then-reopen). */
  keepTargets: readonly HTMLElement[];
  /** Domain guard (setting on && rail empty) — evaluated at dwell start AND expiry. */
  mayPeek(): boolean;
  isPeeking(): boolean;
  peek(): void;
  dismiss(): void;
}

/** Install the gesture listeners once. Command (void); no teardown, like the
 *  panels it serves. */
export function installEdgePeek(o: EdgePeekOptions): void {
  let armed = true; // pointer left the strip since the last peek ended
  let lastButtons = 0;
  let inZone = false;
  let dwellTimer: ReturnType<typeof setTimeout> | null = null;
  let leaveTimer: ReturnType<typeof setTimeout> | null = null;

  const peekHeld = (): boolean => isContextMenuOpen() || lastButtons !== 0;

  const canStartDwell = (e: PointerEvent | MouseEvent): boolean =>
    armed &&
    !o.isPeeking() &&
    inEdgeZone(e.clientX, e.clientY) &&
    e.buttons === 0 &&
    e.target instanceof Node &&
    o.workspace.contains(e.target) &&
    document.hasFocus() &&
    o.mayPeek();

  const cancelDwell = (): void => {
    if (dwellTimer !== null) clearTimeout(dwellTimer);
    dwellTimer = null;
  };
  const startDwell = (): void => {
    dwellTimer = setTimeout(() => {
      dwellTimer = null;
      if (!o.isPeeking() && o.mayPeek() && document.hasFocus() && inZone) {
        armed = false;
        o.peek();
      }
    }, PEEK_DWELL_MS);
  };

  const cancelLeaveClose = (): void => {
    if (leaveTimer !== null) clearTimeout(leaveTimer);
    leaveTimer = null;
  };
  /** The single path for every close the controller causes. */
  const endPeek = (): void => {
    cancelLeaveClose();
    armed = false;
    o.dismiss();
  };
  const scheduleLeaveClose = (): void => {
    if (leaveTimer !== null) return;
    leaveTimer = setTimeout(function expire() {
      leaveTimer = null;
      if (!o.isPeeking()) return; // closed by another path meanwhile
      if (peekHeld()) {
        leaveTimer = setTimeout(expire, PEEK_LEAVE_GRACE_MS); // self-recovering re-check
        return;
      }
      endPeek();
    }, PEEK_LEAVE_GRACE_MS);
  };

  document.addEventListener(
    "pointermove",
    (e) => {
      lastButtons = e.buttons;
      inZone = inEdgeZone(e.clientX, e.clientY);
      if (!inZone) armed = true;
      if (o.isPeeking()) {
        if (e.target instanceof Node && o.aside.contains(e.target)) cancelLeaveClose();
        else scheduleLeaveClose();
        return;
      }
      if (canStartDwell(e)) {
        if (dwellTimer === null) startDwell();
      } else {
        cancelDwell();
      }
    },
    { passive: true },
  );

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!o.isPeeking() || isContextMenuOpen()) return;
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (o.aside.contains(t) || o.keepTargets.some((k) => k.contains(t))) return;
      endPeek(); // never preventDefault/stopPropagation — the click still lands
    },
    true,
  );

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !o.isPeeking() || isContextMenuOpen() || isImeComposing(e)) return;
      endPeek(); // no preventDefault: vim / CM search Esc still pass through
    },
    true,
  );

  document.addEventListener("mouseout", (e) => {
    if (e.relatedTarget !== null) return; // still inside the window
    cancelDwell();
    if (o.isPeeking()) scheduleLeaveClose();
  });

  window.addEventListener("blur", cancelDwell);
}
