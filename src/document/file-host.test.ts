import { describe, it, expect, vi } from "vitest";
import { makeFileHost, remoteFileHost, classifyRemoteError, type FileHostBackend } from "./file-host";
import type { RemoteVault } from "../workspace/workspace-state";

const backend = (): FileHostBackend => ({
  readFile: vi.fn(async () => ({ text: "hi", mtime: 1 })),
  listDir: vi.fn(async () => []),
  listFilesRecursive: vi.fn(async () => ({ files: [], truncated: false })),
  resolveImage: vi.fn(async () => null),
  listLinkTargets: vi.fn(async () => []),
  pathExists: vi.fn(async () => true),
  directoryExists: vi.fn(async () => true),
});

describe("makeFileHost", () => {
  it("로컬 볼트는 로컬 백엔드로 간다", async () => {
    const local = backend();
    const remote = backend();
    const host = makeFileHost({ local, remoteFor: () => remote });
    await host.forVault({ persistenceKind: "permanent" } as never).readFile("/a.md");
    expect(local.readFile).toHaveBeenCalledWith("/a.md");
    expect(remote.readFile).not.toHaveBeenCalled();
  });

  it("글로벌 볼트도 로컬 백엔드로 간다", async () => {
    const local = backend();
    const host = makeFileHost({ local, remoteFor: () => backend() });
    await host.forVault({ persistenceKind: "global" } as never).listDir("/d", false);
    expect(local.listDir).toHaveBeenCalledWith("/d", false);
  });

  it("원격 볼트는 remoteFor가 만든 백엔드로 간다", async () => {
    const local = backend();
    const remote = backend();
    const host = makeFileHost({ local, remoteFor: () => remote });
    await host.forVault({ persistenceKind: "remote" } as never).pathExists("/r/a.md");
    expect(remote.pathExists).toHaveBeenCalledWith("/r/a.md");
    expect(local.pathExists).not.toHaveBeenCalled();
  });
});

const remoteVault: RemoteVault = {
  vaultId: "v1",
  workspaceId: "w1",
  displayName: "원격",
  rootPath: null,
  persistenceKind: "remote",
  explorerRoot: "",
  host: "wis-macmini",
  remoteVaultId: "rv1",
};

describe("remoteFileHost", () => {
  it("원격 볼트는 remote_* 커맨드로 간다 (토큰 없이)", async () => {
    const calls: Array<[string, unknown]> = [];
    const host = remoteFileHost(remoteVault, ((cmd: string, args?: unknown) => {
      calls.push([cmd, args]);
      return Promise.resolve({ text: "", mtime: 0 });
    }) as never);
    await host.readFile("note.md");
    expect(calls[0][0]).toBe("remote_read_file");
    expect(calls[0][1]).toMatchObject({ host: "wis-macmini", vault: "rv1", path: "note.md" });
    expect(calls[0][1]).not.toHaveProperty("token");
  });

  it("listDir/listFilesRecursive/resolveImage/listLinkTargets가 문서화된 remote_* 시그니처 그대로 간다", async () => {
    const calls: Array<[string, unknown]> = [];
    const call = ((cmd: string, args?: unknown) => {
      calls.push([cmd, args]);
      if (cmd === "remote_list_dir") return Promise.resolve([]);
      if (cmd === "remote_list_files_recursive") return Promise.resolve({ files: [], truncated: false });
      if (cmd === "remote_resolve_image") return Promise.resolve(null);
      if (cmd === "remote_list_link_targets") return Promise.resolve([]);
      return Promise.resolve(undefined);
    }) as never;
    const host = remoteFileHost(remoteVault, call);

    await host.listDir("sub", true);
    expect(calls[0]).toEqual(["remote_list_dir", { host: "wis-macmini", vault: "rv1", path: "sub", showHidden: true }]);

    await host.listFilesRecursive("sub", false);
    expect(calls[1]).toEqual(["remote_list_files_recursive", { host: "wis-macmini", vault: "rv1", path: "sub", showHidden: false }]);

    await host.resolveImage("notes", "img.png", 3);
    expect(calls[2]).toEqual(["remote_resolve_image", { host: "wis-macmini", vault: "rv1", path: "notes", name: "img.png", maxDepth: 3 }]);

    await host.listLinkTargets("notes");
    expect(calls[3]).toEqual(["remote_list_link_targets", { host: "wis-macmini", vault: "rv1", path: "notes" }]);
  });

  it("pathExists는 remote_list_dir로 부모 디렉터리를 조회해 이름이 있는지로 판정한다 (무조건 true 아님)", async () => {
    const call = ((cmd: string, args: { path: string }) => {
      if (cmd === "remote_list_dir") {
        if (args.path === "notes") {
          return Promise.resolve([{ name: "real.md", path: "notes/real.md", is_dir: false }]);
        }
        return Promise.reject(new Error("REMOTE:SharingOff"));
      }
      return Promise.reject(new Error("unexpected " + cmd));
    }) as never;
    const host = remoteFileHost(remoteVault, call);
    expect(await host.pathExists("notes/real.md")).toBe(true);
    expect(await host.pathExists("notes/missing.md")).toBe(false);
  });

  it("pathExists는 부모 디렉터리 조회가 실패하면 false로 처리한다", async () => {
    const call = (() => Promise.reject(new Error("REMOTE:Unreachable"))) as never;
    const host = remoteFileHost(remoteVault, call);
    expect(await host.pathExists("gone/note.md")).toBe(false);
  });

  it("같은 폴더의 형제 위키링크 두 개가 pathExists를 부르면 remote_list_dir은 한 번만 나간다", async () => {
    let listDirCalls = 0;
    const call = ((cmd: string) => {
      if (cmd === "remote_list_dir") {
        listDirCalls++;
        return Promise.resolve([
          { name: "a.md", path: "notes/a.md", is_dir: false },
          { name: "b.md", path: "notes/b.md", is_dir: false },
        ]);
      }
      return Promise.reject(new Error("unexpected " + cmd));
    }) as never;
    const host = remoteFileHost(remoteVault, call);
    const [existsA, existsB] = await Promise.all([
      host.pathExists("notes/a.md"),
      host.pathExists("notes/b.md"),
    ]);
    expect(existsA).toBe(true);
    expect(existsB).toBe(true);
    expect(listDirCalls).toBe(1);

    // A third, sequential call for the same parent within the TTL window
    // also reuses the cached listing rather than firing a new request.
    expect(await host.pathExists("notes/a.md")).toBe(true);
    expect(listDirCalls).toBe(1);
  });

  it("directoryExists는 remote_list_dir 성공 여부로 판정한다", async () => {
    const call = ((cmd: string, args: { path: string }) => {
      if (cmd === "remote_list_dir" && args.path === "notes") return Promise.resolve([]);
      return Promise.reject(new Error("REMOTE:SharingOff"));
    }) as never;
    const host = remoteFileHost(remoteVault, call);
    expect(await host.directoryExists("notes")).toBe(true);
    expect(await host.directoryExists("gone")).toBe(false);
  });
});

describe("classifyRemoteError", () => {
  it("원격 실패는 4종 상태로 분류된다", () => {
    expect(classifyRemoteError(new Error("REMOTE:AuthExpired"))).toBe("auth-expired");
    expect(classifyRemoteError(new Error("REMOTE:SharingOff"))).toBe("sharing-off");
    expect(classifyRemoteError(new Error("연결 실패: timeout"))).toBe("unreachable");
  });
});
