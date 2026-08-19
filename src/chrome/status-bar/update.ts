import {
  subscribeUpdate,
  updatePhase,
  foundUpdate,
  canStartDownload,
  canInstall,
  startDownload,
  installAndRelaunch,
  type UpdatePhase,
} from "../../update/update-flow";
import { downloadStat } from "../../update/update-progress";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";

/** Footer update button — a persistent chrome sink over update-flow's phase
 *  (`subscribeUpdate`; never torn down, mirrors makeWidthSlider/makeSaveStatus
 *  living for the app's whole session). Hidden at rest (idle/checking); once
 *  ensureCheckedOnce (boot) or the version-pane's checkNow finds an update,
 *  this button appears with the found version, then walks itself through
 *  download -> install -> relaunch on click — a single control surface for
 *  the whole flow, no separate confirm dialog (wry's window.confirm is a
 *  silent no-op — see version-pane.ts's header comment).
 *
 *  Once a download reaches "downloaded", main.ts's phase subscriber installs
 *  and relaunches automatically (사용자 요청 2026-08-19) — this button's own
 *  "설치하고 재시작" click path stays wired below as the manual fallback for
 *  when that auto-attempt fails (see main.ts's autoInstallArmed comment), so
 *  the phase usually passes through "downloaded" too briefly for a click here
 *  to matter, but must still work if it doesn't.
 *
 *  Not in the editor measure tree (footer chrome) -> zoom-guard holds. */
export function makeUpdateButton(): { el: HTMLElement } {
  const wrap = document.createElement("div");
  wrap.className = "status-update";
  wrap.hidden = true;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "status-update-btn";
  btn.setAttribute("aria-label", "업데이트 확인");
  wrap.appendChild(btn);

  const caption = document.createElement("span");
  caption.className = "status-update-caption";
  caption.hidden = true;
  wrap.appendChild(caption);

  // Local byte tally for the live progress caption — update-flow only tracks
  // PHASE (downloading/downloaded), not bytes, so each sink that wants a
  // caption/progress-bar keeps its own running total from the onEvent stream
  // (the settings version-pane keeps its own separate tally the same way).
  let downloaded = 0;
  let total: number | null = null;

  function render(phase: UpdatePhase): void {
    wrap.dataset.state = phase;
    wrap.hidden = phase === "idle" || phase === "checking";
    caption.hidden = phase !== "downloading";

    const fu = foundUpdate();
    if (phase === "found" && fu) {
      btn.textContent = `v${fu.version} 업데이트`;
      btn.disabled = false;
      btn.setAttribute("aria-label", `v${fu.version} 업데이트 다운로드`);
    } else if (phase === "downloading") {
      btn.textContent = "다운로드 중...";
      btn.disabled = true;
      btn.setAttribute("aria-label", "업데이트 다운로드 중");
    } else if (phase === "downloaded") {
      btn.textContent = "설치하고 재시작";
      btn.disabled = false;
      btn.setAttribute("aria-label", "설치하고 재시작");
    } else if (phase === "installing") {
      btn.textContent = "설치 중...";
      btn.disabled = true;
      btn.setAttribute("aria-label", "설치 중");
    }
  }

  // Role split: the BUTTON carries the state word ("다운로드 중...", "설치
  // 중..." — see render() above), the CAPTION next to it carries only the
  // number/detail the button doesn't already say. Using formatDownloadProgress
  // (which prefixes its own "다운로드 중...") here used to print the state word
  // twice ("다운로드 중...   다운로드 중... 53% (...)" — 실사용 스크린샷으로 확인),
  // so this sink uses the prefix-free downloadStat instead. Same reasoning for
  // "Finished": don't restate "설치 중..." (the button's install-phase label).
  function onDownloadEvent(ev: DownloadEvent): void {
    if (ev.event === "Started") {
      total = ev.data.contentLength ?? null;
    } else if (ev.event === "Progress") {
      downloaded += ev.data.chunkLength;
      caption.textContent = downloadStat(downloaded, total);
    } else if (ev.event === "Finished") {
      caption.textContent = "곧 재시작됩니다";
    }
  }

  btn.addEventListener("click", () => {
    const phase = updatePhase();
    if (canStartDownload(phase)) {
      downloaded = 0;
      total = null;
      void startDownload(onDownloadEvent);
    } else if (canInstall(phase)) {
      void installAndRelaunch();
    }
  });

  subscribeUpdate(() => render(updatePhase()));
  render(updatePhase());

  return { el: wrap };
}
