// The single chokepoint every read of vault content goes through. Before
// this module existed, `invoke<>("read_file"/"list_dir"/...)` was called
// directly from ~12 sites across main.ts/editor.ts/markdown/*.ts — fine while
// every vault was a local folder, but a dead end for the remote-vault feature
// (a MacBook's mermark reading a Mac mini's shared vault over the network):
// there was no single seam to redirect a remote vault's reads elsewhere.
//
// `FileHostBackend` names the exact six read-only commands a vault needs
// (`write_file` is deliberately absent — v1 remote vaults are read-only).
// `localFileHost` is today's ONLY backend, wired straight to `invoke`.
// `makeFileHost`/`fileHostFor` route a `Vault` to a backend by
// `persistenceKind`; `remoteFor` is unreachable today (no remote vault can
// exist yet) but gives a later task the one seam to plug a real remote
// backend into, with every call site already migrated off direct `invoke`.
import { invoke } from "@tauri-apps/api/core";
import type { Vault, RemoteVault } from "../workspace/workspace-state";
import type { DirEntry, ScanResult, LinkTarget } from "./types";
import { isRemoteVault } from "./document-vault";

export interface FileHostBackend {
  readFile(path: string): Promise<{ text: string; mtime: number }>;
  listDir(path: string, showHidden: boolean): Promise<DirEntry[]>;
  listFilesRecursive(root: string, showHidden: boolean): Promise<ScanResult>;
  resolveImage(baseDir: string, name: string, maxDepth: number): Promise<string | null>;
  listLinkTargets(dir: string): Promise<LinkTarget[]>;
  pathExists(path: string): Promise<boolean>;
  directoryExists(path: string): Promise<boolean>;
}

/** The only backend today: every method is a direct `invoke` of the existing
 *  Tauri command, unchanged from what each call site used to do inline. */
export const localFileHost: FileHostBackend = {
  readFile: (path) => invoke("read_file", { path }),
  listDir: (path, showHidden) => invoke("list_dir", { path, showHidden }),
  listFilesRecursive: (root, showHidden) => invoke("list_files_recursive", { root, showHidden }),
  resolveImage: (baseDir, name, maxDepth) => invoke("resolve_image", { baseDir, name, maxDepth }),
  listLinkTargets: (dir) => invoke("list_link_targets", { dir }),
  pathExists: (path) => invoke("path_exists", { path }),
  directoryExists: (path) => invoke("directory_exists", { path }),
};

/** The four connection states a remote read can end in, surfaced all the way
 *  to the UI so a stalled remote vault says WHICH thing is wrong instead of
 *  a single generic "failed" (this project forbids collapsing distinct
 *  failures into one - the user needs to know whether to re-pair, turn
 *  sharing back on, or check the network). */
export type RemoteConnectionState = "connected" | "unreachable" | "auth-expired" | "sharing-off";

/** Reads the `REMOTE:*` tag `remote_client.rs` embeds in its `Err` strings
 *  (`token_for_or_expired`/`classify`) and maps it to one of the four states.
 *  Anything unrecognized - a network error, a Rust panic message, a mock
 *  throwing something else entirely - falls to "unreachable" rather than
 *  throwing here, since this function's whole job is to always resolve to
 *  one of the four UI states, never propagate a fifth shape. */
export const classifyRemoteError = (e: unknown): RemoteConnectionState => {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("REMOTE:AuthExpired")) return "auth-expired";
  if (msg.includes("REMOTE:SharingOff")) return "sharing-off";
  return "unreachable";
};

/** Probes a paired remote vault's reachability for the sidebar's connection
 *  badge (Task 10). Reuses `remote_list_dir` on the vault's own root rather
 *  than adding a dedicated ping command — a directory listing already proves
 *  every layer the badge cares about (host reachable, token still valid,
 *  sharing still on), and `classifyRemoteError` already turns its failure
 *  shape into exactly the 4 states the badge renders. `call` defaults to the
 *  real `invoke`, swappable for a spy in tests — same pattern as
 *  `remoteFileHost`. */
