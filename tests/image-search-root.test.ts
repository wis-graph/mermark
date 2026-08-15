// owningVaultRoot — the single, pure rule for "which vault root does THIS
// document belong to?" (design §분기1, plan F1). Deliberately takes NO
// concept of "the active vault": its only inputs are the document's own
// directory and the list of registered permanent vault roots, so switching
// the active vault in the UI can never change what a document's `![[name]]`
// resolves against. That's the exact bug this whole change reverts
// (src/main.ts:703-706's old `setVaultImageContext` read `currentVault()`).
import { describe, it, expect } from "vitest";
import { owningVaultRoot } from "../src/markdown/image-search-root";

describe("owningVaultRoot", () => {
  it("picks the deepest (most specific) owning root when vaults nest", () => {
    expect(owningVaultRoot("/proj/sub/notes", ["/proj", "/proj/sub"])).toBe("/proj/sub");
  });

  it("falls back to the shallower root when the document is outside the nested vault", () => {
    expect(owningVaultRoot("/proj/assets", ["/proj", "/proj/sub"])).toBe("/proj");
  });

  it("returns null when the document is outside every registered root", () => {
    expect(owningVaultRoot("/elsewhere", ["/proj", "/proj/sub"])).toBeNull();
  });

  it("is boundary-safe: a sibling directory that merely shares a string prefix never matches", () => {
    // /proj2/x looks like it starts with "/proj" as a raw string, but isn't
    // inside it as a path — isPathInsideRoot's boundary-safety must survive
    // reuse here (the exact hazard its own doc comment calls out).
    expect(owningVaultRoot("/proj2/x", ["/proj"])).toBeNull();
  });

  it("treats the document directory itself as inside a root that equals it", () => {
    expect(owningVaultRoot("/proj/sub", ["/proj", "/proj/sub"])).toBe("/proj/sub");
  });

  it("resolution is a pure function of document dir and registered roots — no active-vault concept exists to pass in", () => {
    // Same document dir, same registered roots, called twice with fresh
    // arrays — must always agree. There is no third "active vault" parameter
    // this function could even accept; the signature itself is the guard
    // against the bug this change reverts.
    const dir = "/proj/sub/notes";
    const roots = ["/proj", "/proj/sub"];
    expect(owningVaultRoot(dir, [...roots])).toBe(owningVaultRoot(dir, [...roots]));
    expect(owningVaultRoot.length).toBe(2); // (documentDir, vaultRoots) — nothing else
  });

  it("returns null when no roots are registered", () => {
    expect(owningVaultRoot("/proj/sub/notes", [])).toBeNull();
  });

  it("regression (00_request_vaultimage_fix.md 결함1): /proj/sub/note.md's search root is /proj/sub whether the app's active vault is /proj or /proj/sub", () => {
    // The old bug: setVaultImageContext(() => currentVault()...) made a
    // document's image resolution depend on which vault the SIDEBAR had
    // active, so /proj/sub/note.md resolved against /proj when /proj was
    // active and against /proj/sub when /proj/sub was active — same file,
    // same line, two different pictures depending on app state. Simulate
    // "switching the active vault" by calling with the roots in a
    // different registration order (registration/selection order is the
    // only thing "active vault" could smuggle in through this signature) —
    // the result must not move.
    const doc = "/proj/sub/note.md";
    const rootsAsIfProjActive = ["/proj", "/proj/sub"];
    const rootsAsIfSubActive = ["/proj/sub", "/proj"];
    expect(owningVaultRoot(doc, rootsAsIfProjActive)).toBe("/proj/sub");
    expect(owningVaultRoot(doc, rootsAsIfSubActive)).toBe("/proj/sub");
    expect(owningVaultRoot(doc, rootsAsIfProjActive)).toBe(owningVaultRoot(doc, rootsAsIfSubActive));
  });
});
