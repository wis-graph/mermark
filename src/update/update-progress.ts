// Pure formatting helpers for the 버전 pane's download progress. Split out from
// version-pane.ts so the byte-math is unit-testable without mounting any DOM —
// the pane just calls these on every `downloadAndInstall` Progress event.

/** downloaded/total bytes → a 0-100 percentage, or null when the server didn't
 *  send a Content-Length (an "Started" event with no `contentLength`) — a
 *  percentage would be meaningless without a denominator. Query: pure. */
export function downloadPercent(downloaded: number, total: number | null): number | null {
  if (total == null || total <= 0) return null;
  return Math.min(100, Math.max(0, (downloaded / total) * 100));
}

/** downloaded/total bytes → JUST the numeric readout, e.g. "43% (4.2 / 9.8 MB)"
 *  or "4.2 MB" when `total` is unknown — no state word ("다운로드 중...") in
 *  front. Split out for callers that already show their OWN state word next
 *  to this text (the status-bar button's caption sits beside a button whose
 *  label already says "다운로드 중...", so pairing it with formatDownloadProgress's
 *  full string used to duplicate the phrase — see chrome/status-bar/update.ts).
 *  Query: pure. */
export function downloadStat(downloaded: number, total: number | null): string {
  const dl = toMb(downloaded);
  const pct = downloadPercent(downloaded, total);
  if (pct == null) return `${dl} MB`;
  return `${Math.round(pct)}% (${dl} / ${toMb(total as number)} MB)`;
}

/** downloaded/total bytes → the caption shown above the progress bar, e.g.
 *  "다운로드 중... 43% (4.2 / 9.8 MB)", or "다운로드 중... 4.2 MB" when `total`
 *  is unknown. Built by prefixing downloadStat with the state word, so the two
 *  strings can never drift apart. Used by the settings 버전 pane, where the
 *  caption is the ONLY status text on screen (no separate button label change)
 *  and therefore needs the prefix spelled out. Query: pure. */
export function formatDownloadProgress(downloaded: number, total: number | null): string {
  return `다운로드 중... ${downloadStat(downloaded, total)}`;
}

function toMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
