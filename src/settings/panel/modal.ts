// The settings modal: a centered overlay mounted as a sibling of the editor host
// (outside CodeMirror — it pushes no Specs, adds no decorations). Cold-load
// rule: the DOM is built LAZILY on first open; boot only pays the ⚙ button.
// The panel iterates groups() from the registry, so adding a setting never
// touches this file.
import { groups, type Group } from "../registry";
import { RENDER, runTeardown } from "./controls";
import type { Setting, Control } from "../store";
import { icon } from "../../icons";
import { renderVersionPane } from "./version-pane";

/** Build a ⚙ chrome button that opens the settings modal. Boot-cheap: only the
 *  button is created now; the modal DOM is built on first open. Position is the
 *  CALLER's responsibility (M2: arrangeTitleBar places it in the right cluster) —
 *  this function does not append it anywhere, unlike the old mountSettingsButton
 *  it replaces (that one assumed "append = far right", which broke once
 *  .window-controls started owning the far-right slot on win/linux). */
export function createSettingsButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "chrome-btn settings-btn icon-only";
  const label = document.createElement("span");
  label.className = "chrome-btn-label";
  label.textContent = "설정";
  btn.append(icon("settings"), label);
  btn.title = "설정";
  // Icon-only chrome hides .chrome-btn-label visually (styles.css) — the
  // accessible name needs an explicit source, so this doubles as aria-label.
  btn.setAttribute("aria-label", "설정");
  let modal: SettingsModal | null = null;
  btn.addEventListener("click", () => {
    if (!modal) modal = buildModal(); // lazy build on first open
    modal.open();
  });
  return btn;
}

interface SettingsModal {
  open(): void;
  close(): void;
}

/** Build the modal DOM once (backdrop + 2-pane: sidebar + pane). The sidebar is
 *  groups() in insertion order; clicking a category swaps the pane. Open/close
 *  handle ESC, backdrop click, focus restore, and editor inert. */
