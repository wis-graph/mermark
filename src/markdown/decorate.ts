import { syntaxTree } from "@codemirror/language";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { StateField } from "@codemirror/state";
import type { EditorState, Transaction, Range } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { invoke } from "@tauri-apps/api/core";
import { CheckboxWidget } from "./checkbox";
import { SupWidget } from "./footnote";
import { ImageWidget, resolveImageUrl } from "./image";
import { KatexWidget } from "./math-widget";
import { MermaidWidget } from "./mermaid-widget";
import { TableWidget } from "./table-widget";
import { WikilinkWidget, wikilinkPath, isImageTarget } from "./wikilink";

// ---------------------------------------------------------------------------
// Live-preview core: every decoration that *conceals* source text is dropped
// for lines the selection touches, so the cursor edits raw markdown in place
// (Obsidian-style). Non-concealing decorations (styling) always apply.
// ---------------------------------------------------------------------------

/** True when any selection range touches [from,to] expanded to whole lines. */
export function selectionTouches(state: EditorState, from: number, to: number): boolean {
  const lineFrom = state.doc.lineAt(from).from;
  const lineTo = state.doc.lineAt(Math.min(to, state.doc.length)).to;
  return state.selection.ranges.some((r) => r.from <= lineTo && r.to >= lineFrom);
}

/** True when the syntax tree advanced (incremental background parse or edit). */
function treeChanged(a: EditorState, b: EditorState): boolean {
  return syntaxTree(a) !== syntaxTree(b);
}

const hide = Decoration.replace({});

const STYLE: Record<string, string> = {
  StrongEmphasis: "cm-strong",
  Emphasis: "cm-em",
  InlineCode: "cm-inline-code",
  Strikethrough: "cm-strike",
};
const MARKERS = new Set([
  "EmphasisMark",
  "CodeMark",
  "StrikethroughMark",
  "HeaderMark",
  "QuoteMark",
]);
const HEADING_LINE: Record<string, string> = {
  ATXHeading1: "cm-h1",
  ATXHeading2: "cm-h2",
  ATXHeading3: "cm-h3",
  ATXHeading4: "cm-h4",
  ATXHeading5: "cm-h5",
  ATXHeading6: "cm-h6",
  SetextHeading1: "cm-h1",
  SetextHeading2: "cm-h2",
};

const CALLOUT_HEAD = /^\s*(?:>\s*)+\[!(\w+)\]/;

interface Spec {
  from: number;
  to: number;
  deco: Decoration;
  conceal: boolean;
}

function fencedInfo(state: EditorState, node: SyntaxNode): string {
  const info = node.getChild("CodeInfo");
  return info ? state.sliceDoc(info.from, info.to).trim().toLowerCase() : "";
}

/** Emit line decorations for every line a node spans (deduped later). */
function eachLine(state: EditorState, from: number, to: number, fn: (lineFrom: number) => void) {
  let pos = from;
  const end = Math.min(to, state.doc.length);
  for (;;) {
    const line = state.doc.lineAt(pos);
    fn(line.from);
    if (line.to >= end) break;
    pos = line.to + 1;
  }
}

function emitLink(state: EditorState, node: SyntaxNode, out: Spec[]) {
  const marks = node.getChildren("LinkMark");
  const url = node.getChild("URL");
  if (marks.length < 2) return;
  const textFrom = marks[0].to;
  const textTo = marks[1].from;
  const href = url ? state.sliceDoc(url.from, url.to) : null;
  out.push({ from: node.from, to: textFrom, deco: hide, conceal: true });
  out.push({ from: textTo, to: node.to, deco: hide, conceal: true });
  if (textTo > textFrom)
    out.push({
      from: textFrom,
      to: textTo,
      deco: Decoration.mark({
        class: "cm-link",
        attributes: href ? { "data-href": href, title: href } : {},
      }),
      conceal: false,
    });
}

