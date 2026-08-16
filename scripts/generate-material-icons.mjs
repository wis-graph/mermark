// Vendors a FILE-ONLY subset of the Material Icon Theme (MIT,
// https://github.com/material-extensions/vscode-material-icon-theme) into the
// repo, so mermark's file glyphs ship as static assets under version control
// instead of a runtime dependency on `material-icon-theme` — bumping that
// package must never silently reshape the app's icons. Run:
//
//   node scripts/generate-material-icons.mjs
//
// after `npm install`/`npm update` touches material-icon-theme, then commit
// the result (src/sidebar/explorer/material-icons/*.svg +
// material-icons.generated.ts). Deterministic: same source package version
// always produces byte-identical output (keys are sorted before emission).
//
// Scope: FILES ONLY. Folder icons stay hand-drawn Lucide glyphs
// (src/icons.ts's folder/folder-open) — material-icon-theme's folder set is
// deliberately not vendored (see _workspace/03_frontend_material_icons.md).
// We also only ever read the DEFAULT (dark-background) icon ids — never the
// package's `light` override table, which exists for the opposite case
// (dark icon glyphs over a light host UI). mermark's sidebar is
// dark-inverted in all three themes, so `light` would be the wrong choice.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG_ROOT = join(ROOT, "node_modules", "material-icon-theme");
const PKG_VERSION = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version;
const MANIFEST = JSON.parse(readFileSync(join(PKG_ROOT, "dist", "material-icons.json"), "utf8"));
const ICONS_SRC_DIR = join(PKG_ROOT, "icons");

const OUT_DIR = join(ROOT, "src", "sidebar", "explorer");
const ASSET_DIR = join(OUT_DIR, "material-icons");
const GENERATED_TS = join(OUT_DIR, "material-icons.generated.ts");

/** Icon id → absolute path of its source .svg, or null if the manifest
 *  references an id with no matching asset on disk (defensive: a future
 *  package version could drop a file the JSON still names). Pure query. */
function resolveSvgPath(iconId) {
  const def = MANIFEST.iconDefinitions[iconId];
  if (!def) return null;
  const abs = join(ICONS_SRC_DIR, basename(def.iconPath));
  return existsSync(abs) ? abs : null;
}

/** Build ext/filename → icon id, DROPPING any mapping whose icon id has no
 *  resolvable asset (resolveSvgPath) and reporting what got dropped so a
 *  future material-icon-theme bump can't silently go blind on an extension.
 *  Query — reads the manifest, returns a plain object; the caller decides
 *  what to do with `dropped`. */
function buildMapping(manifestTable) {
  const kept = {};
  const dropped = [];
  for (const key of Object.keys(manifestTable).sort()) {
    const iconId = manifestTable[key];
    if (resolveSvgPath(iconId)) kept[key.toLowerCase()] = iconId;
    else dropped.push(`${key} -> ${iconId}`);
  }
  return { kept, dropped };
}

const { kept: extToIcon, dropped: droppedExt } = buildMapping(MANIFEST.fileExtensions);
const { kept: nameToIcon, dropped: droppedNames } = buildMapping(MANIFEST.fileNames);
const defaultIconId = MANIFEST.file;
if (!resolveSvgPath(defaultIconId)) {
  throw new Error(`material-icon-theme's default file icon "${defaultIconId}" has no asset — aborting`);
}

if (droppedExt.length || droppedNames.length) {
  console.warn(
    `[generate-material-icons] ${droppedExt.length + droppedNames.length} mapping(s) dropped ` +
      `(icon id referenced in the manifest has no on-disk asset):`,
  );
  for (const line of [...droppedExt, ...droppedNames]) console.warn(`  ${line}`);
}

// Union of every icon id actually reachable through the two maps + the
// default — this, not the package's full 1250-id catalog, is what gets
// vendored. Sorted so the copy order (and any directory listing) is stable.
const usedIconIds = [...new Set([...Object.values(extToIcon), ...Object.values(nameToIcon), defaultIconId])].sort();

rmSync(ASSET_DIR, { recursive: true, force: true });
mkdirSync(ASSET_DIR, { recursive: true });
for (const iconId of usedIconIds) {
  copyFileSync(resolveSvgPath(iconId), join(ASSET_DIR, `${iconId}.svg`));
}
copyFileSync(join(PKG_ROOT, "LICENSE"), join(ASSET_DIR, "LICENSE"));

const banner =
  `// GENERATED FILE — DO NOT EDIT BY HAND.\n` +
  `// Produced by scripts/generate-material-icons.mjs from material-icon-theme@${PKG_VERSION}\n` +
  `// (MIT — see ./material-icons/LICENSE). Regenerate: node scripts/generate-material-icons.mjs\n` +
  `//\n` +
  `// FILE extension/filename → Material Icon Theme icon id. The matching SVG\n` +
  `// for each id lives at ./material-icons/<id>.svg (vendored, not fetched at\n` +
  `// runtime) and is lazy-loaded per id via import.meta.glob in\n` +
  `// material-icon-glyph.ts — this module carries no SVG payload itself, so\n` +
  `// importing it costs nothing on the cold-load path.\n`;

const body =
  `\n` +
  `/** Lowercased extension (no leading dot, see file-icons.ts's \`extensionOf\`)\n` +
  ` *  → Material Icon Theme icon id. ${Object.keys(extToIcon).length} entries. */\n` +
  `export const MATERIAL_EXT_TO_ICON: Readonly<Record<string, string>> = ${JSON.stringify(extToIcon, null, 2)};\n` +
  `\n` +
  `/** Lowercased EXACT filename (e.g. "dockerfile", ".gitignore",\n` +
  ` *  "package.json") → Material Icon Theme icon id. Takes priority over\n` +
  ` *  MATERIAL_EXT_TO_ICON when a name matches. ${Object.keys(nameToIcon).length} entries. */\n` +
  `export const MATERIAL_FILENAME_TO_ICON: Readonly<Record<string, string>> = ${JSON.stringify(nameToIcon, null, 2)};\n` +
  `\n` +
  `/** Fallback icon id when neither map matches (Material Icon Theme's own\n` +
  ` *  generic-file glyph). */\n` +
  `export const MATERIAL_DEFAULT_ICON = ${JSON.stringify(defaultIconId)};\n`;

writeFileSync(GENERATED_TS, banner + body);

console.log(
  `[generate-material-icons] wrote ${usedIconIds.length} svg(s) to ${ASSET_DIR} and ${GENERATED_TS} ` +
    `(${Object.keys(extToIcon).length} extensions, ${Object.keys(nameToIcon).length} filenames)`,
);
