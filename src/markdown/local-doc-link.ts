// Standard-Markdown-link ([label](./note.md)) safe-open validation pipeline
// (single-window-opening Todo 3). A local link is accepted only when it is a
// literal relative path to a `.md`/`.txt` file that stays inside the
// permanent vault after symlink resolution — everything else is rejected
// with a visible Korean reason. Wikilinks do NOT go through this pipeline
// (see document-open.ts's "resolved-document" branch); this module is
// standard-Markdown-link-only.
//
// Pipeline shape (design §3): a PURE prefix (steps 1-10, no IO — decides
// whether a decoration-time href even LOOKS like a candidate) feeds an async
// resolver (steps 11-17, IPC reads only — canonicalize + isolation + regular-
// file checks) that is the only path to acceptance. `isLocalDocumentLinkCandidate`
// reuses `parseLocalDocumentHref` itself so decoration-time judgment and
// click-time validation can never drift apart.
import { invoke } from "@tauri-apps/api/core";
import { dirOf, basename } from "../document/path";
import { isEditableTextFile } from "../sidebar/explorer/file-icons";

export type LocalLinkRejectionReason =
  | "query"
  | "empty-path"
  | "malformed-escape"
  | "nul"
  | "drive-path"
  | "unc-path"
  | "rooted-path"
  | "scheme"
  | "mixed-separators"
  | "non-document-extension"
  | "no-vault-context"
  | "vault-root-unavailable"
  | "document-not-in-vault"
  | "missing-target"
  | "outside-vault"
  | "not-a-regular-file";

export const LOCAL_LINK_REJECTION_MESSAGES: Record<LocalLinkRejectionReason, string> = {
  query: "쿼리 문자열이 있는 링크는 열 수 없습니다",
  "empty-path": "링크 대상이 비어 있습니다",
  "malformed-escape": "잘못된 퍼센트 인코딩입니다",
  nul: "허용되지 않는 문자가 포함된 경로입니다",
  "drive-path": "드라이브 경로는 열 수 없습니다",
  "unc-path": "네트워크(UNC) 경로는 열 수 없습니다",
  "rooted-path": "절대 경로 링크는 열 수 없습니다",
  scheme: "허용되지 않는 링크 형식입니다",
  "mixed-separators": "경로 구분자가 올바르지 않습니다",
  "non-document-extension": "문서 파일(.md/.txt)만 열 수 있습니다",
  "no-vault-context": "영구 볼트의 문서에서만 로컬 링크를 열 수 있습니다",
  "vault-root-unavailable": "볼트 루트를 확인할 수 없습니다",
  "document-not-in-vault": "현재 문서가 볼트 안에 있지 않습니다",
  "missing-target": "링크 대상 파일이 없습니다",
  "outside-vault": "볼트 밖의 파일은 열 수 없습니다",
  "not-a-regular-file": "일반 파일이 아닌 대상은 열 수 없습니다",
};

// ---------------------------------------------------------------------------
// Pure prefix (steps 1-10) — each domain rule gets its own named function so
// no rule is buried in an inline `if` (mermark-frontend §7 naming discipline).
// ---------------------------------------------------------------------------

/** Split a literal (NOT YET decoded) href into `{path, fragment}`, or `null`
 *  when a literal `?` precedes any literal `#` (a query string — rejected
 *  outright, never reaches decode). This split happens BEFORE percent-decoding
 *  on purpose: `%23`/`%3F` must NOT be treated as a fragment/query separator —
 *  only a LITERAL `#`/`?` in the raw href counts. A fragment (once split off)
 *  is discarded by the caller; only the path half is validated/decoded. */
function splitLinkSuffix(href: string): { readonly path: string; readonly fragment: string | null } | null {
  const hashIdx = href.indexOf("#");
  const queryIdx = href.indexOf("?");
  if (queryIdx !== -1 && (hashIdx === -1 || queryIdx < hashIdx)) return null;
  if (hashIdx === -1) return { path: href, fragment: null };
  return { path: href.slice(0, hashIdx), fragment: href.slice(hashIdx + 1) };
}

