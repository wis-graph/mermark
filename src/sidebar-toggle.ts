import { icon } from "./icons";

// ---------------------------------------------------------------------------
// Shared left-sidebar toggle-button rendering. The explorer and outline buttons
// both toggle the SAME left area (mutually exclusive, VSCode-style), so both use
// the panel-left icon pair to reinforce "these open the one left region" — the
// button IDENTITY rides in the label ("탐색기" / "목차"), the STATE in the icon.
//
// One named command so the "swap icon + set disclosure ARIA" rule lives in one
// place, not duplicated inline in each panel: closed → panel-left-open (affords
// opening), open → panel-left-close (affords closing). aria-expanded reflects
// open/closed and aria-controls points at the aside it toggles (disclosure
// pattern — one ARIA idiom, no aria-pressed to conflict with it).
// ---------------------------------------------------------------------------

const create = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

/** Render a left-sidebar toggle button for its current open/closed state: swap
 *  the panel-left icon, restore the text label, and set the disclosure ARIA
 *  (aria-expanded + aria-controls). Command (void) — call at init and on every
 *  open()/close() so the icon + ARIA never drift from the aside's visibility. */
export function renderSidebarButton(
  button: HTMLButtonElement,
  labelText: string,
  isOpen: boolean,
  controlsId: string,
): void {
  const label = create("span", "chrome-btn-label");
  label.textContent = labelText;
  button.replaceChildren(icon(isOpen ? "panel-left-close" : "panel-left-open"), label);
  button.setAttribute("aria-expanded", String(isOpen));
  button.setAttribute("aria-controls", controlsId);
}
