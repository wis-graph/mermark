import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// Style-contract gate for "a chapter/page box inside a COLUMN FLEX scroll
// container must opt OUT of flex shrinking" (2026-07-29, root-caused in
// _workspace/05_trace_epub_height.md against two real books).
//
// The bug this exists to stop: `.epub-viewer-chapters` is a column flex
// container, and a book is always taller than the viewport, so every child is
// a flex item with the default `flex-shrink: 1`. Column-flex shrinking then
// compressed every chapter placeholder down to its `min-height: 60vh` floor,
// silently overriding the explicit inline `height` epub-viewer.ts's measure
// handler sets. Measured live: a chapter set to 1252.5px rendered at exactly
// 480px, +773px of its iframe overflowing UNDER the next chapter — which is
// what the user saw as "images cut off" and "text painted over the cover".
//
// jsdom computes no layout, so no DOM test can catch this class of bug. A
// source sweep can: it asserts the DECLARATION is present, so deleting the
// line turns this red even though nothing else would. Same technique as
// tests/viewer-size-envelope.test.ts / viewer-zoom.test.ts next door.
describe("viewer flex items (style contract — sized children never shrink)", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const css = readFileSync(join(ROOT, "src", "styles.css"), "utf8");
  const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

  function blockFor(selector: string): string {
    const re = new RegExp(`(^|[,}])\\s*${selector.replace(/[.\-]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
    const m = re.exec(cssNoComments);
    expect(m, `no rule found for ${selector} in styles.css`).not.toBeNull();
    return m![2];
  }

  // The two viewers that stack JS-sized boxes in a column flex scroller. HWP
  // carried `flex: none` from the start; EPUB shipped without it in v0.9.16
  // and broke on every book taller than one viewport.
  const SIZED_FLEX_ITEMS = [".hwp-viewer-page", ".epub-viewer-chapter"];

  it.each(SIZED_FLEX_ITEMS)("%s opts out of flex shrinking", (selector) => {
    const block = blockFor(selector);
    // `flex: none` (= 0 0 auto) or an explicit `flex-shrink: 0` both satisfy
    // the contract; anything else leaves the default shrink factor of 1.
    expect(
      /flex\s*:\s*none/.test(block) || /flex-shrink\s*:\s*0/.test(block),
      `${selector} must declare \`flex: none\` (or \`flex-shrink: 0\`) — without it the ` +
        `column-flex parent compresses it to its min-height floor and the JS-set height is ignored. ` +
        `got block: ${block}`,
    ).toBe(true);
  });

  it("the chapter container really is a column flex scroller (the premise above)", () => {
    // If this ever stops being true, the rule above is no longer load-bearing
    // and this whole gate should be re-derived rather than silently kept.
    const block = blockFor(".epub-viewer-chapters");
    expect(block).toMatch(/display\s*:\s*flex/);
    expect(block).toMatch(/flex-direction\s*:\s*column/);
  });
});
