import { describe, it, expect, vi, beforeEach } from "vitest";

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

import {
  parseLocalDocumentHref,
  isLocalDocumentLinkCandidate,
  resolveLocalDocumentLink,
  openStandardLocalLink,
  isPathInsideRoot,
  LOCAL_LINK_REJECTION_MESSAGES,
  type LocalLinkContext,
} from "../src/markdown/local-doc-link";

// ---------------------------------------------------------------------------
// Pure prefix — parseLocalDocumentHref (design §3 steps 1-10). One `it` per
// matrix row (P-1..P-16) — no bundled "rejected" assertion.
// ---------------------------------------------------------------------------
describe("parseLocalDocumentHref — pure prefix", () => {
  it("P-1: ./note.md?x=1 -> rejected (query)", () => {
    expect(parseLocalDocumentHref("./note.md?x=1")).toEqual({ ok: false, reason: "query" });
  });
  it("P-2: #section -> rejected (empty-path)", () => {
    expect(parseLocalDocumentHref("#section")).toEqual({ ok: false, reason: "empty-path" });
  });
  it("P-3: bad%zz.md -> rejected (malformed-escape)", () => {
    expect(parseLocalDocumentHref("bad%zz.md")).toEqual({ ok: false, reason: "malformed-escape" });
  });
  it("P-4: nul%00.md -> rejected (nul)", () => {
    expect(parseLocalDocumentHref("nul%00.md")).toEqual({ ok: false, reason: "nul" });
  });
  it("P-5: C:\\notes\\a.md -> rejected (drive-path)", () => {
    expect(parseLocalDocumentHref("C:\\notes\\a.md")).toEqual({ ok: false, reason: "drive-path" });
  });
  it("P-6: C:/notes/a.md -> rejected (drive-path)", () => {
    expect(parseLocalDocumentHref("C:/notes/a.md")).toEqual({ ok: false, reason: "drive-path" });
  });
  it("P-7: \\\\server\\share\\a.md -> rejected (unc-path)", () => {
    expect(parseLocalDocumentHref("\\\\server\\share\\a.md")).toEqual({ ok: false, reason: "unc-path" });
  });
  it("P-8: /abs.md -> rejected (rooted-path)", () => {
    expect(parseLocalDocumentHref("/abs.md")).toEqual({ ok: false, reason: "rooted-path" });
  });
  it("P-9: javascript:alert(1) -> rejected (scheme)", () => {
    expect(parseLocalDocumentHref("javascript:alert(1)")).toEqual({ ok: false, reason: "scheme" });
  });
  it("P-10: https%3A%2F%2Fevil.com%2Fa.md (decodes to a scheme) -> rejected (scheme)", () => {
    expect(parseLocalDocumentHref("https%3A%2F%2Fevil.com%2Fa.md")).toEqual({ ok: false, reason: "scheme" });
  });
  it("P-11: dir%5Cnote.md (%5c decodes to backslash) -> rejected (mixed-separators)", () => {
    expect(parseLocalDocumentHref("dir%5Cnote.md")).toEqual({ ok: false, reason: "mixed-separators" });
  });
  it("P-12: dir\\note.md (literal backslash) -> rejected (mixed-separators)", () => {
    expect(parseLocalDocumentHref("dir\\note.md")).toEqual({ ok: false, reason: "mixed-separators" });
  });
  it("P-13: ./img.png -> rejected (non-document-extension)", () => {
    expect(parseLocalDocumentHref("./img.png")).toEqual({ ok: false, reason: "non-document-extension" });
  });
  it("P-14: ./note.md#sec -> accepted, path=./note.md, fragment=sec", () => {
    expect(parseLocalDocumentHref("./note.md#sec")).toEqual({ ok: true, path: "./note.md", fragment: "sec" });
  });
  it("P-15: note%23x.md (encoded # -> literal filename char, not a fragment) -> accepted, path=note#x.md", () => {
    expect(parseLocalDocumentHref("note%23x.md")).toEqual({ ok: true, path: "note#x.md", fragment: null });
  });
  it("P-16: %252e%252e%2Fa.md (double-encoded — decode exactly once) -> accepted, path=%2e%2e/a.md (never promoted to ..)", () => {
    const result = parseLocalDocumentHref("%252e%252e%2Fa.md");
    expect(result).toEqual({ ok: true, path: "%2e%2e/a.md", fragment: null });
    if (result.ok) expect(result.path).not.toBe("../a.md");
  });

  it("candidate judgment reuses parseLocalDocumentHref for every P-1..P-14 input (no drift between decoration and click validation)", () => {
    const rejects = [
      "./note.md?x=1",
      "#section",
      "bad%zz.md",
      "nul%00.md",
      "C:\\notes\\a.md",
      "C:/notes/a.md",
      "\\\\server\\share\\a.md",
      "/abs.md",
      "javascript:alert(1)",
      "https%3A%2F%2Fevil.com%2Fa.md",
      "dir%5Cnote.md",
      "dir\\note.md",
      "./img.png",
    ];
    for (const href of rejects) expect(isLocalDocumentLinkCandidate(href)).toBe(false);
    expect(isLocalDocumentLinkCandidate("./note.md#sec")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isPathInsideRoot — strict boundary-character isolation judgment (H-5).
// ---------------------------------------------------------------------------
describe("isPathInsideRoot — strict boundary", () => {
  it("H-5a: a sibling directory sharing a string prefix is NOT inside", () => {
    expect(isPathInsideRoot("/vault", "/vault-evil/a.md")).toBe(false);
  });
  it("H-5b: a real child path IS inside", () => {
    expect(isPathInsideRoot("/vault", "/vault/a.md")).toBe(true);
  });
  it("H-5c: the root path itself is NOT inside (a directory is not an in-vault file)", () => {
    expect(isPathInsideRoot("/vault", "/vault")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveLocalDocumentLink — resolver stage (design §3 steps 11-17). invoke
// mocked per-case; symlink escape is simulated by making canonicalize_path
// return a path outside the vault for the relevant candidate.
// ---------------------------------------------------------------------------
const VAULT_ROOT = "/vault";
const DOC_PATH = "/vault/dir/cur.md";

function context(): LocalLinkContext {
  return { documentPath: DOC_PATH, vaultRootPath: VAULT_ROOT };
}

describe("resolveLocalDocumentLink — resolver", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("R-1: null context (global vault / no document) -> rejected, zero IPC", async () => {
    const result = await resolveLocalDocumentLink("./note.md", null);
    expect(result).toEqual({ ok: false, reason: "no-vault-context" });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("R-2: vault root canonicalize rejects -> vault-root-unavailable", async () => {
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === "canonicalize_path" && args.path === VAULT_ROOT) return Promise.reject(new Error("nope"));
      return Promise.resolve(true);
    });
    const result = await resolveLocalDocumentLink("./note.md", context());
    expect(result).toEqual({ ok: false, reason: "vault-root-unavailable" });
  });

  it("R-3: current document canonicalizes outside the vault -> document-not-in-vault", async () => {
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === "canonicalize_path" && args.path === VAULT_ROOT) return Promise.resolve("/vault");
      if (cmd === "canonicalize_path" && args.path === DOC_PATH) return Promise.resolve("/elsewhere/cur.md");
      return Promise.resolve(true);
    });
    const result = await resolveLocalDocumentLink("./note.md", context());
    expect(result).toEqual({ ok: false, reason: "document-not-in-vault" });
  });

  it("R-4: ../outside.md canonicalizes to a path outside the vault -> outside-vault", async () => {
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === "canonicalize_path" && args.path === VAULT_ROOT) return Promise.resolve("/vault");
      if (cmd === "canonicalize_path" && args.path === DOC_PATH) return Promise.resolve(DOC_PATH);
      if (cmd === "canonicalize_path") return Promise.resolve("/outside.md");
      return Promise.resolve(true);
    });
    const result = await resolveLocalDocumentLink("../outside.md", context());
    expect(result).toEqual({ ok: false, reason: "outside-vault" });
  });

  it("R-5: %2e%2e%2f%2e%2e%2fout.md (decodes to ../../out.md, resolves outside) -> outside-vault", async () => {
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === "canonicalize_path" && args.path === VAULT_ROOT) return Promise.resolve("/vault");
      if (cmd === "canonicalize_path" && args.path === DOC_PATH) return Promise.resolve(DOC_PATH);
      if (cmd === "canonicalize_path") return Promise.resolve("/out.md");
      return Promise.resolve(true);
    });
    const result = await resolveLocalDocumentLink("%2e%2e%2f%2e%2e%2fout.md", context());
    expect(result).toEqual({ ok: false, reason: "outside-vault" });
  });

  it("R-6: ./sym.md resolves through a symlink to a path outside the vault -> outside-vault", async () => {
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === "canonicalize_path" && args.path === VAULT_ROOT) return Promise.resolve("/vault");
      if (cmd === "canonicalize_path" && args.path === DOC_PATH) return Promise.resolve(DOC_PATH);
      if (cmd === "canonicalize_path") return Promise.resolve("/evil/real.md");
      return Promise.resolve(true);
    });
    const result = await resolveLocalDocumentLink("./sym.md", context());
    expect(result).toEqual({ ok: false, reason: "outside-vault" });
  });

  it("R-7: ./missing.md target canonicalize rejects (absent) -> missing-target", async () => {
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === "canonicalize_path" && args.path === VAULT_ROOT) return Promise.resolve("/vault");
      if (cmd === "canonicalize_path" && args.path === DOC_PATH) return Promise.resolve(DOC_PATH);
      if (cmd === "canonicalize_path") return Promise.reject(new Error("no such file"));
      return Promise.resolve(true);
    });
    const result = await resolveLocalDocumentLink("./missing.md", context());
    expect(result).toEqual({ ok: false, reason: "missing-target" });
  });

  it("R-8: ./folder.md canonicalizes inside the vault but path_exists is false (not a regular file) -> not-a-regular-file", async () => {
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === "canonicalize_path" && args.path === VAULT_ROOT) return Promise.resolve("/vault");
      if (cmd === "canonicalize_path" && args.path === DOC_PATH) return Promise.resolve(DOC_PATH);
      if (cmd === "canonicalize_path") return Promise.resolve("/vault/dir/folder.md");
      if (cmd === "path_exists" && args.path === DOC_PATH) return Promise.resolve(true);
      if (cmd === "path_exists" && args.path === "/vault/dir/folder.md") return Promise.resolve(false);
      return Promise.resolve(true);
    });
    const result = await resolveLocalDocumentLink("./folder.md", context());
    expect(result).toEqual({ ok: false, reason: "not-a-regular-file" });
  });

  it("H-1: ./note.md resolves inside the vault and exists -> accepted, path = canonical target", async () => {
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === "canonicalize_path" && args.path === VAULT_ROOT) return Promise.resolve("/vault");
      if (cmd === "canonicalize_path" && args.path === DOC_PATH) return Promise.resolve(DOC_PATH);
      if (cmd === "canonicalize_path") return Promise.resolve("/vault/dir/note.md");
      return Promise.resolve(true);
    });
    const result = await resolveLocalDocumentLink("./note.md", context());
    expect(result).toEqual({ ok: true, path: "/vault/dir/note.md" });
  });

  it("H-2: ../up/note.md resolves inside the vault via a lexical .. -> accepted", async () => {
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === "canonicalize_path" && args.path === VAULT_ROOT) return Promise.resolve("/vault");
      if (cmd === "canonicalize_path" && args.path === DOC_PATH) return Promise.resolve(DOC_PATH);
      if (cmd === "canonicalize_path") return Promise.resolve("/vault/up/note.md");
      return Promise.resolve(true);
    });
    const result = await resolveLocalDocumentLink("../up/note.md", context());
    expect(result).toEqual({ ok: true, path: "/vault/up/note.md" });
  });

  it("H-3: ./note.txt is accepted (same as .md)", async () => {
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === "canonicalize_path" && args.path === VAULT_ROOT) return Promise.resolve("/vault");
      if (cmd === "canonicalize_path" && args.path === DOC_PATH) return Promise.resolve(DOC_PATH);
      if (cmd === "canonicalize_path") return Promise.resolve("/vault/dir/note.txt");
      return Promise.resolve(true);
    });
    const result = await resolveLocalDocumentLink("./note.txt", context());
    expect(result).toEqual({ ok: true, path: "/vault/dir/note.txt" });
  });
});

