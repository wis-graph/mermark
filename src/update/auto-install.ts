import { installAndRelaunch, subscribeUpdate, updatePhase } from "./update-flow";

/** Auto-restart once an update download finishes (사용자 요청 2026-08-19):
 *  update-flow used to just sit in "downloaded" until the user clicked
 *  "설치하고 재시작" (footer button or the settings 버전 pane). This module owns
 *  only the policy "try one automatic install when a download completes".
 *  Durability is NOT its job: update-flow's installAndRelaunch forces every
 *  restart (this one and the manual buttons) through the RelaunchGuard main
 *  injected — confirmDurable (commitBeforeSwitch) first, never relaunching if
 *  the buffer can't be made durable, resuming autosave if install fails.
 *
 *  autoInstallArmed guards against update-flow's own catch-and-revert:
 *  installAndRelaunch() reverts phase back to "downloaded" if the guard
 *  refuses or install()/relaunch() fails, and without this guard that revert
 *  would re-trigger this same subscriber forever (repeated failing installs
 *  in a tight loop). It's re-armed only when a FRESH download starts
 *  ("downloading" phase), so a later successful download still auto-
 *  installs; after a failed auto-attempt, the phase stays "downloaded" and
 *  the existing "설치하고 재시작" buttons remain as the manual fallback (they
 *  call installAndRelaunch() too, unaffected by this flag).
 *
 *  2026-09-25: moved out of main.ts. 2026-10-18: commitBeforeSwitch moved into
 *  update-flow's RelaunchGuard so the manual paths can't skip it. */
export function installAutoRestartOnUpdate(): void {
  let autoInstallArmed = true;
  subscribeUpdate(() => {
    const phase = updatePhase();
    if (phase === "downloading") {
      autoInstallArmed = true;
    } else if (phase === "downloaded" && autoInstallArmed) {
      autoInstallArmed = false;
      void installAndRelaunch();
    }
  });
}
