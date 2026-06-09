import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeBlocks } from "./markdown/codeblock";
import { inlineDecorations } from "./markdown/inline";
import { markdownLang } from "./markdown/parser";

export function mountEditor(parent: HTMLElement, doc: string): EditorView {
  const state = EditorState.create({
    doc,
    extensions: [
      markdownLang(),
      inlineDecorations,
      codeBlocks,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.lineWrapping,
    ],
  });
  return new EditorView({ state, parent });
}