export const remoteConnectionStateFor = async (
  vault: RemoteVault,
  call: typeof invoke = invoke,
): Promise<RemoteConnectionState> => {
  try {
    await call("remote_list_dir", { host: vault.host, vault: vault.remoteVaultId, path: vault.explorerRoot, showHidden: false });
    return "connected";
  } catch (e) {
    return classifyRemoteError(e);
  }
};

const remoteParentAndName = (path: string): { parent: string; name: string } => {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? { parent: "", name: path } : { parent: path.slice(0, slash), name: path.slice(slash + 1) };
};

/** How long a `remote_list_dir` listing is trusted before a repeat call
 *  re-fetches. Short and deliberately not "forever": v1 remote vaults are
 *  read-only from this client's POV but the host can still change underfoot
 *  (another device edits it), so this is purely a burst-dedup window, not a
 *  correctness cache. */
const REMOTE_LISTING_TTL_MS = 8000;

/** The real remote backend (Task 6's `remote_*` commands, Task 2's
 *  `RemoteVault`). The device token never reaches here (Ruling 4): the
 *  frontend sends only `host`+`vault`, and Rust looks the token up from its
 *  own managed state keyed by host, so no invoke below ever carries a
 *  `token` field. `call` defaults to the real `invoke` and is swappable for
 *  a spy in tests. */
export const remoteFileHost = (
  vault: RemoteVault,
  call: typeof invoke = invoke,
): FileHostBackend => {
  const base = { host: vault.host, vault: vault.remoteVaultId };
  // `pathExists` runs once per rendered `[[wikilink]]` (wikilink.ts's
  // `toDOM`), and `inlinePreview`'s ViewPlugin rebuilds on every
  // `selectionSet`/`viewportChanged` (core.ts) - so a document with N
  // wikilinks in one folder would otherwise fire N *repeated* identical
  // `remote_list_dir` round-trips for the same parent, and re-pay that cost
  // again on every cursor move or scroll. `listingCache` collapses
  // concurrent/rapid-repeat listings of the same `(path, showHidden)` to one
  // in-flight (or recently-settled) request; it lives on this closure, so it
  // only pays off across calls if the SAME `remoteFileHost` instance is
  // reused — see `remoteHostFor`'s per-vaultId memoization below.
  const listingCache = new Map<string, { expires: number; promise: Promise<DirEntry[]> }>();
  const listDir = (path: string, showHidden: boolean): Promise<DirEntry[]> => {
    const key = `${path} ${showHidden}`;
    const hit = listingCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.promise;
    const promise: Promise<DirEntry[]> = call("remote_list_dir", { ...base, path, showHidden });
    listingCache.set(key, { expires: Date.now() + REMOTE_LISTING_TTL_MS, promise });
    // A failed listing shouldn't poison the cache for the full TTL - evict
    // it immediately so the next call retries instead of replaying the
    // same error to every waiter.
    promise.catch(() => listingCache.delete(key));
    return promise;
  };
  return {
    readFile: (path) => call("remote_read_file", { ...base, path }),
    listDir,
    listFilesRecursive: (root, showHidden) => call("remote_list_files_recursive", { ...base, path: root, showHidden }),
    resolveImage: (baseDir, name, maxDepth) => call("remote_resolve_image", { ...base, path: baseDir, name, maxDepth }),
    listLinkTargets: (dir) => call("remote_list_link_targets", { ...base, path: dir }),
    // remote_client.rs exposes no `path_exists`/`directory_exists` command
    // (this task makes no Rust changes, so none can be added here either),
    // and stubbing this to unconditional `true` - as an earlier draft of
    // this task assumed, on the theory that "the server 404s anyway" - is
    // wrong: nothing downstream ever sees that 404, because nothing here
    // makes the request that would produce it. `pathExists` is read by
    // wikilink.ts to decide whether a `[[link]]` renders as resolved or
    // missing; `true` unconditionally would render every remote wikilink as
    // existing, including genuinely missing ones - silently defeating the
    // one thing that check exists for. So both are derived from
    // `remote_list_dir`, which the host already 404s for a path that
    // doesn't exist (remote_host.rs's `list_dir_handler`): `pathExists`
    // lists the parent and looks for a same-named entry, `directoryExists`
    // lists the path itself and treats success as existence. Either an
    // error simply means "does not exist" for this purpose - propagating
    // the specific remote-failure reason here would misreport a genuinely
    // offline host as a missing file, which is a worse UI lie than treating
    // it as absent.
    pathExists: async (path) => {
      const { parent, name } = remoteParentAndName(path);
      try {
        const entries = await listDir(parent, true);
        return entries.some((e) => e.name === name);
      } catch {
        return false;
      }
    },
    directoryExists: async (path) => {
      try {
        await listDir(path, true);
        return true;
      } catch {
        return false;
      }
    },
  };
};