function buildModal(): SettingsModal {
  const backdrop = document.createElement("div");
  backdrop.className = "settings-backdrop";
  backdrop.hidden = true;

  const modal = document.createElement("div");
  modal.className = "settings-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", "설정");

  // Editorial header (DESIGN.md): a caption-uppercase title + a transparent close
  // glyph. Lives ABOVE the sidebar/pane body, so the body stays a flex row while
  // the modal becomes a flex column. The close button is NOT inside .settings-sidebar,
  // so open() still lands first focus on the first category (focus-trap unchanged).
  const header = document.createElement("div");
  header.className = "settings-header";
  const heading = document.createElement("span");
  heading.className = "settings-title";
  heading.textContent = "설정";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "settings-close";
  closeBtn.setAttribute("aria-label", "닫기");
  closeBtn.append(icon("x"));
  closeBtn.addEventListener("click", () => api.close());
  header.append(heading, closeBtn);

  const body = document.createElement("div");
  body.className = "settings-body";
  const sidebar = document.createElement("div");
  sidebar.className = "settings-sidebar";
  const pane = document.createElement("div");
  pane.className = "settings-pane";
  body.append(sidebar, pane);
  modal.append(header, body);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const gs = groups();
  // Every sidebar button (registry categories + the standalone "버전" category
  // below) shares one active-toggle so only one is ever highlighted, regardless
  // of which side of the divider it's on.
  const allCatButtons: HTMLButtonElement[] = [];
  const markActive = (target: HTMLButtonElement): void => {
    for (const b of allCatButtons) b.classList.toggle("active", b === target);
  };

  const catButtons = gs.map((g) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "settings-cat";
    b.textContent = g.name;
    b.addEventListener("click", () => selectCategory(g));
    sidebar.appendChild(b);
    allCatButtons.push(b);
    return { b, group: g };
  });

  // 구분선 아래 "버전" 카테고리: 다른 카테고리와 동형 버튼이지만 registry rows가
  // 아니라 renderVersionPane()의 커스텀 DOM을 pane에 얹는다.
  const divider = document.createElement("div");
  divider.className = "settings-sidebar-divider";
  sidebar.appendChild(divider);

  const versionCatBtn = document.createElement("button");
  versionCatBtn.type = "button";
  versionCatBtn.className = "settings-cat";
  versionCatBtn.textContent = "버전";
  versionCatBtn.addEventListener("click", () => selectVersionCategory());
  sidebar.appendChild(versionCatBtn);
  allCatButtons.push(versionCatBtn);

  /** Tear down every control currently in the pane (run their stashed unsubscribe
   *  fns) before the DOM is discarded, so no stale subscription survives a swap or
   *  close. Command/CQS: void. */
  function teardownPane(): void {
    for (const child of Array.from(pane.children)) runTeardown(child as HTMLElement);
  }

  // The category currently shown in the pane — re-selected on open() so a reopen
  // rebuilds it with fresh subscriptions (close() tears the old ones down). The
  // "버전" pane carries no Setting subscription, so it's tracked as a bare tag
  // rather than a Group.
  type ActiveCategory = { kind: "group"; group: Group } | { kind: "version" };
  let active: ActiveCategory | null = null;

  /** Swap the pane to a category's controls and mark its sidebar button active.
   *  Command/CQS: mutates the DOM, returns nothing. */
  function selectCategory(g: Group): void {
    teardownPane(); // drop the outgoing category's subscriptions before replacing
    pane.replaceChildren();
    for (const entry of g.entries) {
      const renderer = RENDER[entry.ui.control.kind] as (
        s: Setting<never>,
        c: Control<unknown>,
      ) => HTMLElement;
      const labeled = renderer(entry.setting as Setting<never>, entry.ui.control);
      // stamp the label into the row's label cell (controls render an empty one)
      const labelCell = labeled.querySelector(".settings-row-label");
      if (labelCell) labelCell.textContent = entry.ui.label;
      pane.appendChild(labeled);
    }
    const found = catButtons.find((c) => c.group === g);
    if (found) markActive(found.b);
    active = { kind: "group", group: g };
  }

  /** Swap the pane to the 버전 category. Same teardown discipline as
   *  selectCategory even though the version pane has no subscriptions today —
   *  keeps the swap contract uniform if that ever changes. */
  function selectVersionCategory(): void {
    teardownPane();
    pane.replaceChildren();
    pane.appendChild(renderVersionPane());
    markActive(versionCatBtn);
    active = { kind: "version" };
  }

  // First category ("테마") selected on open.
  if (gs[0]) selectCategory(gs[0]);

  let lastFocused: Element | null = null;
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      api.close();
    } else if (e.key === "Tab") {
      trapFocus(modal, e);
    }
  };
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) api.close(); // backdrop click closes; inside doesn't
  });

  const editorHost = () => document.querySelector<HTMLElement>(".editor-host");

  const api: SettingsModal = {
    open() {
      lastFocused = document.activeElement;
      // Rebuild the active category so its controls re-subscribe (close() tore the
      // prior subscriptions down). Guards the reopen-after-close case from showing
      // a pane whose reflect closures are dead.
      if (active?.kind === "group") selectCategory(active.group);
      else if (active?.kind === "version") selectVersionCategory();
      backdrop.hidden = false;
      editorHost()?.setAttribute("inert", ""); // editor underneath is non-interactive
      document.addEventListener("keydown", onKeydown, true);
      (sidebar.querySelector("button") as HTMLButtonElement | null)?.focus();
    },
    close() {
      teardownPane(); // release subscriptions so a reopen doesn't accumulate stale ones
      backdrop.hidden = true;
      editorHost()?.removeAttribute("inert");
      document.removeEventListener("keydown", onKeydown, true);
      (lastFocused as HTMLElement | null)?.focus?.();
    },
  };
  return api;
}

/** Keep Tab focus inside the modal (wrap at the ends). The focus trap rule, named
 *  once so the keydown handler stays a dispatcher, not a tangle of inline ifs. */
function trapFocus(modal: HTMLElement, e: KeyboardEvent): void {
  const focusable = modal.querySelectorAll<HTMLElement>(
    'button, select, textarea, input, a[href], [tabindex]:not([tabindex="-1"])',
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}
