// Edit/read mode-toggle title-bar widget moved out of main.ts (2026-09-25, pure move).

import { el, setButtonContent } from "./dom";
import type { PreviewMode } from "../editor";

/** Edit/read toggle that lives in the title-bar (icon + label). Also carries
 *  the PERSISTENT remote-read-only indicator (Task 11): a remote document is
 *  forced to read mode end to end (editor.ts's `remoteReadOnly`), but before
 *  this the toggle only ever reflected the global `modeSetting` — so it could
 *  still show "편집" while the open document was, in fact, uneditable, and the
 *  user only learned the truth from a transient error toast on the next
 *  keystroke/save attempt. `remote: true` replaces the edit/read label
 *  outright with a fixed "읽기 전용 (원격)" state, for as long as this document
 *  stays open — not a toast, so it can't scroll away or get missed. */
export function makeModeToggle(): { btn: HTMLButtonElement; render: (m: PreviewMode, remote: boolean) => void } {
  const btn = el("button", "chrome-btn mode-toggle icon-only");
  const render = (m: PreviewMode, remote: boolean) => {
    btn.dataset.remote = String(remote);
    if (remote) {
      setButtonContent(btn, "lock", "읽기 전용 (원격)");
      btn.title = "읽기 전용 (원격) — 원격 볼트는 편집할 수 없습니다";
      return;
    }
    setButtonContent(btn, m === "edit" ? "square-pen" : "eye", m === "edit" ? "편집" : "리더");
    btn.title = m === "edit" ? "편집 모드 (⌘E: 리더 모드로)" : "리더 모드 (⌘E: 편집 모드로)";
  };
  return { btn, render };
}
