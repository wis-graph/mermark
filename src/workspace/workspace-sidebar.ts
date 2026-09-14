import { icon } from "../icons";
import { renderSidebarButton } from "../sidebar/toggle";
import { redundantPathLabel, truncatedPathLabel } from "../chrome/path-label";
import { basename, dirOf, isPathWithin } from "../document/path";
import { extensionOf, renderEntryGlyph } from "../sidebar/explorer/file-icons";
import { WorkspaceStateError, anyVaultStillUsesHost, type RemoteVault, type Vault, type WorkspaceState, type WorkspaceStore } from "./workspace-state";
import type { VaultTabs } from "./vault-tabs";
import { isVaultCollapsed, setVaultCollapsed } from "./vault-collapse";
import { badgeFor } from "./add-remote-vault";
import { remoteConnectionStateFor, evictSshTunnelMemo, type RemoteConnectionState } from "../document/file-host";
import { createRemoteVaultDialog, type RemoteVaultDialog } from "./remote-vault-dialog";
import { invoke } from "@tauri-apps/api/core";

export interface WorkspaceSidebar {
  readonly button: HTMLButtonElement;
  readonly aside: HTMLElement;
  close(): void;
  refresh(): void;
}

export interface WorkspaceSidebarHandlers {
  readonly store: WorkspaceStore;
  readonly onSelectVault: (vault: Vault) => void;
  readonly onSelectTab?: (vault: Vault, tab: VaultTabs["tabs"][number]) => void | Promise<boolean>;
  readonly onCloseTab?: (vault: Vault, tab: VaultTabs["tabs"][number]) => void;
  onOpen?(): void;
  readonly getTabs?: (vaultId: string) => VaultTabs;
  /** Swappable for a spy in tests (pairing dialog + connection badges). */
  readonly call?: typeof invoke;
}

/** How long a remote vault's connection badge is trusted before the next
 *  render re-probes it — a burst-dedup window (this panel re-renders on
 *  every store notification, e.g. a tab open/close), not a correctness
 *  cache: a genuinely stale badge just waits for its own re-render, exactly
 *  like `remoteFileHost`'s listing cache (file-host.ts) this mirrors. */
const BADGE_TTL_MS = 8000;
const badgeCache = new Map<string, { expires: number; state: RemoteConnectionState }>();
/** One shared in-flight probe per vaultId (Task 10 fix round 1, Minor) —
 *  `render()` fires on every store notification (a tab open/close, a badge
 *  itself resolving and re-painting, …), so without this a stale cache entry
 *  would fire a fresh `remote_list_dir` on EVERY one of those renders that
 *  lands before the first probe settles, not just the one that started it.
 *  Mirrors `remoteFileHost`'s own `listingCache` (file-host.ts) — same
 *  shape, same reason. */
const badgeProbes = new Map<string, Promise<RemoteConnectionState>>();

/** Test-only escape hatch, same reasoning as file-host.ts's sibling
 *  `__resetRemoteCachesForTests` (Minor, final review): `badgeCache`/
 *  `badgeProbes` have no reset seam, so this file's own tests dodge
 *  cross-test pollution by giving every test a unique host/vaultId instead
 *  — this lets a `beforeEach` opt into real isolation. */
export function __resetBadgeCachesForTests(): void {
  badgeCache.clear();
  badgeProbes.clear();
}

/** The single probe for `vault`'s connection state — reuses an in-flight
 *  request for the same vaultId instead of starting a second one, and
 *  populates `badgeCache` on settle. Command in effect (mutates the two
 *  shared maps above) but returns the resolved state so callers can paint
 *  without a second cache read. */
function probeRemoteConnection(vault: RemoteVault, call: typeof invoke): Promise<RemoteConnectionState> {
  const pending = badgeProbes.get(vault.vaultId);
  if (pending) return pending;
  const probe = remoteConnectionStateFor(vault, call)
    .then((state) => {
      badgeCache.set(vault.vaultId, { expires: Date.now() + BADGE_TTL_MS, state });
      return state;
    })
    .finally(() => {
      if (badgeProbes.get(vault.vaultId) === probe) badgeProbes.delete(vault.vaultId);
    });
  badgeProbes.set(vault.vaultId, probe);
  return probe;
}

