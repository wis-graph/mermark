import { canonicalRootPath } from "./workspace-state";

export type TabPersistenceScope = "permanent" | "session";
export type VaultTab = { readonly tabId: string; readonly path: string };
export type VaultTabs = { readonly vaultId: string; readonly tabs: readonly VaultTab[]; readonly activeTabId: string | null };
export type VaultViewSelection = { readonly kind: "document"; readonly tab: VaultTab } | { readonly kind: "welcome" };

export const selectVaultView = (tabs: VaultTabs): VaultViewSelection => {
  const active = tabs.tabs.find((tab) => tab.tabId === tabs.activeTabId);
  return active ? { kind: "document", tab: active } : { kind: "welcome" };
};

const storageKey = (vaultId: string): string => `mermark.vaultTabs.${vaultId}`;

export class VaultTabStore {
  private readonly sessions = new Map<string, VaultTabs>();
  private readonly listeners = new Set<(tabs: VaultTabs) => void>();

  subscribe(listener: (tabs: VaultTabs) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  get(vaultId: string): VaultTabs {
    const session = this.sessions.get(vaultId);
    if (session) return session;
    const raw = localStorage.getItem(storageKey(vaultId));
    if (!raw) return { vaultId, tabs: [], activeTabId: null };
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return { vaultId, tabs: [], activeTabId: null };
      const candidate = parsed as Partial<VaultTabs>;
      if (candidate.vaultId !== vaultId || !Array.isArray(candidate.tabs) || (typeof candidate.activeTabId !== "string" && candidate.activeTabId !== null)) return { vaultId, tabs: [], activeTabId: null };
      const tabs = candidate.tabs.filter((tab): tab is VaultTab => typeof tab === "object" && tab !== null && typeof (tab as Partial<VaultTab>).tabId === "string" && typeof (tab as Partial<VaultTab>).path === "string");
      return { vaultId, tabs, activeTabId: tabs.some((tab) => tab.tabId === candidate.activeTabId) ? candidate.activeTabId : tabs[0]?.tabId ?? null };
    } catch (error) { if (error instanceof SyntaxError) return { vaultId, tabs: [], activeTabId: null }; throw error; }
  }

  open(vaultId: string, path: string, scope: TabPersistenceScope): VaultTab {
    const current = this.get(vaultId); const canonical = canonicalRootPath(path);
    const existing = current.tabs.find((tab) => tab.path === canonical);
    const tab = existing ?? { tabId: `${vaultId}-tab-${encodeURIComponent(canonical)}`, path: canonical };
    const next: VaultTabs = { vaultId, tabs: existing ? current.tabs : [...current.tabs, tab], activeTabId: tab.tabId };
    this.sessions.set(vaultId, next);
    if (scope === "permanent") localStorage.setItem(storageKey(vaultId), JSON.stringify(next));
    for (const listener of this.listeners) listener(next);
    return tab;
  }
}
