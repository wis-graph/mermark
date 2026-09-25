// Pure vault-routing rules moved out of main.ts (2026-09-25, pure move). Every
// function here is a query over its arguments — no boot() state.

import { isResolvedAbsolutePath } from "../document/path";
import { isRemoteVault } from "../document/document-vault";
import { REMOTE_VAULT_LOCAL_LINK_MESSAGE } from "../markdown/local-doc-link";
import type { PersistenceKind, Vault, WorkspaceState } from "./workspace-state";
import type { TabPersistenceScope } from "./vault-tabs";

export function shouldPreserveGlobalExplorerRoot(vault: Pick<Vault, "persistenceKind"> | undefined): boolean {
  return vault?.persistenceKind === "global";
}

/** Unreachable-branch guard for `Vault.persistenceKind` switches — two below
 *  in this file, three more in `main.ts` (`explorerRootForVault` and its
 *  siblings). Widening `Vault` (RemoteVault's addition) only made `tsc` flag
 *  ONE hand-rolled ternary, `explorerRootForVault` — every other kind check
 *  was `=== "permanent"` / `=== "global"`, so a vault kind neither of those
 *  silently fell into an `else` written for local vaults. Routing every kind
 *  check through a `switch (...) { default: return assertNever(x) }` makes
 *  the NEXT new vault kind fail `tsc` at every one of these sites, not just
 *  one (task-2b brief). */
export function assertNever(x: never): never {
  throw new Error(`처리되지 않은 볼트 종류: ${JSON.stringify(x)}`);
}

/** Whether the Explorer must refuse to navigate above a vault's own root.
 *  Permanent vaults are locked to their registered filesystem folder; remote
 *  vaults are locked too, for a different reason — the host only serves paths
 *  inside the shared vault root, so there is no "above" to browse to even in
 *  principle. The Global Vault is the only unlocked kind (it deliberately
 *  roams the whole filesystem from HOME). `undefined` (no vault selected yet)
 *  defaults to unlocked, matching the pre-existing `currentVault()?.persistenceKind
 *  === "permanent"` check this replaces. */
export function isVaultRootLocked(vault: Pick<Vault, "persistenceKind"> | undefined): boolean {
  if (!vault) return false;
  const kind = vault.persistenceKind;
  switch (kind) {
    case "permanent": return true;
    case "global": return false;
    case "remote": return true;
    default: return assertNever(kind);
  }
}

/** Which persistence tier a vault's open-tab list belongs to. Permanent
 *  vaults restore tabs from localStorage across app restarts; every other
 *  kind is session-only. Remote vaults are deliberately session-scoped, not
 *  promoted to "permanent" alongside local vaults: persisting a tab list
 *  across restarts risks reopening a document the host no longer shares (the
 *  Mac mini offline, or the shared vault renamed/withdrawn on its side)
 *  before the host connection is even re-established — re-deriving remote
 *  tabs fresh each session is the safe default until v1's read-only scope
 *  grows a sync story. This was already the ACCIDENTAL behavior of every
 *  `=== "permanent" ? "permanent" : "session"` ternary this replaces (remote
 *  fell into the `else`); this function just makes that choice explicit and
 *  exhaustive so it survives the next vault kind. */
export function tabScopeForVault(vault: Pick<Vault, "persistenceKind">): TabPersistenceScope {
  const kind = vault.persistenceKind;
  switch (kind) {
    case "permanent": return "permanent";
    case "global": return "session";
    case "remote": return "session";
    default: return assertNever(kind);
  }
}

/** task-8a (Ruling 9): whether `routeDocumentPath` should TRUST the
 *  already-routed vault instead of re-deriving one from the document's path
 *  via `routeCliFile`. `routeCliFile` can only ever resolve "permanent" (by
 *  matching a REGISTERED PERMANENT ROOT — an absolute local path) or
 *  "global" — a remote document's path is vault-relative (`"노트.md"`, no
 *  root prefix at all) and can never match, so re-deriving would silently
 *  reclassify an already-known remote document as the Global Vault. "global"
 *  needed the same trust already (its own path re-derivation was always a
 *  no-op at best, at worst a spurious match against an unrelated registered
 *  permanent root on the same filesystem) — this just makes remote share
 *  that exact rule instead of falling through routeCliFile like "permanent"
 *  correctly still does (a real absolute path that might belong to a
 *  DIFFERENT permanent vault than the one currently routed). Pure query. */
