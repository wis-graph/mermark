// The single "what kind of binary container is this" classifier for the
// docx viewer's error handling (01_architect_design.md §핵심 판정 3). A
// `.docx` file IS a zip archive (OOXML); a `.doc`/encrypted-`.docx` file
// renamed to `.docx` is a CFB (OLE2) archive, which `docx-preview`'s JSZip
// layer cannot open at all — distinguishing the two up front lets openDocxViewer
// show a message that names the ACTUAL problem instead of JSZip's raw
// "Can't find end of central directory" (a message about zip internals, not
// about what the user should do). Pure query — no I/O, no throw on any input
// shape (design plan Stage 1: "경계: 절대 throw 금지" — 4바이트 미만/빈 버퍼도
// "unknown", never an exception).

/** The three container shapes this viewer distinguishes. `"zip"` covers both
 *  a genuine OOXML `.docx` AND a corrupted/non-OOXML zip — `docxOpenErrorMessage`
 *  (index.ts) tells those apart by whether `renderAsync` itself threw, not by
 *  signature bytes (a zip's central directory can be intact while the OOXML
 *  parts inside it are garbage, so the signature alone can't distinguish
 *  them). */
export type DocxContainerKind = "zip" | "cfb" | "unknown";

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** True when `bytes` starts with exactly `signature`'s bytes — the one place
 *  both signature checks below compare a byte-prefix, so ZIP/CFB detection
 *  can never drift into two different comparison rules. Pure query. */
function startsWithSignature(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, i) => bytes[i] === byte);
}

/** Classify `bytes` by its leading signature: `50 4B 03 04` (a zip local-file
 *  header — every OOXML `.docx`, valid or corrupted, starts this way),
 *  `D0 CF 11 E0 A1 B1 1A E1` (the CFB/OLE2 magic — legacy `.doc`, AND an
 *  encrypted `.docx`, which OOXML re-wraps in a CFB "EncryptedPackage"
 *  container), or `"unknown"` for anything else (including a too-short
 *  buffer). Pure query. */
export function docxContainerKind(bytes: ArrayBuffer): DocxContainerKind {
  const view = new Uint8Array(bytes);
  if (startsWithSignature(view, ZIP_SIGNATURE)) return "zip";
  if (startsWithSignature(view, CFB_SIGNATURE)) return "cfb";
  return "unknown";
}
