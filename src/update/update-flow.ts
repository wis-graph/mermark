// The single SSOT module for the update-checking/download/install state
// machine — shared by the footer button (chrome/status-bar/update.ts, a persistent
// subscriber) and the settings 버전 pane (a mount-time query-only reader; see
// version-pane.ts's "no external subscriptions to tear down" contract). The
// `Update` resource returned by `check()` is kept in a module-private cell —
// only its serializable metadata (FoundUpdate) is exposed via queries — so no
// caller can hold or leak the rid-bearing resource itself.
//
// Cold-load invariant: `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-process`
// are dynamic-imported only at check/relaunch time (`import type` for the
// static type references below), so they never enter the boot bundle.
import type { Update, DownloadEvent } from "@tauri-apps/plugin-updater";

export type UpdatePhase = "idle" | "checking" | "found" | "downloading" | "downloaded" | "installing";
export interface FoundUpdate {
  version: string;
  date?: string;
  body?: string;
}

// ── module-private state (the SSOT cell) ───────────────────────────────────
let phase: UpdatePhase = "idle";
let pendingUpdate: Update | null = null;
let found: FoundUpdate | null = null;
let lastResult: "found" | "none" | "error" | null = null;
let hasCheckedOnce = false;
let inFlightCheck: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setPhase(next: UpdatePhase): void {
  phase = next;
  for (const cb of listeners) cb();
}

// ── queries (pure, CQS) ─────────────────────────────────────────────────────
export function updatePhase(): UpdatePhase {
  return phase;
}
export function foundUpdate(): FoundUpdate | null {
  return found;
}
export function lastCheckResult(): "found" | "none" | "error" | null {
  return lastResult;
}
/** phase === "found" — the one domain rule for "can we start a download now",
 *  named so call sites never re-derive it with an inline comparison. */
export function canStartDownload(p: UpdatePhase): boolean {
  return p === "found";
}
/** phase === "downloaded" — mirrors canStartDownload for the install step. */
export function canInstall(p: UpdatePhase): boolean {
  return p === "downloaded";
}
/** idle or found — the only phases a check may start from. Guards against the
 *  "footer download in progress, settings panel re-checks" interleaving:
 *  without this, a check triggered mid-download/mid-install would clobber
 *  pendingUpdate/found out from under the in-flight resource (see doCheck).
 *  Mirrors canStartDownload/canInstall's named-guard style. */
export function canCheck(p: UpdatePhase): boolean {
  return p === "idle" || p === "found";
}

/** Subscribe to every phase transition. Returns an unsubscribe function.
 *  The footer button (persistent chrome) is the intended long-lived
 *  subscriber; the version-pane deliberately does NOT call this (see its
 *  no-teardown contract) — it re-queries on its own mount/action instead. */
export function subscribeUpdate(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// ── the shared in-flight check, deduped regardless of caller ───────────────
async function performCheck(): Promise<void> {
  setPhase("checking");
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (update) {
      pendingUpdate = update;
      found = { version: update.version, date: update.date, body: update.body };
      lastResult = "found";
      setPhase("found");
    } else {
      pendingUpdate = null;
      found = null;
      lastResult = "none";
      setPhase("idle");
    }
  } catch {
    // Boot auto-check requirement: network failure (or any check() rejection)
    // is swallowed quietly — no throw, no user-facing error, just idle.
    pendingUpdate = null;
    found = null;
    lastResult = "error";
    setPhase("idle");
  }
}

/** Gate + share a single in-flight check() call across overlapping callers,
 *  whether they arrived via ensureCheckedOnce or checkNow. Two layers:
 *  (1) if a check is already in flight (phase "checking"), every caller
 *  shares that one promise instead of racing the network twice; (2) once
 *  that in-flight promise is gone, canCheck(phase) rejects reentry from any
 *  other non-idle/found phase (downloading/downloaded/installing) so a check
 *  triggered mid-download/mid-install can't clobber pendingUpdate/found out
 *  from under the resource actually in use (see 04_audit_report.md #1).
 *  hasCheckedOnce is set here — not in ensureCheckedOnce — so "a check has
 *  happened" is tracked by whichever path (boot or manual) actually ran the
 *  first real check, not by which function was called. */
function doCheck(): Promise<void> {
  if (inFlightCheck) return inFlightCheck;
  if (!canCheck(phase)) return Promise.resolve();
  hasCheckedOnce = true;
  inFlightCheck = performCheck().finally(() => {
    inFlightCheck = null;
  });
  return inFlightCheck;
}

// ── commands (void Promise, CQS) ────────────────────────────────────────────
/** Boot-time check: idempotent across repeated calls (once a check has ever
 *  been kicked off, later calls are no-ops) — re-opening a window/document
 *  during the same page load must not re-trigger the network check. */
export function ensureCheckedOnce(): Promise<void> {
  if (hasCheckedOnce) return Promise.resolve();
  return doCheck();
}

/** Manual check (version-pane's "업데이트 확인" button): performs a fresh
 *  check when the phase allows it (idle or found — canCheck), sharing an
 *  in-flight request rather than racing the network twice. No-ops while a
 *  download/install is in progress elsewhere (e.g. the footer button) so it
 *  can't clobber that in-flight resource — a legitimate re-check from
 *  "found" (user wants the latest info again) still goes through. */
export function checkNow(): Promise<void> {
  return doCheck();
}

/** found -> downloading -> downloaded. No-op outside "found" (canStartDownload
 *  guards it) so a stray call can't restart a download mid-flight or before
 *  anything was found. Errors revert to "found" so the UI can offer retry. */
export async function startDownload(onEvent?: (ev: DownloadEvent) => void): Promise<void> {
  if (!canStartDownload(phase) || !pendingUpdate) return;
  setPhase("downloading");
  try {
    await pendingUpdate.download((ev) => onEvent?.(ev));
    setPhase("downloaded");
  } catch {
    setPhase("found");
  }
}

/** downloaded -> installing -> install() + relaunch(). No-op outside
 *  "downloaded" (canInstall guards it). Errors revert to "downloaded" so the
 *  UI can offer retry; relaunch() is only reached after a successful install,
 *  and its promise not resolving (the process exits) is the expected end. */
export async function installAndRelaunch(): Promise<void> {
  if (!canInstall(phase) || !pendingUpdate) return;
  setPhase("installing");
  try {
    await pendingUpdate.install();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch {
    setPhase("downloaded");
  }
}
