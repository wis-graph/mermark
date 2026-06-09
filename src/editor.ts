import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeBlocks } from "./markdown/codeblock";
import { inlineDecorations } from "./markdown/inline";
import { mathBlocks } from "./markdown/math-widget";
import { mermaidBlocks } from "./markdown/mermaid-widget";
import { markdownLang } from "./markdown/parser";

export function mountEditor(parent: HTMLElement, doc: string): EditorView {
  const state = EditorState.create({
    doc,
    extensions: [
      markdownLang(),
      inlineDecorations,
      mermaidBlocks,
      codeBlocks,
      mathBlocks,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.lineWrapping,
    ],
  });
  return new EditorView({ state, parent });
}
