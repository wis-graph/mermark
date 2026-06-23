import { type ChangeSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Whether `text` is a single http(s) URL we can wrap a selection in. Pure query.
 *  Scope is deliberately minimal (the 00 request's "http/https minimum"): one
 *  whitespace-free token starting with http:// or https://. `www.`/mailto/ftp and
 *  multi-line or space-containing clipboard payloads are NOT urls here — they fall
 *  back to a normal paste. */
export function isUrl(text: string): boolean {
  return /^https?:\/\/\S+$/.test(text.trim());
}

/** Build the markdown link string for `selected` text pointing at `url`. Pure
 *  query (no side effects) — the dispatch that applies it lives in the paste
 *  handler, keeping query/command separate (CQS). */
export function linkWrap(selected: string, url: string): string {
  return `[${selected}](${url})`;
}

/** Paste handler: when the clipboard holds a single URL and the selection is
 *  non-empty, replace each non-empty range with `[range](url)` (Obsidian-style
 *  auto-linking); empty ranges in a multi-cursor get the raw url inserted. All
 *  ranges go in ONE transaction so undo reverts the whole paste in one step.
 *  Otherwise we return without preventing default → CodeMirror's normal paste. */
export function pasteLinkWrap() {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const clip = event.clipboardData?.getData("text/plain") ?? "";
      const url = clip.trim();
      if (!isUrl(url)) return false; // not a url → normal paste
      const ranges = view.state.selection.ranges;
      if (ranges.every((r) => r.empty)) return false; // nothing selected → normal paste
      event.preventDefault();
      const changes: ChangeSpec[] = ranges.map((r) =>
        r.empty
          ? { from: r.from, insert: url }
          : { from: r.from, to: r.to, insert: linkWrap(view.state.sliceDoc(r.from, r.to), url) },
      );
      view.dispatch({ changes, userEvent: "input.paste" });
      return true;
    },
  });
}
