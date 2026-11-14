import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createWorkspaceSidebar, openDocumentCountLabel } from "../src/workspace/workspace-sidebar";
import { isVaultCollapsed, setVaultCollapsed } from "../src/workspace/vault-collapse";
import { GLOBAL_VAULT_ID, WorkspaceStateError, WorkspaceStore, workspaceStorageKey } from "../src/workspace/workspace-state";
import { ensureSshTunnel } from "../src/document/file-host";

describe("workspace sidebar", () => {
  beforeEach(() => localStorage.clear());

  it("renders vault rows without global registration or rename controls", () => {
    const store = new WorkspaceStore();
    const onSelectVault = vi.fn();
    const vault = store.registerVault("/notes/project", "Project");
    const sidebar = createWorkspaceSidebar({ store, onSelectVault });
    document.body.append(sidebar.aside, sidebar.button);

    expect(sidebar.aside.querySelectorAll(".workspace-vault-row")).toHaveLength(2);
    expect(sidebar.aside.querySelector(".workspace-id")).toBeNull();
    expect(sidebar.aside.querySelector(".workspace-vault-group-label")).toBeNull();
    expect(sidebar.aside.querySelectorAll("[role=heading]")).toHaveLength(0);
    expect(sidebar.aside.querySelector(`[data-vault-id="${GLOBAL_VAULT_ID}"]`)).toBeTruthy();
    expect(sidebar.aside.textContent).toContain("글로벌 볼트");
    expect(sidebar.aside.querySelector(`[data-vault-id="${GLOBAL_VAULT_ID}"]`)?.compareDocumentPosition(sidebar.aside.querySelector(`[data-vault-id="${vault.vaultId}"]`) as Node) && Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sidebar.aside.querySelector(".workspace-vault-path")).toBeNull();
    const permanentRow = sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${vault.vaultId}"]`);
    expect(permanentRow?.querySelector<HTMLButtonElement>(".workspace-vault-select")?.title).toBe("/notes/project");
    permanentRow?.querySelector<HTMLButtonElement>(".workspace-vault-select")?.click();
    expect(onSelectVault).toHaveBeenCalledWith(vault);
    expect(sidebar.aside.querySelector(".workspace-action")).toBeNull();
    expect(sidebar.aside.querySelector(".icon-square-pen")).toBeNull();
    expect(sidebar.aside.textContent).not.toContain("볼트 등록");
    expect(sidebar.aside.textContent).not.toContain("이름 변경");
  });

  it("does not render temporary/session groups or per-document vault rows", () => {
    const store = new WorkspaceStore();
    store.registerVault("/notes/project", "Project");
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
    document.body.append(sidebar.aside);

    expect(sidebar.aside.querySelector(".workspace-vault-group--temporary")).toBeNull();
    expect(sidebar.aside.textContent).not.toContain("이번 세션");
  });

  it("unregisters a permanent vault immediately without a browser confirmation dialog", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
    document.body.append(sidebar.aside);

    expect(sidebar.aside.querySelector(`[data-vault-id="${vault.vaultId}"] .icon-bookmark-filled`)).toBeTruthy();
    sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] .workspace-vault-action`)?.click();

    expect(store.get().vaults).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
    expect(sidebar.aside.querySelector(`[data-vault-id="${vault.vaultId}"]`)).toBeNull();
  });

  // The unregister button is a one-way action (it removes its own row), not a
  // toggle — aria-pressed promises the wrong contract (a leftover from
  // copying the explorer's real bookmark toggle). Its title communicates the
  // one fact that makes the click safe to make lightly: tab state survives.
  it("the unregister button has no aria-pressed and its title/aria-label say the tab state is kept", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
    document.body.append(sidebar.aside);

    const remove = sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] .workspace-vault-action`);
    expect(remove?.hasAttribute("aria-pressed")).toBe(false);
    expect(remove?.title).toContain("보존");
    expect(remove?.getAttribute("aria-label")).toContain("보존");
  });

  // Disambiguation path label (P10): the shared .path-label component
  // (src/chrome/path-label.ts, same one recent-item uses) only when a
  // displayName collides with another vault ON SCREEN RIGHT NOW — collision
  // scope is every rendered vault including the global one, not just
  // same-group siblings.
  it("adds a path label only to vaults whose name collides with another on-screen vault", () => {
    const store = new WorkspaceStore();
    const dup1 = store.registerVault("/work/notes", "notes");
    const dup2 = store.registerVault("/home/notes", "notes");
    const unique = store.registerVault("/home/journal", "journal");
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
    document.body.append(sidebar.aside);

    const rowFor = (vaultId: string) => sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${vaultId}"]`);
    expect(rowFor(dup1.vaultId)?.querySelector(".path-label")).toBeTruthy();
    expect(rowFor(dup2.vaultId)?.querySelector(".path-label")).toBeTruthy();
    expect(rowFor(unique.vaultId)?.querySelector(".path-label")).toBeNull();
    // The global vault has no rootPath, so it never gets one even though
    // nothing here makes its name collide in this test — the row simply
    // has no path to show.
    expect(rowFor(GLOBAL_VAULT_ID)?.querySelector(".path-label")).toBeNull();
  });

  it("does not add a path label when every on-screen vault name is unique", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
    document.body.append(sidebar.aside);

    expect(sidebar.aside.querySelector(".path-label")).toBeNull();
    // The tooltip stays — the label is a supplement, not a replacement.
    expect(sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] .workspace-vault-select`)?.title).toBe("/notes/project");
  });

  // Inline error line (P11): WorkspaceStateError shows in the panel and
  // clears on the next successful render; anything else keeps propagating
  // instead of being silently swallowed. jsdom doesn't let a listener
  // exception propagate through .click() itself (matches real browsers —
  // dispatchEvent reports it via the global 'error' event rather than
  // throwing back at the caller), so that's what this test listens for.
  it("shows a WorkspaceStateError inline (no window.alert) and clears it on the next successful render", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const onSelectVault = vi.fn(() => { throw new WorkspaceStateError("missing-vault", "그 볼트를 찾을 수 없습니다"); });
    const sidebar = createWorkspaceSidebar({ store, onSelectVault });
    document.body.append(sidebar.aside);

    sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] .workspace-vault-select`)?.click();

    expect(alertSpy).not.toHaveBeenCalled();
    const errorEl = sidebar.aside.querySelector<HTMLElement>(".workspace-error");
    expect(errorEl?.hidden).toBe(false);
    expect(errorEl?.textContent).toContain("그 볼트를 찾을 수 없습니다");

    // Any subsequent successful render (a rename here, unrelated to the
    // failed selection) clears the stale line.
    store.renameVault(vault.vaultId, "Renamed");
    expect(sidebar.aside.querySelector<HTMLElement>(".workspace-error")?.hidden).toBe(true);
  });

  it("still throws a non-WorkspaceStateError instead of swallowing it", () => {
    const store = new WorkspaceStore();
    const vault = store.registerVault("/notes/project", "Project");
    const onSelectVault = vi.fn(() => { throw new Error("boom-unexpected"); });
    const sidebar = createWorkspaceSidebar({ store, onSelectVault });
    document.body.append(sidebar.aside);

    let captured: unknown = null;
    const onWindowError = (event: ErrorEvent) => { captured = event.error; event.preventDefault(); };
    window.addEventListener("error", onWindowError);
    sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] .workspace-vault-select`)?.click();
    window.removeEventListener("error", onWindowError);

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe("boom-unexpected");
    // Not swallowed into the inline error line either.
    expect(sidebar.aside.querySelector<HTMLElement>(".workspace-error")?.hidden).not.toBe(false);
  });

  it("locks the [hidden] override that actually hides a vault row", () => {
    const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles.css");
    const css = readFileSync(cssPath, "utf8");
    expect(css).toMatch(/\.workspace-vault-row\[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
  });

  describe("tab strip removed; open-document count; explorer-folder-row column grammar", () => {
    const mount = (opts: { count?: (vaultId: string) => number } = {}) => {
      const store = new WorkspaceStore();
      const parent = store.registerVault("/notes", "Notes");
      const child = store.registerVault("/notes/project", "Project");
      const lone = store.registerVault("/z", "Zed");
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), ...(opts.count ? { openDocumentCount: opts.count } : {}) });
      document.body.append(sidebar.aside);
      const row = (id: string) => sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${id}"]`)!;
      return { store, parent, child, lone, sidebar, row };
    };

    it("renders no tab strip even when a vault has open documents", () => {
      const { sidebar } = mount({ count: () => 2 });
      for (const sel of [".workspace-vault-tabs", ".workspace-vault-tab", "[role=tablist]", "[role=tab]"]) {
        expect(sidebar.aside.querySelector(sel)).toBeNull();
      }
    });

    it("shows a muted count after the name, with an accessible name on the select button", () => {
      const { parent, lone, row } = mount({ count: (id) => (id.includes("notes") && !id.includes("project") ? 3 : 0) });
      const select = row(parent.vaultId).querySelector<HTMLButtonElement>(".workspace-vault-select")!;
      const count = select.querySelector(".workspace-vault-count")!;
      expect(count.textContent).toBe("3");
      expect(count.getAttribute("aria-hidden")).toBe("true");
      expect(select.getAttribute("aria-label")).toBe("Notes, 열린 문서 3개");
      expect(select.title).toBe("/notes");
      const zero = row(lone.vaultId).querySelector<HTMLButtonElement>(".workspace-vault-select")!;
      expect(zero.querySelector(".workspace-vault-count")).toBeNull();
      expect(zero.hasAttribute("aria-label")).toBe(false);
    });

    it("omits counts entirely when openDocumentCount is not injected", () => {
      const { sidebar } = mount();
      expect(sidebar.aside.querySelector(".workspace-vault-count")).toBeNull();
    });

    it("refresh() updates the count text and removes the span at zero", () => {
      let n = 2;
      const { sidebar, lone, row } = mount({ count: (id) => (id.includes("z") ? n : 0) });
      expect(row(lone.vaultId).querySelector(".workspace-vault-count")?.textContent).toBe("2");
      n = 5; sidebar.refresh();
      expect(row(lone.vaultId).querySelector(".workspace-vault-count")?.textContent).toBe("5");
      n = 0; sidebar.refresh();
      expect(row(lone.vaultId).querySelector(".workspace-vault-count")).toBeNull();
    });

    it("openDocumentCountLabel is null at 0 and names the count otherwise", () => {
      expect(openDocumentCountLabel(0)).toBeNull();
      expect(openDocumentCountLabel(1)).toBe("열린 문서 1개");
    });

    it("a row without child vaults has an empty chevron spacer and no toggle; the glyph lives in the select button", () => {
      const { lone, row } = mount();
      const r = row(lone.vaultId);
      expect(r.querySelector(".workspace-vault-toggle")).toBeNull();
      const spacer = r.querySelector(".workspace-vault-toggle-spacer")!;
      expect(spacer.getAttribute("aria-hidden")).toBe("true");
      expect(spacer.querySelector(".workspace-vault-chevron.is-empty")).toBeTruthy();
      const select = r.querySelector(".workspace-vault-select")!;
      expect(select.querySelector(":scope > .workspace-vault-glyph .icon-folder")).toBeTruthy();
      const kids = [...select.children].map((c) => c.className);
      expect(kids[0]).toBe("workspace-vault-glyph");
      expect(kids[1]).toBe("workspace-vault-name");
    });

    it("a parent row has a chevron toggle; collapsing hides child rows, swaps the glyph and labels, never enters the vault", () => {
      const { parent, child, row, sidebar } = mount();
      const toggle = row(parent.vaultId).querySelector<HTMLButtonElement>("button.workspace-vault-toggle")!;
      expect(toggle.querySelector(".workspace-vault-chevron")).toBeTruthy();
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(toggle.getAttribute("aria-label")).toBe("Notes 하위 볼트 접기");
      const glyph = row(parent.vaultId).querySelector(".workspace-vault-select .workspace-vault-glyph")!;
      expect(glyph.querySelector(".icon-folder-open")).toBeTruthy();
      expect(toggle.querySelector(".workspace-vault-glyph")).toBeNull();

      toggle.click();
      expect(row(child.vaultId).hidden).toBe(true);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(toggle.getAttribute("aria-label")).toBe("Notes 하위 볼트 펼치기");
      expect(glyph.querySelector(".icon-folder")).toBeTruthy();
      expect(glyph.querySelector(".icon-folder-open")).toBeNull();
      expect(sidebar.aside.querySelector('.workspace-vault-select[aria-current="true"]')?.closest("[data-vault-id]")?.getAttribute("data-vault-id")).not.toBe(parent.vaultId);

      toggle.click();
      expect(row(child.vaultId).hidden).toBe(false);
      expect(glyph.querySelector(".icon-folder-open")).toBeTruthy();
    });

    it("clicking the select button enters the vault and leaves the collapse state alone", () => {
      const store = new WorkspaceStore();
      const parent = store.registerVault("/notes", "Notes");
      store.registerVault("/notes/project", "Project");
      const onSelectVault = vi.fn();
      const sidebar = createWorkspaceSidebar({ store, onSelectVault });
      document.body.append(sidebar.aside);
      const r = sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${parent.vaultId}"]`)!;
      r.querySelector<HTMLButtonElement>(".workspace-vault-select")!.click();
      expect(onSelectVault).toHaveBeenCalledWith(parent);
      expect(r.querySelector(".workspace-vault-toggle")?.getAttribute("aria-expanded")).toBe("true");
    });

    it("persists collapse across sidebar instances and defaults to expanded", () => {
      const store = new WorkspaceStore();
      const parent = store.registerVault("/notes", "Notes");
      const child = store.registerVault("/notes/project", "Project");
      const a = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
      document.body.append(a.aside);
      const toggleA = a.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${parent.vaultId}"] .workspace-vault-toggle`)!;
      expect(toggleA.getAttribute("aria-expanded")).toBe("true");
      toggleA.click();
      a.aside.remove();
      const b = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
      document.body.append(b.aside);
      expect(b.aside.querySelector(`[data-vault-id="${parent.vaultId}"] .workspace-vault-toggle`)?.getAttribute("aria-expanded")).toBe("false");
      expect(b.aside.querySelector<HTMLElement>(`[data-vault-id="${child.vaultId}"]`)?.hidden).toBe(true);
    });
  });

  it("closes competing panels when workspace opens", () => {
    const store = new WorkspaceStore();
    const onOpen = vi.fn();
    const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), onOpen });

    sidebar.button.click();

    expect(onOpen).toHaveBeenCalledOnce();
  });

  // Fix round 2, Important B: registerRemoteVault dedupes on
  // (host, remoteVaultId), not host alone — two vaults from the same ssh
  // host can coexist, and removing one must not disconnect the shared
  // tunnel out from under the other.
  describe("remote vault removal and SSH tunnel sharing", () => {
    it("removing one of two vaults sharing an ssh host leaves the tunnel connected; removing the last one disconnects it", () => {
      // Host/remoteVaultId pairs used here are deliberately unique within
      // this test file: `workspace-sidebar.ts`'s badge caches
      // (`badgeCache`/`badgeProbes`) are module-level singletons that
      // persist across tests, keyed by `vaultId` — which is derived
      // deterministically from `(host, remoteVaultId)` — so reusing a pair
      // another test in this file already used would leak a cached badge
      // state into this test (or vice versa) rather than testing this
      // fix in isolation.
      const store = new WorkspaceStore();
      const first = store.registerRemoteVault("ssh://wis@t12b-shared-host", "rv-t12b-1", "볼트1");
      const second = store.registerRemoteVault("ssh://wis@t12b-shared-host", "rv-t12b-2", "볼트2");
      const call = vi.fn(async () => undefined) as never;
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), call });
      document.body.append(sidebar.aside);

      const removeButtonFor = (vaultId: string): HTMLButtonElement =>
        sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vaultId}"] .workspace-vault-action`)!;

      removeButtonFor(first.vaultId).click();
      // Sibling (rv-t12b-2) still registered on the same host — must not disconnect.
      expect(call).not.toHaveBeenCalledWith("remote_ssh_disconnect", expect.anything());
      expect(store.get().vaults.map((v) => v.vaultId)).toEqual([second.vaultId]);

      removeButtonFor(second.vaultId).click();
      // Now nothing remains on that host — safe (and expected) to disconnect.
      expect(call).toHaveBeenCalledWith("remote_ssh_disconnect", { host: "ssh://wis@t12b-shared-host" });
    });

    it("removing a vault on a non-ssh host never calls remote_ssh_disconnect", () => {
      const store = new WorkspaceStore();
      const vault = store.registerRemoteVault("t12b-nonssh-host", "rv-t12b-3", "볼트");
      const call = vi.fn(async () => undefined) as never;
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), call });
      document.body.append(sidebar.aside);

      sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] .workspace-vault-action`)!.click();
      expect(call).not.toHaveBeenCalledWith("remote_ssh_disconnect", expect.anything());
    });

    // I5 (final review): an explicit user-initiated "연결 해제" tore down
    // the Rust-side tunnel via remote_ssh_disconnect, but left file-host.ts's
    // OWN client-side memo (`ensureSshTunnel`'s cache) believing the tunnel
    // was still "ready" — the next read for a re-added vault on the same
    // host would skip reconnecting entirely until a live request happened to
    // fail with SSH_TUNNEL_MISMATCH. The disconnect action must evict that
    // memo itself, the same way a failed connect or a discovered mismatch
    // already does (file-host.ts's evictSshTunnelMemo).
    it("disconnecting the last vault on an ssh host evicts file-host.ts's client-side tunnel memo, so the next read reconnects instead of trusting a stale memo", async () => {
      const host = "ssh://wis@t12b-i5-host";
      const store = new WorkspaceStore();
      const vault = store.registerRemoteVault(host, "rv-i5", "볼트");
      const call = vi.fn(async () => undefined) as never;

      // Memoize the tunnel as "ready" first (same as a normal read would).
      await ensureSshTunnel(host, call);
      const connectCallsBefore = (call as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === "remote_ssh_connect").length;
      expect(connectCallsBefore).toBe(1);

      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), call });
      document.body.append(sidebar.aside);
      sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${vault.vaultId}"] .workspace-vault-action`)!.click();
      expect(call).toHaveBeenCalledWith("remote_ssh_disconnect", { host });

      // If the memo were still cached, this would resolve WITHOUT calling
      // remote_ssh_connect again.
      await ensureSshTunnel(host, call);
      const connectCallsAfter = (call as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === "remote_ssh_connect").length;
      expect(connectCallsAfter).toBe(2);
    });
  });

  // 볼트 목록 부모-자식 인덴트 (00_request.md #1): a child vault whose root sits
  // inside a registered parent vault's root renders one level deeper
  // (--level on the row), immediately after its parent — reusing isPathWithin
  // (path.ts), not a new predicate.
  describe("vault parent-child indent", () => {
    it("indents a child vault under its registered parent and places it immediately after", () => {
      const store = new WorkspaceStore();
      const parent = store.registerVault("/notes", "Notes");
      const child = store.registerVault("/notes/project", "Project");
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
      document.body.append(sidebar.aside);

      const parentRow = sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${parent.vaultId}"]`);
      const childRow = sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${child.vaultId}"]`);
      expect(parentRow?.style.getPropertyValue("--level")).toBe("1");
      expect(childRow?.style.getPropertyValue("--level")).toBe("2");
      // Parent immediately followed by its child.
      expect(parentRow?.compareDocumentPosition(childRow as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      const rows = [...sidebar.aside.querySelectorAll<HTMLElement>(".workspace-vault-group--permanent .workspace-vault-row")];
      expect(rows.indexOf(childRow as HTMLElement)).toBe(rows.indexOf(parentRow as HTMLElement) + 1);
    });

    it("attaches a 3-level-deep vault to its NEAREST registered ancestor only, not every ancestor", () => {
      const store = new WorkspaceStore();
      const grandparent = store.registerVault("/a", "A");
      const parent = store.registerVault("/a/b", "B");
      const child = store.registerVault("/a/b/c", "C");
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
      document.body.append(sidebar.aside);

      const rowFor = (id: string) => sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${id}"]`);
      expect(rowFor(grandparent.vaultId)?.style.getPropertyValue("--level")).toBe("1");
      expect(rowFor(parent.vaultId)?.style.getPropertyValue("--level")).toBe("2");
      expect(rowFor(child.vaultId)?.style.getPropertyValue("--level")).toBe("3");
    });

    it("does not indent unrelated top-level vaults", () => {
      const store = new WorkspaceStore();
      const first = store.registerVault("/work/one", "One");
      const second = store.registerVault("/home/two", "Two");
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
      document.body.append(sidebar.aside);

      const rowFor = (id: string) => sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${id}"]`);
      expect(rowFor(first.vaultId)?.style.getPropertyValue("--level")).toBe("1");
      expect(rowFor(second.vaultId)?.style.getPropertyValue("--level")).toBe("1");
    });

    // design §1.1 SUPERSEDE: this used to assert the OPPOSITE ("never lets a
    // collapsed parent hide its child vault's row"). The user asked that
    // collapsing a vault also collapse its sub-folder (child vault) rows.
    it("collapsing a parent hides its child vault rows (design §1.1 supersede), expanding restores them", () => {
      const store = new WorkspaceStore();
      const parent = store.registerVault("/notes", "Notes");
      const child = store.registerVault("/notes/project", "Project");
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
      document.body.append(sidebar.aside);
      const toggle = sidebar.aside.querySelector<HTMLButtonElement>(`[data-vault-id="${parent.vaultId}"] .workspace-vault-toggle`);
      const childRow = () => sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${child.vaultId}"]`);

      toggle?.click();
      expect(childRow()?.hidden).toBe(true);
      // The parent's own row (and its toggle) stays reachable.
      expect(sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${parent.vaultId}"]`)?.hidden).toBe(false);

      toggle?.click();
      expect(childRow()?.hidden).toBe(false);
    });

    it("collapsing a grandparent hides grandchildren too, even when the middle vault is expanded", () => {
      const store = new WorkspaceStore();
      const grand = store.registerVault("/a", "A");
      const mid = store.registerVault("/a/b", "B");
      const leaf = store.registerVault("/a/b/c", "C");
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
      document.body.append(sidebar.aside);
      const row = (id: string) => sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${id}"]`)!;

      row(grand.vaultId).querySelector<HTMLButtonElement>(".workspace-vault-toggle")?.click();
      expect(row(mid.vaultId).hidden).toBe(true);
      expect(row(leaf.vaultId).hidden).toBe(true); // mid itself is NOT collapsed
      expect(isVaultCollapsed(mid.vaultId)).toBe(false);
    });

    it("a child's own collapsed state survives the parent's collapse/expand cycle", () => {
      const store = new WorkspaceStore();
      const parent = store.registerVault("/a", "A");
      const child = store.registerVault("/a/b", "B");
      const leaf = store.registerVault("/a/b/c", "C");
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
      document.body.append(sidebar.aside);
      const row = (id: string) => sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${id}"]`)!;
      const toggleOf = (id: string) => row(id).querySelector<HTMLButtonElement>(".workspace-vault-toggle")!;

      toggleOf(child.vaultId).click(); // child collapsed itself
      toggleOf(parent.vaultId).click(); // parent collapse
      toggleOf(parent.vaultId).click(); // parent expand

      expect(row(child.vaultId).hidden).toBe(false);
      expect(isVaultCollapsed(child.vaultId)).toBe(true);
      expect(row(leaf.vaultId).hidden).toBe(true); // still under the collapsed child
    });

    it("a hidden-by-ancestor state is restored from storage on a fresh sidebar instance", () => {
      const store = new WorkspaceStore();
      const parent = store.registerVault("/a", "A");
      const child = store.registerVault("/a/b", "B");
      setVaultCollapsed(parent.vaultId, true);
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
      document.body.append(sidebar.aside);
      expect(sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${child.vaultId}"]`)?.hidden).toBe(true);
    });

    it("toggling keeps focus on the clicked toggle (no full re-render)", () => {
      const store = new WorkspaceStore();
      const parent = store.registerVault("/a", "A");
      store.registerVault("/a/b", "B");
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
      document.body.append(sidebar.aside);
      const rowEl = sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${parent.vaultId}"]`)!;
      const toggle = rowEl.querySelector<HTMLButtonElement>(".workspace-vault-toggle")!;
      toggle.focus();
      toggle.click();
      expect(sidebar.aside.querySelector(`[data-vault-id="${parent.vaultId}"]`)).toBe(rowEl);
      expect(document.activeElement).toBe(toggle);
    });

    it("sorts top-level and direct-child siblings by displayName while preserving DFS levels and stored registration order", () => {
      const store = new WorkspaceStore();
      const parent = store.registerVault("/work", "Work");
      const zChild = store.registerVault("/work/z", "Zulu");
      const zRoot = store.registerVault("/z-root", "Zulu Root");
      const aChild = store.registerVault("/work/a", "Alpha");
      const aRoot = store.registerVault("/a-root", "Alpha Root");
      const registrationOrder = [parent.vaultId, zChild.vaultId, zRoot.vaultId, aChild.vaultId, aRoot.vaultId];
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
      document.body.append(sidebar.aside);

      const permanentRows = [...sidebar.aside.querySelectorAll<HTMLElement>(
        ".workspace-vault-group--permanent .workspace-vault-row",
      )];
      const renderedIds = permanentRows.map((row) => row.dataset.vaultId);

      expect(renderedIds).toEqual([
        aRoot.vaultId,
        parent.vaultId,
        aChild.vaultId,
        zChild.vaultId,
        zRoot.vaultId,
      ]);

      const levelFor = (vaultId: string) =>
        sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${vaultId}"]`)?.style.getPropertyValue("--level");
      expect(levelFor(aRoot.vaultId)).toBe("1");
      expect(levelFor(parent.vaultId)).toBe("1");
      expect(levelFor(aChild.vaultId)).toBe("2");
      expect(levelFor(zChild.vaultId)).toBe("2");
      expect(levelFor(zRoot.vaultId)).toBe("1");

      const allRows = [...sidebar.aside.querySelectorAll<HTMLElement>(".workspace-vault-row")];
      expect(allRows[0]?.dataset.vaultId).toBe(GLOBAL_VAULT_ID);
      expect(levelFor(GLOBAL_VAULT_ID)).toBe("1");

      expect(store.get().workspaces[0]?.vaultIds).toEqual(registrationOrder);
      expect(store.get().vaults.map((vault) => vault.vaultId)).toEqual(registrationOrder);

      const saved = JSON.parse(localStorage.getItem(workspaceStorageKey) ?? "null") as {
        workspaces: Array<{ vaultIds: string[] }>;
        vaults: Array<{ vaultId: string }>;
      };
      expect(saved.workspaces[0]?.vaultIds).toEqual(registrationOrder);
      expect(saved.vaults.map((vault) => vault.vaultId)).toEqual(registrationOrder);
    });

    it("breaks equal displayName sibling ties by vaultId instead of registration order", () => {
      const store = new WorkspaceStore();
      const z = store.registerVault("/tie/z", "Same");
      const a = store.registerVault("/tie/a", "Same");
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
      document.body.append(sidebar.aside);

      const renderedIds = [...sidebar.aside.querySelectorAll<HTMLElement>(
        ".workspace-vault-group--permanent .workspace-vault-row",
      )].map((row) => row.dataset.vaultId);

      expect(renderedIds).toEqual([a.vaultId, z.vaultId]);
      expect(store.get().workspaces[0]?.vaultIds).toEqual([z.vaultId, a.vaultId]);
    });

    it("keeps the global vault outside the hierarchy (no rootPath, no --level bump)", () => {
      const store = new WorkspaceStore();
      store.registerVault("/notes", "Notes");
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn() });
      document.body.append(sidebar.aside);

      const globalRow = sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${GLOBAL_VAULT_ID}"]`);
      expect(globalRow?.style.getPropertyValue("--level")).toBe("1");
    });
  });

  // Task 10 fix round 1 (Minor): render() fires on every store notification,
  // so a naive per-render probe would fire one remote_list_dir per render
  // while the first probe is still in flight. probeRemoteConnection's
  // in-flight dedup (workspace-sidebar.ts) must collapse those into one.
  describe("remote vault connection badge", () => {
    it("dedupes concurrent probes for the same vault across multiple renders", async () => {
      const store = new WorkspaceStore();
      const remote = store.registerRemoteVault("wis-macmini", "rv-1", "맥미니 노트");
      let resolveProbe!: (v: unknown) => void;
      const call = vi.fn(() => new Promise((resolve) => { resolveProbe = resolve; })) as unknown as typeof import("@tauri-apps/api/core").invoke;
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), call });
      document.body.append(sidebar.aside);

      // A second render while the first probe is still pending (e.g. a tab
      // open elsewhere triggers store.subscribe) must NOT start a second
      // remote_list_dir call for the same vault.
      sidebar.refresh();
      sidebar.refresh();
      expect(call).toHaveBeenCalledTimes(1);

      const badge = sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${remote.vaultId}"] .workspace-vault-badge`);
      expect(badge?.textContent).toBe("확인 중");

      resolveProbe([]);
      await vi.waitFor(() => expect(badge?.textContent).toBe("연결됨"));
    });
  });

  describe("share-keyed badge probes (M2)", () => {
    it("root + folder vaults of one share probe once and retry together", async () => {
      const store = new WorkspaceStore();
      store.registerRemoteVault("m2-host", "m2-rv", "root");
      store.registerRemoteVault("m2-host", "m2-rv", "deep", "notes/deep");
      const call = vi.fn().mockResolvedValue([]) as unknown as typeof import("@tauri-apps/api/core").invoke;
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), call });
      document.body.append(sidebar.aside);
      await vi.waitFor(() => expect([...sidebar.aside.querySelectorAll(".workspace-vault-badge")].map((b) => b.textContent)).toEqual(["연결됨", "연결됨"]));
      expect(call).toHaveBeenCalledTimes(1);
      const labels = [...sidebar.aside.querySelectorAll(".workspace-vault-badge")].map((b) => b.textContent);
      expect(labels).toHaveLength(2);
      expect(new Set(labels).size).toBe(1);
    });
  });

  // Reconnect UI for a remote vault whose badge is not "connected" — the "×"
  // used to be the ONLY button on a broken row, which meant the sole
  // recovery path from "연결 안 됨" was to unregister the vault and re-pair
  // from scratch. Each test below uses a unique host/vaultId per the file's
  // established convention (module-level badgeCache/badgeProbes pollute
  // across tests that share an id).
  describe("remote vault reconnect", () => {
    const rejecting = (message: string) => vi.fn().mockRejectedValue(new Error(message));

    it("unreachable: shows a 다시 시도 action that reprobes immediately, bypassing the TTL cache", async () => {
      const store = new WorkspaceStore();
      const remote = store.registerRemoteVault("host-reconnect-1", "rv-a1", "재연결 A1");
      const call = rejecting("boom") as unknown as typeof import("@tauri-apps/api/core").invoke;
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), call });
      document.body.append(sidebar.aside);

      const row = () => sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${remote.vaultId}"]`)!;
      const badge = () => row().querySelector<HTMLElement>(".workspace-vault-badge")!;
      await vi.waitFor(() => expect(badge().textContent).toBe("연결 안 됨"));

      const recover = row().querySelector<HTMLButtonElement>(".workspace-vault-recover")!;
      expect(recover.hidden).toBe(false);
      expect(recover.textContent).toBe("다시 시도");

      expect(call).toHaveBeenCalledTimes(1);
      recover.click();
      // Reprobes right away even though BADGE_TTL_MS hasn't elapsed — a
      // cached "연결 안 됨" must never be replayed on retry.
      expect(badge().textContent).toBe("확인 중");
      expect(call).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => expect(badge().textContent).toBe("연결 안 됨"));

      // Retry failing again must never remove the vault registration.
      expect(store.get().vaults.some((v) => v.vaultId === remote.vaultId)).toBe(true);
      sidebar.destroy();
    });

    it("sharing-off: shows a 다시 시도 action too", async () => {
      const store = new WorkspaceStore();
      const remote = store.registerRemoteVault("host-reconnect-2", "rv-a2", "재연결 A2");
      const call = rejecting("REMOTE:SharingOff") as unknown as typeof import("@tauri-apps/api/core").invoke;
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), call });
      document.body.append(sidebar.aside);

      const row = sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${remote.vaultId}"]`)!;
      const badge = row.querySelector<HTMLElement>(".workspace-vault-badge")!;
      await vi.waitFor(() => expect(badge.textContent).toBe("호스트가 공유를 껐음"));
      const recover = row.querySelector<HTMLButtonElement>(".workspace-vault-recover")!;
      expect(recover.hidden).toBe(false);
      expect(recover.textContent).toBe("다시 시도");
      sidebar.destroy();
    });

    it("auth-expired: shows a 다시 페어링 action that opens the pairing dialog prefilled with the vault's host, never reprobes", async () => {
      const store = new WorkspaceStore();
      const remote = store.registerRemoteVault("host-reconnect-3", "rv-a3", "재연결 A3");
      const call = rejecting("REMOTE:AuthExpired") as unknown as typeof import("@tauri-apps/api/core").invoke;
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), call });
      document.body.append(sidebar.aside);

      const row = sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${remote.vaultId}"]`)!;
      const badge = row.querySelector<HTMLElement>(".workspace-vault-badge")!;
      await vi.waitFor(() => expect(badge.textContent).toBe("인증 만료"));
      const recover = row.querySelector<HTMLButtonElement>(".workspace-vault-recover")!;
      expect(recover.hidden).toBe(false);
      expect(recover.textContent).toBe("다시 페어링");

      const callsBefore = (call as ReturnType<typeof vi.fn>).mock.calls.length;
      recover.click();
      // auth-expired can't be fixed by re-probing (the token itself is
      // dead) — clicking it must open pairing, not fire another probe.
      expect((call as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);

      const dialogHostInput = sidebar.aside.querySelector<HTMLInputElement>(".remote-vault-dialog-input");
      expect(dialogHostInput?.value).toBe("host-reconnect-3");
      const dialogRoot = sidebar.aside.querySelector<HTMLElement>(".remote-vault-dialog");
      expect(dialogRoot?.hidden).toBe(false);
      sidebar.destroy();
    });

    it("connected: shows no recovery action", async () => {
      const store = new WorkspaceStore();
      const remote = store.registerRemoteVault("host-reconnect-4", "rv-a4", "재연결 A4");
      const call = vi.fn().mockResolvedValue([]) as unknown as typeof import("@tauri-apps/api/core").invoke;
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), call });
      document.body.append(sidebar.aside);

      const row = sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${remote.vaultId}"]`)!;
      const badge = row.querySelector<HTMLElement>(".workspace-vault-badge")!;
      await vi.waitFor(() => expect(badge.textContent).toBe("연결됨"));
      const recover = row.querySelector<HTMLButtonElement>(".workspace-vault-recover")!;
      expect(recover.hidden).toBe(true);
      sidebar.destroy();
    });

    it("the disconnect (×) button's title tells the user re-pairing will be needed afterwards", () => {
      const store = new WorkspaceStore();
      const remote = store.registerRemoteVault("host-reconnect-5", "rv-a5", "재연결 A5");
      const call = vi.fn().mockResolvedValue([]) as unknown as typeof import("@tauri-apps/api/core").invoke;
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), call });
      document.body.append(sidebar.aside);

      const row = sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${remote.vaultId}"]`)!;
      const disconnect = [...row.querySelectorAll<HTMLButtonElement>(".workspace-vault-action")].find((b) => b.title.includes("해제"))!;
      expect(disconnect.title).toContain("페어링");
      sidebar.destroy();
    });

    describe("remote folder vaults", () => {
      const mk = () => {
        const store = new WorkspaceStore();
        const call = vi.fn().mockResolvedValue([]) as unknown as typeof import("@tauri-apps/api/core").invoke;
        return { store, call };
      };
      const mount = (store: WorkspaceStore, call: typeof import("@tauri-apps/api/core").invoke) => {
        const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), call });
        document.body.append(sidebar.aside);
        const row = (id: string) => sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${id}"]`)!;
        return { sidebar, row };
      };
      const level = (el: HTMLElement) => el.style.getPropertyValue("--level") || el.dataset.level;

      it("nests folder vaults under their share root, nearest parent wins, other shares / permanent do not nest", () => {
        const { store, call } = mk();
        const root = store.registerRemoteVault("fv-host", "rv-1", "루트");
        const notes = store.registerRemoteVault("fv-host", "rv-1", "", "notes");
        const deep = store.registerRemoteVault("fv-host", "rv-1", "", "notes/deep");
        const other = store.registerRemoteVault("fv-host", "rv-2", "", "notes/deep");
        const { sidebar, row } = mount(store, call);
        expect([root, notes, deep, other].map((v) => level(row(v.vaultId)))).toEqual(["1", "2", "3", "1"]);
        const order = [...sidebar.aside.querySelectorAll<HTMLElement>(".workspace-vault-group--remote [data-vault-id]")].map((el) => el.dataset.vaultId).filter((id) => id !== other.vaultId);
        expect(order).toEqual([root.vaultId, notes.vaultId, deep.vaultId]);
        sidebar.destroy();
      });

      it("a folder vault without its share root is level 1", () => {
        const { store, call } = mk();
        const only = store.registerRemoteVault("fv-host2", "rv-1", "", "notes/deep");
        const { sidebar, row } = mount(store, call);
        expect(level(row(only.vaultId))).toBe("1");
        sidebar.destroy();
      });

      it("shows folder name + `host › subpath` title, folder-specific unregister label, and probes the share root", async () => {
        const { store, call } = mk();
        store.registerRemoteVault("fv-host3", "rv-1", "루트");
        const folder = store.registerRemoteVault("fv-host3", "rv-1", "", "notes/deep");
        const { sidebar, row } = mount(store, call);
        const el = row(folder.vaultId);
        expect(el.querySelector(".workspace-vault-name")?.textContent).toBe("deep");
        expect(el.querySelector<HTMLElement>(".workspace-vault-select")?.title).toBe("fv-host3 › notes/deep");
        const remove = el.querySelector<HTMLButtonElement>(".workspace-vault-action")!;
        expect(remove.title).toContain("탐색기에서 다시 등록");
        expect(remove.title).not.toContain("페어링");
        expect(el.querySelector(".workspace-vault-badge")).not.toBeNull();
        await vi.waitFor(() => expect(call).toHaveBeenCalledWith("remote_list_dir", expect.objectContaining({ path: "" })));
        expect(call).not.toHaveBeenCalledWith("remote_list_dir", expect.objectContaining({ path: "notes/deep" }));
        sidebar.destroy();
      });

      it("unregistering a folder vault removes it and does not tear down the ssh tunnel while the root remains", () => {
        const { store, call } = mk();
        store.registerRemoteVault("ssh://u@fv-host4", "rv-1", "루트");
        const folder = store.registerRemoteVault("ssh://u@fv-host4", "rv-1", "", "notes");
        const { sidebar, row } = mount(store, call);
        row(folder.vaultId).querySelector<HTMLButtonElement>(".workspace-vault-action")!.click();
        expect(store.get().vaults.some((v) => v.vaultId === folder.vaultId)).toBe(false);
        expect(call).not.toHaveBeenCalledWith("remote_ssh_disconnect", expect.anything());
        sidebar.destroy();
      });
    });

    it("recovers automatically when the window comes back online — invalidates the cache and reprobes without polling", async () => {
      const store = new WorkspaceStore();
      const remote = store.registerRemoteVault("host-reconnect-6", "rv-a6", "재연결 A6");
      const call = rejecting("boom") as unknown as typeof import("@tauri-apps/api/core").invoke;
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), call });
      document.body.append(sidebar.aside);

      const badge = () => sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${remote.vaultId}"] .workspace-vault-badge`)!;
      await vi.waitFor(() => expect(badge().textContent).toBe("연결 안 됨"));
      expect(call).toHaveBeenCalledTimes(1);

      window.dispatchEvent(new Event("online"));
      // Still within BADGE_TTL_MS — must reprobe anyway, not serve the cache.
      expect(call).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => expect(badge().textContent).toBe("연결 안 됨"));
      sidebar.destroy();
    });

    it("destroy() removes the online/focus/visibilitychange listeners it installed", async () => {
      const store = new WorkspaceStore();
      const remote = store.registerRemoteVault("host-reconnect-7", "rv-a7", "재연결 A7");
      const call = rejecting("boom") as unknown as typeof import("@tauri-apps/api/core").invoke;
      const sidebar = createWorkspaceSidebar({ store, onSelectVault: vi.fn(), call });
      document.body.append(sidebar.aside);

      const badge = () => sidebar.aside.querySelector<HTMLElement>(`[data-vault-id="${remote.vaultId}"] .workspace-vault-badge`)!;
      await vi.waitFor(() => expect(badge().textContent).toBe("연결 안 됨"));
      const callsAfterFirstProbe = (call as ReturnType<typeof vi.fn>).mock.calls.length;

      sidebar.destroy();
      sidebar.aside.remove();
      window.dispatchEvent(new Event("online"));
      expect((call as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirstProbe);
    });
  });
});
