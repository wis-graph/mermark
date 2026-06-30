// The conflict modal: a VSCode-style line diff shown when the file changed on
// disk AND the local buffer has unsaved work, so neither side can be adopted
// silently. Two explicit choices — keep local (overwrite disk) or use external
// (reload from disk) — map straight onto the editor controller's existing
// methods (forceSave / reloadFromFile). Merge is out of scope by design.
//
// Built lazily (only when a conflict actually occurs —平소 0 비용), mounted as a
// body-level sibling of the editor host (outside CodeMirror: pushes no Specs,
// adds no decorations, lives outside the measure tree → ZOOM GUARD holds). The
// focus-trap / ESC / backdrop / inert behavior mirrors settings/panel/modal.ts.
import { diffLines, toDiffLines, type DiffRow } from "../diff/line-diff";

export interface ConflictModalOptions {
  /** The user's current buffer (local edits not yet on disk). */
  local: string;
  /** The new on-disk content the watcher delivered. */
  external: string;
  /** Keep my edits, overwrite the disk (→ controller.forceSave). */
  onKeepLocal: () => void;
  /** Discard my edits, load the disk version (→ controller.reloadFromFile). */
  onUseExternal: () => void;
  /** Dismiss without choosing — the conflict stays unresolved (autosave paused). */
  onDismiss?: () => void;
}

export interface ConflictModalHandle {
  /** Tear down: remove the DOM + listeners and restore the editor + focus. */
  close(): void;
}

/** Build a diff <table> (one row per DiffRow) so the user sees external vs local
 *  side by side. Pure DOM construction; no listeners. */
function renderDiffTable(rows: DiffRow[]): HTMLElement {
  const table = document.createElement("div");
  table.className = "conflict-diff";
  for (const row of rows) {
    const line = document.createElement("div");
    line.className = `conflict-row conflict-${row.kind}`;
    const sign = document.createElement("span");
    sign.className = "conflict-sign";
    sign.textContent = row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " ";
    const body = document.createElement("span");
    body.className = "conflict-line";
    body.textContent = row.kind === "added" ? (row.external ?? "") : (row.local ?? "");
    line.append(sign, body);
    table.appendChild(line);
  }
  return table;
}

/** Keep Tab focus inside the modal (wrap at the ends) — same rule as the settings
 *  modal's trapFocus, replicated here so the conflict modal stays decoupled from
 *  the settings registry. */
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

/** Open the conflict modal. Returns a handle whose close() restores the page.
 *  The two action buttons run their callback then close; ESC / backdrop close
 *  WITHOUT choosing (onDismiss), leaving the conflict unresolved on purpose. */
export function openConflictModal(opts: ConflictModalOptions): ConflictModalHandle {
  const lastFocused = document.activeElement;

  const backdrop = document.createElement("div");
  backdrop.className = "conflict-backdrop";

  const modal = document.createElement("div");
  modal.className = "conflict-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", "파일 충돌");

  const header = document.createElement("div");
  header.className = "conflict-header";
  const title = document.createElement("span");
  title.className = "conflict-title";
  title.textContent = "외부 변경 충돌";
  const subtitle = document.createElement("span");
  subtitle.className = "conflict-subtitle";
  subtitle.textContent = "파일이 디스크에서 변경되었고 저장하지 않은 편집이 있습니다. 어느 쪽을 사용할지 선택하세요.";
  header.append(title, subtitle);

  const diff = renderDiffTable(diffLines(toDiffLines(opts.local), toDiffLines(opts.external)));

  const actions = document.createElement("div");
  actions.className = "conflict-actions";
  const useExternal = document.createElement("button");
  useExternal.type = "button";
  useExternal.className = "conflict-btn conflict-use-external";
  useExternal.textContent = "외부 채택 (디스크 내용으로 다시 읽기)";
  const keepLocal = document.createElement("button");
  keepLocal.type = "button";
  keepLocal.className = "conflict-btn conflict-keep-local";
  keepLocal.textContent = "로컬 유지 (내 편집으로 덮어쓰기)";
  actions.append(useExternal, keepLocal);

  modal.append(header, diff, actions);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const editorHost = () => document.querySelector<HTMLElement>(".editor-host");
  editorHost()?.setAttribute("inert", "");

  const handle: ConflictModalHandle = {
    close() {
      document.removeEventListener("keydown", onKeydown, true);
      backdrop.remove();
      editorHost()?.removeAttribute("inert");
      (lastFocused as HTMLElement | null)?.focus?.();
    },
  };

  const choose = (fn: () => void) => {
    fn();
    handle.close();
  };
  const dismiss = () => {
    opts.onDismiss?.();
    handle.close();
  };

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      dismiss();
    } else if (e.key === "Tab") {
      trapFocus(modal, e);
    }
  };

  useExternal.addEventListener("click", () => choose(opts.onUseExternal));
  keepLocal.addEventListener("click", () => choose(opts.onKeepLocal));
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) dismiss(); // backdrop click dismisses; inside doesn't
  });
  document.addEventListener("keydown", onKeydown, true);

  useExternal.focus(); // first action focused on open (accessibility)
  return handle;
}