/** Renders `el` as a connection badge for `vault`, serving a cached state
 *  immediately if fresh and always kicking off a background re-probe when
 *  stale — never blocks the row's render on the network (item 4: skeleton,
 *  not a synchronous freeze). Command (void); the cache above is the shared
 *  state, this function only paints from + refreshes it. */
function renderRemoteBadge(el: HTMLElement, vault: RemoteVault, call: typeof invoke): void {
  const paint = (state: RemoteConnectionState): void => {
    const badge = badgeFor(state);
    el.textContent = badge.label;
    el.className = `workspace-vault-badge workspace-vault-badge--${badge.tone}`;
  };
  const hit = badgeCache.get(vault.vaultId);
  if (hit && hit.expires > Date.now()) { paint(hit.state); return; }
  el.textContent = "확인 중"; el.className = "workspace-vault-badge workspace-vault-badge--checking";
  void probeRemoteConnection(vault, call).then(paint);
}

const create = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag); if (className) element.className = className; return element;
};

/** Sync a vault row's collapse toggle — glyph, aria-expanded, labels, and the
 *  tab strip's visibility — in one command so the picture and the state can
 *  never drift apart. Same discipline as the explorer's
 *  renderFolderGlyph/expandFolder/collapseFolder (explorer-panel.ts).
 *  `hasTabs` drives the "찬 폴더" fill (design_tabbar_visual.md §2.4): a
 *  collapsed vault that still has tabs inside gets its closed-folder glyph
 *  filled (`.has-tabs`, styles.css) so "there's something in here" survives
 *  the collapse — an empty collapsed vault stays a bare outline. No new
 *  stored state: the caller already has the tab list in hand for this render. */
function renderVaultCollapse(toggle: HTMLButtonElement, glyph: HTMLElement, tabList: HTMLElement, displayName: string, collapsed: boolean, hasTabs: boolean): void {
  glyph.replaceChildren(icon(collapsed ? "folder" : "folder-open"));
  glyph.classList.toggle("has-tabs", collapsed && hasTabs);
  toggle.setAttribute("aria-expanded", String(!collapsed));
  const label = `${displayName} 탭 ${collapsed ? "펼치기" : "접기"}`;
  toggle.title = label;
  toggle.setAttribute("aria-label", label);
  tabList.hidden = collapsed;
}

/** D6's one-level folder prefix: the muted "which folder" hint shown before a
 *  tab's filename, or null when none applies. Null cases: the global vault
 *  (no root — nothing to be relative TO, so no folder structure is "this
 *  vault's own"), and a file that lives directly under the vault root
 *  (nothing to disambiguate). Two-or-more levels deep collapses to a bare
 *  "…/" — D6 rules out real tree depth, this just says "there's more" — and
 *  a single level over MAX_PREFIX_CHARS keeps its first N characters and
 *  swaps the tail for "…" rather than silently truncating without a mark.
 *  Pure query — the caller (the tab loop below) decides whether to actually
 *  render it, since that also depends on the PREVIOUS rendered tab's folder. */
const MAX_PREFIX_CHARS = 10;
function folderPrefixFor(path: string, vaultRoot: string | null): string | null {
  if (!vaultRoot) return null;
  const dir = dirOf(path);
  if (dir === vaultRoot) return null;
  if (!dir.startsWith(vaultRoot)) return null; // defensive: a tab outside its own vault's root
  const relative = dir.slice(vaultRoot.length).replace(/^[\\/]/, "");
  const segments = relative.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.length > 1) return "…/";
  const folder = segments[0] ?? "";
  return folder.length > MAX_PREFIX_CHARS ? `${folder.slice(0, MAX_PREFIX_CHARS)}…/` : `${folder}/`;
}

/** One rendered vault row's nesting depth (1-based, matching the explorer
 *  tree's `aria-level` convention). */
interface VaultRow { readonly vault: Vault; readonly level: number }

/** The nearest registered ancestor of `vault` among `all` — the registered
 *  vault whose root STRICTLY contains `vault`'s root (via `isPathWithin`,
 *  path.ts — reused, not reinvented) with the LONGEST root path (closest
 *  wins over a more distant grandparent). Null when `vault` has no root
 *  (the global vault) or no registered vault contains it (a top-level root).
 *  Pure query. */
