import type { Extension } from "@codemirror/state";
import {
  blockPreview as buildBlockPreview,
  inlinePreview as buildInlinePreview,
  type BlockFeature,
  type InlineFeature,
} from "./core";
import {
  registerInlineFeature,
  registerBlockFeature,
  currentInlineFeatures,
  currentBlockFeatures,
} from "./feature-registry";
import { textStyles } from "./features/text-styles";
import { cjkBold } from "./features/cjk-bold";
import { heading } from "./features/heading";
import { blockquote } from "./features/blockquote";
import { link } from "./features/link";
import { autolink } from "./features/autolink";
import { image } from "./features/image";
import { wikilink } from "./features/wikilink";
import { footnote } from "./features/footnote";
import { task } from "./features/task";
import { list } from "./features/list";
import { listLine } from "./features/list-line";
import { hr } from "./features/hr";
import { codeBlock, codeLines } from "./features/code-block";
import { inlineMath, blockMath } from "./features/math";
import { mermaid } from "./features/mermaid";
import { table } from "./features/table";
import { frontmatter } from "./features/frontmatter";

export { modeFacet, selectionTouches, refreshBlocks } from "./core";
export type { PreviewMode } from "./core";
export {
  registerInlineFeature,
  registerBlockFeature,
  currentInlineFeatures,
  currentBlockFeatures,
  onFeaturesChanged,
} from "./feature-registry";

/** The shipped feature catalogs. Order here IS the enter/match dispatch order
 *  (core.ts's byNode maps preserve insertion order), so seeding the registry
 *  in this exact sequence — once, at module load, before any listener exists
 *  — reproduces the old compile-time-array behavior exactly. Extensions
 *  (src/extensions) and tests add to the registry AFTER this seeding via
 *  registerInlineFeature/registerBlockFeature. */
const SHIPPED_INLINE_FEATURES: InlineFeature[] = [
  textStyles,
  cjkBold,
  heading,
  blockquote,
  link,
  autolink,
  image,
  wikilink,
  footnote,
  task,
  list,
  listLine,
  hr,
  codeLines,
  inlineMath,
];

const SHIPPED_BLOCK_FEATURES: BlockFeature[] = [mermaid, codeBlock, table, blockMath, frontmatter];

for (const f of SHIPPED_INLINE_FEATURES) registerInlineFeature(f);
for (const f of SHIPPED_BLOCK_FEATURES) registerBlockFeature(f);

/** Inline decorations (conceal/style/line-class) for the registered features.
 *  Reads the registry at CALL time (not module-load time), so a late
 *  registration is included the next time an editor mounts/reconfigures. */
export function inlinePreview(baseDir: string, currentFile: string) {
  return buildInlinePreview(currentInlineFeatures() as InlineFeature[], baseDir, currentFile);
}

/** Block widgets (mermaid / table / display math) for the registered
 *  features. A FACTORY (not a module-load-time constant) — each call builds a
 *  fresh StateField extension from the CURRENT registry contents, which is
 *  what makes late registration + reloadFeatures() (editor.ts) possible.
 *  Callers must invoke it (`blockPreview()`); passing the function itself
 *  where an Extension is expected is a type error, so a forgotten `()` is
 *  caught by tsc rather than surfacing as a silent no-op at runtime. */
export function blockPreview(): Extension {
  return buildBlockPreview(currentBlockFeatures() as BlockFeature[]);
}
