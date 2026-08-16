import { icon, type IconName } from "../../icons";

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

/** Extension → curated Lucide icon id. Originally the ONLY file glyph source;
 *  since the Material Icon Theme adoption (renderEntryGlyph below) it's the
 *  FALLBACK glyph — painted instantly for files while that entry's Material
 *  icon chunk is still loading (material-icon-glyph.ts), and it's still the
 *  only glyph folders ever get. A tight set (one shared icon per file family)
 *  so even the fallback frame reads at a glance; anything not listed falls
 *  back to the generic `file`. Keyed by the lowercased extension
 *  `extensionOf` returns. Image extensions are spread in from
 *  IMAGE_EXTENSIONS so the icon map and the open-policy set can never drift
 *  apart. */
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

type MaterialGlyphModule = typeof import("./material-icon-glyph");

/** Once the FIRST file glyph anywhere has needed it, holds the resolved
 *  material-icon-glyph.ts module so every render after that can call it
 *  synchronously — no fallback repaint, no flicker, once warm. */
let materialGlyphModule: MaterialGlyphModule | null = null;
let materialGlyphLoader: Promise<MaterialGlyphModule> | null = null;

/** Lazily `import()` the Material Icon Theme runtime — material-icon-glyph.ts
 *  PLUS the ext/filename lookup tables it statically imports
 *  (material-icons.generated.ts, ~1300+2100 entries) — exactly once. Mirrors
 *  math-widget.ts's katexLoader / mermaid-widget.ts's mermaidLoader: a
 *  module-level cached Promise so app boot (before the sidebar has ever
 *  drawn a file row) never pays for this feature. file-icons.ts is imported
 *  by explorer-panel.ts/search-panel.ts, both part of the main bundle, so
 *  keeping THIS import dynamic (not a top-level `import … from`) is what
 *  keeps the ~100KB generated table and the 585-entry svg-loader glob table
 *  (material-icon-glyph.ts's `import.meta.glob`) out of the cold-load path —
 *  a top-level import here would defeat the whole point of vendoring the
 *  icon set as lazy per-id chunks. */
function loadMaterialGlyph(): Promise<MaterialGlyphModule> {
  if (!materialGlyphLoader) {
    materialGlyphLoader = import("./material-icon-glyph").then((m) => {
      materialGlyphModule = m;
      return m;
    });
  }
  return materialGlyphLoader;
}

/** THE single entry point for painting a tree/list-row glyph — explorer,
 *  search, and (next) workspace tabs all call this instead of hand-rolling
 *  `container.append(icon(iconNameForEntry(...)))` themselves, so the
 *  Lucide-vs-Material split (and the lazy-load boundary above) lives in
 *  exactly one place. Folders are unaffected by the Material Icon Theme
 *  adoption (2026-08, see _workspace/03_frontend_material_icons.md) and keep
 *  resolving through iconNameForEntry's Lucide folder/folder-open glyphs,
 *  synchronously, forever. Files resolve iconNameForEntry's EXT_ICON entry
 *  as the FALLBACK glyph (painted instantly, same 16x16 box), then hand off
 *  to renderMaterialFileGlyph for the real per-extension/per-filename
 *  Material glyph — synchronously once material-icon-glyph.ts is warm this
 *  session, asynchronously (fallback-then-upgrade, no layout jump) the first
 *  time any file glyph is requested. Command (void): mutates `container`,
 *  not a query. */
export function renderEntryGlyph(container: HTMLElement, name: string, isDir: boolean, expanded: boolean): void {
  const fallback = iconNameForEntry(name, isDir, expanded);
  if (isDir) {
    container.replaceChildren(icon(fallback));
    return;
  }
  if (materialGlyphModule) {
    materialGlyphModule.renderMaterialFileGlyph(container, name, fallback);
    return;
  }
  container.replaceChildren(icon(fallback));
  void loadMaterialGlyph().then((m) => m.renderMaterialFileGlyph(container, name, fallback));
}
