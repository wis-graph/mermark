// The settings modal: a centered overlay mounted as a sibling of the editor host
// (outside CodeMirror — it pushes no Specs, adds no decorations). Cold-load
// rule: the DOM is built LAZILY on first open; boot only pays the ⚙ button.
// The panel iterates groups() from the registry, so adding a setting never
// touches this file.
import { groups, type Group } from "../registry";
import { RENDER, runTeardown } from "./controls";
import type { Setting, Control } from "../store";
import { icon } from "../../icons";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

/** Build a ⚙ chrome button that opens the settings modal. Boot-cheap: only the
 *  button is created now; the modal DOM is built on first open. Position is the
 *  CALLER's responsibility (M2: arrangeTitleBar places it in the right cluster) —
 *  this function does not append it anywhere, unlike the old mountSettingsButton
 *  it replaces (that one assumed "append = far right", which broke once
 *  .window-controls started owning the far-right slot on win/linux). */
export function createSettingsButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "chrome-btn settings-btn";
  const label = document.createElement("span");
  label.className = "chrome-btn-label";
  label.textContent = "설정";
  btn.append(icon("settings"), label);
  btn.title = "설정";
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
  const catButtons = gs.map((g) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "settings-cat";
    b.textContent = g.name;
    b.addEventListener("click", () => selectCategory(g));
    sidebar.appendChild(b);
    return { b, group: g };
  });

  // 1. 구분선
  const divider = document.createElement("div");
  divider.className = "settings-sidebar-divider";
  sidebar.appendChild(divider);

  // 2. 버전 정보 표시용 텍스트 영역
  const versionInfo = document.createElement("div");
  versionInfo.className = "settings-version-info";
  versionInfo.textContent = "v0.4.0"; // fallback 하드코딩
  sidebar.appendChild(versionInfo);

  // 비동기로 실제 앱 버전 가져와서 반영
  getVersion().then((v) => {
    if (v) versionInfo.textContent = `v${v}`;
  }).catch(() => {});

  // 3. 업데이트 확인 버튼
  const updateBtn = document.createElement("button");
  updateBtn.type = "button";
  updateBtn.className = "settings-cat update-btn";
  updateBtn.style.color = "var(--accent)";
  updateBtn.append(icon("refresh-cw"), " 업데이트 확인");

  let isChecking = false;
  updateBtn.addEventListener("click", async () => {
    if (isChecking) return;
    isChecking = true;
    updateBtn.disabled = true;
    updateBtn.textContent = "확인 중...";

    try {
      const update = await check();
      if (update) {
        const confirmed = confirm(
          `새로운 업데이트가 있습니다!\n\n버전: ${update.version}\n게시일: ${update.date ?? "N/A"}\n\n지금 설치하고 재시작하시겠습니까?`
        );
        if (confirmed) {
          updateBtn.textContent = "설치 중...";
          await update.downloadAndInstall();
          await relaunch();
        }
      } else {
        alert("최신 버전을 사용 중입니다.");
      }
    } catch (err) {
      console.error(err);
      alert(`업데이트 확인 실패:\n${err}`);
    } finally {
      isChecking = false;
      updateBtn.disabled = false;
      updateBtn.replaceChildren(icon("refresh-cw"), " 업데이트 확인");
    }
  });
  sidebar.appendChild(updateBtn);

  /** Tear down every control currently in the pane (run their stashed unsubscribe
   *  fns) before the DOM is discarded, so no stale subscription survives a swap or
   *  close. Command/CQS: void. */
  function teardownPane(): void {
    for (const child of Array.from(pane.children)) runTeardown(child as HTMLElement);
  }

  // The category currently shown in the pane — re-selected on open() so a reopen
  // rebuilds it with fresh subscriptions (close() tears the old ones down).
  let activeGroup: Group | null = null;

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
    for (const { b, group } of catButtons) b.classList.toggle("active", group === g);
    activeGroup = g;
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
      if (activeGroup) selectCategory(activeGroup);
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