function nearestRegisteredParent(vault: Vault, all: readonly Vault[]): Vault | null {
  if (vault.rootPath === null) return null;
  let best: Vault | null = null;
  for (const candidate of all) {
    if (candidate.vaultId === vault.vaultId || candidate.rootPath === null) continue;
    if (candidate.rootPath === vault.rootPath) continue; // defensive: store forbids duplicate roots
    if (!isPathWithin(vault.rootPath, candidate.rootPath)) continue;
    if (!best || best.rootPath === null || candidate.rootPath.length > best.rootPath.length) best = candidate;
  }
  return best;
}

function compareVaultDisplayOrder(left: Vault, right: Vault): number {
  if (left.displayName < right.displayName) return -1;
  if (left.displayName > right.displayName) return 1;
  return left.vaultId < right.vaultId ? -1 : left.vaultId > right.vaultId ? 1 : 0;
}

/** Arrange `vaults` into parent-then-children DFS pre-order, each row tagged
 *  with its nesting `level` — a parent is ALWAYS immediately followed by its
 *  own children (00_request.md #1), and every vault attaches to its nearest
 *  registered ancestor only (never every ancestor up the chain). Roots and
 *  each parent's direct children sort by `displayName`, then `vaultId`; only
 *  function-local arrays are sorted, preserving stored registration order. A
 *  child's collapse state is its own (vault-collapse.ts) — this function only
 *  decides ORDER/LEVEL, never visibility, so a collapsed parent can never hide
 *  a child row (the request's "부모를 접어도 자식은 숨지 않는다" invariant lives
 *  structurally here: children are sibling rows in the DOM, never nested
 *  inside the parent's tab strip). Pure query. */
function arrangeVaultHierarchy(vaults: readonly Vault[]): VaultRow[] {
  const childrenByParentId = new Map<string, Vault[]>();
  const roots: Vault[] = [];
  for (const vault of vaults) {
    const parent = nearestRegisteredParent(vault, vaults);
    if (!parent) { roots.push(vault); continue; }
    const siblings = childrenByParentId.get(parent.vaultId) ?? [];
    siblings.push(vault);
    childrenByParentId.set(parent.vaultId, siblings);
  }
  roots.sort(compareVaultDisplayOrder);
  for (const siblings of childrenByParentId.values()) siblings.sort(compareVaultDisplayOrder);
  const rows: VaultRow[] = [];
  const visit = (vault: Vault, level: number): void => {
    rows.push({ vault, level });
    for (const child of childrenByParentId.get(vault.vaultId) ?? []) visit(child, level + 1);
  };
  for (const vault of roots) visit(vault, 1);
  return rows;
}

