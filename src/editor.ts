import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { inlineDecorations } from "./markdown/inline";
import { markdownLang } from "./markdown/parser";

export function mountEditor(parent: HTMLElement, doc: string): EditorView {
  const state = EditorState.create({
    doc,
    extensions: [
      markdownLang(),
      inlineDecorations,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.lineWrapping,
    ],
  });
  return new EditorView({ state, parent });
}
