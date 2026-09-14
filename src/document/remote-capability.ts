// What a v1 remote vault can actually open (Task 11, docs/design/remote-vault.md
// §6). The remote read path only ever serves two shapes: markdown text
// (`remote_read_file`) and images (the widget's `asset://` src). Everything
// else mermark can open goes through a registered Viewer (chrome/viewer/*,
// extensions/*) whose open() reads through a Tauri command or a local-disk
// path that has no remote counterpart — `arm_epub_view`/`read_epub_entry`
// (EPUB), the sqlite_*/hwp_* commands, pdf.js/docx-preview/xlsx fetching an
// on-disk ArrayBuffer, DOMParser reading a local `.html` file. Opening one of
// those against a remote vault must fail with an explicit, readable message —
// never a broken or empty viewer (this repo forbids silent degradation).
//
// The extension set below is the UNION of every extension a registered
// Viewer claims as of this writing (verified against src/chrome/viewer/* and
// src/extensions/*, NOT the shorter set task-11-brief.md sketched — that
// draft predates docx/xlsx/csv/sqlite3/db3 landing as their own viewers):
//   - epub-viewer.ts        → epub
//   - hwp-viewer.ts         → hwp, hwpx
//   - sqlite-viewer.ts      → sqlite, sqlite3, db, db3
//   - extensions/pdf-viewer → pdf
//   - extensions/docx-viewer→ docx
//   - extensions/excel-viewer → xlsx, xls, csv
//   - extensions/html-viewer  → html, htm
// Hand-kept (not imported from chrome/viewer/registry.ts) because the
// registry is empty until main.ts's boot() runs registerViewer for each of
// the above — this module has to stay a plain, standalone pure function
// usable before any of that machinery exists (open-time gate, unit tests).
import { extensionOf } from "../sidebar/explorer/file-icons";

const REMOTE_UNSUPPORTED_EXTENSIONS = new Set([
  "epub",
  "hwp",
  "hwpx",
  "sqlite",
  "sqlite3",
  "db",
  "db3",
  "pdf",
  "docx",
  "xlsx",
  "xls",
  "csv",
  "html",
  "htm",
]);

/** Can a remote (read-only) vault open `fileName` at all? True for markdown
 *  and every image extension (the only two things `remote_read_file`-backed
 *  reading actually serves); false for anything a registered Viewer claims,
 *  since that viewer's open() has no remote-capable read path. Pure query. */
export const remoteCanOpen = (fileName: string): boolean => !REMOTE_UNSUPPORTED_EXTENSIONS.has(extensionOf(fileName));

/** The explicit refusal shown in place of a broken/empty viewer when
 *  `remoteCanOpen` is false. Deliberately distinct from local-doc-link.ts's
 *  `REMOTE_VAULT_LOCAL_LINK_MESSAGE` ("원격 볼트에서는 지원하지 않습니다"): that
 *  message reports a standard-Markdown-link's resolver pipeline being
 *  entirely bypassed for remote vaults (a link-mechanism gap, unrelated to
 *  the target's file type). This one reports a v1 file-type scope limit —
 *  "아직" (not yet) is the accurate word here because EPUB/PDF/etc. could
 *  gain a remote-capable read path later, whereas the link-mechanism gap is
 *  a different, structural limitation. Keeping the wording distinct avoids
 *  implying the two gaps would lift together. Pure query (the file name is
 *  unused today — every unsupported type gets the same message — but kept as
 *  a parameter so a later per-type message doesn't change the call sites). */
export const remoteUnsupportedMessage = (_fileName: string): string => "원격 볼트에서는 아직 지원하지 않습니다";
