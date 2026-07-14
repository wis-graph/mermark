import { describe, it, expect } from "vitest";
import { extensionOf, iconNameForEntry, IMAGE_EXTENSIONS } from "../src/sidebar/explorer/file-icons";

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

// Since R11 (_workspace/01_r11.md §3), IMAGE_EXTENSIONS no longer solely owns
// the explorer open-gate (that's the viewer registry's `viewerFor` now) — it
// stays the single source the icon map (EXT_ICON) AND main.ts's built-in
// image-viewer registration both derive from, so this SSOT test now checks
// membership directly against the exported Set instead of a deleted
// `isImageExtension` predicate.
describe("IMAGE_EXTENSIONS: the single image-extension SSOT (icon map + built-in viewer registration)", () => {
  it("contains every image extension mermark opens in the viewer", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]) {
      expect(IMAGE_EXTENSIONS.has(ext)).toBe(true);
    }
  });

  it("does not contain non-image extensions or uppercase input (extensionOf already lowercases)", () => {
    expect(IMAGE_EXTENSIONS.has("md")).toBe(false);
    expect(IMAGE_EXTENSIONS.has("ts")).toBe(false);
    expect(IMAGE_EXTENSIONS.has("")).toBe(false);
    expect(IMAGE_EXTENSIONS.has("PNG")).toBe(false);
  });

  it("iconNameForEntry maps bmp/avif to file-image (EXT_ICON derives from IMAGE_EXTENSIONS)", () => {
    expect(iconNameForEntry("shot.bmp", false, false)).toBe("file-image");
    expect(iconNameForEntry("a.avif", false, false)).toBe("file-image");
  });

  // R11 design §3's drift guard (§9 RED-4): every extension the built-in
  // image viewer would claim (IMAGE_EXTENSIONS, what main.ts registers) has
  // a concrete `file-image` icon entry — not the generic fallback. A viewer
  // registered for an extension with no icon would silently show a wrong
  // glyph forever (this session's "test a guard both ways" lesson).
  it("every IMAGE_EXTENSIONS member resolves to file-image, never the generic fallback", () => {
    for (const ext of IMAGE_EXTENSIONS) {
      expect(iconNameForEntry(`f.${ext}`, false, false)).toBe("file-image");
    }
  });
});
