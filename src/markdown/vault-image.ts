// Pure typed contracts for `vault:<vault-relative-path>` image references and
// the vault attachment (import/finalize/rollback) lifecycle —
// single-window-opening Wave 2, Todo 4. This module does ZERO IO/DOM: it
// only parses, classifies, and names things. The async resolution pipeline
// that actually walks the filesystem (canonicalize + containment +
// regular-file checks, mirroring local-doc-link.ts's resolver) and the
// native import/rollback machinery are Todo 5's job (vault-image-widget.ts /
// attachment_import.rs) and consume the types defined here — this file is
// the single source of truth those build on.
//
// Reuse instead of reinvention (mermark-frontend §7, design §분기1): the
// vault-relative path grammar here is NOT the same grammar as
// local-doc-link.ts's document-link href grammar (no fragment concept, an
// image extension gate instead of a .md/.txt gate, and `.`/`..` segments are
// rejected outright rather than lexically resolved then canonicalized) — so
// the pure prefix is reimplemented here rather than extracted into a shared
// module (see local-doc-link.ts's header comment for the same reasoning
// applied to wikilinks vs standard links). Only the two genuinely shared,
// self-contained primitives are reused: `decodeOnceStrict` (imported from
// local-doc-link.ts) for the single-decode-pass rule, and `isPathInsideRoot`
// (imported directly by Todo 5's async resolver, not by this module) for
// boundary-safe containment.
import { basename } from "../document/path";
import { extensionOf, IMAGE_EXTENSIONS } from "../sidebar/explorer/file-icons";
import { decodeOnceStrict } from "./local-doc-link";

// ---------------------------------------------------------------------------
// `vault:` reference parsing (pure, no IO)
// ---------------------------------------------------------------------------

const VAULT_SCHEME = "vault:";

/** Whether `raw` opens with the vault image scheme — a case-sensitive, exact
 *  `vault:` prefix match. Uppercase `VAULT:` (or any other casing) is
 *  deliberately NOT a vault reference: it falls through to the existing
 *  relative-path-join semantics `resolveImageSrc` already implements
 *  (image.ts:22-27) instead of being silently reinterpreted — a decisive,
 *  documented choice, not an oversight. Pure query. */
export function isVaultImageRef(raw: string): boolean {
  return raw.startsWith(VAULT_SCHEME);
}

export type VaultImageRejectionReason =
  | "not-vault-ref"
  | "empty-path"
  | "malformed-escape"
  | "drive-path"
  | "unc-path"
  | "rooted-path"
  | "nul"
  | "mixed-separators"
  | "traversal"
  | "not-an-image"
  | "no-permanent-vault"
  | "vault-root-unavailable"
  | "missing-target"
  | "outside-vault"
  | "not-a-regular-file";

/** Korean, always-visible rejection message for a `vault:` reference that
 *  failed to parse or resolve — shown as the broken-image widget's `title`
 *  (design §분기4). Every member of `VaultImageRejectionReason` has an entry
 *  here (enforced by the `Record` type), so a new reason can never ship
 *  without a matching Korean message. */
export const VAULT_IMAGE_REJECTION_MESSAGES: Record<VaultImageRejectionReason, string> = {
  "not-vault-ref": "vault: 참조가 아닙니다",
  "empty-path": "vault 참조 경로가 비어 있습니다",
  "malformed-escape": "잘못된 퍼센트 인코딩입니다",
  "drive-path": "드라이브 경로는 사용할 수 없습니다",
  "unc-path": "네트워크(UNC) 경로는 사용할 수 없습니다",
  "rooted-path": "vault 참조는 절대 경로를 사용할 수 없습니다",
  nul: "허용되지 않는 문자가 포함된 경로입니다",
  "mixed-separators": "경로 구분자가 올바르지 않습니다",
  traversal: "상위 경로(..) 이동은 허용되지 않습니다",
  "not-an-image": "이미지 파일이 아니어서 열 수 없습니다",
  "no-permanent-vault": "영구 볼트가 선택되어 있지 않아 이미지를 열 수 없습니다",
  "vault-root-unavailable": "볼트 루트를 확인할 수 없습니다",
  "missing-target": "참조된 이미지 파일이 없습니다",
  "outside-vault": "볼트 밖의 파일은 열 수 없습니다",
  "not-a-regular-file": "일반 파일이 아닌 대상은 열 수 없습니다",
};