function buildInline(view: EditorView, baseDir: string, currentFile: string): DecorationSet {
  const state = view.state;
  const specs: Spec[] = [];
  const lineClasses = new Map<number, Set<string>>(); // lineFrom → classes (deduped)
  const addLineClass = (lineFrom: number, cls: string) => {
    let set = lineClasses.get(lineFrom);
    if (!set) lineClasses.set(lineFrom, (set = new Set()));
    set.add(cls);
  };
  const tree = syntaxTree(state);

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        const cls = STYLE[node.name];
        if (cls) {
          specs.push({ from: node.from, to: node.to, deco: Decoration.mark({ class: cls }), conceal: false });
          return;
        }
        if (MARKERS.has(node.name)) {
          if (node.to > node.from) specs.push({ from: node.from, to: node.to, deco: hide, conceal: true });
          return;
        }
        const heading = HEADING_LINE[node.name];
        if (heading) {
          addLineClass(state.doc.lineAt(node.from).from, `cm-heading ${heading}`);
          return;
        }
        switch (node.name) {
          case "Link":
            emitLink(state, node.node, specs);
            return false;
          case "Image": {
            const n = node.node;
            const url = n.getChild("URL");
            if (!url) return false;
            const marks = n.getChildren("LinkMark");
            const alt = marks.length >= 2 ? state.sliceDoc(marks[0].to, marks[1].from) : "";
            const src = resolveImageUrl(state.sliceDoc(url.from, url.to).trim(), baseDir);
            specs.push({
              from: node.from,
              to: node.to,
              deco: Decoration.replace({ widget: new ImageWidget(src, alt) }),
              conceal: true,
            });
            return false;
          }
          case "Wikilink":
          case "WikilinkEmbed": {
            const n = node.node;
            const target = state.sliceDoc(n.getChild("WikilinkTarget")?.from ?? node.from, n.getChild("WikilinkTarget")?.to ?? node.from).trim();
            const aliasNode = n.getChild("WikilinkAlias");
            const alias = aliasNode ? state.sliceDoc(aliasNode.from, aliasNode.to).trim() : target;
            if (!target) return false;
            const embed = node.name === "WikilinkEmbed";
            const deco = embed && isImageTarget(target)
              ? Decoration.replace({ widget: new ImageWidget(resolveImageUrl(target, baseDir), alias) })
              : Decoration.replace({ widget: new WikilinkWidget(alias, wikilinkPath(target, baseDir, currentFile)) });
            specs.push({ from: node.from, to: node.to, deco, conceal: true });
            return false;
          }
          case "InlineMath": {
            const tex = state.sliceDoc(node.from + 1, node.to - 1).trim();
            specs.push({
              from: node.from,
              to: node.to,
              deco: Decoration.replace({ widget: new KatexWidget(tex, false) }),
              conceal: true,
            });
            return false;
          }
          case "FootnoteRef": {
            const line = state.doc.lineAt(node.from);
            const isDef = node.from === line.from && state.sliceDoc(node.to, node.to + 1) === ":";
            if (isDef) {
              addLineClass(line.from, "cm-footnote-def");
            } else {
              const label = state.sliceDoc(node.from + 2, node.to - 1);
              specs.push({
                from: node.from,
                to: node.to,
                deco: Decoration.replace({ widget: new SupWidget(label) }),
                conceal: true,
              });
            }
            return false;
          }
          case "TaskMarker": {
            const checked = /x/i.test(state.sliceDoc(node.from, node.to));
            specs.push({
              from: node.from,
              to: node.to,
              deco: Decoration.replace({ widget: new CheckboxWidget(checked) }),
              conceal: true,
            });
            return false;
          }
          case "FencedCode": {
            if (fencedInfo(state, node.node) === "mermaid") return false; // block widget
            eachLine(state, node.from, node.to, (lf) => addLineClass(lf, "cm-code-block"));
            return; // descend so CodeMark etc. could style later if needed
          }
          case "Blockquote": {
            const first = state.doc.lineAt(node.from);
            const head = CALLOUT_HEAD.exec(first.text);
            if (head) {
              const type = head[1].toLowerCase();
              addLineClass(first.from, `cm-callout cm-callout-${type} cm-callout-head`);
              eachLine(state, first.to + 1 <= node.to ? first.to + 1 : node.to, node.to, (lf) =>
                addLineClass(lf, `cm-callout cm-callout-${type}`),
              );
            }
            return; // descend: quote marks, nested content
          }
          case "Table":
          case "BlockMath":
            return false; // block widgets own these; keep raw when revealed
        }
      },
    });
  }

  const ranges: Range<Decoration>[] = [];
  for (const s of specs) {
    if (s.conceal && selectionTouches(state, s.from, s.to)) continue;
    ranges.push(s.deco.range(s.from, s.to));
  }
  for (const [lineFrom, classes] of lineClasses) {
    ranges.push(Decoration.line({ class: [...classes].join(" ") }).range(lineFrom));
  }
  return Decoration.set(ranges, true);
}

/** One plugin for ALL inline/line decorations: styles, marker conceals,
 *  links, images, wikilinks, footnotes, checkboxes, inline math, code/callout
 *  line backgrounds. Walks only the visible ranges of the syntax tree. */
