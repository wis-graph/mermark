// `[[` wikilink file picker — a CodeMirror completion source.
//
// This is an *input-UX* layer, not a render/decoration layer: it does not push
// Specs, touch the live-preview pipeline, or add parser nodes. It detects an
// open `[[` context by text matching (the half-typed `[[` has no tree node yet),
// fetches the folder's link targets once (cached), filters by the partial query,
// and inserts a bare target — letting closeBrackets' `]]` close the link so we
// never double the closing brackets.

import {
  insertCompletionText,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";

/** One linkable file in the base folder. Mirrors the Rust `LinkTarget` serde
 *  shape 1:1 (name/rel/kind) so the IPC boundary, the browser mock, and this
 *  source agree. `kind` drives the insert rule (markdown → basename, image →
 *  filename with extension). */
export interface LinkTarget {
  /** Insert label: markdown = basename (no `.md`); image = filename (with ext). */
  name: string;
  /** Path relative to the base dir — kept for future dedup/recursive expansion. */
  rel: string;
  /** "markdown" | "image" — selects the insert rule. The Rust `LinkTarget.kind`
   *  is the SSOT for these exact strings (see commands.rs classify_link_target). */
  kind: "markdown" | "image";
}

/** Matches a still-open `[[` query directly before the cursor. A `]`, `[`, or
 *  `|` in the tail breaks the match (already-closed or alias region). `![[`
 *  (embed) matches too — the leading `!` is outside the capture and ignored. */
const WIKILINK_OPEN = /\[\[([^[\]|]*)$/;

/** True only when the open `[[` context exists right before `pos`. The returned
 *  `from` is where the partial query starts (just after `[[`) — the start of the
 *  completion's replace range. A pure query: no side effects, layout-free so it
 *  unit-tests by feeding a raw string + position. */
export function detectWikilinkContext(
  text: string,
  pos: number,
): { from: number; query: string } | null {
  const before = text.slice(0, pos);
  const m = WIKILINK_OPEN.exec(before);
  if (!m) return null;
  const query = m[1];
  return { from: pos - query.length, query };
}

/** Case-insensitive substring filter over the target list. An empty query keeps
 *  everything (the command already sorted the list). Pure. */
export function filterTargets(list: readonly LinkTarget[], query: string): LinkTarget[] {
  if (query === "") return [...list];
  const needle = query.toLowerCase();
  return list.filter((t) => t.name.toLowerCase().includes(needle));
}

/** The text inserted between the `[[` and `]]`. Markdown → basename (Obsidian
 *  style, `.md` already stripped into `name`); image → filename with extension.
 *  No leading `!` (embed) and no trailing `]]` — closeBrackets owns the close.
 *  Pure. */
export function completionInsertText(target: LinkTarget): string {
  return target.name;
}

/** True when the two characters right after the cursor are `]]` — i.e.
 *  closeBrackets already inserted the closing pair. Lets the apply step avoid
 *  doubling `]]`. Pure query (reads state.doc only). */
export function hasClosingBrackets(context: CompletionContext): boolean {
  const doc = context.state.doc;
  return doc.sliceString(context.pos, Math.min(context.pos + 2, doc.length)) === "]]";
}

// --- cache gate (the one side-effecting command) -----------------------------

const TTL_MS = 5000;
let cache: LinkTarget[] | null = null;
let cachedDir: string | null = null;
let cachedAt = 0;

/** Fetch the folder's link targets, caching by dir for TTL_MS so per-keystroke
 *  IPC is zero. Invalidates when the dir changes or the TTL lapses. Side-effecting
 *  (a command): the only function here that talks to the backend. */
export async function loadTargetsOnce(baseDir: string): Promise<LinkTarget[]> {
  const fresh = cache !== null && cachedDir === baseDir && Date.now() - cachedAt < TTL_MS;
  if (fresh) return cache!;
  const list = await invoke<LinkTarget[]>("list_link_targets", { dir: baseDir });
  cache = list;
  cachedDir = baseDir;
  cachedAt = Date.now();
  return list;
}

/** Reset the module cache. Test-only seam so cache assertions don't bleed across
 *  cases; also handy if a future "rescan" command wants to force a refetch. */
export function resetWikilinkCache(): void {
  cache = null;
  cachedDir = null;
  cachedAt = 0;
}

// --- apply rule (named so the `]]` guard isn't an inline if) ------------------

/** Apply the completion: replace the partial query with the target text. If the
 *  closing `]]` is missing (closeBrackets off, or the user deleted it), append
 *  it so the link is still well-formed; when `]]` is already there, never add a
 *  second pair. The `]]`-duplication rule lives here, in one named place. */
function applyWikilinkCompletion(target: LinkTarget) {
  return (view: EditorView, _completion: Completion, from: number, to: number): void => {
    const ctx = { state: view.state, pos: to } as CompletionContext;
    const text = completionInsertText(target) + (hasClosingBrackets(ctx) ? "" : "]]");
    view.dispatch(insertCompletionText(view.state, text, from, to));
  };
}

/** Map a CodeMirror completion icon to the target kind (image → file, md → text). */
function completionType(kind: LinkTarget["kind"]): string {
  return kind === "image" ? "file" : "text";
}

/** Build the completion source bound to `baseDir`. Returns null off any open
 *  `[[` context (no popup, no IPC). On an open context it loads the targets once,
 *  filters by the partial query, and offers bare-target insertions. */
export function wikilinkCompletionSource(baseDir: string): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const hit = context.matchBefore(WIKILINK_OPEN);
    if (!hit) return null;
    const query = hit.text.slice(2); // drop the leading `[[`
    const targets = await loadTargetsOnce(baseDir);
    if (context.aborted) return null;
    const options: Completion[] = filterTargets(targets, query).map((t) => ({
      label: t.name,
      detail: t.kind,
      type: completionType(t.kind),
      apply: applyWikilinkCompletion(t),
    }));
    return { from: hit.from + 2, to: context.pos, options, filter: false };
  };
}