/** Percent-decode `path` EXACTLY once, or `null` on a malformed escape
 *  (`decodeURIComponent` throws on e.g. `%zz`). This is the pipeline's only
 *  decode call — nowhere else in this module (or its callers) may call
 *  `decodeURIComponent` again, or a double-encoded traversal (`%252e%252e`)
 *  would silently get promoted into a real `..`. Exported so any future
 *  reference-parsing module can reuse the same single-decode rule instead of
 *  re-deriving it — every caller of this export must uphold the same
 *  "decode exactly once" rule. */
export function decodeOnceStrict(path: string): string | null {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

/** Whether a decoded path carries a NUL byte (`%00` decoded) — never a valid
 *  filesystem path component. */
function containsNul(decoded: string): boolean {
  return decoded.includes("\u0000");
}

/** Whether a decoded path opens with a Windows drive letter (`C:\` / `C:/`).
 *  Checked before the scheme test so `C:` gets the more specific reason. */
function hasWindowsDrivePrefix(decoded: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(decoded);
}

/** Whether a decoded path is a UNC/protocol-relative network path (`\\host\
 *  share` or `//host/share`). Checked before the generic rooted-path test so
 *  a doubled leading `/` gets the more specific reason. */
function isUncPath(decoded: string): boolean {
  return /^(\\\\|\/\/)/.test(decoded);
}

/** Whether a decoded path is filesystem-rooted (`/abs.md`) — outside the
 *  "relative to the current document" contract this pipeline enforces. */
function isRootedPath(decoded: string): boolean {
  return /^\//.test(decoded);
}

/** Whether a decoded path opens with a URI scheme (`javascript:`, `file:`,
 *  `vault:`, …). Literal external URLs (`https://…`) never reach this
 *  pipeline — `isExternalUrl` already routes them to the external opener
 *  before decoration; this only catches schemes that were hiding behind
 *  percent-encoding or aren't in the external whitelist. */
function hasUriScheme(decoded: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.\-]*:/.test(decoded);
}

/** Whether a decoded path contains a backslash — the vault's canonical
 *  separator is `/`; a `\` (literal or decoded from `%5c`) means the link was
 *  authored for a different path convention and must not be silently
 *  reinterpreted. */
function containsBackslash(decoded: string): boolean {
  return decoded.includes("\\");
}

export type ParsedLocalDocumentHref =
  | { readonly ok: true; readonly path: string; readonly fragment: string | null }
  | { readonly ok: false; readonly reason: LocalLinkRejectionReason };

/** Pure query — steps 1-10 of the pipeline. Decides whether `href` even LOOKS
 *  like a valid local document link, without touching the filesystem. A
 *  fragment (`#sec`) is split off and returned but never consulted further —
 *  heading-jump-on-open is out of scope (D1); the target file alone is what
 *  gets validated and opened. */
export function parseLocalDocumentHref(href: string): ParsedLocalDocumentHref {
  const split = splitLinkSuffix(href);
  if (split === null) return { ok: false, reason: "query" };
  if (split.path === "") return { ok: false, reason: "empty-path" };
  const decoded = decodeOnceStrict(split.path);
  if (decoded === null) return { ok: false, reason: "malformed-escape" };
  if (containsNul(decoded)) return { ok: false, reason: "nul" };
  if (hasWindowsDrivePrefix(decoded)) return { ok: false, reason: "drive-path" };
  if (isUncPath(decoded)) return { ok: false, reason: "unc-path" };
  if (isRootedPath(decoded)) return { ok: false, reason: "rooted-path" };
  if (hasUriScheme(decoded)) return { ok: false, reason: "scheme" };
  if (containsBackslash(decoded)) return { ok: false, reason: "mixed-separators" };
  if (!isEditableTextFile(basename(decoded))) return { ok: false, reason: "non-document-extension" };
  return { ok: true, path: decoded, fragment: split.fragment };
}

/** Decoration-time candidate judgment — reuses `parseLocalDocumentHref` itself
 *  (not a re-derived regex soup) so the decorator and the click-time validator
 *  can never drift on what counts as "looks like a local document link". Pure
 *  query, zero IPC — safe to call on every render. */
export function isLocalDocumentLinkCandidate(href: string): boolean {
  return parseLocalDocumentHref(href).ok;
}

// ---------------------------------------------------------------------------
// Resolver (steps 11-17) — IPC reads only (query, CQS: no side effects beyond
// the network round-trip). The only way to reach `{ ok: true }` is through the
// full canonicalize+isolation+regular-file chain below; there is no
// early-return acceptance anywhere in this function.
// ---------------------------------------------------------------------------

