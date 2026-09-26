// Vault-selection routing — the "which vault is a click/open against right
// now" question main.ts used to answer with a bare `routedVault` module
// cell. Extracted first (riffactor B, C1 — _workspace/01_architect_design.md
// §3.7) because DocumentSession (C2+) needs it as a port: `currentVault`/
// `routeDocumentPath` are read by every open transaction, and `setRoutedVault`
// is the one write surface every transaction's commit step uses.
//
// The body of every function here is moved VERBATIM from main.ts (same
// control flow, same names once destructured) — tests/main-wiring.test.ts's
// `vaultSelectionSource` assertion pins the exact text so this module can
// never silently drift from what main.ts used to inline.
import { routeCliFile } from "./cli-routing";
import { routingTrustsCurrentVault } from "./vault-routing";
import type { Vault, WorkspaceStore } from "./workspace-state";

export interface VaultSelectionDeps {
  readonly workspaceStore: WorkspaceStore;
  readonly initialRoutedVault: Vault | undefined;
}

export interface VaultSelection {
  currentVault(): Vault | undefined;
  selectedWorkspaceVault(): Vault | undefined;
  routeDocumentPath(path: string): Vault;
  setRoutedVault(vault: Vault | undefined): void;
}

export function createVaultSelection(deps: VaultSelectionDeps): VaultSelection {
  const { workspaceStore } = deps;
  let routedVault = deps.initialRoutedVault;

  const selectedWorkspaceVault = (): Vault | undefined => {
    const workspace = workspaceStore.get().workspaces.find((item) => item.workspaceId === workspaceStore.get().currentWorkspaceId);
    return workspace?.currentVaultId ? workspaceStore.getVault(workspace.currentVaultId) : undefined;
  };
  const currentVault = () => {
    return routedVault ?? selectedWorkspaceVault();
  };
  const routeDocumentPath = (path: string) => {
    const current = routedVault;
    if (current && routingTrustsCurrentVault(current.persistenceKind)) return current;
    const route = routeCliFile(workspaceStore, path);
    routedVault = route.vault;
    return route.vault;
  };
  const setRoutedVault = (vault: Vault | undefined): void => {
    routedVault = vault;
  };

  return { currentVault, selectedWorkspaceVault, routeDocumentPath, setRoutedVault };
}
