import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";

export function mountEditor(parent: HTMLElement, doc: string): EditorView {
  const state = EditorState.create({
    doc,
    extensions: [
      markdown(),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.lineWrapping,
    ],
  });
  return new EditorView({ state, parent });
}
