// Fence info-string SSOT. Info strings (```lang) used to be decided by
// scattered `if (lang === "mermaid")` checks in features/mermaid.ts and
// features/code-block.ts — a hardcoded 2-way branch. As more mermark-specific
// fence directives arrive (```highlight, …) that branch would grow a third
// arm, then a fourth, one hand-edit at a time. This table is the ONE place
// info strings are classified; every consumer queries `resolveFence`, no
// inline `if (info === "...")` anywhere else.
//
// Leaf module, same pattern as callout-types.ts: no imports (not even type-
// only). parser.ts (the parse layer) and live-preview/features/* (the render
// layer) both depend on this file; it depends on nothing, so it can never
// pull a widget/renderer into the parse layer's import graph — that's the
// cold-load guarantee. Widget FACTORIES are deliberately NOT stored here (see
// resolveFence's doc) — this table only decides WHICH processing path an
// info string takes, not how that path renders.

/** How a fence's body is processed once its info string is classified. */
export type FenceKind = "widget" | "markdown-block" | "code";

interface FenceSpecBase {
  /** Canonical key. A "widget" feature identifies its own fence by this key
   *  (e.g. mermaid.ts checks `resolveFence(info).key === "mermaid"`). */
  key: string;
  /** Every info string (canonical + aliases) this spec claims, lowercase. */
  info: readonly string[];
}

interface WidgetFenceSpec extends FenceSpecBase {
  kind: "widget";
}

/** A `kind: "markdown-block"` entry carries its full Lezer node identity —
 *  `node`/`fenceNode`/`lineClass` are REQUIRED, not optional, so a table row
 *  that parses but forgets how to render (or vice versa) is a compile error,
 *  not a silent half-working fence (audit `_workspace/04_audit_report.md`
 *  §🟡2). `node` and `fenceNode` are two DIFFERENT Lezer node names on
 *  purpose: `node` is the whole block (`HighlightBlock`), `fenceNode` is the
 *  shared node for its opening AND closing fence LINE (`HighlightFence`) —
 *  parser.ts's `markdownBlockFenceExt` defines both, and
 *  `features/fenced-markdown-block.ts` reads `fenceNode` back to find those
 *  lines in the tree. Declaring `fenceNode` explicitly here (rather than
 *  deriving it from `node` via a naming convention) is what let
 *  `fenceNodeNameFor` be deleted — that function was the codebase's only
 *  render→parse import edge (a live-preview feature importing parser.ts). */
export interface MarkdownBlockFenceSpec extends FenceSpecBase {
  kind: "markdown-block";
  /** The Lezer node name the parser defines for the whole block. */
  node: string;
  /** The Lezer node name shared by the opening and closing fence LINE. */
  fenceNode: string;
  /** CSS line class applied to every source line of the block (body + both
   *  fence lines — see features/fenced-markdown-block.ts). */
  lineClass: string;
}

interface CodeFenceSpec extends FenceSpecBase {
  kind: "code";
}

export type FenceSpec = WidgetFenceSpec | MarkdownBlockFenceSpec | CodeFenceSpec;

// Stage 2 adds one markdown-block entry: ```highlight. Its body is parsed as
// real markdown (parser.ts's HighlightBlock composite) and rendered as a line
// class (features/fenced-markdown-block.ts) — not a widget. Everything else
// still falls back to CODE_FALLBACK below — identical to the pre-SSOT
// behavior where codeBlock claimed every FencedCode that wasn't mermaid.
const FENCE_SPECS: readonly FenceSpec[] = [
  { key: "mermaid", info: ["mermaid"], kind: "widget" },
  {
    key: "highlight",
    info: ["highlight"],
    kind: "markdown-block",
    node: "HighlightBlock",
    fenceNode: "HighlightFence",
    lineClass: "cm-highlight-block",
  },
];

/** Fallback for any info string not in FENCE_SPECS (including ""). Same
 *  destination as the pre-SSOT `codeBlock` catch-all. Also where an info
 *  string with EXTRA tokens after the directive lands — `resolveFence` looks
 *  up the WHOLE trimmed info string, so ```highlight title=x (a directive
 *  plus attributes) doesn't match the bare "highlight" key and demotes to a
 *  plain code box, same as any other unrecognized info string. */
const CODE_FALLBACK: FenceSpec = { key: "code", info: [], kind: "code" };

// Built once at module load: info string → its spec, flattening aliases.
const BY_INFO = new Map<string, FenceSpec>();
for (const spec of FENCE_SPECS) {
  for (const info of spec.info) BY_INFO.set(info, spec);
}

/** Classify a fence info string (case-insensitive, trimmed). Unregistered or
 *  empty info strings resolve to the code fallback. Pure query — depends only
 *  on `info`. */
export function resolveFence(info: string): FenceSpec {
  return BY_INFO.get(info.trim().toLowerCase()) ?? CODE_FALLBACK;
}

/** Every registered kind "markdown-block" spec, in table order, narrowed to
 *  `MarkdownBlockFenceSpec` — parser.ts and fenced-markdown-block.ts both read
 *  `node`/`fenceNode`/`lineClass` off the result with no `as string` casts or
 *  defensive `s.node && s.lineClass` filters, since the type guarantees every
 *  element has them. Pure query. */
export function markdownBlockFences(): readonly MarkdownBlockFenceSpec[] {
  return FENCE_SPECS.filter((spec): spec is MarkdownBlockFenceSpec => spec.kind === "markdown-block");
}