// ---------------------------------------------------------------------------
// H-4: openStandardLocalLink command — rejection marks feedbackEl visibly in
// Korean and never opens; acceptance opens the canonical path.
// ---------------------------------------------------------------------------
describe("openStandardLocalLink — command", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("H-4: rejection marks feedbackEl with .cm-local-link-error + the matching Korean title, and never opens", async () => {
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === "canonicalize_path" && args.path === VAULT_ROOT) return Promise.resolve("/vault");
      if (cmd === "canonicalize_path" && args.path === DOC_PATH) return Promise.resolve(DOC_PATH);
      if (cmd === "canonicalize_path") return Promise.resolve("/outside.md");
      return Promise.resolve(true);
    });
    const el = document.createElement("a");
    const open = vi.fn().mockResolvedValue(true);
    await openStandardLocalLink({ href: "../outside.md", feedbackEl: el }, context(), open);
    expect(el.classList.contains("cm-local-link-error")).toBe(true);
    expect(el.title).toBe(LOCAL_LINK_REJECTION_MESSAGES["outside-vault"]);
    expect(open).not.toHaveBeenCalled();
  });

  it("no-vault-context rejection marks the Korean 'permanent vault only' message", async () => {
    const el = document.createElement("a");
    const open = vi.fn().mockResolvedValue(true);
    await openStandardLocalLink({ href: "./note.md", feedbackEl: el }, null, open);
    expect(el.classList.contains("cm-local-link-error")).toBe(true);
    expect(el.title).toBe(LOCAL_LINK_REJECTION_MESSAGES["no-vault-context"]);
    expect(open).not.toHaveBeenCalled();
  });

  it("accepted link opens the canonical path via the injected opener, no feedback marked", async () => {
    mockInvoke.mockImplementation((cmd: string, args: any) => {
      if (cmd === "canonicalize_path" && args.path === VAULT_ROOT) return Promise.resolve("/vault");
      if (cmd === "canonicalize_path" && args.path === DOC_PATH) return Promise.resolve(DOC_PATH);
      if (cmd === "canonicalize_path") return Promise.resolve("/vault/dir/note.md");
      return Promise.resolve(true);
    });
    const el = document.createElement("a");
    const open = vi.fn().mockResolvedValue(true);
    await openStandardLocalLink({ href: "./note.md", feedbackEl: el }, context(), open);
    expect(open).toHaveBeenCalledWith("/vault/dir/note.md");
    expect(el.classList.contains("cm-local-link-error")).toBe(false);
  });
});
