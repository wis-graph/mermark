// Vault image attachment orchestration — `vault:` scheme withdrawal
// (_workspace/00_request_vaultimage_fix.md). Migrated from the old
// vault-image.ts/vault-image-widget.ts pair: the RENDER half of those files
// (parseVaultImageRef, VaultImageWidget, the `vault:` resolution pipeline)
// is deleted outright — resolution is now name search under a vault root
// (image.ts's `searchPlanFor` + image-search-root.ts's `owningVaultRoot`),
// not a scheme to parse. This file keeps only what's still true: the
// picker→import→insert→finalize/rollback lifecycle, its Korean messages,
// and the receipt/outcome contracts, none of which had anything to do with
// `vault:` — they're the file-safety machinery
// (_workspace/00_request_vaultimage_fix.md: "버리는 건 참조 스킴이지 파일
// 안전성 기계가 아니다").
//
// mock-fidelity note (unchanged from the old file): the vitest suite
// exercising `attachImageToVault` verifies ORCHESTRATION ONLY — call order,
// token plumbing, message selection, document preservation on every failure
// path. Atomicity (hard_link no-replace), (dev,ino) file identity, and the
// TempGuard RAII cleanup are native properties only cargo's
// attachment_import.rs integration tests can verify.
import type { EditorView } from "@codemirror/view";
import { VAULT_IMAGE_SCAN_DEPTH } from "./image-search-root";

// ---------------------------------------------------------------------------
// Attachment import/finalize/rollback lifecycle — opaque receipt shapes and
// Korean failure messages. These types mirror `attachments.rs`'s serde
// shapes exactly (backend); `attachImageToVault` below is the only consumer.
// ---------------------------------------------------------------------------

/** An opaque receipt for a just-imported attachment. `token` is the ONLY
 *  input `finalize_attachment_import`/`rollback_attachment_import` accept —
 *  there is no path field a caller could redirect to delete an arbitrary
 *  file. `relPath`/`fileName` are display-only (building the `![[name]]`
 *  insertion text via `embedMarkdownFor`, and the shadowing check below). */
export interface AttachmentReceipt {
  readonly token: number;
  readonly relPath: string;
  readonly fileName: string;
}

/** The result of `import_vault_attachment` — the user cancelled the native
 *  picker (no file was ever touched), a file outside the vault was copied in
 *  and an opaque receipt was issued, or the picked file was ALREADY inside
 *  the vault (nothing copied, no receipt — there is nothing to finalize or
 *  roll back). Mirrors `attachments.rs`'s
 *  `#[serde(tag = "status", rename_all = "camelCase")] AttachmentImportOutcome`. */
export type AttachmentImportOutcome =
  | { readonly status: "cancelled" }
  | { readonly status: "imported"; readonly receipt: AttachmentReceipt }
  | { readonly status: "alreadyInVault"; readonly fileName: string };

/** Every named point of attachment-lifecycle failure, keyed independently of
 *  any render-time concern (that union — `VaultImageRejectionReason` — no
 *  longer exists; rendering a broken `![[name]]` just shows a broken image,
 *  no per-reason message). This one is about IMPORTING a new attachment. */
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

/** Korean, actionable message for each attachment-lifecycle failure kind.
 *  Shown via the existing `flashStatus` status-bar surface, never a raw
 *  error string. `"no-permanent-vault"`'s text is updated for the new
 *  contract — attachment now requires the document to live INSIDE a
 *  registered vault (image-search-root.ts's `owningVaultRoot`), not that
 *  some vault merely be "active". */
