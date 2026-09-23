// The source-code viewer's extension → hljs-language mapping (Stage A,
// _workspace/01_architect_plan.md, 01_architect_design.md §3.1). Pure — no
// DOM, no IO, no hljs import at module load time (that stays confined to
// `index.ts`'s `open()` handler, design §2's cold-load rule).
//
// SINGLE SOURCE OF TRUTH: `CODE_VIEWER_EXTENSIONS` (the viewer's
// `Viewer.extensions` claim list) is DERIVED from this table's keys — the
// claim set and the language dispatch can never drift apart, because there
// is exactly one place either could be edited.
import type { HLJSApi, LanguageFn } from "highlight.js";

/** Extension (lowercase, no leading dot) → hljs language name, or `null` for
 *  an extension this viewer claims (so the file opens here, not falls
 *  through to the editor or an OS default-app) but renders as plain text —
 *  currently only `gradle` (Groovy has no grammar in `highlight.js/lib/common`
 *  and this viewer deliberately does not pull in the full 190+-language
 *  bundle for one extension, design §2). Deliberately excludes anything
 *  another viewer/the editor already claims (image/hwp/sqlite/epub/excel/
 *  html/pdf/docx, and md/markdown/txt — design §3.1's collision table). */
export const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string | null>> = Object.freeze({
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  py: "python",
  pyw: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  cfg: "ini",
  xml: "xml",
  xsd: "xml",
  xsl: "xml",
  plist: "xml",
  vue: "xml",
  svelte: "xml",
  css: "css",
  scss: "scss",
  less: "less",
  lua: "lua",
  r: "r",
  pl: "perl",
  pm: "perl",
  dart: "dart",
  dockerfile: "dockerfile",
  makefile: "makefile",
  mk: "makefile",
  diff: "diff",
  patch: "diff",
  graphql: "graphql",
  gql: "graphql",
  gradle: null,
});

/** The viewer's `Viewer.extensions` claim list — derived, never hand-kept in
 *  parallel with the table above. Pure query (a frozen array literal). */
export const CODE_VIEWER_EXTENSIONS: readonly string[] = Object.freeze(Object.keys(LANGUAGE_BY_EXTENSION));

/** Languages `highlight.js/lib/common` does not bundle, dynamic-imported
 *  alongside `lib/common` inside `index.ts`'s `open()` (never at boot —
 *  design §2's cold-load rule). Each entry's `load()` returns the module a
 *  `hljs.registerLanguage(name, mod.default)` call expects. */
export const EXTRA_LANGUAGES: ReadonlyArray<{ name: string; load: () => Promise<{ default: LanguageFn }> }> = [
  { name: "dockerfile", load: () => import("highlight.js/lib/languages/dockerfile") },
  { name: "dart", load: () => import("highlight.js/lib/languages/dart") },
];

// Re-exported only for this module's own test file (typo-guard test loads
// hljs itself) — not part of the viewer's runtime import graph.
export type { HLJSApi };

/** The file extension of `path`'s basename, lowercased, last-dot-only, ""
 *  for a dotfile/no-extension/trailing-dot name — the SAME contract
 *  `sidebar/explorer/file-icons.ts`'s `extensionOf` promises, reimplemented
 *  locally because `src/extensions/**` may only import the `../../api`
 *  facade or a sibling file (tests/api-fence.test.ts), never a mermark
 *  module outside its own tree directly (excel-viewer's `decode-input.ts`
 *  sets the same precedent: a local regex/rule instead of importing
 *  `extensionOf`). Pure query. */
export function extensionOfPath(path: string): string {
  const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** The hljs language name for `ext` (any case, an optional leading dot), or
 *  `null` if this viewer does not claim it OR claims it as plain text
 *  (`gradle`). Never throws — a hostile/malformed extension (path traversal
 *  strings, `"constructor"`/`"__proto__"`) simply misses the lookup.
 *  `Object.prototype.hasOwnProperty.call` (not `in`/bracket-index alone,
 *  same idiom `favorite-vault-migration.ts` uses — this repo's target
 *  predates `Object.hasOwn`) blocks prototype-chain properties like
 *  `"constructor"` or `"toString"` from resolving to a built-in
 *  Object.prototype value instead of `undefined`. Pure query. */
export function languageForExtension(ext: string): string | null {
  const normalized = ext.toLowerCase().replace(/^\./, "");
  if (!Object.prototype.hasOwnProperty.call(LANGUAGE_BY_EXTENSION, normalized)) return null;
  return LANGUAGE_BY_EXTENSION[normalized];
}