export function routingTrustsCurrentVault(kind: PersistenceKind | undefined): boolean {
  return kind === "global" || kind === "remote";
}

/** task-8a (Ruling 9): which vault a read should route through when a caller
 *  may already know the TARGET explicitly — `openDocument`'s `targetVault`
 *  (onSelectVault/onSelectTab already know which vault they're switching
 *  TO), or `navigateHistory`'s history-entry vault (resolved fresh by id,
 *  never a captured `Vault` object). `explicit` always wins over `fallback`
 *  (typically `currentVault()` — the vault of whatever is open RIGHT NOW,
 *  i.e. the navigation's SOURCE, not its target), which itself falls back to
 *  `global`. Pure query — the entire fix for "a vault-crossing open reads
 *  through the wrong backend" collapses to this one three-way `??`, so it is
 *  tested directly instead of only through main.ts's wiring. */
export function resolveTargetVault(explicit: Vault | undefined, fallback: Vault | undefined, global: Vault): Vault {
  return explicit ?? fallback ?? global;
}

/** task-8a (Ruling 10/item 4): the Korean rejection message a standard
 *  `[text](sibling.md)` link click should show for `vault` BEFORE
 *  `resolveLocalDocumentLink` (local-doc-link.ts) ever runs, or `null` when
 *  the ordinary validation pipeline should decide instead. Every step of
 *  that pipeline past its pure prefix is `canonicalize_path` — a
 *  LOCAL-filesystem-only command with no remote equivalent and no
 *  `vaultRootPath` for a remote vault to canonicalize against — see
 *  local-doc-link.ts's header comment on `REMOTE_VAULT_LOCAL_LINK_MESSAGE`
 *  for the full item-4 reasoning. Pure query. */
export function standardLinkRejectionFor(vault: Vault | undefined): string | null {
  return isRemoteVault(vault) ? REMOTE_VAULT_LOCAL_LINK_MESSAGE : null;
}

/** The user's home directory, resolved through the EXISTING `canonicalize_path`
 *  IPC command (already used by CLI routing in `./cli-routing.ts`) fed the
 *  literal `~` — the backend's `expand_home` (src-tauri/src/fs/paths.rs)
 *  already special-cases a bare `~` as `$HOME`/`%USERPROFILE%`, so this needs
 *  no new backend surface. Falls back to `fallback` (the historic default
 *  root) when canonicalization fails outright (e.g. a headless test/CI
 *  environment) — the same defensive posture `routeCliFileResolved`'s
 *  (`./cli-routing.ts`) own canonicalize wrapper uses —
 *  AND when it "succeeds" with a value that isn't actually a usable root
 *  (`isResolvedAbsolutePath`). That second guard matters because the backend's
 *  home lookup can itself fail (an environment with no resolvable home
 *  directory): `expand_home`'s documented contract on that failure is to
 *  return the input LITERALLY, so `canonicalize_path("~")` can come back as
 *  the bare relative string `"~"` (or wherever a relative `~` canonicalizes
 *  against the process's cwd) instead of raising an error. Using that as the
 *  explorer's root pointed it at an arbitrary, usually-nonexistent location —
 *  this guard keeps a home-resolution failure from ever promoting a
 *  non-absolute value to "the root". Named + exported so "how do we get home"
 *  lives in one place and is independently testable, instead of being
 *  inlined at the one call site that needs it (00_request.md #2). */
export async function resolveHomeRoot(canonicalize: (path: string) => Promise<string>, fallback: string): Promise<string> {
  try {
    const resolved = await canonicalize("~");
    return resolved && isResolvedAbsolutePath(resolved) ? resolved : fallback;
  } catch (error) {
    if (error instanceof Error || typeof error === "string") return fallback;
    throw error;
  }
}

/** Every registered PERMANENT vault's canonical root path — the exact input
 *  `owningVaultRoot` (image-search-root.ts) needs. Named so "which vaults
 *  count" (permanent only; the global vault has no `rootPath` to search)
 *  lives in one place instead of being re-derived as an inline filter at
 *  each call site. Pure query. */
export function permanentRootsOf(state: WorkspaceState): readonly string[] {
  return state.vaults.filter((vault) => vault.persistenceKind === "permanent").map((vault) => vault.rootPath);
}
