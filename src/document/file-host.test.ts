import { describe, it, expect, vi } from "vitest";
import {
  makeFileHost,
  remoteFileHost,
  remoteConnectionStateFor,
  classifyRemoteError,
  ensureSshTunnel,
  evictSshTunnelMemo,
  fileHostFor,
  __resetRemoteCachesForTests,
  type FileHostBackend,
} from "./file-host";
import type { RemoteVault } from "../workspace/workspace-state";

// Only the __resetRemoteCachesForTests suite (bottom of this file) needs a
// real invoke() spy — fileHostFor's remoteHostFor memo (unlike
// remoteFileHost) has no way to inject a `call` spy, since it's reached
// through the app-wide singleton. Every other suite in this file passes its
// own `call` directly to remoteFileHost/ensureSshTunnel and never touches
// this import.
const coreInvokeMock = vi.fn(async (_cmd: string, _args?: unknown) => [] as unknown);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => coreInvokeMock(cmd, args) }));

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

// Fix round 2, Important A: nothing reconnected an `ssh://` vault's tunnel
// after an app restart — `remote-vault-dialog.ts` only calls
// `remote_ssh_connect` once, during the pairing session itself. These tests
// exercise `remoteFileHost`/`remoteConnectionStateFor` exactly as a *fresh*
// process would see them (a brand-new `remoteFileHost(...)` call, no prior
// `remote_ssh_connect` in this test's history) — standing in for "the app
// just restarted and the user opens a note in a previously-paired ssh://
// vault" without needing a real process restart.
describe("remoteFileHost / remoteConnectionStateFor — ssh tunnel reconnect (fix round 2, Important A)", () => {
  const sshVault = (host: string): RemoteVault => ({
    vaultId: `v-${host}`,
    workspaceId: "w1",
    displayName: "원격(ssh)",
    rootPath: null,
    persistenceKind: "remote",
    explorerRoot: "",
    host,
    remoteVaultId: "rv1",
  });

  it("a fresh remoteFileHost call for an ssh:// vault connects the tunnel before its first read", async () => {
    const calls: string[] = [];
    const call = ((cmd: string) => {
      calls.push(cmd);
      if (cmd === "remote_ssh_connect") return Promise.resolve(undefined);
      if (cmd === "remote_read_file") return Promise.resolve({ text: "본문", mtime: 1 });
      return Promise.reject(new Error("unexpected " + cmd));
    }) as never;
    const host = remoteFileHost(sshVault("ssh://wis@restart-test-1"), call);
    await host.readFile("note.md");
    expect(calls).toEqual(["remote_ssh_connect", "remote_read_file"]);
  });

  it("never calls remote_ssh_connect for a non-ssh (Tailscale-style) host", async () => {
    const calls: string[] = [];
    const call = ((cmd: string) => {
      calls.push(cmd);
      return Promise.resolve({ text: "", mtime: 0 });
    }) as never;
    const host = remoteFileHost(sshVault("wis-macmini"), call);
    await host.readFile("note.md");
    expect(calls).toEqual(["remote_read_file"]);
  });

  it("reconnects only once across several reads of the same ssh:// vault", async () => {
    const connectCalls: string[] = [];
    const call = ((cmd: string) => {
      if (cmd === "remote_ssh_connect") { connectCalls.push(cmd); return Promise.resolve(undefined); }
      if (cmd === "remote_read_file") return Promise.resolve({ text: "본문", mtime: 1 });
      if (cmd === "remote_list_dir") return Promise.resolve([]);
      return Promise.reject(new Error("unexpected " + cmd));
    }) as never;
    const host = remoteFileHost(sshVault("ssh://wis@restart-test-2"), call);
    await host.readFile("a.md");
    await host.listDir("sub", false);
    await host.readFile("b.md");
    expect(connectCalls.length).toBe(1);
  });

  it("a tunnel failure surfaces as one of the four connection states (via the badge probe), not a silent dead vault", async () => {
    const call = ((cmd: string) => {
      if (cmd === "remote_ssh_connect") return Promise.reject("REMOTE:Unreachable: SSH 터널이 8초 내에 준비되지 않았습니다");
      return Promise.reject(new Error("unexpected " + cmd));
    }) as never;
    const state = await remoteConnectionStateFor(sshVault("ssh://wis@restart-test-3"), call);
    expect(state).toBe("unreachable");
  });

  it("remoteConnectionStateFor also reconnects the tunnel for an ssh:// vault before probing", async () => {
    const calls: string[] = [];
    const call = ((cmd: string) => {
      calls.push(cmd);
      if (cmd === "remote_ssh_connect") return Promise.resolve(undefined);
      if (cmd === "remote_list_dir") return Promise.resolve([]);
      return Promise.reject(new Error("unexpected " + cmd));
    }) as never;
    const state = await remoteConnectionStateFor(sshVault("ssh://wis@restart-test-4"), call);
    expect(state).toBe("connected");
    expect(calls).toEqual(["remote_ssh_connect", "remote_list_dir"]);
  });

  // Fix round 3, Important 4 (TS side): a tunnel that dies *after*
  // `ensureSshTunnel` last resolved successfully (laptop sleep/wake, the
  // remote host rebooting into a different host's tunnel taking over the
  // shared port — see remote_ssh.rs's `tunnel_serves` doc comment) must not
  // stay cached as "ready" forever. Rust's `ensure_tunnel_serves` guard
  // reports that mismatch as an `SSH_TUNNEL_MISMATCH:`-prefixed rejection
  // from the underlying `remote_*` call itself (not from
  // `remote_ssh_connect`), so the eviction has to watch for that, not just
  // `ensureSshTunnel`'s own promise.
  it("a SSH_TUNNEL_MISMATCH failure evicts the memo so the next read reconnects", async () => {
    const host = "ssh://wis@restart-test-5";
    const calls: string[] = [];
    let readShouldMismatch = true;
    const call = ((cmd: string) => {
      calls.push(cmd);
      if (cmd === "remote_ssh_connect") return Promise.resolve(undefined);
      if (cmd === "remote_read_file") {
        if (readShouldMismatch) {
          readShouldMismatch = false;
          return Promise.reject(new Error(`SSH_TUNNEL_MISMATCH: ${host}에 대한 SSH 터널이 더 이상 유효하지 않습니다.`));
        }
        return Promise.resolve({ text: "본문", mtime: 1 });
      }
      return Promise.reject(new Error("unexpected " + cmd));
    }) as never;
    const vault = sshVault(host);
    const backend = remoteFileHost(vault, call);

    // First read: tunnel connects, but the read itself discovers the tunnel
    // now serves a different host and rejects.
    await expect(backend.readFile("a.md")).rejects.toThrow("SSH_TUNNEL_MISMATCH");
    expect(calls).toEqual(["remote_ssh_connect", "remote_read_file"]);

    // Without eviction, this second read would see the memo still "ready"
    // and skip straight to remote_read_file — it must reconnect instead.
    await backend.readFile("b.md");
    expect(calls).toEqual(["remote_ssh_connect", "remote_read_file", "remote_ssh_connect", "remote_read_file"]);
  });

  it("evictSshTunnelMemo forces the next ensureSshTunnel call to reconnect", async () => {
    const host = "ssh://wis@restart-test-6";
    const calls: string[] = [];
    const call = ((cmd: string) => {
      calls.push(cmd);
      return Promise.resolve(undefined);
    }) as never;

    await ensureSshTunnel(host, call);
    await ensureSshTunnel(host, call); // memoized — no second connect
    expect(calls).toEqual(["remote_ssh_connect"]);

    evictSshTunnelMemo(host);
    await ensureSshTunnel(host, call);
    expect(calls).toEqual(["remote_ssh_connect", "remote_ssh_connect"]);
  });
});

