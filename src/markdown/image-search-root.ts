// Vault-root image search — the fix for the SSOT bug the `vault:` scheme
// re-introduced (_workspace/00_request_vaultimage_fix.md 결함1): a document's
// `![[name]]` search scope must be a pure function of the DOCUMENT'S OWN
// location, never of which vault happens to be "active" in the UI. This
// module is the single place that rule lives.
import { normalizePath } from "../document/path";
import { isPathInsideRoot } from "./local-doc-link";

/** Depth to which the backend's `resolve_image` walks a vault root looking
 *  for a basename match (`scan_match`, src-tauri/src/commands.rs). Mirrors
 *  the backend's `MAX_IMAGE_SCAN_DEPTH` constant — the two MUST agree, or a
 *  file the frontend expects to be reachable silently isn't. Kept here (not
 *  inlined at the call site) so there is exactly one place to bump both
 *  sides in lockstep. */
export const VAULT_IMAGE_SCAN_DEPTH = 12;

/** Whether `root` owns `dir` — equal paths count as owning (a document
 *  sitting directly at the vault root is still "inside" it), otherwise
 *  delegates to `isPathInsideRoot`'s boundary-safe prefix check (so a
 *  same-string-prefix sibling like `/proj2` for root `/proj` never matches).
 *  Pure query. */
function rootOwns(root: string, dir: string): boolean {
  return root === dir || isPathInsideRoot(root, dir);
}

/** The vault root that OWNS `documentDir` — the deepest (most specific)
 *  registered permanent-vault root that contains the document, or `null` if
 *  none does (global vault, or a document outside every registered vault).
 *  Deliberately takes no "active vault" input: resolution depends only on
 *  where the document itself lives, so switching the active vault in the
 *  sidebar can never change what a document's `![[name]]` resolves against
 *  (the exact bug `_workspace/00_request_vaultimage_fix.md` reverts — the old
 *  `setVaultImageContext(() => currentVault()...)` wiring read app state
 *  instead of the document's location). Deepest-root-wins because a nested
 *  vault registration (`/proj/sub` inside `/proj`) is a deliberate "this
 *  subtree is its own vault" declaration — its documents search their own
 *  root first, not the outer one. Pure query (CQS). */
export function owningVaultRoot(documentDir: string, vaultRoots: readonly string[]): string | null {
  const dir = normalizePath(documentDir);
  let best: string | null = null;
  for (const raw of vaultRoots) {
    const root = normalizePath(raw);
    if (!rootOwns(root, dir)) continue;
    if (best === null || root.length > best.length) best = root;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Plain-module slot (image-open.ts/document-open.ts pattern): lets ImageWidget
// (markdown layer) ask "what vault root should `![[name]]` search under for
// THIS render?" without importing the workspace/chrome layer. main.ts wires
// the real provider once at startup, computing it from `owningVaultRoot` +
// the current document's path — never from "the active vault".
// ---------------------------------------------------------------------------

let searchRootProvider: (() => string | null) | null = null;

/** Wire the real "what vault root owns the current document?" provider —
 *  called once by main.ts at startup. Command (void). */
export function setImageSearchRoot(fn: () => string | null): void {
  searchRootProvider = fn;
}

/** The current owning vault root, or `null` before any provider is wired
 *  (e.g. a test that never calls `setImageSearchRoot`) or when the wired
 *  provider itself reports no owning vault (global vault, or a document
 *  outside every registered vault — folder-scope fallback applies instead).
 *  Pure from this function's own point of view — delegates entirely to
 *  whatever provider is wired. */
export function imageSearchRoot(): string | null {
  return searchRootProvider?.() ?? null;
}
