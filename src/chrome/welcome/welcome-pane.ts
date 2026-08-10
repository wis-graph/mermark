// The boot-time welcome screen — shown when mermark opens with no `?file=`.
// Extracted from main.ts's former (file-private) renderWelcomeScreen: same
//
// CTA (2026-07-12 design-polish pass, tour-11): the prior screen had two
// possibly-empty list sections and no call to action. `onOpenFolder` reuses
// the EXISTING explorer-open flow (main injects `() => explorer.button.click()`)
// — no new Tauri command, no new IPC surface.
import { basename } from "../../document/path";
import { icon } from "../../icons";
import { redundantPathLabel } from "../path-label";
import { recentDocsSetting } from "../../settings/app";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

/** Domain rule (2026-07-12 design-polish pass, tour-11): the welcome pane is a
 *  "blank slate" — a single centered hero instead of an empty-state section
 *  stacked under the CTA — only when recent docs are empty. A recent entry
 *  means there's real content to show, so the
 *  pane falls back to the existing grid layout. Pure query. */
export function isBlankSlate(recent: string[]): boolean {
  return recent.length === 0;
}

export interface WelcomePaneHandlers {
  /** The current recent-documents list, most-recent-first. */
  getRecent(): string[];
  /** Open an absolute document path in the current window. */
  onOpenFile(path: string): void;
  /** The CTA's primary action: open a folder. Main injects
   *  `() => explorer.button.click()` — reuses the existing explorer-toggle
   *  flow instead of a new native folder picker (IPC-surface constraint). */
  onOpenFolder(): void;
  /** Display string for the explorer-toggle chord (e.g. "⌘B"), shown as a
   *  hint beside the CTA. `null` when the action has no bound chord. */
  openFolderChord: string | null;
}

export function createWelcomePane({
  getRecent,
  onOpenFile,
  onOpenFolder,
  openFolderChord,
}: WelcomePaneHandlers): HTMLElement {
  const pane = el("div", "welcome-pane");

  const reflectBlankSlate = (): void => {
    pane.classList.toggle("is-blank-slate", isBlankSlate(getRecent()));
  };

  // 0.a Word-mark shown ONLY in blank-slate mode (CSS-gated) — no image asset
  // pulled into the cold-load path, just a styled text mark above the CTA.
  const mark = el("div", "welcome-mark");
  mark.textContent = "mermark";
  pane.append(mark);

  // 0. CTA — the empty-state action (design review tour-11): open a folder
  // via the existing explorer flow, with a keyboard-shortcut hint beside it.
  const cta = el("div", "welcome-cta");
  const ctaBtn = el("button", "welcome-cta-btn") as HTMLButtonElement;
  ctaBtn.type = "button";
  ctaBtn.textContent = "폴더 열기";
  ctaBtn.addEventListener("click", onOpenFolder);
  const hint = el("span", "welcome-cta-hint");
  hint.textContent = openFolderChord
    ? `탐색기 ${openFolderChord} · 경로 입력은 제목줄 폴더 아이콘`
    : "경로 입력은 제목줄 폴더 아이콘";
  cta.append(ctaBtn, hint);
  pane.append(cta);

  const recSection = el("div", "welcome-section");
  const recHeader = el("h2", "welcome-title");
  recHeader.textContent = "최근 문서";
  recSection.append(recHeader);

  const renderRecents = () => {
    const docs = getRecent();
    const listContainer = el("div", "welcome-list");
    if (docs.length === 0) {
      const empty = el("div", "welcome-empty");
      empty.textContent = "최근 열어본 문서가 없습니다.";
      listContainer.append(empty);
    } else {
      docs.forEach((doc) => {
        const row = el("div", "welcome-row welcome-file-row");
        const iconSpan = el("span", "welcome-icon");
        iconSpan.append(icon("file-text"));

        const nameEl = el("span", "welcome-name");
        nameEl.textContent = basename(doc);
        row.append(iconSpan, nameEl);

        if (!redundantPathLabel(doc)) {
          const pathInfo = el("span", "welcome-path");
          pathInfo.textContent = doc;
          row.append(pathInfo);
        }

        row.addEventListener("click", () => onOpenFile(doc));
        listContainer.append(row);
      });
    }
    return listContainer;
  };

  let recList = renderRecents();
  recSection.append(recList);
  pane.append(recSection);

  recentDocsSetting.subscribe(() => {
    const next = renderRecents();
    recList.replaceWith(next);
    recList = next;
    reflectBlankSlate();
  });

  reflectBlankSlate(); // initial mount: both sections are in the DOM by now
  return pane;
}
