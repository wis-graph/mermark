import { fencedInfo, type BlockFeature } from "../core";
import { MermaidWidget } from "../../mermaid-widget";

/** Pixel dimensions declared on a diagram's first line, plus the diagram body
 *  with that declaration stripped. `null` means "not declared" (use natural). */
export interface MermaidDimensions {
  width: number | null;
  height: number | null;
  body: string;
}

/** Parse an optional `width[, height]` declaration off the diagram's first line
 *  (modern-mermaid spec §2.4). The first line is split on `,`; each part is
 *  `parseInt`-ed. If EITHER yields a valid number the line is a size declaration
 *  and is dropped from the body. If BOTH are NaN (e.g. `graph TD`) the line is
 *  diagram content and kept verbatim.
 *
 *  Spec-accepted footgun: a body whose first line is a bare number (`42`) is
 *  mistaken for a size declaration and stripped. Diagram type keywords
 *  (`graph`/`flowchart`/`sequenceDiagram`…) never start with a digit, so this is
 *  safe in practice — we accept it rather than gold-plate a guard. */
export function parseDimensions(source: string): MermaidDimensions {
  const nl = source.indexOf("\n");
  const firstLine = nl === -1 ? source : source.slice(0, nl);
  const rest = nl === -1 ? "" : source.slice(nl + 1);
  const parts = firstLine.split(",");
  const width = toDimension(parts[0]);
  const height = toDimension(parts[1]);
  if (width === null && height === null) return { width: null, height: null, body: source };
  return { width, height, body: rest };
}

/** `parseInt` a single dimension part: a leading integer wins (`300px` → 300),
 *  anything non-numeric is `null`. Whitespace-only / missing parts are `null`. */
function toDimension(part: string | undefined): number | null {
  if (part === undefined) return null;
  const n = parseInt(part.trim(), 10);
  return Number.isNaN(n) ? null : n;
}

export const mermaid: BlockFeature = {
  nodes: ["FencedCode"],
  match(node, ctx) {
    if (fencedInfo(ctx.state, node) !== "mermaid") return null;
    const full = ctx.fencedBody(node).join("\n");
    const { width, height, body } = parseDimensions(full);
    // src is the render body (size declaration stripped) so the SVG cache / eq
    // key stays consistent; dims drive host sizing (CSS), not the SVG itself.
    return {
      kind: "mermaid",
      from: node.from,
      to: node.to,
      src: body,
      widget: () => new MermaidWidget(body, { width, height }),
    };
  },
};
