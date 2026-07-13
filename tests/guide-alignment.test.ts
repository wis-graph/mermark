// Derivation-lock test (2026-07-12 design-polish batch ③): pins the indent
// guide's alignment as a DERIVED value (--guide-col, tied to --bullet-size)
// rather than a stale literal (.55em) that drifted out of sync with the
// bullet's actual geometry after a marker-metrics change — the bug this
// change fixes. jsdom doesn't compute layout/background-position, so this
// asserts against the styles.css SOURCE TEXT directly; the real pixel-level
// check is scratchpad/guide-measure2.mjs (CDP, run by qa-verifier).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");

/** The .cm-list-d{2..6} guide rule blocks, extracted so assertions don't
 *  accidentally match unrelated `.55em` uses elsewhere in the stylesheet. */
function listGuideBlocks(): string[] {
  const blocks: string[] = [];
  for (const depth of [2, 3, 4, 5, 6]) {
    const re = new RegExp(
      `\\.cm-editor \\.cm-line\\.cm-list-d${depth} \\{[\\s\\S]*?\\n\\}`,
    );
    const m = css.match(re);
    if (m) blocks.push(m[0]);
  }
  return blocks;
}

describe("indent guide alignment (derived from --bullet-size, not a stale .55em literal)", () => {
  it("declares --bullet-size and --guide-col in the .cm-list-line scope", () => {
    const scopeMatch = css.match(/\.cm-editor \.cm-line\.cm-list-line \{[\s\S]*?\n\}/);
    expect(scopeMatch).not.toBeNull();
    const scope = scopeMatch![0];
    expect(scope).toMatch(/--bullet-size:\s*\.30em/);
    expect(scope).toMatch(/--guide-col:\s*calc\(var\(--bullet-size\)\s*\/\s*2\)/);
  });

  it(".cm-bullet's width/height are var(--bullet-size), not a re-stated literal", () => {
    const bulletRule = css.match(/\.cm-bullet \{[^}]*\}/)![0];
    expect(bulletRule).toMatch(/width:\s*var\(--bullet-size\)/);
    expect(bulletRule).toMatch(/height:\s*var\(--bullet-size\)/);
  });

  it("no .cm-list-d{2..6} guide rule has a raw .55em literal left over", () => {
    for (const block of listGuideBlocks()) {
      expect(block).not.toMatch(/\.55em/);
    }
  });

  it("every background-position term in d2..d6 uses var(--guide-col)", () => {
    const blocks = listGuideBlocks();
    expect(blocks).toHaveLength(5);
    for (const block of blocks) {
      const posMatch = block.match(/background-position:\s*([\s\S]*?);/);
      expect(posMatch).not.toBeNull();
      const terms = posMatch![1].split(",");
      expect(terms.length).toBeGreaterThan(0);
      for (const term of terms) {
        expect(term).toMatch(/var\(--guide-col\)/);
      }
    }
  });
});
