import { canonicalRootPath, GLOBAL_VAULT_ID } from "./workspace-state";

export type TabPersistenceScope = "permanent" | "session";
export type VaultTab = { readonly tabId: string; readonly path: string };
export type VaultTabs = { readonly vaultId: string; readonly tabs: readonly VaultTab[]; readonly activeTabId: string | null };
export type VaultViewSelection = { readonly kind: "document"; readonly tab: VaultTab } | { readonly kind: "welcome" };

export const selectVaultView = (tabs: VaultTabs): VaultViewSelection => {
  const active = tabs.tabs.find((tab) => tab.tabId === tabs.activeTabId);
  return active ? { kind: "document", tab: active } : { kind: "welcome" };
};

/** What `VaultTabs` would look like after closing `tabId` — the "which tab
 *  becomes active" rule in ONE place (audit 🟡-3: this used to be hand-copied
 *  at `close()`'s own site, `closeActiveTab`'s nextTab computation, and the
 *  BC-3 guard, in `src/document/session.ts`). If `tabId` was the active tab,
 *  the new active tab is the LAST one remaining (or none, landing on
 *  welcome); otherwise the active selection doesn't change at all — closing
 *  a background tab is not a navigation act. Pure query (CQS): returns the
 *  SAME `tabs` reference (identity) when `tabId` isn't present, so callers
 *  can cheaply detect a no-op the way `close()` already did. */
export function tabsAfterClose(tabs: VaultTabs, tabId: string): VaultTabs {
  const remaining = tabs.tabs.filter((tab) => tab.tabId !== tabId);
  if (remaining.length === tabs.tabs.length) return tabs;
  const activeTabId = tabs.activeTabId === tabId ? remaining[remaining.length - 1]?.tabId ?? null : tabs.activeTabId;
  return { vaultId: tabs.vaultId, tabs: remaining, activeTabId };
}

const storageKey = (vaultId: string): string => `mermark.vaultTabs.${vaultId}`;

export class VaultTabStore {
  private readonly sessions = new Map<string, VaultTabs>();
  private readonly listeners = new Set<(tabs: VaultTabs) => void>();

  subscribe(listener: (tabs: VaultTabs) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  get(vaultId: string): VaultTabs {
    const session = this.sessions.get(vaultId);
    if (session) return session;
    if (vaultId === GLOBAL_VAULT_ID) return { vaultId, tabs: [], activeTabId: null };
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
    this.commit(next, scope);
    return tab;
  }

  select(vaultId: string, tabId: string, scope: TabPersistenceScope): VaultTabs {
    const current = this.get(vaultId);
    if (!current.tabs.some((tab) => tab.tabId === tabId) || current.activeTabId === tabId) return current;
    const next: VaultTabs = { ...current, activeTabId: tabId };
    this.commit(next, scope);
    return next;
  }

  close(vaultId: string, tabId: string, scope: TabPersistenceScope): VaultTabs {
    const current = this.get(vaultId);
    const next = tabsAfterClose(current, tabId);
    if (next === current) return current;
    this.commit(next, scope);
    return next;
  }

  discard(vaultId: string): void {
    this.sessions.delete(vaultId);
    localStorage.removeItem(storageKey(vaultId));
  }

  private commit(next: VaultTabs, scope: TabPersistenceScope): void {
    this.sessions.set(next.vaultId, next);
    if (next.vaultId === GLOBAL_VAULT_ID || scope === "session") localStorage.removeItem(storageKey(next.vaultId));
    else localStorage.setItem(storageKey(next.vaultId), JSON.stringify(next));
    for (const listener of this.listeners) listener(next);
  }
}
