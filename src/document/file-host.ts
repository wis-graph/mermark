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

/** Memoized per-host "the SSH tunnel for this `ssh://` vault is up" promise
 *  — same shape as `remoteFileHost`'s `listingCache` below and
 *  workspace-sidebar.ts's `badgeProbes`. Fix round 2, Important A: nothing
 *  reconnected an `ssh://` vault's tunnel after an app restart —
 *  `remote-vault-dialog.ts` only calls `remote_ssh_connect` once, during
 *  the pairing flow itself — so a registered `ssh://` vault silently died
 *  the moment the pairing session ended. Every remote command for such a
 *  vault now goes through here first.
 *
 *  Chose **lazy, on first request** over a boot-time reconnect sweep: this
 *  module is already the single chokepoint every remote read passes
 *  through (module doc above), reconnecting here needs no separate startup
 *  scan of `WorkspaceState` for `ssh://` vaults (some of which the user may
 *  never even open this session), and `remote_ssh_connect` is already
 *  idempotent/cheap to call repeatedly (its own `AlreadyConnected` fast
 *  path) — the memo below just avoids paying even that idempotent round
 *  trip on every single read. A non-`ssh://` host resolves immediately
 *  without ever touching `call`, so this is a no-op for the common
 *  Tailscale case. A failure is evicted immediately (same "don't poison the
 *  cache with an error" rule `listingCache` uses) so the very next read —
 *  not just the next app launch — gets to retry; the failure itself
 *  propagates as this read's own rejection, which `classifyRemoteError`
 *  already resolves to one of the four states (an SSH-prefixed error like
 *  `SSH_PORT_BUSY:`/`REMOTE:Unreachable` doesn't match `auth-expired`/
 *  `sharing-off`, so it falls to `unreachable` — actionable, not silent). */
const sshTunnelReady = new Map<string, Promise<void>>();
export const ensureSshTunnel = (host: string, call: typeof invoke): Promise<void> => {
  if (!host.startsWith("ssh://")) return Promise.resolve();
  const hit = sshTunnelReady.get(host);
  if (hit) return hit;
  const promise = call("remote_ssh_connect", { host }).then(() => undefined);
  sshTunnelReady.set(host, promise);
  promise.catch(() => sshTunnelReady.delete(host));
  return promise;
};

/** Drops `host`'s memoized "tunnel ready" promise, if any — the seam
 *  `evictOnTunnelMismatch` (below) uses once a request discovers the memo
 *  was lying, and exported so `workspace-sidebar.ts`'s `remote_ssh_disconnect`
 *  call site (an explicit user-initiated disconnect, not a request failure)
 *  can evict the same memo instead of leaving a resolved "ready" promise
 *  pointing at a tunnel that command just tore down. Fix round 3, Important
 *  4's other half: this module already re-established a *dead* tunnel
 *  (`ensureSshTunnel`'s own `.catch` above) but never noticed a tunnel that
 *  died silently and was later reused for a *different* host — the eviction
 *  path this function feeds. */
export const evictSshTunnelMemo = (host: string): void => {
  sshTunnelReady.delete(host);
};

/** Whether a `remote_*` call's rejection is the Rust-side
 *  `ensure_tunnel_serves` guard's `SSH_TUNNEL_MISMATCH:` (see
 *  `remote_client.rs`): the memoized tunnel this client thought was ready no
 *  longer actually serves `host` — reboot/reconnect race, another host's
 *  tunnel now occupies the shared local port. Deliberately not folded into
 *  `classifyRemoteError`'s four states: those are reachability/auth outcomes
 *  a vault can't fix by itself; this one specifically means the cached
 *  promise below is stale and must be dropped so the *next* read
 *  re-establishes the tunnel, rather than replaying the same mismatch
 *  forever. */
const isTunnelMismatch = (e: unknown): boolean =>
  (e instanceof Error ? e.message : String(e)).includes("SSH_TUNNEL_MISMATCH");

