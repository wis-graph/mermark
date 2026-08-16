import { describe, it, expect, beforeEach } from "vitest";
import { renderMaterialFileGlyph } from "../src/sidebar/explorer/material-icon-glyph";

// ---------------------------------------------------------------------------
// renderMaterialFileGlyph is the async half of the Material Icon Theme
// adoption (see file-icons.ts's renderEntryGlyph, which is the actual public
// entry point explorer/search call). These tests exercise it directly so the
// fallback-then-upgrade contract (instant same-size placeholder, then a
// synchronous-cache-or-async-chunk swap to the real Material glyph) is
// pinned independent of any tree/panel timing. Real timers, same `flush`
// idiom as explorer-panel.test.ts — import.meta.glob's per-id chunk is a
// real dynamic import, not a microtask.
// ---------------------------------------------------------------------------

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function makeGlyph(): HTMLElement {
  return document.createElement("span");
}

/** Poll (real timers, bounded) until `el`'s Material icon has landed. A
 *  vitest worker's FIRST-ever dynamic import of a given ./material-icons/*.svg
 *  chunk goes through actual transform + module registration, which can take
 *  more than one macrotask tick — unlike production (a real network fetch of
 *  an already-built chunk), so tests can't assume a single `flush()` settles
 *  it. Once warm (iconSvgCache hit) later calls DO resolve within the same
 *  tick, as the "resolves synchronously once warm" test below shows. */
async function waitForMaterialIcon(el: HTMLElement, tries = 20): Promise<void> {
  for (let i = 0; i < tries && !el.dataset.materialIcon; i++) await flush();
}

describe("renderMaterialFileGlyph: fallback-then-upgrade", () => {
  it("paints the Lucide fallback synchronously, before the Material chunk can possibly resolve", () => {
    const el = makeGlyph();
    renderMaterialFileGlyph(el, "app.ts", "file-code");
    const svg = el.querySelector("svg");
    expect(svg?.classList.contains("icon-file-code")).toBe(true);
    expect(el.dataset.materialIcon).toBeUndefined();
  });

  it("upgrades to the Material glyph (typescript) once its chunk loads, same 16x16 box", async () => {
    const el = makeGlyph();
    renderMaterialFileGlyph(el, "app.ts", "file-code");
    await waitForMaterialIcon(el);
    expect(el.dataset.materialIcon).toBe("typescript");
    const svg = el.querySelector("svg");
    expect(svg?.classList.contains("icon-material")).toBe(true);
    expect(svg?.getAttribute("width")).toBe("16");
    expect(svg?.getAttribute("height")).toBe("16");
  });

  it("resolves synchronously (no fallback frame) once that icon id is already warm this session", async () => {
    const first = makeGlyph();
    renderMaterialFileGlyph(first, "other.ts", "file-code");
    await waitForMaterialIcon(first); // warms the shared "typescript" chunk cache

    const second = makeGlyph();
    renderMaterialFileGlyph(second, "another.ts", "file-code");
    // No await at all — a cache hit must apply synchronously in the same call.
    expect(second.dataset.materialIcon).toBe("typescript");
  });

  it("an exact filename match (package.json) beats the plain extension match (json)", async () => {
    const byExt = makeGlyph();
    renderMaterialFileGlyph(byExt, "settings.json", "braces");
    const byName = makeGlyph();
    renderMaterialFileGlyph(byName, "package.json", "braces");
    await waitForMaterialIcon(byExt);
    await waitForMaterialIcon(byName);
    expect(byExt.dataset.materialIcon).toBe("json");
    expect(byName.dataset.materialIcon).toBe("nodejs");
  });

  it("filename matching is case-insensitive (Dockerfile → the lowercase 'dockerfile' entry)", async () => {
    const el = makeGlyph();
    renderMaterialFileGlyph(el, "Dockerfile", "file");
    await waitForMaterialIcon(el);
    expect(el.dataset.materialIcon).toBe("docker");
  });

  it("an unmapped extension falls back to Material's own generic file icon id, not the empty fallback forever", async () => {
    const el = makeGlyph();
    renderMaterialFileGlyph(el, "mystery.zzz-not-a-real-ext", "file");
    await waitForMaterialIcon(el);
    expect(el.dataset.materialIcon).toBe("file");
  });
});
