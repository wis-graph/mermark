import type { IconName } from "../../icons";

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

/** Extensions mermark treats as images — the source of the `file-image` icon
 *  glyph family (EXT_ICON below, derived from this set) AND the list main.ts
 *  registers the built-in image viewer for (`registerViewer({ id: "image",
 *  extensions: [...IMAGE_EXTENSIONS], ... })`). Since R11
 *  (_workspace/01_r11.md §3) this no longer solely owns "can the explorer
 *  open this file" — that's the viewer registry's `viewerFor` now (queried
 *  through main.ts's `canOpenWithViewer` injection, chrome/viewer/registry.ts)
 *  — but it's still the single place both consumers derive from, so the icon
 *  family and the registered extensions can never drift apart. Keyed by the
 *  lowercased extension `extensionOf` returns. */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "avif",
]);

/** Extensions mermark opens in its own editor (same live-preview pipeline for
 *  every member — no plain-text-mode branch). The SSOT for "can the explorer/
 *  search/wikilink layer open this file with mermark itself" — txt was added
 *  here (2026-08) to join md; `.markdown`/`.mdx` deliberately stay OUT (scoped
 *  out of the txt-as-md decision, see _workspace/01_architect_design_txt.md
 *  §0). Keyed by the lowercased extension `extensionOf` returns.
 *  Mirrored in Rust by `commands.rs`'s `is_editor_text_ext` (the
 *  `list_link_targets`/`classify_link_target` picker gate) — the language
 *  boundary means this can't be a shared reference, so the two sets are
 *  synced BY HAND. Adding an extension here without also updating
 *  `is_editor_text_ext` splits the two gates. */
export const EDITABLE_TEXT_EXTENSIONS: ReadonlySet<string> = new Set(["md", "txt"]);

/** Whether `name` is a file mermark's own editor can open (see
 *  EDITABLE_TEXT_EXTENSIONS above). Named rule so explorer-panel.ts's click
 *  gate, search-panel.ts's openability gate, and wikilink.ts's
 *  mermark-window-vs-external-app branch all converge on ONE predicate instead
 *  of re-deriving ".md-only" three times (the drift `file-icons.ts`'s own
 *  header comment warns against). Pure query. */
export function isEditableTextFile(name: string): boolean {
  return EDITABLE_TEXT_EXTENSIONS.has(extensionOf(name));
}

/** Extension → curated icon id. A tight set (one shared icon per file family)
 *  so the explorer reads at a glance; anything not listed falls back to the
 *  generic `file`. Keyed by the lowercased extension `extensionOf` returns.
 *  Image extensions are spread in from IMAGE_EXTENSIONS so the icon map and
 *  the open-policy set can never drift apart. */
const EXT_ICON: Readonly<Record<string, IconName>> = {
  md: "file-text",
  markdown: "file-text",
  txt: "file-text",
  ...Object.fromEntries([...IMAGE_EXTENSIONS].map((ext) => [ext, "file-image" as const])),
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
