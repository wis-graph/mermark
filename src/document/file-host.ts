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
import type { Vault } from "../workspace/workspace-state";
import type { DirEntry, ScanResult, LinkTarget } from "./types";

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

/** The app-wide singleton every call site outside tests uses. `remoteFor`
 *  returns `localFileHost` for now — a remote vault cannot be reached yet
 *  (RemoteVault has no host connection code), so this is an unreachable stub,
 *  not a real remote backend. A later task swaps this one line for a real
 *  `remoteFileHost`; every call site already routes through `fileHostFor` and
 *  needs no further change. */
const fileHost = makeFileHost({ local: localFileHost, remoteFor: () => localFileHost });

/** The backend `vault`'s reads should go through. Thin named wrapper over the
 *  singleton so call sites read `fileHostFor(vault).readFile(...)` instead of
 *  reaching into `fileHost` directly. */
export const fileHostFor = (vault: Vault): FileHostBackend => fileHost.forVault(vault);
