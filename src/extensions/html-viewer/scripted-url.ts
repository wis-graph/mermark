// The scripted HTML viewer path's URL builder
// (_workspace/01_architect_design_htmljs.md §10.3/§10.7 — Revision 1).
//
// Revision 1 supersedes the original "reuse convertFileSrc" approach: the
// per-open TOKEN now has to live in the URL's HOST (not merely a path
// segment), because host is what fixes the frame document's ORIGIN
// (scheme, host) — one arm() call = one unique token = one unique origin,
// which is the whole isolation invariant this revision buys (design §10.3:
// same-origin siblings/localStorage sharing between two scripted documents
// is closed off by giving each open its own host, not by opaque-origin
// anymore). Tauri's `convertFileSrc(path, protocol)` always emits
// `<protocol>://localhost/<path>` — the host is the fixed literal
// `"localhost"`, with no way to substitute a token — so it can no longer
// build this URL; the string is assembled by hand instead.
//
// macOS/Linux only (this round's design/verification scope — design §10.7's
// "1차 지원, 실측 대상"; Windows is an explicit opt-in fallback the BACKEND
// handler alone accepts, out of this round per the project's mac-first
// release convention, `_workspace/02_backend_changes_htmljs.md` §11).
const HTMLVIEW_PROTOCOL = "htmlview";

/** The `iframe.src` URL for the scripted HTML viewer to load `docFileName`
 *  (the opened document's own file name, NOT an absolute path — the armed
 *  root already pins the directory via `token`) through the `htmlview`
 *  custom-scheme handler, once `arm_html_view_root` has minted `token` for
 *  this open. Pure query. */
export function htmlViewUrl(token: string, docFileName: string): string {
  return `${HTMLVIEW_PROTOCOL}://${token}/${encodeURIComponent(docFileName)}`;
}