export type ParsedVaultImageRef =
  | { readonly ok: true; readonly relPath: string }
  | { readonly ok: false; readonly reason: VaultImageRejectionReason };

/** A Windows drive prefix (`C:\`/`C:/`) — never a valid vault-relative
 *  segment (mirrors local-doc-link.ts's `hasWindowsDrivePrefix`, reimplemented
 *  here per this module's header reuse rationale). */
function hasWindowsDriveLikePrefix(decoded: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(decoded);
}

/** A UNC/protocol-relative-looking prefix (`\\host\share` or `//host/share`)
 *  — checked before the generic rooted-path test so a doubled leading
 *  separator gets the more specific reason (mirrors local-doc-link.ts's
 *  `isUncPath`). */
function isUncLikePath(decoded: string): boolean {
  return /^(\\\\|\/\/)/.test(decoded);
}

/** Whether a decoded vault-relative path carries a NUL byte (`%00` decoded). */
function containsNul(decoded: string): boolean {
  return decoded.includes("\u0000");
}

/** Whether any `/`-delimited segment of `decoded` is `.` or `..` — the
 *  traversal gate. Vault references are always vault-root-relative EXACT
 *  paths (design §분기1: "볼트 전역 basename 탐색 금지... 정확 경로만
 *  해석"), so a `.`/`..` segment has no legitimate use here and is rejected
 *  outright rather than lexically collapsed and re-validated (contrast with
 *  local-doc-link.ts, which lets the backend's `fs::canonicalize` resolve a
 *  `..` that crosses a symlink to its real target). */
function hasTraversalSegment(decoded: string): boolean {
  return decoded.split("/").some((segment) => segment === "." || segment === "..");
}

/** Whether `decoded` opens with something shaped like a URI scheme
 *  (`https:`, `file:`, …) smuggled in after the `vault:` prefix has already
 *  been stripped off by the caller. A vault reference has no scheme concept
 *  of its own — there is nothing left to strip a second time — so a
 *  residual scheme-shaped prefix can never be a legitimate vault-relative
 *  image path. Folded into the extension gate ("not-an-image") below rather
 *  than given its own rejection reason: from the caller's point of view a
 *  disguised remote URL and a file with the wrong extension are the same
 *  outcome, "this isn't an image mermark can open here". */
function looksLikeNestedScheme(decoded: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.\-]*:/.test(decoded);
}

/** Parse a `vault:`-prefixed raw href into a validated, vault-root-relative
 *  path, or a specific rejection reason. Pure query (CQS) — no IO, so this
 *  is safe to call on every decoration render as well as before an async
 *  resolve. The ONLY way to reach `{ ok: true }` is through every gate below
 *  in order; there is no early-return acceptance. */
export function parseVaultImageRef(raw: string): ParsedVaultImageRef {
  if (!isVaultImageRef(raw)) return { ok: false, reason: "not-vault-ref" };
  const decoded = decodeOnceStrict(raw.slice(VAULT_SCHEME.length));
  if (decoded === null) return { ok: false, reason: "malformed-escape" };
  if (decoded === "") return { ok: false, reason: "empty-path" };
  if (hasWindowsDriveLikePrefix(decoded)) return { ok: false, reason: "drive-path" };
  if (isUncLikePath(decoded)) return { ok: false, reason: "unc-path" };
  if (decoded.startsWith("/")) return { ok: false, reason: "rooted-path" };
  if (containsNul(decoded)) return { ok: false, reason: "nul" };
  if (decoded.includes("\\")) return { ok: false, reason: "mixed-separators" };
  if (decoded.endsWith("/")) return { ok: false, reason: "empty-path" };
  if (hasTraversalSegment(decoded)) return { ok: false, reason: "traversal" };
  if (looksLikeNestedScheme(decoded)) return { ok: false, reason: "not-an-image" };
  if (!IMAGE_EXTENSIONS.has(extensionOf(basename(decoded)))) return { ok: false, reason: "not-an-image" };
  return { ok: true, relPath: decoded };
}