/** Builds the `forVault` router from an explicit `local`/`remoteFor` pair —
 *  kept as a factory (rather than baking `localFileHost` in directly) so
 *  tests can swap both backends for spies without touching `invoke`. Routes
 *  through an exhaustive switch on the extracted `persistenceKind`
 *  discriminant, matching the `assertNever` pattern main.ts already uses for
 *  `Vault`-kind branching (`isVaultRootLocked`/`tabScopeForVault`) — so the
 *  NEXT vault kind fails `tsc` here too, instead of silently falling through
 *  to local. */
export const makeFileHost = (deps: {
  local: FileHostBackend;
  remoteFor: (vault: Vault) => FileHostBackend;
}) => ({
  forVault: (vault: Vault): FileHostBackend => {
    const kind = vault.persistenceKind;
    switch (kind) {
      case "permanent": return deps.local;
      case "global": return deps.local;
      case "remote": return deps.remoteFor(vault);
      default: return assertNeverPersistenceKind(kind);
    }
  },
});

function assertNeverPersistenceKind(kind: never): never {
  throw new Error(`처리되지 않은 볼트 종류: ${JSON.stringify(kind)}`);
}

/** One `remoteFileHost` instance per `vaultId`, reused across every
 *  `fileHostFor()` call for that vault. Required for `remoteFileHost`'s
 *  `listingCache` (above) to ever pay off: `makeFileHost`'s `remoteFor` is
 *  invoked fresh on every single `forVault()` call (once per read, in
 *  practice — see `fileHostFor` below), so without this memo a brand new
 *  instance, with a brand new empty cache, would be built on every read and
 *  thrown away immediately after — the cache would never survive between
 *  two `pathExists` calls for sibling wikilinks, defeating the point. */
const remoteHostCache = new Map<string, FileHostBackend>();
const remoteHostFor = (vault: RemoteVault): FileHostBackend => {
  const cached = remoteHostCache.get(vault.vaultId);
  if (cached) return cached;
  const created = remoteFileHost(vault);
  remoteHostCache.set(vault.vaultId, created);
  return created;
};

/** The app-wide singleton every call site outside tests uses. `remoteFor` is
 *  now the real `remoteFileHost` (this task's change), routed through
 *  `remoteHostFor` so the same instance — and its listing cache — is reused
 *  for a given vault. Every call site already routed through `fileHostFor`
 *  via Task 1's chokepoint, so no further call-site change was needed to
 *  make remote vaults real. `isRemoteVault` narrows the switch's
 *  already-remote `vault` to `RemoteVault` without a cast; it can't actually
 *  fail (the `"remote"` case in `makeFileHost`'s switch guarantees it), so
 *  the fallback only exists to keep this a total function instead of
 *  asserting. */
const fileHost = makeFileHost({
  local: localFileHost,
  remoteFor: (vault) => (isRemoteVault(vault) ? remoteHostFor(vault) : localFileHost),
});

/** The backend `vault`'s reads should go through. Thin named wrapper over the
 *  singleton so call sites read `fileHostFor(vault).readFile(...)` instead of
 *  reaching into `fileHost` directly. */
export const fileHostFor = (vault: Vault): FileHostBackend => fileHost.forVault(vault);
