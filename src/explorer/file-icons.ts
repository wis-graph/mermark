import type { IconName } from "../icons";

// ---------------------------------------------------------------------------
// Explorer file/folder icon resolution — a PURE lookup, not a setting. The
// extension → icon map is a fixed curated constant (mermark ships it, the user
// doesn't toggle it), so there is no `defineSetting`, no SSOT fan-out, and no
// side effects. Kept out of explorer-panel.ts so the parsing rule lives in one
// named place and unit-tests without a DOM.
// ---------------------------------------------------------------------------

/** The file extension of `name`, lowercased, or "" when there is none. The
 *  single extension-parsing rule (so `isMarkdownEntry` and the icon map agree):
 *  - lowercased — "README.MD" → "md" (case-insensitive like the OS-agnostic gate).
 *  - last dot only — "a.test.ts" → "ts", "archive.tar.gz" → "gz".
 *  - no dot → "" — "README" → "" (generic).
 *  - dotfile → "" — ".gitignore"'s leading dot is not an extension (dot at 0).
 *  - trailing dot → "" — "foo." → "" (nothing after the dot).
 *  Pure query: returns a value, touches nothing. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** Extension → curated icon id. A tight set (one shared icon per file family)
 *  so the explorer reads at a glance; anything not listed falls back to the
 *  generic `file`. Keyed by the lowercased extension `extensionOf` returns. */
const EXT_ICON: Readonly<Record<string, IconName>> = {
  md: "file-text",
  markdown: "file-text",
  png: "file-image",
  jpg: "file-image",
  jpeg: "file-image",
  gif: "file-image",
  svg: "file-image",
  webp: "file-image",
  json: "braces",
  js: "file-code",
  ts: "file-code",
  jsx: "file-code",
  tsx: "file-code",
  rs: "file-code",
  py: "file-code",
  go: "file-code",
  c: "file-code",
  cpp: "file-code",
  h: "file-code",
  sh: "file-code",
};

/** The icon id for a tree entry. Folders swap on open state (`folder-open` when
 *  expanded, else `folder`) and ignore `name`; files map by extension through
 *  EXT_ICON, defaulting to the generic `file`. Returns an `IconName` so callers
 *  pass it straight to `icon()` type-safely. Pure query. */
export function iconNameForEntry(name: string, isDir: boolean, expanded: boolean): IconName {
  if (isDir) return expanded ? "folder-open" : "folder";
  return EXT_ICON[extensionOf(name)] ?? "file";
}
