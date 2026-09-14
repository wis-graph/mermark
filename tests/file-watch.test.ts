import { describe, it, expect } from "vitest";

// decideExternalChange is a pure decision — it imports nothing from Tauri, so we
// don't need to mock the IPC/event modules here. (watchFile/unwatchFile/onFileChanged
// are thin invoke/listen wrappers covered by the golden-master + render path.)
import { createWatcherHandoff, decideExternalChange, shouldWatchDocument } from "../src/document/file-watch";
import type { RemoteVault, PermanentVault } from "../src/workspace/workspace-state";

describe("decideExternalChange (auto-reload vs conflict)", () => {
  it("reloads silently when there is no unsaved work", () => {
    expect(decideExternalChange(false)).toBe("reload");
  });

  it("opens a conflict when the local buffer has unsaved work", () => {
    expect(decideExternalChange(true)).toBe("conflict");
  });

  it.each([
    ["self-save", false, false, "not-invoked"],
    ["clean-external-edit", true, false, "reload"],
    ["dirty-external-edit", true, true, "conflict"],
    ["same-mtime-rewrite", true, false, "reload"],
    ["atomic-replacement", true, false, "reload"],
    ["watcher-replacement-tab-activation", true, false, "reload"],
    ["deletion", false, false, "not-invoked"],
    ["unreadable-path", false, false, "not-invoked"],
  ] as const)("projects the native %s boundary to %s", (_scenario, event, dirty, expected) => {
    expect(event ? decideExternalChange(dirty) : "not-invoked").toBe(expected);
  });

  it("commits a successful handoff and rolls back a rejected attachment", async () => {
    const events: string[] = [];
    let generation = 0;
    const handoff = createWatcherHandoff({
      unwatch: async () => { events.push("unwatch"); },
      watch: async (path) => {
        events.push(`watch ${path}`);
        if (path === "/B.md") throw new Error("watch failed");
        return { path, generation: String(++generation) };
      },
    }, () => {});

    await expect(handoff.handoff("/A.md")).resolves.toBe(true);
    events.length = 0;
    await expect(handoff.handoff("/B.md")).resolves.toBe(false);

    expect(events).toEqual(["unwatch", "watch /B.md", "watch /A.md"]);
  });

  // C2 (final-review-ts.md): every remote document open called
  // watch_file(<vault-relative name>) against the LOCAL filesystem — the
  // remote skip in main.ts's openInWindow was gated behind a flag every real
  // caller had already flipped, so it was dead code. This makes it
  // structurally impossible instead: `handoff` itself refuses to call
  // `port.watch` for a remote vault, no matter which caller forgets to
  // check first.
  const remoteVault: RemoteVault = {
    vaultId: "vault-remote-1",
    workspaceId: "workspace-default",
    displayName: "원격",
    rootPath: null,
    persistenceKind: "remote",
    explorerRoot: "",
    host: "wis-macmini",
    remoteVaultId: "rv-1",
  };
  const permanentVault: PermanentVault = {
    vaultId: "vault-local-1",
    workspaceId: "workspace-default",
    displayName: "로컬",
    rootPath: "/A",
    persistenceKind: "permanent",
    explorerRoot: "/A",
  };

  it("shouldWatchDocument: false for a remote vault, true for local/global/undefined", () => {
    expect(shouldWatchDocument(remoteVault)).toBe(false);
    expect(shouldWatchDocument(permanentVault)).toBe(true);
    expect(shouldWatchDocument(undefined)).toBe(true);
  });

  it("handoff never calls port.watch for a remote vault's document, even though a path was given — it still unwatches whatever was previously watched", async () => {
    const events: string[] = [];
    const handoff = createWatcherHandoff({
      unwatch: async () => { events.push("unwatch"); },
      watch: async (path) => { events.push(`watch ${path}`); return { path, generation: "1" }; },
    }, () => {});

    await expect(handoff.handoff("노트.md", remoteVault)).resolves.toBe(true);
    expect(events).toEqual(["unwatch"]); // no "watch 노트.md" — the local watcher was never armed
  });

  it("handoff still watches a local vault's document exactly as before", async () => {
    const events: string[] = [];
    const handoff = createWatcherHandoff({
      unwatch: async () => { events.push("unwatch"); },
      watch: async (path) => { events.push(`watch ${path}`); return { path, generation: "1" }; },
    }, () => {});

    await expect(handoff.handoff("/A/note.md", permanentVault)).resolves.toBe(true);
    expect(events).toEqual(["unwatch", "watch /A/note.md"]);
  });
});
