import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { findFootnoteDef, findFootnoteRef } from "../src/markdown/footnote-nav";

const state = (doc: string) => EditorState.create({ doc });

describe("findFootnoteDef", () => {
  it("returns the line-start position of the definition marker", () => {
    const doc = "see [^a] here\n\n[^a]: the note";
    const s = state(doc);
    expect(findFootnoteDef(s, "a")).toBe(doc.indexOf("[^a]:"));
  });

  it("returns null when no definition exists (reference only)", () => {
    const s = state("see [^a] here, no def below");
    expect(findFootnoteDef(s, "a")).toBeNull();
  });

  it("ignores a reference and only matches the definition line", () => {
    // [^a] appears first as a reference; the def is later. Must point at the def.
    const doc = "ref [^a]\nmore [^a] text\n[^a]: def";
    const s = state(doc);
    expect(findFootnoteDef(s, "a")).toBe(doc.indexOf("[^a]: def"));
  });

  it("escapes regex-special characters in the label", () => {
    // `a.b*` would, unescaped, be a regex matching e.g. `aXb` — escaping pins it
    // to the literal label so only the real definition matches.
    const doc = "see [^a.b*]\n\n[^a.b*]: literal def";
    const s = state(doc);
    expect(findFootnoteDef(s, "a.b*")).toBe(doc.indexOf("[^a.b*]: literal"));
    // A label that the unescaped pattern would have matched must NOT resolve.
    expect(findFootnoteDef(state("[^aXbb]: other"), "a.b*")).toBeNull();
  });
});

describe("findFootnoteRef", () => {
  it("returns the position of the first non-definition reference", () => {
    const doc = "[^a]: def\n\nbody [^a] reference";
    const s = state(doc);
    expect(findFootnoteRef(s, "a")).toBe(doc.indexOf("[^a] reference"));
  });

  it("does not treat the definition's own marker as a reference", () => {
    // Only the def line contains [^a]; there is no real reference → null.
    const s = state("[^a]: the note, defined but never cited");
    expect(findFootnoteRef(s, "a")).toBeNull();
  });

  it("returns null when the label appears nowhere", () => {
    const s = state("plain text with no footnotes");
    expect(findFootnoteRef(s, "missing")).toBeNull();
  });

  it("returns the FIRST reference when several cite the same label", () => {
    const doc = "[^a]: def\nfirst [^a]\nsecond [^a]";
    const s = state(doc);
    expect(findFootnoteRef(s, "a")).toBe(doc.indexOf("first [^a]") + "first ".length);
  });

  it("escapes regex-special characters when skipping the definition line", () => {
    const doc = "[^a.b*]: def\ncite [^a.b*] here";
    const s = state(doc);
    expect(findFootnoteRef(s, "a.b*")).toBe(doc.indexOf("cite [^a.b*]") + "cite ".length);
  });
});
