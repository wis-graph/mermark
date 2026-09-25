import { installAndRelaunch, subscribeUpdate, updatePhase } from "./update-flow";

/** Auto-restart once an update download finishes (사용자 요청 2026-08-19):
 *  update-flow used to just sit in "downloaded" until the user clicked
 *  "설치하고 재시작" (footer button or the settings 버전 pane). Lives here, not
 *  in update-flow.ts, because update-flow must stay editor-agnostic (its own
 *  header comment) — only main.ts knows about `current`/commitBeforeSwitch,
 *  and relaunching the process without flushing the live buffer first could
 *  drop an edit that never made it to disk. commitBeforeSwitch (not
 *  flushSave) is the right tool here: flushSave() is fire-and-forget (void),
 *  so we couldn't tell whether the write actually landed before killing the
 *  process; commitBeforeSwitch already exists for exactly this "confirm the
 *  buffer is durably persisted before doing something disruptive" contract
 *  (mtime-conflict rescue via the .mermark-recovered sibling included) and
 *  resolves only once settled. If it resolves false (both the original AND
 *  the recovery write failed), we do NOT relaunch — commitBeforeSwitch's own
 *  failure path already resumed autosave and surfaced a recovery dialog, so
 *  the user keeps editing and can retry the update manually later. Never
 *  discard unsaved work to force a restart.
 *
 *  autoInstallArmed guards against update-flow's own catch-and-revert:
 *  installAndRelaunch() reverts phase back to "downloaded" if install() or
 *  relaunch() fails (update-flow.ts), and without this guard that revert
 *  would re-trigger this same subscriber forever (repeated failing installs
 *  in a tight loop). It's re-armed only when a FRESH download starts
 *  ("downloading" phase), so a later successful download still auto-
 *  installs; after a failed auto-attempt, the phase stays "downloaded" and
 *  the existing "설치하고 재시작" buttons remain as the manual fallback
 *  (their click handlers call installAndRelaunch() directly, unaffected by
 *  this flag).
 *
 *  2026-09-25: moved out of main.ts; `commitBeforeSwitch` is injected, so
 *  this module still knows nothing about the editor. */
export function installAutoRestartOnUpdate(commitBeforeSwitch: () => Promise<boolean>): void {
  let autoInstallArmed = true;
  subscribeUpdate(() => {
    const phase = updatePhase();
    if (phase === "downloading") {
      autoInstallArmed = true;
    } else if (phase === "downloaded" && autoInstallArmed) {
      autoInstallArmed = false;
      void (async () => {
        if (!(await commitBeforeSwitch())) return;
        await installAndRelaunch();
      })();
    }
  });
}
