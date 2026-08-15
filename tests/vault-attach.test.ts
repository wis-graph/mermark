// Vault image attachment — single-window-opening Wave 2, Todo 5 (frontend
// half). Consumes Todo 4's pure contracts (vault-image.ts, already covered
// by tests/image.test.ts) and tests the async resolution pipeline
// (resolveVaultImage), the rendering widget (VaultImageWidget), and the
// attach-action orchestration (attachImageToVault) — all in
// vault-image-widget.ts.
//
// mock-fidelity boundary (design §분기7, plan's explicit instruction): this
// suite proves the ORCHESTRATION contract only — invoke call order/args,
// token plumbing, Korean message selection, and that the document/existing
// files are preserved on every failure path. It does NOT and CANNOT prove
// atomicity (hard_link no-replace), real (dev,ino) file identity, or
// TempGuard cleanup — those are native properties only
// `src-tauri/src/attachment_import.rs`'s cargo temp-vault integration tests
// can verify. "This file green" + "cargo attachment --lib green" together is
// the safety claim; this file alone is not.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EditorView } from "@codemirror/view";

const invokeSpy = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://localhost${p}`,
  invoke: (...args: unknown[]) => invokeSpy(...args),
}));

import {
  resolveVaultImage,
  VaultImageWidget,
  attachImageToVault,
  type AttachImageDeps,
} from "../src/markdown/vault-image-widget";
import { setImageOpenHandler } from "../src/markdown/image-open";
import { VAULT_ATTACHMENT_MESSAGES, VAULT_IMAGE_REJECTION_MESSAGES, setVaultImageContext, type VaultImageContext } from "../src/markdown/vault-image";
import { mountEditor } from "../src/editor";

const fakeView = {} as unknown as EditorView;

// ---------------------------------------------------------------------------
// resolveVaultImage — the async canonicalize+containment+regular-file+
// extension chain (design §분기1). No early-return acceptance: every ok
// result below goes through every gate.
// ---------------------------------------------------------------------------

