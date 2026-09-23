import { describe, it, expect } from "vitest";
import {
  LANGUAGE_BY_EXTENSION,
  CODE_VIEWER_EXTENSIONS,
  languageForExtension,
} from "../src/extensions/code-viewer/language-map";
import { EXTRA_LANGUAGES } from "../src/extensions/code-viewer/language-map";

// Stage A (01_architect_plan.md §1 Stage A) — pure extension→hljs-language
// mapping, no DOM/IO. `languageForExtension` is the single source both the
// viewer's claim list (`CODE_VIEWER_EXTENSIONS`) and its highlight dispatch
// derive from (design §3.1).

describe("languageForExtension", () => {
  it("maps known extensions to their hljs language name", () => {
    expect(languageForExtension("ts")).toBe("typescript");
    expect(languageForExtension("tsx")).toBe("typescript");
    expect(languageForExtension("mjs")).toBe("javascript");
    expect(languageForExtension("toml")).toBe("ini");
    expect(languageForExtension("vue")).toBe("xml");
    expect(languageForExtension("dockerfile")).toBe("dockerfile");
    expect(languageForExtension("dart")).toBe("dart");
    expect(languageForExtension("kts")).toBe("kotlin");
    expect(languageForExtension("h")).toBe("c");
    expect(languageForExtension("hpp")).toBe("cpp");
  });

  it("claims gradle but returns null (plain text, no Groovy grammar in common)", () => {
    expect(languageForExtension("gradle")).toBeNull();
  });

  it("returns null for extensions this viewer never claims", () => {
    expect(languageForExtension("md")).toBeNull();
    expect(languageForExtension("txt")).toBeNull();
    expect(languageForExtension("exe")).toBeNull();
    expect(languageForExtension("")).toBeNull();
  });

  it("normalizes case and a leading dot, never throws", () => {
    expect(languageForExtension("TS")).toBe("typescript");
    expect(languageForExtension(".ts")).toBe("typescript");
    expect(() => languageForExtension("../../etc/passwd")).not.toThrow();
    expect(() => languageForExtension("constructor")).not.toThrow();
    expect(languageForExtension("constructor")).toBeNull();
  });
});

describe("CODE_VIEWER_EXTENSIONS", () => {
  it("is exactly Object.keys(LANGUAGE_BY_EXTENSION) — single source of truth", () => {
    expect(CODE_VIEWER_EXTENSIONS).toEqual(Object.keys(LANGUAGE_BY_EXTENSION));
  });

  const FORBIDDEN_EXTENSIONS = [
    "md",
    "markdown",
    "txt",
    "html",
    "htm",
    "csv",
    "svg",
    "xlsx",
    "pdf",
    "docx",
    "hwp",
    "epub",
    "sqlite",
    "db",
  ];

  it.each(FORBIDDEN_EXTENSIONS)("never claims %s (owned by another viewer or the editor)", (ext) => {
    expect(CODE_VIEWER_EXTENSIONS).not.toContain(ext);
  });

  it("every claimed extension is lowercase, has no leading dot, and is non-empty", () => {
    for (const ext of CODE_VIEWER_EXTENSIONS) {
      expect(ext).toBe(ext.toLowerCase());
      expect(ext.startsWith(".")).toBe(false);
      expect(ext.length).toBeGreaterThan(0);
    }
  });

  // Typo guard: every non-null hljs language name this registry claims must
  // actually exist once EXTRA_LANGUAGES (dockerfile/dart) are registered on
  // top of `highlight.js/lib/common` — catches a language name typo'd into
  // LANGUAGE_BY_EXTENSION that would silently render as plain text forever.
  it("every non-null language name resolves to a real hljs grammar", async () => {
    const hljs = (await import("highlight.js/lib/common")).default;
    for (const extra of EXTRA_LANGUAGES) {
      const mod = await extra.load();
      hljs.registerLanguage(extra.name, mod.default);
    }
    for (const [ext, lang] of Object.entries(LANGUAGE_BY_EXTENSION)) {
      if (lang === null) continue;
      expect(hljs.getLanguage(lang), `extension "${ext}" claims language "${lang}"`).toBeTruthy();
    }
  });
});
