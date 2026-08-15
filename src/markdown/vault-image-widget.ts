// Async `vault:` resolution + rendering + attachment orchestration —
// single-window-opening Wave 2, Todo 5. Consumes the pure contracts Todo 4
// locked in `vault-image.ts` (parseVaultImageRef, the rejection/failure
// message maps, the receipt/outcome types, the context slot) and does the IO
// those contracts deliberately stayed clear of: canonicalize+containment+
// regular-file resolution (mirroring local-doc-link.ts's resolver), the
// VaultImageWidget DOM, and the import/finalize/rollback orchestration wired
// to the `image.attach` action.
import { EditorView, WidgetType } from "@codemirror/view";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { basename } from "../document/path";
import { extensionOf, IMAGE_EXTENSIONS } from "../sidebar/explorer/file-icons";
import { isPathInsideRoot } from "./local-doc-link";
import { attachAltClickEdit } from "./wikilink";
import { requestImageOpen } from "./image-open";
import { dragExceededClickSlop } from "./image";
import {
  parseVaultImageRef,
  vaultAttachmentMarkdown,
  attachmentFailureMessage,
  VAULT_ATTACHMENT_MESSAGES,
  VAULT_IMAGE_REJECTION_MESSAGES,
  type VaultImageContext,
  type VaultImageRejectionReason,
  type AttachmentImportOutcome,
} from "./vault-image";

// ---------------------------------------------------------------------------
// Resolution (design §분기1's async pipeline, steps 1-9). Mirrors
// resolveLocalDocumentLink's shape: a pure prefix (parseVaultImageRef, Todo 4)
// feeds a canonicalize→containment→regular-file→extension chain that is the
// ONLY path to acceptance — no early-return acceptance anywhere below.
// baseDir/currentFile are never consulted: a vault reference resolves against
// the vault ROOT alone, which is exactly what makes it work identically from
// any document at any nesting depth (design's acceptance criterion).
// ---------------------------------------------------------------------------

export type VaultImageResolution =
  | { readonly ok: true; readonly url: string; readonly canonTarget: string }
  | { readonly ok: false; readonly reason: VaultImageRejectionReason };

/** Resolve a `vault:`-prefixed raw href to a webview-loadable asset URL (and
 *  the canonical absolute path, for the widget's click-to-open), or a
 *  specific rejection reason. Query (IPC reads only, no side effects) — safe
 *  to call from every widget mount. */
