import { describe, it, expect } from "vitest";
import {
  registerInlineFeature,
  registerBlockFeature,
  currentInlineFeatures,
  currentBlockFeatures,
  onFeaturesChanged,
} from "../src/markdown/live-preview/feature-registry";
import "../src/markdown/live-preview"; // triggers the module-load seeding
import type { InlineFeature, BlockFeature } from "../src/markdown/live-preview/core";

// index.ts's shipped catalogs, mirrored here ONLY to assert seeding order —
// this list must track index.ts's INLINE_FEATURES/BLOCK_FEATURES arrays.
const SHIPPED_INLINE_NAMES = [
  "textStyles",
  "cjkBold",
  "heading",
  "blockquote",
  "link",
  "autolink",
  "image",
  "wikilink",
  "footnote",
  "task",
  "list",
  "listLine",
  "hr",
  "codeLines",
  "inlineMath",
];
const SHIPPED_BLOCK_NAMES = ["mermaid", "codeBlock", "table", "blockMath", "frontmatter"];

describe("feature-registry", () => {
  it("seeds the shipped block features in shipped order (5, byNode dispatch order is behavior)", () => {
    expect(currentBlockFeatures().length).toBe(SHIPPED_BLOCK_NAMES.length);
  });

  it("seeds the shipped inline features in shipped order (15)", () => {
    expect(currentInlineFeatures().length).toBe(SHIPPED_INLINE_NAMES.length);
  });

  it("registerBlockFeature appends by default", () => {
    const before = currentBlockFeatures().length;
    const testFeature: BlockFeature = { nodes: ["__TestNode__"], match: () => null };
    const unregister = registerBlockFeature(testFeature);
    const after = currentBlockFeatures();
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1]).toBe(testFeature);
    unregister();
    expect(currentBlockFeatures().length).toBe(before);
  });

  it("registerBlockFeature({ prepend: true }) puts the feature first", () => {
    const before = currentBlockFeatures().length;
    const testFeature: BlockFeature = { nodes: ["__TestNodePrepend__"], match: () => null };
    const unregister = registerBlockFeature(testFeature, { prepend: true });
    expect(currentBlockFeatures()[0]).toBe(testFeature);
    unregister();
    expect(currentBlockFeatures().length).toBe(before);
  });

  it("registerInlineFeature appends by default and unregister removes it", () => {
    const before = currentInlineFeatures().length;
    const testFeature: InlineFeature = { nodes: ["__TestInline__"], enter: () => {} };
    const unregister = registerInlineFeature(testFeature);
    const after = currentInlineFeatures();
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1]).toBe(testFeature);
    unregister();
    expect(currentInlineFeatures().length).toBe(before);
  });

  it("registerInlineFeature({ prepend: true }) puts the feature first", () => {
    const testFeature: InlineFeature = { nodes: ["__TestInlinePrepend__"], enter: () => {} };
    const unregister = registerInlineFeature(testFeature, { prepend: true });
    expect(currentInlineFeatures()[0]).toBe(testFeature);
    unregister();
  });

  it("onFeaturesChanged fires once per register/unregister, not on subscribe, not after unsubscribe", () => {
    let calls = 0;
    const stop = onFeaturesChanged(() => calls++);
    expect(calls).toBe(0); // no fire on subscribe
    const testFeature: BlockFeature = { nodes: ["__TestNotify__"], match: () => null };
    const unregister = registerBlockFeature(testFeature);
    expect(calls).toBe(1);
    unregister();
    expect(calls).toBe(2);
    stop();
    const unregister2 = registerBlockFeature(testFeature);
    expect(calls).toBe(2); // unsubscribed — no further notifications
    unregister2();
  });
});
