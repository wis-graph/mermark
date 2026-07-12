import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdownLang } from "../src/markdown/parser";
import { continuesHeadingCluster } from "../src/markdown/live-preview/features/heading";

// continuesHeadingCluster is the PURE decision behind the "consecutive
// heading cluster" top-margin rule (cm-heading-cont): does headingLineFrom
// CONTINUE a run of headings — nearest non-blank line above also a heading,
// within the blank-line skip cap? Built against a real markdown-parsed
// EditorState (needs the Lezer tree), not a bare doc string, so it's a
// focused unit test rather than a full editor mount.

function stateFor(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdownLang()] });
}

describe("continuesHeadingCluster (consecutive heading cluster rule)", () => {
  it("true when the immediately preceding line is a heading", () => {
    const s = stateFor("# A\n## B");
    const bLine = s.doc.line(2);
    expect(continuesHeadingCluster(s, bLine.from)).toBe(true);
  });

  it("true across exactly one blank line", () => {
    const s = stateFor("# A\n\n## B");
    const bLine = s.doc.line(3);
    expect(continuesHeadingCluster(s, bLine.from)).toBe(true);
  });

  it("true across two blank lines (at the skip cap)", () => {
    const s = stateFor("# A\n\n\n## B");
    const bLine = s.doc.line(4);
    expect(continuesHeadingCluster(s, bLine.from)).toBe(true);
  });

  it("false across three blank lines (exceeds the skip cap — not a cluster)", () => {
    const s = stateFor("# A\n\n\n\n## B");
    const bLine = s.doc.line(5);
    expect(continuesHeadingCluster(s, bLine.from)).toBe(false);
  });

  it("false when the nearest non-blank line above is body text", () => {
    const s = stateFor("본문\n\n## C");
    const cLine = s.doc.line(3);
    expect(continuesHeadingCluster(s, cLine.from)).toBe(false);
  });

  it("false for the document's first heading (nothing above it)", () => {
    const s = stateFor("# A\n\nbody");
    const aLine = s.doc.line(1);
    expect(continuesHeadingCluster(s, aLine.from)).toBe(false);
  });
});