/** Percent-encode `path` segment-by-segment (never the `/` separators
 *  themselves) so a vault-relative path with spaces, parentheses, or
 *  non-ASCII characters (Korean filenames) survives round-tripping through a
 *  CommonMark link destination. Round-trips exactly with `decodeOnceStrict`
 *  called once — the pairing `parseVaultImageRef` above depends on. A
 *  hand-typed, already-safe path (no special characters) is unaffected,
 *  since `encodeURIComponent` is the identity on that alphabet. */
export function encodeVaultImagePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** The filename without its extension, using the same last-dot rule as
 *  `extensionOf` (file-icons.ts) so the two never disagree on where a name's
 *  extension starts — a dotfile or extension-less name is its own stem. */
function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 || dot === name.length - 1 ? name : name.slice(0, dot);
}

/** The markdown to insert for a newly-imported attachment `fileName` living
 *  at vault-root-relative `.attachments/<fileName>` — the ONE place this
 *  shape is assembled, so the attachment writer (Todo 5's `attachImageToVault`)
 *  and any future reader agree on it byte-for-byte. */
export function vaultAttachmentMarkdown(fileName: string): string {
  return `![${stemOf(fileName)}](${VAULT_SCHEME}${encodeVaultImagePath(`.attachments/${fileName}`)})`;
}

// ---------------------------------------------------------------------------
// Global-vault structural containment — a plain-module context slot, the
// same pattern as image-open.ts/document-open.ts: it lets renderer/action
// code ask "what's the current permanent vault root?" without importing the
// chrome/workspace layer, and main.ts wires the real provider once at
// startup (Todo 5). `VaultImageContext.rootPath` is a required `string`
// (unlike `GlobalVault.rootPath`, which is `null` — workspace-state.ts:17-21),
// so a `VaultImageContext` can ONLY be constructed from a permanent vault.
// Both the render path (resolveVaultImage) and the attach action
// (attachImageToVault) read this ONE slot for their root — there is no `if`
// to forget at either call site, and the global vault can never be made to
// act as a filesystem root by accident.
// ---------------------------------------------------------------------------

export interface VaultImageContext {
  readonly rootPath: string;
}

let contextProvider: (() => VaultImageContext | null) | null = null;

/** Wire the real "what's the current permanent vault?" provider — called
 *  once by main.ts at startup. Command (void). */
export function setVaultImageContext(fn: () => VaultImageContext | null): void {
  contextProvider = fn;
}

/** The current permanent-vault context, or `null` when no provider has been
 *  wired yet (e.g. a test that never calls `setVaultImageContext`) or the
 *  provider itself reports no permanent vault is active (the global vault is
 *  selected). Pure from this function's own point of view — it delegates
 *  entirely to whatever the wired provider returns. */
export function vaultImageContext(): VaultImageContext | null {
  return contextProvider?.() ?? null;
}

// ---------------------------------------------------------------------------
// Attachment import/finalize/rollback lifecycle — opaque receipt shapes
// (design §분기3) and Korean failure messages (design §분기4). These types
// mirror `attachments.rs`'s serde shapes exactly (Todo 4 backend); Todo 5's
// native commands and `vault-image-widget.ts`'s `attachImageToVault`
// orchestration are the only consumers.
// ---------------------------------------------------------------------------

/** An opaque receipt for a just-imported attachment. `token` is the ONLY
 *  input `finalize_attachment_import`/`rollback_attachment_import` accept —
 *  there is no path field a caller could redirect to delete an arbitrary
 *  file. `relPath`/`fileName` are display-only (building the markdown
 *  insertion text via `vaultAttachmentMarkdown`). */
export interface AttachmentReceipt {
  readonly token: number;
  readonly relPath: string;
  readonly fileName: string;
}

