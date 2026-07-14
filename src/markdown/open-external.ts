import { openUrl } from "@tauri-apps/plugin-opener";

/** Whitelist of schemes safe to hand to the OS's default-app opener. */
const EXTERNAL_URL_RE = /^(https?:\/\/|mailto:|tel:)/i;

/**
 * Is `url` an external URL that may be opened outside the editor?
 *
 * One predicate serves two jobs that must never drift apart: it is the
 * *routing* test (does this target go to the OS opener, or stay inside the
 * app as a note/heading/asset path?) and the *safety* test (dangerous schemes
 * — `javascript:`, `file:`, `data:`, `vbscript:`, bare relative paths — never
 * qualify, because the whitelist only recognizes the schemes above). Pure
 * query — no side effects.
 */
export function isExternalUrl(url: string): boolean {
  return EXTERNAL_URL_RE.test(url);
}

/** Mark `el` with the shared external-link failure presentation (mirrors the
 *  existing `cm-wikilink-error` + title pattern). No-op without an element —
 *  callers that don't have (or don't want) inline feedback may omit it. */
function markFailure(el: HTMLElement | undefined, message: string): void {
  if (!el) return;
  el.classList.add("cm-external-link-error");
  el.title = message;
}

/**
 * Open `url` in the OS's default handler — the single exit every external
 * link click (markdown link / wikilink / autolink / rendered table-cell or
 * changelog anchor) shares.
 *
 * Command, void. Re-validates the scheme itself (`url` may come from
 * untrusted markdown source text, not just from a caller that already
 * gated), and on rejection — whether that's a disallowed scheme or the
 * `openUrl` IPC call failing — marks `feedbackEl` instead of silently doing
 * nothing. There is deliberately no `window.open` fallback: WKWebView makes
 * `window.open` a no-op, which is exactly the silent failure this replaces.
 */
export async function openExternal(url: string, feedbackEl?: HTMLElement): Promise<void> {
  if (!isExternalUrl(url)) {
    markFailure(feedbackEl, `열 수 없는 링크입니다: ${url}`);
    return;
  }
  try {
    await openUrl(url);
  } catch (err) {
    markFailure(feedbackEl, `링크를 여는 데 실패했습니다: ${String(err)}`);
  }
}