export interface LocalLinkContext {
  readonly documentPath: string;
  readonly vaultRootPath: string;
}

export type LocalLinkResolution =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: LocalLinkRejectionReason };

/** Strict, boundary-character-safe "is `target` inside `root`?" — appends a
 *  trailing separator to `root` before the prefix comparison so a sibling
 *  directory that merely SHARES a string prefix (`/vault-evil` vs `/vault`)
 *  can never pass as "inside" (a naive `target.startsWith(root)` would let it
 *  through). `root` itself is never "inside" itself — the root is a
 *  directory, not an openable regular file, so callers must reject the
 *  degenerate case rather than treat it as a valid target. Pure query. */
export function isPathInsideRoot(root: string, target: string): boolean {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return target.startsWith(prefix);
}

/** Resolver — steps 11-17: context gate, vault-root canonicalize, current-
 *  document canonicalize+isolation+regular check, candidate assembly (literal
 *  join, NOT lexically collapsed — `..` is resolved by the backend's
 *  `fs::canonicalize`, never by frontend string surgery, so a `..` that
 *  crosses a symlinked directory resolves to the REAL path, not a lexical
 *  guess), target canonicalize+isolation+regular+extension. Query (IPC reads
 *  only, no side effects). */
export async function resolveLocalDocumentLink(
  href: string,
  context: LocalLinkContext | null,
): Promise<LocalLinkResolution> {
  const parsed = parseLocalDocumentHref(href);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (context === null) return { ok: false, reason: "no-vault-context" };

  let canonRoot: string;
  try {
    canonRoot = await invoke<string>("canonicalize_path", { path: context.vaultRootPath });
  } catch {
    return { ok: false, reason: "vault-root-unavailable" };
  }

  let canonDoc: string;
  try {
    canonDoc = await invoke<string>("canonicalize_path", { path: context.documentPath });
  } catch {
    return { ok: false, reason: "document-not-in-vault" };
  }
  if (!isPathInsideRoot(canonRoot, canonDoc)) return { ok: false, reason: "document-not-in-vault" };
  if (!(await invoke<boolean>("path_exists", { path: canonDoc }))) {
    return { ok: false, reason: "document-not-in-vault" };
  }

  const candidateAbs = `${dirOf(context.documentPath)}/${parsed.path}`;
  let canonTarget: string;
  try {
    canonTarget = await invoke<string>("canonicalize_path", { path: candidateAbs });
  } catch {
    return { ok: false, reason: "missing-target" };
  }
  if (!isPathInsideRoot(canonRoot, canonTarget)) return { ok: false, reason: "outside-vault" };
  if (!(await invoke<boolean>("path_exists", { path: canonTarget }))) {
    return { ok: false, reason: "not-a-regular-file" };
  }
  if (!isEditableTextFile(basename(canonTarget))) return { ok: false, reason: "non-document-extension" };

  return { ok: true, path: canonTarget };
}

/** Mark `el` with the shared local-link failure presentation (mirrors
 *  `open-external.ts`'s `markFailure` / `wikilink.ts`'s `cm-wikilink-error`
 *  pattern: a CSS class plus a hover-visible Korean title). Command, void. */
function markLocalLinkFailure(el: HTMLElement, message: string): void {
  el.classList.add("cm-local-link-error");
  el.title = message;
}

/** Validate `request.href` and either open it (through the injected `open`
 *  callback, using the CANONICAL resolved path — never the raw href) or mark
 *  `request.feedbackEl` with a visible Korean rejection reason. Command
 *  (void) — the name's promise stops at "accept and open, or reject and show
 *  feedback"; the validation logic itself lives in the pure
 *  `resolveLocalDocumentLink` query (CQS). */
export async function openStandardLocalLink(
  request: { readonly href: string; readonly feedbackEl: HTMLElement },
  context: LocalLinkContext | null,
  open: (absPath: string) => Promise<boolean>,
): Promise<void> {
  const result = await resolveLocalDocumentLink(request.href, context);
  if (!result.ok) {
    markLocalLinkFailure(request.feedbackEl, LOCAL_LINK_REJECTION_MESSAGES[result.reason]);
    return;
  }
  await open(result.path);
}
