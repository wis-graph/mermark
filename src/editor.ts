import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { callouts } from "./markdown/callout-widget";
import { checkboxes } from "./markdown/checkbox";
import { codeBlocks } from "./markdown/codeblock";
import { footnotes } from "./markdown/footnote";
import { imagePlugin } from "./markdown/image";
import { inlineDecorations } from "./markdown/inline";
import { mathBlocks } from "./markdown/math-widget";
import { mermaidBlocks } from "./markdown/mermaid-widget";
import { markdownLang } from "./markdown/parser";
import { tables } from "./markdown/table-widget";
import { wikilinkPlugin } from "./markdown/wikilink";

export function mountEditor(parent: HTMLElement, doc: string, baseDir: string): EditorView {
  const state = EditorState.create({
    doc,
    extensions: [
      markdownLang(),
      inlineDecorations,
      imagePlugin(baseDir),
      wikilinkPlugin(baseDir),
      mermaidBlocks,
      codeBlocks,
      mathBlocks,
      callouts,
      footnotes,
      tables,
      checkboxes,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.lineWrapping,
    ],
  });
  return new EditorView({ state, parent });
}
