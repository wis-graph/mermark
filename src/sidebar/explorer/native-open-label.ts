import { extensionOf } from "./file-icons";

// T4 (0.17.1): the explorer's context menu (chrome/context-menu.ts consumer,
// explorer-panel.ts) always makes the SAME call for "open in a native app" —
// the opener plugin's `openPath(absPath)` — regardless of file kind. Only
// the LABEL changes, so a user reads "미리보기에서 열기" for a PDF instead of
// a generic "기본 앱에서 열기" that would be technically true but less
// helpful. This is a pure lookup, not a dispatch: no `if` branches the
// actual openPath call itself (design §2.2 — "인라인 if 금지").

/** The user-facing label for "open this file in its native app" — the CALL
 *  behind it is always `openPath(absPath)`, one dispatch, regardless of what
 *  this returns. Case-insensitive (reuses `extensionOf`'s own
 *  case-folding), and only ever looks at the LAST extension ("a.tar.gz" →
 *  "gz", never "tar.gz"). Pure query. */
export function nativeOpenLabel(fileName: string): string {
  const ext = extensionOf(fileName);
  if (ext === "html" || ext === "htm" || ext === "svg") return "기본 브라우저에서 열기";
  if (ext === "pdf") return "미리보기에서 열기";
  return "기본 앱에서 열기";
}
