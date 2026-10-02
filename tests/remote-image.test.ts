import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invokeSpy = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => p,
  invoke: (...args: unknown[]) => invokeSpy(...args),
}));

import {
  readRemoteImage,
  loadRemoteEmbed,
  clearRemoteImageCache,
  clearRemoteImageFailureReports,
} from "../src/markdown/remote-image";
import { recursiveImageSearchSetting } from "../src/settings/app";
import type { RemoteVault } from "../src/workspace/workspace-state";

const vault: RemoteVault = {
  vaultId: "v1",
  workspaceId: "w",
  displayName: "r",
  rootPath: null,
  persistenceKind: "remote",
  explorerRoot: "",
  host: "h1",
  remoteVaultId: "rv1",
};

/** Route invoke by command name. */
function route(handlers: Record<string, (args: any) => unknown>) {
  invokeSpy.mockImplementation((cmd: string, args: unknown) => {
    const h = handlers[cmd];
    if (!h) return Promise.reject(new Error(`unexpected ${cmd}`));
    try {
      return Promise.resolve(h(args));
    } catch (e) {
      return Promise.reject(e);
    }
  });
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  invokeSpy.mockReset();
  clearRemoteImageCache();
  clearRemoteImageFailureReports();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe("readRemoteImage", () => {
  it("caches by (host, remoteVaultId, path) — second call does not refetch", async () => {
    route({ remote_read_image: () => "data:image/png;base64,A" });
    await readRemoteImage(vault, "a.png");
    await readRemoteImage(vault, "a.png");
    expect(invokeSpy).toHaveBeenCalledTimes(1);
  });

  it("evicts a rejected entry so a later call retries", async () => {
    let n = 0;
    route({
      remote_read_image: () => {
        if (n++ === 0) throw new Error("REMOTE:Unreachable");
        return "data:ok";
      },
    });
    await expect(readRemoteImage(vault, "a.png")).rejects.toThrow();
    await expect(readRemoteImage(vault, "a.png")).resolves.toBe("data:ok");
  });
});

describe("loadRemoteEmbed", () => {
  it("literal path hit returns it without calling remote_resolve_image", async () => {
    route({ remote_read_image: () => "data:lit" });
    const hit = await loadRemoteEmbed(vault, "pic.png", "notes", "vault");
    expect(hit).toEqual({ dataUrl: "data:lit", path: "notes/pic.png" });
    expect(invokeSpy.mock.calls.map((c) => c[0])).not.toContain("remote_resolve_image");
  });

  it('literal miss on a vault-scope embed searches the remote vault root "" at depth 12 and reads the resolved path', async () => {
    route({
      remote_read_image: (a) => {
        if (a.path === ".attachments/pic.png") return "data:found";
        throw new Error("REMOTE:NotFound");
      },
      remote_resolve_image: () => ".attachments/pic.png",
    });
    const hit = await loadRemoteEmbed(vault, "pic.png", "notes", "vault");
    expect(invokeSpy).toHaveBeenCalledWith("remote_resolve_image", {
      host: "h1", vault: "rv1", path: "", name: "pic.png", maxDepth: 12,
    });
    expect(hit).toEqual({ dataUrl: "data:found", path: ".attachments/pic.png" });
    expect(warn).not.toHaveBeenCalled(); // a successful search after a literal 404 reports nothing
  });

  it("folder scope with the setting off does not search and reports the failure", async () => {
    recursiveImageSearchSetting.set("off");
    route({ remote_read_image: () => { throw new Error("REMOTE:NotFound"); } });
    const hit = await loadRemoteEmbed(vault, "pic.png", "notes", "folder");
    expect(hit).toBeNull();
    expect(invokeSpy.mock.calls.map((c) => c[0])).not.toContain("remote_resolve_image");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("folder scope with the setting on searches baseDir at depth 3", async () => {
    recursiveImageSearchSetting.set("on");
    route({
      remote_read_image: (a) => {
        if (a.path === "notes/deep/pic.png") return "data:deep";
        throw new Error("REMOTE:NotFound");
      },
      remote_resolve_image: () => "notes/deep/pic.png",
    });
    const hit = await loadRemoteEmbed(vault, "pic.png", "notes", "folder");
    expect(invokeSpy).toHaveBeenCalledWith("remote_resolve_image", {
      host: "h1", vault: "rv1", path: "notes", name: "pic.png", maxDepth: 3,
    });
    expect(hit?.path).toBe("notes/deep/pic.png");
  });

  it("not found -> null and exactly one console.warn naming the target and stage", async () => {
    route({
      remote_read_image: () => { throw new Error("REMOTE:NotFound"); },
      remote_resolve_image: () => null,
    });
    expect(await loadRemoteEmbed(vault, "ghost.png", "", "vault")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain("ghost.png");
    expect(msg).toContain("not-found");
  });

  it("a connection error is reported with its raw tag", async () => {
    route({
      remote_read_image: () => { throw new Error("REMOTE:Unreachable"); },
      remote_resolve_image: () => { throw new Error("REMOTE:Unreachable"); },
    });
    expect(await loadRemoteEmbed(vault, "p.png", "", "vault")).toBeNull();
    expect(String(warn.mock.calls[0][0])).toContain("REMOTE:Unreachable");
  });

  it("dedups repeat failures for the same (vault, baseDir, rawSrc)", async () => {
    route({
      remote_read_image: () => { throw new Error("REMOTE:NotFound"); },
      remote_resolve_image: () => null,
    });
    await loadRemoteEmbed(vault, "ghost.png", "", "vault");
    clearRemoteImageCache(); // force a recompute; the report memory must still dedup
    await loadRemoteEmbed(vault, "ghost.png", "", "vault");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