export const VAULT_ATTACHMENT_MESSAGES: Record<AttachmentFailureKind, string> = {
  "no-permanent-vault": "문서가 등록된 볼트 안에 없어 이미지를 첨부할 수 없습니다",
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

/** Shown after a successful `![[fileName]]` insertion when a post-insert
 *  `resolve_image` lookup finds a DIFFERENT file than the one just
 *  attached — i.e. the name is shadowed by a shallower/earlier match
 *  (design §분기4). The insertion itself is never rolled back or retried:
 *  name uniqueness is the user's responsibility
 *  (`_workspace/00_request_vaultimage_fix.md`'s stated rule); this is purely
 *  a visibility nudge toward the escape hatch. */
export const SHADOWED_IMAGE_NAME_WARNING =
  "같은 이름의 다른 파일이 우선합니다 — 정확히 지정하려면 상대 경로(![](...))를 쓰세요";

/** Ordered, specific-prefix-first map from a native `Err(String)`'s stable
 *  code prefix (`ATTACH_*:`/`ROLLBACK_*:`) to the failure kind whose Korean
 *  message applies. Every prefix here is mutually exclusive by construction
 *  (each native error string carries exactly one of these prefixes), so a
 *  `find` is enough — no prefix is a substring of another. */
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

/** The markdown to insert for an attachment living at vault-root-relative
 *  `fileName` — the ONE place this shape is assembled (design §분기3's
 *  "이주한다" list; supersedes the old `vaultAttachmentMarkdown`, which
 *  built a `vault:`-scheme link). A wikilink-image embed, resolved the same
 *  way any other `![[name]]` is (image.ts's vault-scope search) — no
 *  percent-encoding: the wikilink parser reads everything up to `]]`/`|` as
 *  the target verbatim, so spaces and Korean filenames round-trip as-is. */
export function embedMarkdownFor(fileName: string): string {
  return `![[${fileName}]]`;
}

// ---------------------------------------------------------------------------
// attachImageToVault — the `image.attach` action body. Every dependency is
// injected, so this is testable without booting main.ts. `vaultRoot` is the
// document's OWNING vault root (image-search-root.ts's `owningVaultRoot`),
// never "the active vault" — the same single rule the render path
// (image.ts) consumes, computed once by main.ts and shared between both
// call sites (design §분기4's single-SSOT requirement).
// ---------------------------------------------------------------------------

export interface AttachImageDeps {
  readonly vaultRoot: string | null;
  readonly view: EditorView | null;
  readonly invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  readonly flash: (message: string) => void;
}

/** A native `Err(String)`/rejection's message text, whether it arrived as a
 *  raw string (the shape every mock/native command in this codebase throws)
 *  or a wrapped `Error`. Named so `attachImageToVault`'s several catch sites
 *  agree on how to unwrap a rejection instead of each re-deriving it. */
function rejectionMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Insert `insertText` at the cursor — the one seam every outcome branch of
 *  `attachImageToVault` inserts through, so they can't drift on how the
 *  cursor position is read or the change is shaped. Throws through
 *  (callers decide what a synchronous dispatch failure means for THEM: a
 *  freshly-imported file needs a rollback, an already-in-vault one doesn't). */
function insertAtCursor(view: EditorView, insertText: string): void {
  const head = view.state.selection.main.head;
  view.dispatch({ changes: { from: head, insert: insertText } });
}

/** Best-effort post-insert visibility check for the "first match wins"
 *  ambiguity the recursive name search always carries (design §분기4): does
 *  `![[fileName]]`'s own vault-wide search actually land on the file just
 *  attached, or does something shallower/earlier shadow it? Only meaningful
 *  for a freshly-imported file (its expected path is knowable —
 *  `{vaultRoot}/{relPath}`); an `alreadyInVault` outcome has no comparably
 *  cheap expected path on the frontend, so callers don't run this for that
 *  branch (design's explicit scope note: "프론트는 imported 케이스만
 *  비교해도 충분"). A failed lookup is swallowed — this is a visibility
 *  nudge, never a reason to fail the attach that already succeeded. */
async function warnIfShadowedName(
  vaultRoot: string,
  fileName: string,
  expectedPath: string,
  call: AttachImageDeps["invoke"],
  flash: AttachImageDeps["flash"],
): Promise<void> {
  try {
    const found = await call<string | null>("resolve_image", {
      baseDir: vaultRoot,
      name: fileName,
      maxDepth: VAULT_IMAGE_SCAN_DEPTH,
    });
    if (found !== null && found !== expectedPath) flash(SHADOWED_IMAGE_NAME_WARNING);
  } catch {
    /* best-effort visibility only — a lookup failure is not worth surfacing */
  }
}

/** Attach an image into the vault that owns the current document: invoke the
 *  native picker+import command, insert `embedMarkdownFor(fileName)` at the
 *  cursor, and either finalize (a freshly-imported file) or do nothing more
 *  (a file that was already inside the vault — no copy, no receipt, nothing
 *  to finalize). Every failure path — no owning vault, no document,
 *  cancelled picker, any `ATTACH_*`/`ROLLBACK_*` native error — leaves the
 *  document text and every pre-existing file untouched. Command (void;
 *  reports outcome via `flash`, never throws). */
export async function attachImageToVault(deps: AttachImageDeps): Promise<void> {
  const { vaultRoot, view, invoke: call, flash } = deps;
  if (vaultRoot === null) {
    flash(VAULT_ATTACHMENT_MESSAGES["no-permanent-vault"]);
    return;
  }
  if (view === null) {
    flash(VAULT_ATTACHMENT_MESSAGES["no-document"]);
    return;
  }

  let outcome: AttachmentImportOutcome;
  try {
    outcome = await call<AttachmentImportOutcome>("import_vault_attachment", { vaultRoot });
  } catch (error) {
    flash(attachmentFailureMessage(rejectionMessage(error)));
    return;
  }
  if (outcome.status === "cancelled") {
    flash(VAULT_ATTACHMENT_MESSAGES.cancelled);
    return;
  }

  if (outcome.status === "alreadyInVault") {
    // Nothing was copied or created for this outcome, so a synchronous
    // insertion failure has nothing to roll back — just report it.
    try {
      insertAtCursor(view, embedMarkdownFor(outcome.fileName));
    } catch {
      flash(VAULT_ATTACHMENT_MESSAGES["insertion-failed"]);
    }
    return;
  }

  const { receipt } = outcome;
  try {
    insertAtCursor(view, embedMarkdownFor(receipt.fileName));
  } catch {
    // Synchronous insertion failure: the native file was created but never
    // landed in the document — ask native code to remove ONLY that
    // unchanged receipt target (token-only input; see AttachmentReceipt's
    // doc comment for why a path can never be supplied here).
    try {
      await call("rollback_attachment_import", { token: receipt.token });
      flash(VAULT_ATTACHMENT_MESSAGES["insertion-failed"]);
    } catch (rollbackError) {
      flash(attachmentFailureMessage(rejectionMessage(rollbackError)));
    }
    return;
  }

  try {
    await call("finalize_attachment_import", { token: receipt.token });
  } catch (error) {
    // A rejection here means something went wrong on the native side AFTER
    // the file was already safely inserted into the document, so there is
    // nothing left to roll back or warn the user about losing. finalize is
    // documented idempotent-Ok even for an unknown token. Logged, not
    // flashed.
    console.error("finalize_attachment_import failed after a successful insertion", rejectionMessage(error));
  }

  const expectedPath = `${vaultRoot.replace(/\/$/, "")}/${receipt.relPath}`;
  await warnIfShadowedName(vaultRoot, receipt.fileName, expectedPath, call, flash);
}
