import { describe, it, expect, vi } from "vitest";
import { makeFileHost, type FileHostBackend } from "./file-host";

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