describe("resolveVaultImage", () => {
  const context: VaultImageContext = { rootPath: "/vault" };

  beforeEach(() => {
    invokeSpy.mockReset();
  });

  /** Route the two canonicalize_path calls and the one path_exists call by
   *  their input path — resolveVaultImage always calls them in this exact
   *  order (root, then candidate, then existence), so a simple lookup table
   *  keyed on the requested path is enough to script every scenario below. */
  function scriptInvoke(opts: {
    canon?: Record<string, string | "reject">;
    exists?: Record<string, boolean>;
  }) {
    invokeSpy.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === "canonicalize_path") {
        const path = String(args.path);
        const mapped = opts.canon?.[path];
        if (mapped === undefined || mapped === "reject") return Promise.reject(new Error("no such path"));
        return Promise.resolve(mapped);
      }
      if (cmd === "path_exists") {
        return Promise.resolve(opts.exists?.[String(args.path)] ?? false);
      }
      return Promise.reject(new Error(`unexpected invoke ${cmd}`));
    });
  }

  it("resolves an exact .attachments reference under the vault root — nested doc irrelevant, only the vault root matters", async () => {
    scriptInvoke({
      canon: { "/vault": "/vault", "/vault/.attachments/pic.png": "/vault/.attachments/pic.png" },
      exists: { "/vault/.attachments/pic.png": true },
    });

    const result = await resolveVaultImage("vault:.attachments/pic.png", context);

    expect(result).toEqual({
      ok: true,
      url: "asset://localhost/vault/.attachments/pic.png",
      canonTarget: "/vault/.attachments/pic.png",
    });
    expect(invokeSpy).toHaveBeenNthCalledWith(1, "canonicalize_path", { path: "/vault" });
    expect(invokeSpy).toHaveBeenNthCalledWith(2, "canonicalize_path", { path: "/vault/.attachments/pic.png" });
    expect(invokeSpy).toHaveBeenNthCalledWith(3, "path_exists", { path: "/vault/.attachments/pic.png" });
    expect(invokeSpy).toHaveBeenCalledTimes(3);
  });

  it("resolves a nested vault-relative path (not just .attachments)", async () => {
    scriptInvoke({
      canon: { "/vault": "/vault", "/vault/notes/img/pic.png": "/vault/notes/img/pic.png" },
      exists: { "/vault/notes/img/pic.png": true },
    });

    const result = await resolveVaultImage("vault:notes/img/pic.png", context);

    expect(result).toEqual({
      ok: true,
      url: "asset://localhost/vault/notes/img/pic.png",
      canonTarget: "/vault/notes/img/pic.png",
    });
  });

  it("no-permanent-vault when context is null — invoke is never called (structural containment, no IO)", async () => {
    const result = await resolveVaultImage("vault:.attachments/pic.png", null);
    expect(result).toEqual({ ok: false, reason: "no-permanent-vault" });
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("vault-root-unavailable when canonicalizing the vault root rejects", async () => {
    scriptInvoke({ canon: {} }); // /vault -> reject (not scripted)
    const result = await resolveVaultImage("vault:.attachments/pic.png", context);
    expect(result).toEqual({ ok: false, reason: "vault-root-unavailable" });
  });

  it("missing-target when canonicalizing the candidate rejects", async () => {
    scriptInvoke({ canon: { "/vault": "/vault" } }); // candidate path unscripted -> reject
    const result = await resolveVaultImage("vault:.attachments/pic.png", context);
    expect(result).toEqual({ ok: false, reason: "missing-target" });
  });

  it("outside-vault when the canonicalized target escapes the root (symlink escape)", async () => {
    scriptInvoke({
      canon: { "/vault": "/vault", "/vault/.attachments/pic.png": "/etc/escaped.png" },
    });
    const result = await resolveVaultImage("vault:.attachments/pic.png", context);
    expect(result).toEqual({ ok: false, reason: "outside-vault" });
  });

  it("not-a-regular-file when path_exists is false (directory or special file)", async () => {
    scriptInvoke({
      canon: { "/vault": "/vault", "/vault/.attachments/pic.png": "/vault/.attachments/pic.png" },
      exists: { "/vault/.attachments/pic.png": false },
    });
    const result = await resolveVaultImage("vault:.attachments/pic.png", context);
    expect(result).toEqual({ ok: false, reason: "not-a-regular-file" });
  });

  it("not-an-image when the RESOLVED real path (after symlink resolution) has a non-image extension", async () => {
    // The raw ref itself passes the pure parse-time extension gate (.png),
    // but canonicalize followed a symlink to a real file with a different
    // extension — this is the re-check step 8 exists for.
    scriptInvoke({
      canon: { "/vault": "/vault", "/vault/.attachments/link.png": "/vault/.attachments/movie.mp4" },
      exists: { "/vault/.attachments/movie.mp4": true },
    });
    const result = await resolveVaultImage("vault:.attachments/link.png", context);
    expect(result).toEqual({ ok: false, reason: "not-an-image" });
  });

  it("a parse-time rejection (e.g. traversal) never reaches invoke", async () => {
    const result = await resolveVaultImage("vault:../escape.png", context);
    expect(result).toEqual({ ok: false, reason: "traversal" });
    expect(invokeSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// VaultImageWidget — pending→resolve→DOM-swap (WikilinkWidget/ImageWidget
// precedent). The raw document text is never touched by any of this (the
// widget only decorates); that invariant is the render-smoke suite's job,
// not this file's.
// ---------------------------------------------------------------------------

describe("VaultImageWidget", () => {
  const context: VaultImageContext = { rootPath: "/vault" };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    invokeSpy.mockReset();
  });

  it("toDOM swaps img.src on a successful resolution", async () => {
    invokeSpy.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === "canonicalize_path") return Promise.resolve(String(args.path));
      if (cmd === "path_exists") return Promise.resolve(true);
      return Promise.reject(new Error("unexpected"));
    });
    const widget = new VaultImageWidget("vault:.attachments/pic.png", "pic", context);
    const img = widget.toDOM(fakeView) as HTMLImageElement;
    await flush();
    expect(img.src).toBe("asset://localhost/vault/.attachments/pic.png");
    expect(img.classList.contains("cm-vault-image-error")).toBe(false);
  });

  it("toDOM marks a failed resolution with the error class and a Korean title", async () => {
    // context null -> no-permanent-vault, resolved synchronously (no invoke).
    const widget = new VaultImageWidget("vault:.attachments/pic.png", "pic", null);
    const img = widget.toDOM(fakeView) as HTMLImageElement;
    await flush();
    expect(img.classList.contains("cm-vault-image-error")).toBe(true);
    expect(img.title).toBe(VAULT_IMAGE_REJECTION_MESSAGES["no-permanent-vault"]);
  });

  it("eq() includes both raw and the context's rootPath — a vault switch invalidates DOM reuse", () => {
    const a = new VaultImageWidget("vault:.attachments/pic.png", "pic", { rootPath: "/A" });
    expect(a.eq(new VaultImageWidget("vault:.attachments/pic.png", "pic", { rootPath: "/A" }))).toBe(true);
    expect(a.eq(new VaultImageWidget("vault:.attachments/pic.png", "pic", { rootPath: "/B" }))).toBe(false);
    expect(a.eq(new VaultImageWidget("vault:.attachments/other.png", "pic", { rootPath: "/A" }))).toBe(false);
    expect(a.eq(new VaultImageWidget("vault:.attachments/pic.png", "pic", null))).toBe(false);
  });

  it("a click after a successful resolution requests the viewer to open the CANONICAL target", async () => {
    invokeSpy.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === "canonicalize_path") return Promise.resolve(String(args.path));
      if (cmd === "path_exists") return Promise.resolve(true);
      return Promise.reject(new Error("unexpected"));
    });
    const openSpy = vi.fn();
    setImageOpenHandler(openSpy);
    const widget = new VaultImageWidget("vault:.attachments/pic.png", "pic", context);
    const img = widget.toDOM(fakeView) as HTMLImageElement;
    await flush();

    img.dispatchEvent(new MouseEvent("mousedown", { clientX: 0, clientY: 0, bubbles: true }));
    img.dispatchEvent(new MouseEvent("click", { clientX: 0, clientY: 0, bubbles: true }));

    expect(openSpy).toHaveBeenCalledWith("/vault/.attachments/pic.png");
  });

  it("a click on a still-unresolved (or failed) widget is a no-op — no canonTarget to open", () => {
    const openSpy = vi.fn();
    setImageOpenHandler(openSpy);
    const widget = new VaultImageWidget("vault:.attachments/pic.png", "pic", null); // synchronous no-permanent-vault
    const img = widget.toDOM(fakeView) as HTMLImageElement;
    img.dispatchEvent(new MouseEvent("mousedown", { clientX: 0, clientY: 0, bubbles: true }));
    img.dispatchEvent(new MouseEvent("click", { clientX: 0, clientY: 0, bubbles: true }));
    expect(openSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// attachImageToVault — the image.attach action body (design §분기2/3/4/7).
// Every dependency is injected, so this exercises the orchestration with no
// main.ts boot required (plan T5-F step 1's explicit testability goal).
// ---------------------------------------------------------------------------

describe("attachImageToVault", () => {
  const context: VaultImageContext = { rootPath: "/vault" };

  function makeDeps(overrides: Partial<AttachImageDeps> & { dispatch?: (arg: unknown) => void } = {}) {
    const flash = vi.fn();
    const dispatch = overrides.dispatch ?? vi.fn();
    const view = overrides.view === null ? null : ({ state: { selection: { main: { head: 3 } } }, dispatch } as unknown as EditorView);
    const invoke = overrides.invoke ?? vi.fn();
    const resolvedContext = overrides.context !== undefined ? overrides.context : context;
    return { flash, dispatch, deps: { context: resolvedContext, view, invoke, flash } as AttachImageDeps };
  }

  it("no permanent vault: flashes the Korean message, calls invoke 0 times, dispatches nothing", async () => {
    const { flash, dispatch, deps } = makeDeps({ context: null });
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

  it("happy path: inserts vaultAttachmentMarkdown(fileName) at the cursor, then finalizes exactly once", async () => {
    const invoke = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === "import_vault_attachment") {
        return Promise.resolve({ status: "imported", receipt: { token: 42, relPath: ".attachments/pic.png", fileName: "pic.png" } });
      }
      if (cmd === "finalize_attachment_import") return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    const dispatch = vi.fn();
    const { deps } = makeDeps({ invoke, dispatch });

    await attachImageToVault(deps);

    expect(dispatch).toHaveBeenCalledTimes(1);
    const call = dispatch.mock.calls[0][0] as { changes: { from: number; insert: string } };
    expect(call.changes).toEqual({ from: 3, insert: "![pic](vault:.attachments/pic.png)" });
    expect(invoke).toHaveBeenCalledWith("finalize_attachment_import", { token: 42 });
    expect(invoke).not.toHaveBeenCalledWith("rollback_attachment_import", expect.anything());
  });

  it("forced synchronous insertion failure: rolls back the SAME token, flashes insertion-failed, never finalizes", async () => {
    const invoke = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === "import_vault_attachment") {
        return Promise.resolve({ status: "imported", receipt: { token: 7, relPath: ".attachments/pic.png", fileName: "pic.png" } });
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

  it("rollback failure ROLLBACK_IO: flashes the retained-file message", async () => {
    const invoke = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === "import_vault_attachment") {
        return Promise.resolve({ status: "imported", receipt: { token: 1, relPath: ".attachments/pic.png", fileName: "pic.png" } });
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
        return Promise.resolve({ status: "imported", receipt: { token: 2, relPath: ".attachments/pic.png", fileName: "pic.png" } });
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
});

// ---------------------------------------------------------------------------
// Acceptance (design's stated acceptance criterion, T5-F step 2): a note
// nested several folders deep still renders a `.attachments` image AND an
// arbitrary valid `vault:` path — proving resolution is root-anchored, not
// baseDir-anchored (baseDir here is deliberately deep and unrelated to the
// vault root prefix used by the two references).
// ---------------------------------------------------------------------------

describe("acceptance: vault: images render from a deeply nested note", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    invokeSpy.mockReset();
    invokeSpy.mockImplementation((cmd: string, args: Record<string, unknown> = {}) => {
      if (cmd === "canonicalize_path") return Promise.resolve(String(args.path)); // identity mock — no symlinks in this fixture
      if (cmd === "path_exists") return Promise.resolve(true);
      if (cmd === "read_file") return Promise.resolve({ text: "", mtime: 1 });
      if (cmd === "write_file") return Promise.resolve(1);
      return Promise.resolve(false);
    });
    setVaultImageContext(() => ({ rootPath: "/vault" }));
  });

  it("renders a `.attachments` image and an arbitrary nested vault: image from a note nested under /vault/notes/a/b/c", async () => {
    const doc = "# Note\n\n![a](vault:.attachments/pic.png)\n\n![b](vault:notes/deep/pic2.png)\n";
    const { view } = mountEditor(host, doc, "/vault/notes/a/b/c", "/vault/notes/a/b/c/deep.md", { initialMode: "edit" });
    view.dispatch({ selection: { anchor: 0 } }); // cursor on the heading line — neither image line is revealed
    await new Promise((r) => setTimeout(r, 0));
    (view as unknown as { measure(): void }).measure();

    const imgs = host.querySelectorAll<HTMLImageElement>(".cm-vault-image");
    expect(imgs.length).toBe(2);
    imgs.forEach((img) => expect(img.classList.contains("cm-vault-image-error")).toBe(false));
    expect(imgs[0].src).toBe("asset://localhost/vault/.attachments/pic.png");
    expect(imgs[1].src).toBe("asset://localhost/vault/notes/deep/pic2.png");

    view.destroy();
  });
});