describe("classifyRemoteError", () => {
  it("원격 실패는 4종 상태로 분류된다", () => {
    expect(classifyRemoteError(new Error("REMOTE:AuthExpired"))).toBe("auth-expired");
    expect(classifyRemoteError(new Error("REMOTE:SharingOff"))).toBe("sharing-off");
    expect(classifyRemoteError(new Error("연결 실패: timeout"))).toBe("unreachable");
  });
});

// Minor (final review): module-level singletons (sshTunnelReady,
// remoteHostCache) have no reset seam — tests dodge cross-pollution by using
// unique vaultIds/hosts instead, which is fragile (a copy-pasted fixture
// that forgets to change its id silently shares another test's cache).
describe("__resetRemoteCachesForTests", () => {
  const remoteVault: RemoteVault = {
    vaultId: "vault-reset-seam",
    workspaceId: "w1",
    displayName: "원격",
    rootPath: null,
    persistenceKind: "remote",
    explorerRoot: "",
    host: "wis-reset-seam-host",
    remoteVaultId: "rv1",
  };

  it("clears remoteHostCache so fileHostFor's listingCache does not survive the reset", async () => {
    coreInvokeMock.mockResolvedValue([{ name: "a.md", path: "a.md", is_dir: false }] as unknown);
    coreInvokeMock.mockClear();

    await fileHostFor(remoteVault).listDir("", false);
    await fileHostFor(remoteVault).listDir("", false); // same cached backend instance -> dedup'd by listingCache
    expect(coreInvokeMock).toHaveBeenCalledTimes(1);

    __resetRemoteCachesForTests();

    await fileHostFor(remoteVault).listDir("", false); // fresh backend instance -> real call again
    expect(coreInvokeMock).toHaveBeenCalledTimes(2);
  });

  it("clears sshTunnelReady so a memoized tunnel connect is re-run after reset", async () => {
    const host = "ssh://wis@reset-seam";
    const call = vi.fn(async () => undefined) as never;

    await ensureSshTunnel(host, call);
    await ensureSshTunnel(host, call); // memoized -> no second call
    expect(call).toHaveBeenCalledTimes(1);

    __resetRemoteCachesForTests();

    await ensureSshTunnel(host, call);
    expect(call).toHaveBeenCalledTimes(2);
  });
});
