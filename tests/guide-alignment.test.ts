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
    expect(scope).toMatch(/--bullet-size:\s*\.3em/);
    expect(scope).toMatch(/--bullet-cx:\s*\.625em/);
    expect(scope).toMatch(/--list-col:\s*1\.75em/);
  });

  it("list lines keep the body line height (no tighter-than-paragraph override)", () => {
    const scope = css.match(/\.cm-editor \.cm-line\.cm-list-line \{[\s\S]*?\n\}/)![0];
    expect(scope).not.toMatch(/line-height/);
  });

  it(".cm-bullet is the marker box (--list-col); its dot is sized/placed by --bullet-size/--bullet-cx", () => {
    const box = css.match(/\.cm-bullet \{[^}]*\}/)![0];
    expect(box).toMatch(/width:\s*var\(--list-col/);
    const dot = css.match(/\.cm-bullet::before \{[^}]*\}/)![0];
    expect(dot).toMatch(/var\(--bullet-cx/);
    expect(dot).toMatch(/background:\s*var\(--muted\)/);
  });

  it("no .cm-list-d{2..6} guide rule has a raw .55em literal left over", () => {
    for (const block of listGuideBlocks()) {
      expect(block).not.toMatch(/\.55em/);
    }
  });

  it("every background-position term in d2..d6 targets the ancestor dot centre (--bullet-cx)", () => {
    const blocks = listGuideBlocks();
    expect(blocks).toHaveLength(5);
    for (const block of blocks) {
      const posMatch = block.match(/background-position:\s*([\s\S]*?);/);
      expect(posMatch).not.toBeNull();
      const terms = posMatch![1].split(",");
      expect(terms.length).toBeGreaterThan(0);
      for (const term of terms) {
        expect(term).toMatch(/var\(--list-pad\) \+ \d+ \* var\(--list-col\) \+ var\(--bullet-cx\)/);
      }
    }
  });
});

describe("list geometry contract (text column = depth * 1.75em, hang, deterministic indent)", () => {
  it("every depth hangs wrapped rows at pad + depth*col and cancels it with text-indent", () => {
    for (const n of [1, 2, 3, 4, 5, 6]) {
      const b = css.match(new RegExp(`\\.cm-editor \\.cm-line\\.cm-list-d${n} \\{[\\s\\S]*?\\n\\}`))![0];
      expect(b).toMatch(new RegExp(`--list-depth:\\s*${n};`));
      expect(b).toMatch(new RegExp(`padding-inline-start:\\s*calc\\(var\\(--list-pad\\) \\+ ${n} \\* var\\(--list-col\\)\\)`));
      expect(b).toMatch(new RegExp(`text-indent:\\s*calc\\(-${n} \\* var\\(--list-col\\)\\)`));
    }
  });
  it("indent box width depends on depth only, marker box is fixed-width and resets text-indent", () => {
    expect(css.match(/\.cm-list-indent \{[^}]*\}/)![0]).toMatch(/width:\s*calc\(\(var\(--list-depth[^)]*\) - 1\) \* var\(--list-col/);
    const m = css.match(/\.cm-list-marker \{[^}]*\}/)![0];
    expect(m).toMatch(/width:\s*var\(--list-col/);
    expect(m).toMatch(/text-indent:\s*0/);
  });
  it("ordered marker is right-aligned, tabular", () => {
    const o = css.match(/\.cm-list-marker-ordered \{[^}]*\}/)![0];
    expect(o).toMatch(/flex-end/);
    expect(o).toMatch(/tabular-nums/);
  });
});
