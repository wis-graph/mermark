import {
  blockPreview as buildBlockPreview,
  inlinePreview as buildInlinePreview,
  type BlockFeature,
  type InlineFeature,
} from "./core";
import { textStyles } from "./features/text-styles";
import { heading } from "./features/heading";
import { blockquote } from "./features/blockquote";
import { link } from "./features/link";
import { image } from "./features/image";
import { wikilink } from "./features/wikilink";
import { footnote } from "./features/footnote";
import { task } from "./features/task";
import { list } from "./features/list";
import { codeBlock, codeLines } from "./features/code-block";
import { inlineMath, blockMath } from "./features/math";
import { mermaid } from "./features/mermaid";
import { table } from "./features/table";

export { modeFacet, selectionTouches } from "./core";
export type { PreviewMode } from "./core";

/** The live-preview feature registry. Add a feature here to extend the editor;
 *  each one is self-contained in features/. */
const INLINE_FEATURES: InlineFeature[] = [
  textStyles,
  heading,
  blockquote,
  link,
  image,
  wikilink,
  footnote,
  task,
  list,
  codeLines,
  inlineMath,
];

const BLOCK_FEATURES: BlockFeature[] = [mermaid, codeBlock, table, blockMath];

/** Inline decorations (conceal/style/line-class) for the registered features. */
export function inlinePreview(baseDir: string, currentFile: string) {
  return buildInlinePreview(INLINE_FEATURES, baseDir, currentFile);
}

/** Block widgets (mermaid / table / display math) for the registered features. */
export const blockPreview = buildBlockPreview(BLOCK_FEATURES);
