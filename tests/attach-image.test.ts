// Vault image attachment — `vault:` scheme withdrawal
// (_workspace/00_request_vaultimage_fix.md). Rewritten from the old
// tests/vault-attach.test.ts's `attachImageToVault` describe (that file's
// `resolveVaultImage`/`VaultImageWidget`/acceptance describes are deleted —
// there is no more `vault:` resolution pipeline to test; image.test.ts's
// "ImageWidget vault-scope search root" describe covers the render path
// now). This suite proves ORCHESTRATION ONLY — invoke call order/args,
// token plumbing, Korean message selection, and that the document/existing
// files are preserved on every failure path. It does NOT and CANNOT prove
// atomicity, real (dev,ino) file identity, or TempGuard cleanup — those are
// native properties only `src-tauri/src/attachment_import.rs`'s cargo
// integration tests can verify.
import { describe, it, expect, vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import {
  attachImageToVault,
  embedMarkdownFor,
  attachmentFailureMessage,
  VAULT_ATTACHMENT_MESSAGES,
  SHADOWED_IMAGE_NAME_WARNING,
  type AttachImageDeps,
} from "../src/markdown/attach-image";

describe("embedMarkdownFor", () => {
  it("builds a wikilink-image embed for a name needing no encoding", () => {
    expect(embedMarkdownFor("pic-1.png")).toBe("![[pic-1.png]]");
  });
  it("keeps a Korean/space-containing name verbatim (wikilink target has no percent-encoding)", () => {
    expect(embedMarkdownFor("사진 1.png")).toBe("![[사진 1.png]]");
  });
});

describe("attachmentFailureMessage", () => {
  it("maps ATTACH_COPY: to the copy-failure message", () => {
    expect(attachmentFailureMessage("ATTACH_COPY: disk full")).toBe(VAULT_ATTACHMENT_MESSAGES["copy-failed"]);
  });
  it("falls back to the copy-failure message for an unrecognized error string", () => {
    expect(attachmentFailureMessage("some unexpected native error")).toBe(VAULT_ATTACHMENT_MESSAGES["copy-failed"]);
  });
});

describe("attachImageToVault", () => {
  const vaultRoot = "/vault";

  function makeDeps(overrides: Partial<AttachImageDeps> & { dispatch?: (arg: unknown) => void } = {}) {
    const flash = vi.fn();
    const dispatch = overrides.dispatch ?? vi.fn();
    const view =
      overrides.view === null
        ? null
        : ({ state: { selection: { main: { head: 3 } } }, dispatch } as unknown as EditorView);
    // Default invoke: resolve_image echoes back the vault-relative path the
    // shadowing check EXPECTS (root + relPath), so a happy-path test that
    // doesn't care about shadowing never incidentally triggers the warning.
    const invoke =
      overrides.invoke ??
      vi.fn((cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "resolve_image") return Promise.resolve(`${vaultRoot}/${String(args?.name ?? "")}`);
        return Promise.reject(new Error(`unexpected ${cmd}`));
      });
    const resolvedVaultRoot = overrides.vaultRoot !== undefined ? overrides.vaultRoot : vaultRoot;
    return { flash, dispatch, deps: { vaultRoot: resolvedVaultRoot, view, invoke, flash } as AttachImageDeps };
  }

  it("no owning vault: flashes the Korean message, calls invoke 0 times, dispatches nothing", async () => {
    const { flash, dispatch, deps } = makeDeps({ vaultRoot: null });
    await attachImageToVault(deps);
    expect(flash).toHaveBeenCalledWith(VAULT_ATTACHMENT_MESSAGES["no-permanent-vault"]);
    expect(deps.invoke).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("no open document: flashes the no-document message before any invoke", async () => {
    const { flash, deps } = makeDeps({ view: null });
    await attachImageToVault(deps);
    expect(flash).toHaveBeenCalledWith(VAULT_ATTACHMENT_MESSAGES["no-document"]);
    expect(deps.invoke).not.toHaveBeenCalled();
  });

  it("cancelled picker: flashes the cancelled message, never calls finalize/rollback, never dispatches", async () => {
    const invoke = vi.fn().mockResolvedValue({ status: "cancelled" });
    const { flash, dispatch, deps } = makeDeps({ invoke });
    await attachImageToVault(deps);
    expect(flash).toHaveBeenCalledWith(VAULT_ATTACHMENT_MESSAGES.cancelled);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["ATTACH_INVALID_IMAGE:", "invalid-image"],
    ["ATTACH_COPY:", "copy-failed"],
    ["ATTACH_DIR_INVALID:", "dir-invalid"],
    ["ATTACH_ESCAPE:", "escape"],
  ] as const)("import failure %s: flashes the mapped Korean message, never dispatches", async (prefix, kind) => {
    const invoke = vi.fn().mockRejectedValue(`${prefix} detail`);
    const { flash, dispatch, deps } = makeDeps({ invoke });
    await attachImageToVault(deps);
    expect(flash).toHaveBeenCalledWith(VAULT_ATTACHMENT_MESSAGES[kind]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("happy path (imported, outside-vault source): inserts embedMarkdownFor(fileName), then finalizes exactly once", async () => {
    const invoke = vi.fn().mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "import_vault_attachment") {
        return Promise.resolve({
          status: "imported",
          receipt: { token: 42, relPath: ".attachments/pic.png", fileName: "pic.png" },
        });
      }
      if (cmd === "finalize_attachment_import") return Promise.resolve(undefined);
      if (cmd === "resolve_image") return Promise.resolve(`${vaultRoot}/.attachments/${String(args?.name ?? "")}`);
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    const dispatch = vi.fn();
    const { flash, deps } = makeDeps({ invoke, dispatch });

    await attachImageToVault(deps);

    expect(dispatch).toHaveBeenCalledTimes(1);
    const call = dispatch.mock.calls[0][0] as { changes: { from: number; insert: string } };
    expect(call.changes).toEqual({ from: 3, insert: "![[pic.png]]" });
    expect(invoke).toHaveBeenCalledWith("finalize_attachment_import", { token: 42 });
    expect(invoke).not.toHaveBeenCalledWith("rollback_attachment_import", expect.anything());
    expect(flash).not.toHaveBeenCalled(); // resolve_image echoed the expected path — no shadow warning
  });

  it("alreadyInVault outcome: inserts embedMarkdownFor(fileName) with NO copy/finalize/rollback invoke", async () => {
    const invoke = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === "import_vault_attachment") return Promise.resolve({ status: "alreadyInVault", fileName: "pic.png" });
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    const dispatch = vi.fn();
    const { flash, deps } = makeDeps({ invoke, dispatch });

    await attachImageToVault(deps);

    expect(dispatch).toHaveBeenCalledTimes(1);
    const call = dispatch.mock.calls[0][0] as { changes: { from: number; insert: string } };
    expect(call.changes).toEqual({ from: 3, insert: "![[pic.png]]" });
    // Nothing was copied for this outcome — no finalize, no rollback, and
    // (design's explicit scope) no shadow-check resolve_image call either.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith("finalize_attachment_import", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("rollback_attachment_import", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("resolve_image", expect.anything());
    expect(flash).not.toHaveBeenCalled();
  });

  it("forced synchronous insertion failure (imported): rolls back the SAME token, flashes insertion-failed, never finalizes", async () => {
    const invoke = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === "import_vault_attachment") {
        return Promise.resolve({
          status: "imported",
          receipt: { token: 7, relPath: ".attachments/pic.png", fileName: "pic.png" },
        });
      }
      if (cmd === "rollback_attachment_import") return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    const dispatch = vi.fn(() => {
      throw new Error("dispatch exploded");
    });
    const { flash, deps } = makeDeps({ invoke, dispatch });

    await attachImageToVault(deps);

    expect(invoke).toHaveBeenCalledWith("rollback_attachment_import", { token: 7 });
    expect(invoke).not.toHaveBeenCalledWith("finalize_attachment_import", expect.anything());
    expect(flash).toHaveBeenCalledWith(VAULT_ATTACHMENT_MESSAGES["insertion-failed"]);
  });

  it("forced synchronous insertion failure (alreadyInVault): nothing to roll back, just reports insertion-failed", async () => {
    const invoke = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === "import_vault_attachment") return Promise.resolve({ status: "alreadyInVault", fileName: "pic.png" });
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    const dispatch = vi.fn(() => {
      throw new Error("dispatch exploded");
    });
    const { flash, deps } = makeDeps({ invoke, dispatch });

    await attachImageToVault(deps);

    expect(invoke).toHaveBeenCalledTimes(1); // import only — no rollback call exists for this outcome
    expect(invoke).not.toHaveBeenCalledWith("rollback_attachment_import", expect.anything());
    expect(flash).toHaveBeenCalledWith(VAULT_ATTACHMENT_MESSAGES["insertion-failed"]);
  });

  it("rollback failure ROLLBACK_IO: flashes the retained-file message", async () => {
    const invoke = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === "import_vault_attachment") {
        return Promise.resolve({
          status: "imported",
          receipt: { token: 1, relPath: ".attachments/pic.png", fileName: "pic.png" },
        });
      }
      if (cmd === "rollback_attachment_import") return Promise.reject("ROLLBACK_IO: .attachments/pic.png");
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    const dispatch = vi.fn(() => {
      throw new Error("dispatch exploded");
    });
    const { flash, deps } = makeDeps({ invoke, dispatch });

    await attachImageToVault(deps);

    expect(flash).toHaveBeenCalledWith(VAULT_ATTACHMENT_MESSAGES["rollback-io"]);
  });

  it("rollback failure ROLLBACK_CHANGED: flashes the preserved-because-changed message", async () => {
    const invoke = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === "import_vault_attachment") {
        return Promise.resolve({
          status: "imported",
          receipt: { token: 2, relPath: ".attachments/pic.png", fileName: "pic.png" },
        });
      }
      if (cmd === "rollback_attachment_import") return Promise.reject("ROLLBACK_CHANGED: .attachments/pic.png");
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    const dispatch = vi.fn(() => {
      throw new Error("dispatch exploded");
    });
    const { flash, deps } = makeDeps({ invoke, dispatch });

    await attachImageToVault(deps);

    expect(flash).toHaveBeenCalledWith(VAULT_ATTACHMENT_MESSAGES["rollback-changed"]);
  });

  // -------------------------------------------------------------------------
  // Shadowing warning (design §분기4) — a post-insert resolve_image lookup
  // that lands on a DIFFERENT file than the one just imported. The insertion
  // itself is never touched; this is a visibility nudge only.
  // -------------------------------------------------------------------------

  it("shadow warning: a post-insert resolve_image landing on a DIFFERENT path flashes the shadowing warning", async () => {
    const invoke = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === "import_vault_attachment") {
        return Promise.resolve({
          status: "imported",
          receipt: { token: 9, relPath: ".attachments/pic.png", fileName: "pic.png" },
        });
      }
      if (cmd === "finalize_attachment_import") return Promise.resolve(undefined);
      if (cmd === "resolve_image") return Promise.resolve("/vault/pic.png"); // a shallower match wins instead
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    const { flash, deps } = makeDeps({ invoke });

    await attachImageToVault(deps);

    expect(flash).toHaveBeenCalledWith(SHADOWED_IMAGE_NAME_WARNING);
  });

  it("shadow warning: a post-insert resolve_image landing on the SAME expected path flashes nothing", async () => {
    const invoke = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === "import_vault_attachment") {
        return Promise.resolve({
          status: "imported",
          receipt: { token: 10, relPath: ".attachments/pic.png", fileName: "pic.png" },
        });
      }
      if (cmd === "finalize_attachment_import") return Promise.resolve(undefined);
      if (cmd === "resolve_image") return Promise.resolve(`${vaultRoot}/.attachments/pic.png`);
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    const { flash, deps } = makeDeps({ invoke });

    await attachImageToVault(deps);

    expect(flash).not.toHaveBeenCalledWith(SHADOWED_IMAGE_NAME_WARNING);
  });

  it("shadow warning: a failed resolve_image lookup is swallowed — no flash, attach still reported as successful", async () => {
    const invoke = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === "import_vault_attachment") {
        return Promise.resolve({
          status: "imported",
          receipt: { token: 11, relPath: ".attachments/pic.png", fileName: "pic.png" },
        });
      }
      if (cmd === "finalize_attachment_import") return Promise.resolve(undefined);
      if (cmd === "resolve_image") return Promise.reject(new Error("backend hiccup"));
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    const { flash, deps } = makeDeps({ invoke });

    await expect(attachImageToVault(deps)).resolves.toBeUndefined();
    expect(flash).not.toHaveBeenCalled();
  });
});
