import { icon, type IconName } from "./icons";

// ---------------------------------------------------------------------------
// Shared left-sidebar toggle-button rendering. Each sidebar (explorer/recent/
// outline) toggles the SAME left area (mutually exclusive, VSCode-style), so
// they need a way to stay visually distinguishable in the title bar even
// though they share one region. The contract: IDENTITY rides in the icon
// (each view passes its own fixed `iconName` — folder/history/list-tree/…),
// the button never swaps it. STATE (open/closed) rides in `aria-expanded`
// alone, which both drives the disclosure ARIA *and* an active/"pressed" CSS
// highlight (`.chrome-btn[aria-expanded="true"]` in styles.css) — VSCode
// activity-bar style. This replaces an earlier design where identity lived in
// the label and state swapped the icon (panel-left-open/close): with three+
// sidebars sharing one bar, same-icon buttons were indistinguishable by icon
// alone, so identity had to move to the icon and state to a CSS state instead.
//
// One named command so the "set icon once + set disclosure ARIA" rule lives in
// one place, not duplicated inline in each panel. aria-controls points at the
// aside it toggles (disclosure pattern — one ARIA idiom, no aria-pressed to
// conflict with it).
// ---------------------------------------------------------------------------

const create = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

/** Render a left-sidebar toggle button: fixed identity icon + text label, plus
 *  the disclosure ARIA (aria-expanded + aria-controls) for the current
 *  open/closed state. The icon never changes with `isOpen` — only
 *  aria-expanded does, which styles.css reads for the active highlight.
 *  Command (void) — call at init and on every open()/close() so the ARIA
 *  (and therefore the active highlight) never drifts from the aside's
 *  visibility. */
export function renderSidebarButton(
  button: HTMLButtonElement,
  iconName: IconName,
  labelText: string,
  isOpen: boolean,
  controlsId: string,
): void {
  const label = create("span", "chrome-btn-label");
  label.textContent = labelText;
  button.replaceChildren(icon(iconName), label);
  button.setAttribute("aria-expanded", String(isOpen));
  button.setAttribute("aria-controls", controlsId);
  // Icon-only chrome hides .chrome-btn-label visually (styles.css) — the
  // accessible name needs an explicit source, so this doubles as aria-label.
  button.setAttribute("aria-label", labelText);
}