/** Runs `makeCall` — skipping straight through to it, with NO extra
 *  microtask hop, for a non-`ssh://` host. `await`ing even an
 *  already-resolved `Promise.resolve()` (what `ensureSshTunnel` returns for
 *  every non-`ssh://` vault — the overwhelming majority, still) always
 *  defers by one microtask per the language spec; several existing tests
 *  (`workspace-sidebar.test.ts`'s badge-probe dedup, `file-host.test.ts`'s
 *  sibling-wikilink listing dedup) assert the underlying `remote_*` call
 *  happened synchronously-ish, within the same tick a render/click
 *  triggered it — so this only pays that one-tick cost on the `ssh://` path
 *  that actually needs it.
 *
 *  Fix round 3, Important 4: `makeCall`'s own failure — not just
 *  `ensureSshTunnel`'s — is now watched for `SSH_TUNNEL_MISMATCH`
 *  (`isTunnelMismatch`), evicting the memo before rethrowing. Without this,
 *  a tunnel that died *after* `ensureSshTunnel` last resolved successfully
 *  (laptop sleep/wake, the remote host rebooting) stayed cached as "ready"
 *  forever — this function's own doc comment already promised reconnection
 *  after a restart, but nothing evicted the memo once a *live* session's
 *  tunnel went stale mid-session, so every read for that vault kept sending
 *  requests through a tunnel Rust itself would now refuse. */
const afterTunnel = <T>(host: string, call: typeof invoke, makeCall: () => Promise<T>): Promise<T> =>
  host.startsWith("ssh://")
    ? ensureSshTunnel(host, call).then(makeCall).catch((e: unknown) => {
        if (isTunnelMismatch(e)) evictSshTunnelMemo(host);
        throw e;
      })
    : makeCall();

/** Probes a paired remote vault's reachability for the sidebar's connection
 *  badge (Task 10). Reuses `remote_list_dir` on the vault's own root rather
 *  than adding a dedicated ping command — a directory listing already proves
 *  every layer the badge cares about (host reachable, token still valid,
 *  sharing still on), and `classifyRemoteError` already turns its failure
 *  shape into exactly the 4 states the badge renders. `call` defaults to the
 *  real `invoke`, swappable for a spy in tests — same pattern as
 *  `remoteFileHost`. `ensureSshTunnel` first so an `ssh://` vault's badge
 *  reconnects the tunnel itself rather than reporting "unreachable" forever
 *  after a restart with no way to recover short of re-pairing. */
export const remoteConnectionStateFor = async (
  vault: RemoteVault,
  call: typeof invoke = invoke,
): Promise<RemoteConnectionState> => {
  try {
    await afterTunnel(vault.host, call, () =>
      call("remote_list_dir", { host: vault.host, vault: vault.remoteVaultId, path: vault.explorerRoot, showHidden: false }),
    );
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
    const promise: Promise<DirEntry[]> = afterTunnel(vault.host, call, () =>
      call("remote_list_dir", { ...base, path, showHidden }),
    );
    listingCache.set(key, { expires: Date.now() + REMOTE_LISTING_TTL_MS, promise });
    // A failed listing shouldn't poison the cache for the full TTL - evict
    // it immediately so the next call retries instead of replaying the
    // same error to every waiter.
    promise.catch(() => listingCache.delete(key));
    return promise;
  };
  // Every method below goes through `afterTunnel` first (fix round 2,
  // Important A) — for a non-`ssh://` vault this is a direct passthrough
  // with no extra round trip or microtask (see `afterTunnel`'s doc
  // comment), so it costs nothing for the common Tailscale case; for an
  // `ssh://` vault it's what makes a read work at all after an app
  // restart, not just during the pairing session.
  return {
    readFile: (path) => afterTunnel(vault.host, call, () => call("remote_read_file", { ...base, path })),
    listDir,
    listFilesRecursive: (root, showHidden) =>
      afterTunnel(vault.host, call, () => call("remote_list_files_recursive", { ...base, path: root, showHidden })),
    resolveImage: (baseDir, name, maxDepth) =>
      afterTunnel(vault.host, call, () => call("remote_resolve_image", { ...base, path: baseDir, name, maxDepth })),
    listLinkTargets: (dir) => afterTunnel(vault.host, call, () => call("remote_list_link_targets", { ...base, path: dir })),
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

/** Test-only escape hatch, mirrors `image.ts`'s `clearRemoteImageCache`.
 *  Minor (final review): this module's module-level singletons
 *  (`sshTunnelReady`, `remoteHostCache`) have no reset seam, so a test suite
 *  that wants isolation between cases has had to dodge cross-test pollution
 *  by giving every test a UNIQUE `vaultId`/`host` instead — workable, but
 *  fragile (a copy-pasted fixture that forgets to change its host silently
 *  shares state with an unrelated test). Clears both caches so a `beforeEach`
 *  can opt into real isolation instead. */
export function __resetRemoteCachesForTests(): void {
  sshTunnelReady.clear();
  remoteHostCache.clear();
}
