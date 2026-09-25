// Shared chrome DOM helpers moved out of main.ts (2026-09-25, pure move).

import { icon, type IconName } from "../icons";

export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

/** Set a chrome button (title-bar or footer) to a Lucide icon + (optional) label,
 *  replacing whatever it held. The shadcn/Raycast button shape: a 16px monochrome
 *  icon followed by a 13px-medium label, both inheriting the button's `color`.
 *  Replaces the old emoji `textContent =` calls — same render-on-state pattern,
 *  DOM shape only. The label rides in its own <span> so the icon stays a clean
 *  flex item (gap from CSS). */
export function setButtonContent(btn: HTMLElement, name: IconName, label?: string): void {
  btn.replaceChildren(icon(name));
  if (label) {
    const text = el("span", "chrome-btn-label");
    text.textContent = label;
    btn.append(text);
    // Icon-only chrome (design decision: 아이콘 온리 + 심리스 크롬) visually
    // hides .chrome-btn-label (styles.css) — the accessible name still needs
    // an explicit source, so this doubles as the aria-label. `title` (set by
    // each call site) supplies the hover tooltip on top of it.
    btn.setAttribute("aria-label", label);
  }
}
