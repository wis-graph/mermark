// The vault a MOUNTED document belongs to, threaded as a CodeMirror facet —
// deliberately NOT read from app state (`currentVault()`/`workspaceStore`).
// image-search-root.ts's rule (a document's own resolution scope must be a
// pure function of the document itself, never of "the active vault" the
// sidebar happens to have selected) forbids wiring app state into
// markdown/-layer leaf modules; that prohibition exists because of a real
// past bug (`_workspace/00_request_vaultimage_fix.md`'s 결함1 — switching the
// sidebar's vault used to silently change what an ALREADY-OPEN document's
// `![[name]]` resolved against). A facet gives those leaf modules the one
// thing they're allowed to know — THIS document's own vault — without an
// import of workspace/chrome state.
//
// main.ts's openInWindow computes the tab's vault for its own bookkeeping
// already (routeDocumentPath / the explicit vault passed by tab-select
// handlers) and injects it here at mount time; widgets and inline-feature
// contexts read it back via `view.state.facet(documentVault)` /
// `ctx.state.facet(documentVault)` — `view.state` itself is NEVER optional:
// every real `EditorView` has one. Widgets must read it directly (no `?.`
// guard on `.state`) so a caller that somehow mounts a document with no
// vault context fails loudly (see openInWindow's own runtime assertion)
// instead of silently falling back to "local" and reading this machine's
// disk for a document that might not even be local.
//
// The facet's VALUE, unlike `.state` itself, legitimately can be `undefined`
// — that's the combine's own "no provider registered" case (a widget
// exercised directly against a bare `EditorState.create({})`, as every
// leaf-module test does) — and `isRemoteVault` treats that the same as any
// non-remote vault: "local, unknown vault" behavior, unchanged from before
// this facet existed.
import { Facet } from "@codemirror/state";
import type { RemoteVault, Vault } from "../workspace/workspace-state";

export const documentVault = Facet.define<Vault | undefined, Vault | undefined>({
  combine: (values) => (values.length ? values[0] : undefined),
});

/** Whether `vault` is a remote (v1: read-only) vault — a real discriminant
 *  narrowing type guard, not a boolean, so a caller that checks this can use
 *  `vault.host`/`vault.remoteVaultId` afterward without a cast. The single
 *  place this question is decided, so every read-only guard in the markdown
 *  layer (wikilink auto-create, image loading, standard-link resolution, …)
 *  asks the same thing instead of re-deriving `persistenceKind === "remote"`
 *  ad hoc and risking one of them drifting. Pure query. */
export function isRemoteVault(vault: Vault | undefined): vault is RemoteVault {
  return vault?.persistenceKind === "remote";
}

/** The Korean notice every remote-vault read-only guard shows — one string,
 *  reused verbatim, so a user hitting the wall on a wikilink click and on a
 *  standard-link click sees consistent wording instead of two ad hoc
 *  phrasings of the same fact. */
export const REMOTE_VAULT_READONLY_MESSAGE = "원격 볼트는 읽기 전용입니다";