export async function resolveVaultImage(
  raw: string,
  context: VaultImageContext | null,
): Promise<VaultImageResolution> {
  const parsed = parseVaultImageRef(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (context === null) return { ok: false, reason: "no-permanent-vault" };

  let canonRoot: string;
  try {
    canonRoot = await invoke<string>("canonicalize_path", { path: context.rootPath });
  } catch {
    return { ok: false, reason: "vault-root-unavailable" };
  }

  const candidate = `${canonRoot}/${parsed.relPath}`;
  let canonTarget: string;
  try {
    canonTarget = await invoke<string>("canonicalize_path", { path: candidate });
  } catch {
    return { ok: false, reason: "missing-target" };
  }
  if (!isPathInsideRoot(canonRoot, canonTarget)) return { ok: false, reason: "outside-vault" };
  if (!(await invoke<boolean>("path_exists", { path: canonTarget }))) {
    return { ok: false, reason: "not-a-regular-file" };
  }
  if (!IMAGE_EXTENSIONS.has(extensionOf(basename(canonTarget)))) {
    return { ok: false, reason: "not-an-image" };
  }

  return { ok: true, url: convertFileSrc(canonTarget), canonTarget };
}

// ---------------------------------------------------------------------------
// Rendering — VaultImageWidget. Same pending→invoke→DOM-swap shape as
// WikilinkWidget/ImageWidget-onerror: a broken/failed resolution never hides
// the document (conceal:true replace is the same as any other image; the
// widget itself is the only thing that shows a failure), and the widget is
// its own IO boundary — features/image.ts never awaits anything.
// ---------------------------------------------------------------------------

export class VaultImageWidget extends WidgetType {
  constructor(
    readonly raw: string,
    readonly alt: string,
    readonly context: VaultImageContext | null,
  ) {
    super();
  }
  eq(o: VaultImageWidget) {
    // Identity must include the resolved root, not just `raw` — a widget
    // built for one permanent vault must never be reused (stale DOM) once the
    // live vault switches (image.ts's ImageWidget.eq/mermaid's themeVersion
    // apply the same "external state that changes the render belongs in eq"
    // rule). `context?.rootPath ?? ""` collapses "no context" to one stable
    // key rather than comparing object identity, which would always differ.
    return o.raw === this.raw && (o.context?.rootPath ?? "") === (this.context?.rootPath ?? "");
  }
  toDOM(view: EditorView) {
    const img = document.createElement("img");
    img.className = "cm-image cm-vault-image";
    img.alt = this.alt;

    // Recorded once resolution succeeds, so a click opens the SAME canonical
    // file the widget ended up showing (ImageWidget's resolvedPath/
    // viewerSourceFor precedent) — never the raw `vault:` href itself.
    let canonTarget: string | null = null;
    resolveVaultImage(this.raw, this.context).then((result) => {
      if (result.ok) {
        canonTarget = result.canonTarget;
        img.src = result.url;
      } else {
        img.classList.add("cm-vault-image-error");
        img.title = VAULT_IMAGE_REJECTION_MESSAGES[result.reason];
      }
    });

    // Click → open the image viewer, same click/drag/Alt semantics as
    // ImageWidget (dragExceededClickSlop reused, not re-derived). A failed
    // resolution has no canonTarget, so a click on a broken vault image is a
    // no-op rather than opening garbage.
    let downX = 0;
    let downY = 0;
    img.addEventListener("mousedown", (e) => {
      downX = e.clientX;
      downY = e.clientY;
    });
    img.addEventListener("click", (e) => {
      if (e.altKey) return; // Alt+click = edit source (attachAltClickEdit below)
      if (dragExceededClickSlop(downX, downY, e)) return; // drag release, not a click
      e.preventDefault();
      if (canonTarget) requestImageOpen(canonTarget);
    });
    attachAltClickEdit(img, view);

    return img;
  }
  ignoreEvent() {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Attachment orchestration — `attachImageToVault` (the `image.attach` action
// body). Exported as a pure-assembly function with every effectful
// collaborator injected ({context, view, invoke, flash}) so it is testable
// without booting main.ts (design §분기7 / plan T5-F step 1). main.ts's own
// registerHandler call is a one-line adapter over this.
//
// mock-fidelity note (plan's explicit boundary): the vitest suite exercising
// this function verifies ORCHESTRATION ONLY — call order, token plumbing,
// message selection, document preservation on every failure path. Atomicity
// (hard_link no-replace), (dev,ino) file identity, and the TempGuard
// RAII cleanup are native properties the browser mock cannot and does not
// simulate; those are cargo's temp-vault integration tests' job (design
// §분기7: "vitest 초록 + cargo 초록 = 안전", never vitest alone).
// ---------------------------------------------------------------------------

export interface AttachImageDeps {
  readonly context: VaultImageContext | null;
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

/** Attach an image into the permanent vault: invoke the native picker+import
 *  command, insert `vaultAttachmentMarkdown(fileName)` at the cursor on
 *  success, finalize on a successful insertion, or roll back the just-created
 *  file on a synchronous insertion failure. Every failure path — no vault, no
 *  document, cancelled picker, any `ATTACH_*`/`ROLLBACK_*` native error —
 *  leaves the document text and every pre-existing file untouched (design
 *  §분기4's table). Command (void; reports outcome via `flash`, never throws). */
export async function attachImageToVault(deps: AttachImageDeps): Promise<void> {
  const { context, view, invoke: call, flash } = deps;
  if (context === null) {
    flash(VAULT_ATTACHMENT_MESSAGES["no-permanent-vault"]);
    return;
  }
  if (view === null) {
    flash(VAULT_ATTACHMENT_MESSAGES["no-document"]);
    return;
  }

  let outcome: AttachmentImportOutcome;
  try {
    outcome = await call<AttachmentImportOutcome>("import_vault_attachment", { vaultRoot: context.rootPath });
  } catch (error) {
    flash(attachmentFailureMessage(rejectionMessage(error)));
    return;
  }
  if (outcome.status === "cancelled") {
    flash(VAULT_ATTACHMENT_MESSAGES.cancelled);
    return;
  }

  const { receipt } = outcome;
  const insertText = vaultAttachmentMarkdown(receipt.fileName);
  try {
    const head = view.state.selection.main.head;
    view.dispatch({ changes: { from: head, insert: insertText } });
  } catch {
    // Synchronous insertion failure (design failure #7): the native file was
    // created but never landed in the document — ask native code to remove
    // ONLY that unchanged receipt target (token-only input; see
    // vault-image.ts's AttachmentReceipt doc comment for why a path can never
    // be supplied here).
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
    // Not in design §분기4's failure table (finalize is documented idempotent
    // Ok, even for an unknown token) — a rejection here means something went
    // wrong on the native side AFTER the file was already safely inserted
    // into the document, so there is nothing left to roll back or warn the
    // user about losing. Logged, not flashed.
    console.error("finalize_attachment_import failed after a successful insertion", rejectionMessage(error));
  }
}