/** The result of `import_vault_attachment` — either the user cancelled the
 *  native picker (no file was ever touched) or a file was imported and an
 *  opaque receipt was issued. Mirrors `attachments.rs`'s
 *  `#[serde(tag = "status", rename_all = "camelCase")] AttachmentImportOutcome`. */
export type AttachmentImportOutcome =
  | { readonly status: "cancelled" }
  | { readonly status: "imported"; readonly receipt: AttachmentReceipt };

/** Every named point of attachment-lifecycle failure (design §분기4's
 *  8 numbered failures + 3 auxiliary ones), keyed independently of
 *  `VaultImageRejectionReason` — that union is about RENDERING a `vault:`
 *  reference that already exists in a document; this one is about IMPORTING
 *  a new attachment, a disjoint set of failure points with its own Korean
 *  messages and its own (native-error-string-keyed) mapping function below. */
export type AttachmentFailureKind =
  | "no-permanent-vault"
  | "no-document"
  | "cancelled"
  | "invalid-image"
  | "copy-failed"
  | "dir-invalid"
  | "escape"
  | "insertion-failed"
  | "rollback-changed"
  | "rollback-io"
  | "rollback-unknown";

/** Korean, actionable message for each attachment-lifecycle failure kind
 *  (design §분기4's table, # 1-8 + 보조 a-c). Shown via the existing
 *  `flashStatus` status-bar surface (Todo 5), never a raw error string. */
export const VAULT_ATTACHMENT_MESSAGES: Record<AttachmentFailureKind, string> = {
  "no-permanent-vault": "영구 볼트가 선택되어 있지 않아 이미지를 첨부할 수 없습니다",
  "no-document": "이미지를 첨부하려면 문서를 먼저 여세요",
  cancelled: "이미지 선택을 취소했습니다",
  "invalid-image": "이미지 파일이 아니어서 첨부할 수 없습니다",
  "copy-failed": "이미지 복사에 실패했습니다",
  "dir-invalid": ".attachments가 일반 폴더가 아니어서 첨부할 수 없습니다",
  escape: "첨부 파일 이름이 올바르지 않습니다",
  "insertion-failed": "이미지 삽입에 실패해 가져온 파일을 되돌렸습니다",
  "rollback-changed": "가져온 파일이 그 사이 변경되어 삭제하지 않고 보존했습니다",
  "rollback-io": "되돌리기에 실패해 가져온 파일이 .attachments에 남아 있습니다",
  "rollback-unknown": "이전에 가져온 파일은 안전을 위해 보존되어 있습니다",
};

/** Ordered, specific-prefix-first map from a native `Err(String)`'s stable
 *  code prefix (design §분기4/5: `ATTACH_*:`/`ROLLBACK_*:`) to the failure
 *  kind whose Korean message applies. Every prefix here is mutually
 *  exclusive by construction (each native error string carries exactly one
 *  of these prefixes), so a `find` is enough — no prefix is a substring of
 *  another. */
const ATTACHMENT_ERROR_PREFIXES: readonly (readonly [string, AttachmentFailureKind])[] = [
  ["ATTACH_INVALID_IMAGE:", "invalid-image"],
  ["ATTACH_DIR_INVALID:", "dir-invalid"],
  ["ATTACH_ESCAPE:", "escape"],
  ["ATTACH_COPY:", "copy-failed"],
  ["ROLLBACK_CHANGED:", "rollback-changed"],
  ["ROLLBACK_IO:", "rollback-io"],
  ["ROLLBACK_UNKNOWN:", "rollback-unknown"],
];

/** Map a raw native `Err(String)` (or any other failure string) to its
 *  Korean message. An error whose prefix isn't recognized falls back to the
 *  generic copy-failure message — the same user-facing outcome as
 *  `ATTACH_COPY:` (a failed import, nothing new on disk to explain further)
 *  — rather than surfacing a raw Rust error string to the user. Pure query. */
export function attachmentFailureMessage(rawError: string): string {
  const match = ATTACHMENT_ERROR_PREFIXES.find(([prefix]) => rawError.startsWith(prefix));
  return VAULT_ATTACHMENT_MESSAGES[match ? match[1] : "copy-failed"];
}