export function createWorkspaceSidebar({ store, onSelectVault, onSelectTab, onCloseTab, onOpen, getTabs, call = invoke }: WorkspaceSidebarHandlers): WorkspaceSidebar {
  const button = create("button", "chrome-btn workspace-btn icon-only");
  const aside = create("aside", "workspace-aside sidebar-aside");
  aside.id = "workspace-aside"; aside.hidden = true;
  const header = create("div", "workspace-header sidebar-header");
  const title = create("span", "workspace-title"); title.textContent = "워크스페이스"; header.append(title);
  // "볼트 추가 › 원격 볼트" (item 1): local vaults are still registered from
  // the explorer's per-folder bookmark toggle (unchanged by this task), so
  // this button's only job is opening the remote pairing dialog below.
  const addRemoteBtn = create("button", "workspace-add-remote-btn") as HTMLButtonElement;
  addRemoteBtn.type = "button"; addRemoteBtn.title = "원격 볼트 추가"; addRemoteBtn.setAttribute("aria-label", "원격 볼트 추가");
  addRemoteBtn.append(icon("plus"));
  header.append(addRemoteBtn);
  const list = create("div", "workspace-vault-list"); list.setAttribute("role", "list");
  // Names the registration path (the explorer's per-folder bookmark toggle)
  // instead of ending at "없습니다" with no next step. Text only — an "open the
  // explorer" button would need a new callback threaded through main.ts.
  // Lives INSIDE the permanent group (see renderGroup) so it aligns with that
  // group's label and rows, and so "the permanent group is empty" is what the
  // DOM actually says rather than something the reader infers from ordering.
  const empty = create("div", "workspace-empty"); empty.textContent = "등록된 영구 볼트가 없습니다. 탐색기에서 폴더 옆 북마크 아이콘으로 등록할 수 있습니다.";
  // Inline error line (explorer's root-error pattern, not an OS alert — this
  // panel was the one place still using window.alert). Sits above the list so
  // it's visible regardless of which row's action triggered it. A persistent
  // node toggled by `.hidden`, like `empty` above, rather than built fresh —
  // there's only ever one error showing at a time.
  const errorMessage = create("span", "workspace-error-message");
  const errorEl = create("div", "workspace-error"); errorEl.hidden = true; errorEl.append(errorMessage);
  const remoteDialog: RemoteVaultDialog = createRemoteVaultDialog({ store, call, onRegistered: () => remoteDialog.close() });
  aside.append(header, errorEl, list, remoteDialog.root);
  addRemoteBtn.addEventListener("click", () => remoteDialog.open());

  const renderButton = (): void => renderSidebarButton(button, "list-tree", "워크스페이스", !aside.hidden, "workspace-aside");
  renderButton();
  const close = (): void => { aside.hidden = true; renderButton(); };
  button.addEventListener("click", () => { if (!aside.hidden) close(); else { aside.hidden = false; onOpen?.(); renderButton(); } });

  // WorkspaceStateError is a user-facing, expected failure (duplicate root,
  // missing vault) — shown inline, never thrown further. Anything else is
  // unexpected and must keep propagating: swallowing it here would hide a
  // real bug instead of surfacing it. The line clears on the next successful
  // render (see `render` below), not on a timer — a stale error outliving
  // the state that caused it would be worse than one that lingers a beat.
  const showError = (error: unknown): void => {
    if (error instanceof WorkspaceStateError || typeof error === "string") {
      errorMessage.textContent = error instanceof Error ? error.message : error;
      errorEl.hidden = false;
      return;
    }
    throw error;
  };
  const render = (state: WorkspaceState): void => {
    const workspace = state.workspaces.find((item) => item.workspaceId === state.currentWorkspaceId);
    if (!workspace) return;
    errorEl.hidden = true;
    list.replaceChildren();
    // Workspace.vaultIds holds every PERSISTED vault (permanent + remote,
    // Ruling 21) — split by kind here so each renders in its own group below,
    // same shape as the pre-existing global/permanent split.
    const registeredVaults = workspace.vaultIds.flatMap((vaultId) => {
      const vault = state.vaults.find((item) => item.vaultId === vaultId);
      return vault ? [vault] : [];
    });
    const permanentVaults = registeredVaults.filter((vault) => vault.persistenceKind === "permanent");
    const remoteVaults = registeredVaults.filter((vault): vault is RemoteVault => vault.persistenceKind === "remote");
    empty.hidden = permanentVaults.length > 0;
    // Every vault about to render, global included — a permanent vault named
    // the same as the global vault (or another permanent vault) is exactly
    // the case a per-group check would miss, since the two live in separate
    // groups. Counts, not identities: only a name shared by 2+ vaults gets a
    // path label; a lone vault reads fine by name alone (240px is no room for
    // a path nobody needs).
    const nameCounts = new Map<string, number>();
    for (const vault of [store.getGlobalVault(), ...permanentVaults]) nameCounts.set(vault.displayName, (nameCounts.get(vault.displayName) ?? 0) + 1);
    const hasNameCollision = (name: string): boolean => (nameCounts.get(name) ?? 0) > 1;

    // `label` names the group in the DOM (not via CSS `content:`, where the
    // string would be invisible to a grep of the other UI strings, unselectable,
    // and unreliably exposed to assistive tech). The global group stays
    // unlabelled on purpose: it's the single default row, and a second heading
    // above it would add chrome without adding a distinction.
    const renderGroup = (className: string, rows: readonly VaultRow[], label?: string, emptyState?: HTMLElement): void => {
      const group = create("section", `workspace-vault-group ${className}`);
      if (label) {
        const heading = create("div", "workspace-group-label");
        heading.id = `${className}-label`; heading.textContent = label;
        group.setAttribute("aria-labelledby", heading.id);
        group.append(heading);
      }
      for (const { vault, level } of rows) {
        const row = create("div", "workspace-vault-row"); row.setAttribute("role", "listitem"); row.dataset.vaultId = vault.vaultId;
        row.style.setProperty("--level", String(level));
        // Toggle is its own button, not nested inside `select` — a button
        // inside a button is invalid HTML, and it made the two controls'
        // hovers bleed into each other. Its click means collapse/expand;
        // `select`'s click means entry. `folder-open`/`folder` (the same pair
        // the explorer's directory rows use) now means expanded/collapsed
        // only — the old global-vs-permanent reading of this glyph is
        // dropped, since the "영구 볼트" group label already carries that
        // distinction.
        const toggle = create("button", "workspace-vault-toggle") as HTMLButtonElement; toggle.type = "button";
        const glyph = create("span", "workspace-vault-glyph"); toggle.append(glyph);
        const select = create("button", "workspace-vault-select") as HTMLButtonElement; select.type = "button"; select.title = vault.rootPath ?? vault.displayName;
        const name = create("span", "workspace-vault-name"); name.textContent = vault.displayName; select.append(name);
        // Path label only when this vault's name collides with another one
        // currently on screen — the shared left-truncating component
        // (src/chrome/path-label.ts), same as recent-item's disambiguation
        // row, never a fresh one. The global vault has no rootPath (nothing
        // to show), so it can never carry this even if its name collides.
        const pathLabel = vault.rootPath && hasNameCollision(vault.displayName) && !redundantPathLabel(vault.rootPath) ? truncatedPathLabel(vault.rootPath) : null;
        const tabList = create("div", "workspace-vault-tabs"); tabList.setAttribute("role", "tablist"); tabList.setAttribute("aria-orientation", "horizontal"); tabList.setAttribute("aria-label", `${vault.displayName} 탭`);
        const tabs = getTabs?.(vault.vaultId) ?? { vaultId: vault.vaultId, tabs: [], activeTabId: null };
        // D7: render in path order, not open order — the STORED order
        // (tabs.tabs, vaultTabs.ts) is untouched; this is a display-only
        // sort of a copy, so closing/selecting still reads/writes the real
        // array by tabId, never by this sorted position. A plain string
        // comparison (not localeCompare) keeps it deterministic across
        // locales/environments — "사전순" here just means "consistent", not
        // language-aware collation.
        const sortedTabs = [...tabs.tabs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        // D6: a prefix only appears when the folder actually CHANGES from the
        // previous rendered row — tracked against the real folder path, not
        // the (possibly lossy, e.g. "…/") prefix text, so two different deep
        // folders that both render "…/" are never mistaken for "the same
        // folder" and wrongly collapsed together.
        let previousDir: string | null = null;
        for (const tab of sortedTabs) {
          const tabBase = basename(tab.path);
          const tabExt = extensionOf(tabBase);
          // D5: the icon already says the type — an extension suffix would
          // repeat it in text. Only strip when there IS an extension
          // (extensionOf already excludes dotfiles/trailing dots), so
          // "README" stays "README" and ".gitignore" stays ".gitignore".
          const displayName = tabExt ? tabBase.slice(0, tabBase.length - tabExt.length - 1) : tabBase;
          const dir = dirOf(tab.path);
          const prefixText = dir === previousDir ? null : folderPrefixFor(tab.path, vault.rootPath);
          previousDir = dir;
          const tabRow = create("div", "workspace-vault-tab-row");
          // Icon + prefix + name share ONE button (§2.3): the icon isn't a
          // separate control, clicking it opens the tab exactly like
          // clicking the name does — same D3 "highlight scope = action
          // scope" reasoning as the vault row, just with no second action to
          // carve out here.
          const tabEl = create("button", "workspace-vault-tab") as HTMLButtonElement; tabEl.type = "button"; tabEl.dataset.tabId = tab.tabId; tabEl.title = tab.path;
          const tabGlyph = create("span", "workspace-vault-tab-glyph"); renderEntryGlyph(tabGlyph, tabBase, false, false); tabEl.append(tabGlyph);
          if (prefixText) { const prefix = create("span", "workspace-vault-tab-prefix"); prefix.textContent = prefixText; tabEl.append(prefix); }
          const tabNameEl = create("span", "workspace-vault-tab-name"); tabNameEl.textContent = displayName; tabEl.append(tabNameEl);
          const selected = tab.tabId === tabs.activeTabId;
          tabEl.setAttribute("role", "tab"); tabEl.setAttribute("aria-selected", String(selected)); tabEl.tabIndex = selected ? 0 : -1;
          if (selected) { tabEl.dataset.active = "true"; tabEl.setAttribute("aria-current", "page"); }
          const commitRoving = (target: VaultTabs["tabs"][number], focus: boolean): void => {
            const currentList = aside.querySelector<HTMLElement>(`[data-vault-id="${vault.vaultId}"] .workspace-vault-tabs`);
            const buttons = [...(currentList?.querySelectorAll<HTMLButtonElement>(".workspace-vault-tab") ?? [])];
            const targetButton = buttons.find((button) => button.dataset.tabId === target.tabId);
            for (const button of buttons) button.tabIndex = button === targetButton ? 0 : -1;
            if (focus) targetButton?.focus();
          };
          const activate = (target: VaultTabs["tabs"][number], focus: boolean): void => {
            try {
              const result = onSelectTab?.(vault, target);
              if (result && typeof result.then === "function") {
                void result.then((committed) => { if (committed) commitRoving(target, focus); }).catch(showError);
              } else {
                commitRoving(target, focus);
              }
            } catch (error) { showError(error); }
          };
          tabEl.addEventListener("click", () => activate(tab, false));
          tabEl.addEventListener("keydown", (event) => {
            const key = event.key;
            if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") return;
            event.preventDefault();
            // Roving order follows the RENDERED (path-sorted) order, not
            // tabs.tabs' stored order — otherwise → could visually jump
            // backwards.
            const index = sortedTabs.findIndex((candidate) => candidate.tabId === tab.tabId);
            const nextIndex = key === "Home" ? 0 : key === "End" ? sortedTabs.length - 1 : (index + (key === "ArrowRight" ? 1 : -1) + sortedTabs.length) % sortedTabs.length;
            const target = sortedTabs[nextIndex];
            if (target) activate(target, true);
          });
          const closeTab = create("button", "workspace-vault-tab-close") as HTMLButtonElement; closeTab.type = "button"; closeTab.title = "탭 닫기"; closeTab.setAttribute("aria-label", `${tabBase} 탭 닫기`); closeTab.append(icon("x")); closeTab.addEventListener("click", (event) => { event.stopPropagation(); onCloseTab?.(vault, tab); });
          tabRow.append(tabEl, closeTab); tabList.append(tabRow);
        }
        select.setAttribute("aria-current", workspace.currentVaultId === vault.vaultId ? "true" : "false"); select.addEventListener("click", () => { try { onSelectVault(vault); } catch (error) { showError(error); } });
        // Collapse state is UI layout, not workspace state — it lives in its
        // own storage (vault-collapse.ts) and is applied/toggled in place
        // rather than through a full `render()`, so a keyboard user's focus
        // stays on the toggle after activating it.
        let collapsed = isVaultCollapsed(vault.vaultId);
        const hasTabs = tabs.tabs.length > 0;
        renderVaultCollapse(toggle, glyph, tabList, vault.displayName, collapsed, hasTabs);
        toggle.addEventListener("click", (event) => {
          event.stopPropagation();
          collapsed = !collapsed;
          setVaultCollapsed(vault.vaultId, collapsed);
          renderVaultCollapse(toggle, glyph, tabList, vault.displayName, collapsed, hasTabs);
        });
        row.append(toggle, select);
        if (pathLabel) row.append(pathLabel);
        row.append(tabList);
        if (vault.persistenceKind === "permanent") {
          // Reversible, so the title says so instead of reading like a
          // destructive one-way click: unregisterVault only drops the
          // vaultId/rootPath pairing from workspace state (workspace-state.ts)
          // — it never touches `mermark.vaultTabs.<id>`, and vaultId is
          // derived deterministically from the canonical rootPath
          // (`vault-${encodeURIComponent(path)}`), so re-registering the same
          // folder lands on the same id and its saved tabs are still there.
          // No `aria-pressed` — that promises a real toggle (press again to
          // undo in place), but this button removes itself on click; it's a
          // plain one-way action, not a toggle (unlike the explorer's own
          // bookmark toggle, which really does flip back and forth).
          const remove = create("button", "workspace-vault-action") as HTMLButtonElement; remove.type = "button"; remove.title = "영구 볼트 해제 — 탭 상태는 보존됩니다"; remove.setAttribute("aria-label", `${vault.displayName} 영구 볼트 해제 — 탭 상태는 보존됩니다`); remove.append(icon("bookmark-filled")); remove.addEventListener("click", () => { try { store.unregisterVault(vault.vaultId); } catch (error) { showError(error); } });
          row.append(remove);
        }
        if (vault.persistenceKind === "remote") {
          // 4-state connection badge (item 3) — never a generic "실패", each
          // of connected/unreachable/auth-expired/sharing-off says a
          // different thing to fix. Painted async by renderRemoteBadge so a
          // stalled host never blocks this render (item 4's "동기 블로킹
          // 금지" applies here too, not just the explorer tree).
          const badge = create("span", "workspace-vault-badge workspace-vault-badge--checking");
          renderRemoteBadge(badge, vault, call);
          row.append(badge);
          const remove = create("button", "workspace-vault-action") as HTMLButtonElement; remove.type = "button"; remove.title = "원격 볼트 해제"; remove.setAttribute("aria-label", `${vault.displayName} 원격 볼트 해제`); remove.append(icon("x")); remove.addEventListener("click", () => {
            try {
              store.unregisterVault(vault.vaultId);
              // Best-effort: free the local tunnel port as soon as the LAST
              // vault on this host is removed, rather than waiting for app
              // exit's own cleanup (remote_ssh.rs's RunEvent::Exit hook) to
              // get to it. Checked AFTER the removal above, against the
              // post-removal vault list — registerRemoteVault dedupes by
              // (host, remoteVaultId), not by host alone, so two vaults CAN
              // share one ssh host (fix round 2, Important B); disconnecting
              // unconditionally here would cut the tunnel out from under a
              // sibling vault that's still registered. Fire-and-forget — a
              // failure here has nothing left to act on, the vault
              // registration is already gone either way.
              if (vault.host.startsWith("ssh://") && !anyVaultStillUsesHost(store.get().vaults, vault.host)) {
                // I5 (final review): tearing down the Rust-side tunnel alone
                // leaves file-host.ts's OWN memo (ensureSshTunnel's cache)
                // believing it's still "ready" — evict it too, the same way
                // a failed connect or a discovered SSH_TUNNEL_MISMATCH
                // already does, so a re-added vault on this host reconnects
                // on its very next read instead of silently trusting a
                // memo for a tunnel this action just tore down.
                evictSshTunnelMemo(vault.host);
                void call("remote_ssh_disconnect", { host: vault.host }).catch(() => {});
              }
            } catch (error) { showError(error); }
          });
          row.append(remove);
        }
        group.append(row);
      }
      if (emptyState) group.append(emptyState);
      list.append(group);
    };
    renderGroup("workspace-vault-group--global", [{ vault: store.getGlobalVault(), level: 1 }]);
    renderGroup("workspace-vault-group--permanent", arrangeVaultHierarchy(permanentVaults), "영구 볼트", empty);
    // Remote vaults have no rootPath, so arrangeVaultHierarchy's parent/child
    // nesting (which keys off rootPath containment) never applies to them —
    // rendered as a flat level-1 list, no empty-state (the group simply
    // doesn't render when there are none, unlike permanent's "no rows yet"
    // guidance, since there's no registration entry point to point at here
    // other than the + button already in the header).
    if (remoteVaults.length > 0) renderGroup("workspace-vault-group--remote", remoteVaults.map((vault) => ({ vault, level: 1 })), "원격 볼트");
  };
  store.subscribe(render); render(store.get());
  return { button, aside, close, refresh: () => render(store.get()) };
}
