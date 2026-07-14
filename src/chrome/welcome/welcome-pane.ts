// The boot-time welcome screen — shown when mermark opens with no `?file=`.
// Extracted from main.ts's former (file-private) renderWelcomeScreen: same
// DOM shape and subscribe-then-replace reactivity, just behind an injection
// boundary (getFavorites/getRecent/onJumpFolder/onOpenFile/onOpenFolder).
//
// NOT the same wiring as recent-panel/favorites-panel: those panels take
// ONLY the getters and expose a `refresh()` that main calls from a single
// external subscribe (main owns the setting.subscribe). This module returns
// a bare HTMLElement (per its call site's needs — a one-shot boot render with
// no persistent handle for main to call back into), so it self-subscribes to
// the real favoriteFoldersSetting/recentDocsSetting directly (a push/pull
// hybrid: getFavorites/getRecent are the injected PULL for what to render —
// kept testable without the real settings — while the module itself owns the
// PUSH that triggers a re-render). If this ever needs main-driven refresh()
// like the other panels, that would mean dropping the internal subscribe and
// exposing `{ el, refresh }` instead of a bare element.
//
// CTA (2026-07-12 design-polish pass, tour-11): the prior screen had two
// possibly-empty list sections and no call to action. `onOpenFolder` reuses
// the EXISTING explorer-open flow (main injects `() => explorer.button.click()`)
// — no new Tauri command, no new IPC surface.
import { basename } from "../../document/path";
import { icon } from "../../icons";
import { redundantPathLabel } from "../path-label";
import { favoriteFoldersSetting, recentDocsSetting } from "../../settings/app";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

/** Domain rule (2026-07-12 design-polish pass, tour-11): the welcome pane is a
 *  "blank slate" — a single centered hero instead of two empty-state sections
 *  stacked under the CTA — only when BOTH favorites and recent docs are empty.
 *  Either list having an entry means there's real content to show, so the
 *  pane falls back to the existing grid layout. Pure query. */
export function isBlankSlate(favorites: string[], recent: string[]): boolean {
  return favorites.length === 0 && recent.length === 0;
}

export interface WelcomePaneHandlers {
  /** The current favorite folders. A closure over favoriteFoldersSetting so
   *  the pane always reads the live value (SSOT) when it re-renders — see the
   *  module header for how this PULL differs from recent-panel/favorites-
   *  panel's getRecent/getFavorites (there, the getter is the ONLY SSOT
   *  contact; here the module also self-subscribes to trigger the re-render). */
  getFavorites(): string[];
  /** The current recent-documents list, most-recent-first. */
  getRecent(): string[];
  /** Jump the explorer's root to this absolute folder path (reuses main's
   *  explorer.jumpToRoot — no new navigation code). */
  onJumpFolder(path: string): void;
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

/** Build the welcome pane. DOM builder + two internal SSOT subscriptions
 *  (favoriteFoldersSetting/recentDocsSetting) that replace their section's
 *  list on change — unchanged from the pre-extraction behavior. The push
 *  (subscribe) still targets the real settings directly; only the pull (what
 *  to render) goes through the injected getFavorites/getRecent, so the render
 *  logic itself is testable without depending on the real settings' current
 *  value — see the module header for why this is a hybrid, not a full match
 *  to the recent-panel/favorites-panel injection convention. */
export function createWelcomePane({
  getFavorites,
  getRecent,
  onJumpFolder,
  onOpenFile,
  onOpenFolder,
  openFolderChord,
}: WelcomePaneHandlers): HTMLElement {
  const pane = el("div", "welcome-pane");

  // Command: toggle the blank-slate hero mode on the pane root. Reads the
  // CURRENT getFavorites/getRecent (not a snapshot), so it's safe to call
  // after either setting has changed. Must be called from BOTH subscriptions
  // below (a lone-side call would leave the hero stuck after the other list
  // gains an entry) — see the module header for why this pane self-subscribes
  // at all. CQS: void.
  const reflectBlankSlate = (): void => {
    pane.classList.toggle("is-blank-slate", isBlankSlate(getFavorites(), getRecent()));
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

  // 1. 즐겨찾기 섹션
  const favSection = el("div", "welcome-section");
  const favHeader = el("h2", "welcome-title");
  favHeader.textContent = "즐겨찾기";
  favSection.append(favHeader);

  const renderFavorites = () => {
    const folders = getFavorites();
    const listContainer = el("div", "welcome-list");
    if (folders.length === 0) {
      const empty = el("div", "welcome-empty");
      empty.textContent = "등록된 즐겨찾기 폴더가 없습니다.";
      listContainer.append(empty);
    } else {
      folders.forEach((folder) => {
        const row = el("div", "welcome-row welcome-folder-row");
        const iconSpan = el("span", "welcome-icon");
        iconSpan.append(icon("folder"));

        // basename(folder) falls back to the folder string itself (e.g. a
        // root path with no trailing segment), so the redundancy check
        // compares against what's actually DISPLAYED, not just
        // redundantPathLabel's basename()===path rule (which would miss
        // this fallback case).
        const name = basename(folder) || folder;
        const nameEl = el("span", "welcome-name");
        nameEl.textContent = name;
        row.append(iconSpan, nameEl);

        if (name !== folder) {
          const pathInfo = el("span", "welcome-path");
          pathInfo.textContent = folder;
          row.append(pathInfo);
        }

        row.addEventListener("click", () => onJumpFolder(folder));
        listContainer.append(row);
      });
    }
    return listContainer;
  };

  let favList = renderFavorites();
  favSection.append(favList);
  pane.append(favSection);

  favoriteFoldersSetting.subscribe(() => {
    const next = renderFavorites();
    favList.replaceWith(next);
    favList = next;
    reflectBlankSlate();
  });

  // 2. 최근 문서 섹션
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
