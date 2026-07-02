import { describe, it, expect } from "vitest";
import { extensionOf, iconNameForEntry } from "../src/explorer/file-icons";

// ---------------------------------------------------------------------------
// Pure extension parsing + icon map. No DOM, no backend — just the two named
// rules the explorer glyph resolution and the .md open-gate both depend on.
// ---------------------------------------------------------------------------

describe("extensionOf: the single extension-parsing rule", () => {
  it("lowercases the extension (case-insensitive)", () => {
    expect(extensionOf("note.md")).toBe("md");
    expect(extensionOf("NOTE.MD")).toBe("md");
    expect(extensionOf("README.MD")).toBe("md");
  });

  it("takes the LAST dot for multi-dot names", () => {
    expect(extensionOf("a.test.ts")).toBe("ts");
    expect(extensionOf("archive.tar.gz")).toBe("gz");
  });

  it("returns '' when there is no extension", () => {
    expect(extensionOf("README")).toBe("");
  });

  it("returns '' for a dotfile (leading dot is not an extension)", () => {
    expect(extensionOf(".gitignore")).toBe("");
  });

  it("returns '' for a trailing dot (nothing after it)", () => {
    expect(extensionOf("foo.")).toBe("");
  });
});

describe("iconNameForEntry: folders swap on open state; files map by extension", () => {
  it("folders resolve by expanded state and ignore the name", () => {
    expect(iconNameForEntry("src", true, false)).toBe("folder");
    expect(iconNameForEntry("src", true, true)).toBe("folder-open");
    expect(iconNameForEntry("a.md", true, true)).toBe("folder-open"); // name ignored
  });

  it("markdown → file-text", () => {
    expect(iconNameForEntry("note.md", false, false)).toBe("file-text");
    expect(iconNameForEntry("x.markdown", false, false)).toBe("file-text");
  });

  it("images → file-image (case-insensitive)", () => {
    expect(iconNameForEntry("pic.png", false, false)).toBe("file-image");
    expect(iconNameForEntry("a.svg", false, false)).toBe("file-image");
    expect(iconNameForEntry("b.WEBP", false, false)).toBe("file-image");
  });

  it("json → braces", () => {
    expect(iconNameForEntry("data.json", false, false)).toBe("braces");
  });

  it("code → file-code", () => {
    expect(iconNameForEntry("main.ts", false, false)).toBe("file-code");
    expect(iconNameForEntry("app.rs", false, false)).toBe("file-code");
    expect(iconNameForEntry("run.sh", false, false)).toBe("file-code");
  });

  it("pdf and unmapped / extensionless / dotfiles fall back to generic file", () => {
    expect(iconNameForEntry("doc.pdf", false, false)).toBe("file");
    expect(iconNameForEntry("bin.xyz", false, false)).toBe("file");
    expect(iconNameForEntry("README", false, false)).toBe("file");
    expect(iconNameForEntry(".gitignore", false, false)).toBe("file");
  });
});