export function inlinePreview(baseDir: string, currentFile: string) {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = buildInline(view, baseDir, currentFile);
        }
        update(u: ViewUpdate) {
          if (u.docChanged || u.viewportChanged || u.selectionSet || treeChanged(u.startState, u.state))
            this.decorations = buildInline(u.view, baseDir, currentFile);
        }
      },
      { decorations: (v) => v.decorations },
    ),
    EditorView.domEventHandlers({
      mousedown(e) {
        const el = (e.target as HTMLElement).closest?.("[data-href]") as HTMLElement | null;
        if (!el?.dataset.href) return false;
        e.preventDefault();
        invoke("plugin:opener|open_url", { url: el.dataset.href }).catch(() => {
          window.open(el.dataset.href, "_blank");
        });
        return true;
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Block widgets (mermaid / tables / display math). Block decorations must come
// from a StateField. Specs are cached: recomputed only when the document or
// the syntax tree changes (incremental parse progress included — that is what
// un-freezes large files); selection changes only re-filter the cached specs.
// ---------------------------------------------------------------------------

type BlockKind = "mermaid" | "table" | "math";
interface BlockSpec {
  kind: BlockKind;
  from: number;
  to: number;
  src: string;
}

// Skip descending into nodes that can't contain block widgets — avoids
// walking every inline node of large documents on each edit.
const NO_BLOCKS_INSIDE = new Set([
  "Paragraph",
  "ATXHeading1", "ATXHeading2", "ATXHeading3", "ATXHeading4", "ATXHeading5", "ATXHeading6",
  "SetextHeading1", "SetextHeading2",
  "HTMLBlock", "CommentBlock", "LinkReference", "HorizontalRule",
]);

/** Strip `depth` levels of leading blockquote markers from one line. */
function stripQuote(text: string, depth: number): string {
  let t = text;
  for (let i = 0; i < depth; i++) t = t.replace(/^\s*>\s?/, "");
  return t;
}

/** Lines of [from,to], each stripped of `depth` blockquote markers. */
function strippedLines(state: EditorState, from: number, to: number, depth: number): string[] {
  const out: string[] = [];
  eachLine(state, from, to, (lf) => out.push(stripQuote(state.doc.lineAt(lf).text, depth)));
  return out;
}

function computeBlockSpecs(state: EditorState): BlockSpec[] {
  const specs: BlockSpec[] = [];
  let quoteDepth = 0;
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "Blockquote") {
        quoteDepth++;
        return;
      }
      if (NO_BLOCKS_INSIDE.has(node.name)) return false;
      if (node.name === "FencedCode") {
        if (fencedInfo(state, node.node) === "mermaid") {
          const lines = strippedLines(state, node.from, node.to, quoteDepth);
          const body = lines.slice(1, lines[lines.length - 1]?.trim().startsWith("```") ? -1 : undefined);
          specs.push({ kind: "mermaid", from: node.from, to: node.to, src: body.join("\n") });
        }
        return false;
      }
      if (node.name === "Table") {
        const src = strippedLines(state, node.from, node.to, quoteDepth).join("\n");
        specs.push({ kind: "table", from: node.from, to: node.to, src });
        return false;
      }
      if (node.name === "BlockMath") {
        const raw = strippedLines(state, node.from, node.to, quoteDepth).join("\n");
        const src = raw.replace(/^\s*\$\$/, "").replace(/\$\$\s*$/, "").trim();
        specs.push({ kind: "math", from: node.from, to: node.to, src });
        return false;
      }
    },
    leave(node) {
      if (node.name === "Blockquote") quoteDepth--;
    },
  });
  return specs;
}

function buildBlockDeco(state: EditorState, specs: BlockSpec[]): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const s of specs) {
    if (selectionTouches(state, s.from, s.to)) continue; // cursor inside → raw source
    const widget =
      s.kind === "mermaid" ? new MermaidWidget(s.src)
      : s.kind === "table" ? new TableWidget(s.src)
      : new KatexWidget(s.src, true);
    ranges.push(Decoration.replace({ widget, block: true }).range(s.from, s.to));
  }
  return Decoration.set(ranges, true);
}

interface BlockValue {
  specs: BlockSpec[];
  deco: DecorationSet;
}

export const blockPreview = StateField.define<BlockValue>({
  create(state) {
    const specs = computeBlockSpecs(state);
    return { specs, deco: buildBlockDeco(state, specs) };
  },
  update(value, tr: Transaction) {
    if (tr.docChanged || treeChanged(tr.startState, tr.state)) {
      const specs = computeBlockSpecs(tr.state);
      return { specs, deco: buildBlockDeco(tr.state, specs) };
    }
    if (tr.selection) return { specs: value.specs, deco: buildBlockDeco(tr.state, value.specs) };
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});
