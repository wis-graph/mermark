import { describe, expect, it } from "vitest";
import { PRESET_RETIREMENTS, builtInTheme, parseTheme, retiredPresetGenerations, serializeTheme } from "../src/settings/theme-schema";

// PIPELINE RULE: a built-in preset's color change must ship with a retirement
// entry (theme-schema.ts PRESET_RETIREMENTS), or users who ever loaded that preset
// stay frozen on the old inline-var snapshot. This fingerprint turns red on any
// preset change; after adding the entry, update the fingerprint AND bump COUNTS.
const PRESET_FINGERPRINT = {
  dark: JSON.stringify(builtInTheme("dark")),
  light: JSON.stringify(builtInTheme("light")),
  claude: JSON.stringify(builtInTheme("claude")),
};
// Pinned literal copies of the current presets (update together with a retirement).
const PINNED: Record<"dark" | "light" | "claude", string> = {
  dark: '{"name":"dark","colors":{"bg":"#131110","fg":"#ffffff","accent":"#a8c8e8","link":"#a8c8e8","surface":"#1c1917","border":"rgba(255,255,255,.12)","muted":"#a8a29e","highlightBg":"#ffe066","h1":"#ffffff","h2":"#ffffff","h3":"#ffffff","h4":"#ffffff","h5":"#ffffff","h6":"#a8a29e","bold":"#ffffff","italic":"#ffffff","code":"#a8c8e8","highlight":"#1a1300","comment":"#6b665f"},"radii":{"md":"8px","lg":"12px","xl":"16px"},"font":{"sans":"\\"Inter\\", system-ui, sans-serif"}}',
  light: '{"name":"light","colors":{"bg":"#ffffff","fg":"#0c0a09","accent":"#292524","link":"#1d6fb8","surface":"#fafaf9","border":"#e7e5e4","muted":"#6f6a63","highlightBg":"#fff3a3","h1":"#0c0a09","h2":"#0c0a09","h3":"#0c0a09","h4":"#0c0a09","h5":"#0c0a09","h6":"#6f6a63","bold":"#0c0a09","italic":"#0c0a09","code":"#292524","highlight":"#1a1300","comment":"#8f887e"},"radii":{"md":"8px","lg":"12px","xl":"16px"},"font":{"sans":"\\"Inter\\", system-ui, sans-serif"}}',
  claude: '{"name":"claude","colors":{"bg":"#faf9f5","fg":"#141413","accent":"#cc785c","link":"#a9583e","surface":"#efe9de","border":"#e6dfd8","muted":"#5f5d58","highlightBg":"#f0d9a8","h1":"#141413","h2":"#141413","h3":"#141413","h4":"#141413","h5":"#141413","h6":"#6c6a64","bold":"#252523","italic":"#3d3d3a","code":"#93492f","highlight":"#141413","comment":"#8c857a"},"radii":{"md":"8px","lg":"12px","xl":"16px"},"font":{"sans":"\\"Inter\\", system-ui, sans-serif"}}',
};
const GENERATION_COUNTS = { dark: 1, light: 2, claude: 1 };

describe("preset retirement rule", () => {
  for (const name of ["dark", "light", "claude"] as const) {
    it(`${name}: pinned preset unchanged (else add the previous values as a retired generation)`, () => {
      expect(
        PRESET_FINGERPRINT[name],
        `preset ${name} changed — add the previous values as a retired generation in theme-schema.ts PRESET_RETIREMENTS, then update PINNED and GENERATION_COUNTS here`,
      ).toBe(PINNED[name]);
      expect(PRESET_RETIREMENTS[name].length, `preset ${name}: retirement list length drifted from the pin`).toBe(
        GENERATION_COUNTS[name],
      );
    });

    it(`${name}: every generation differs from the current preset and from each other`, () => {
      const cur = builtInTheme(name).colors;
      const gens = retiredPresetGenerations(name);
      const seen = new Set<string>([JSON.stringify(cur)]);
      for (const g of gens) {
        expect(seen.has(JSON.stringify(g)), `${name}: a retirement entry is a no-op or duplicate`).toBe(false);
        seen.add(JSON.stringify(g));
      }
    });
  }
});

describe("snapRetiredPreset across generations", () => {
  const USER_SNAPSHOT =
    '{"name":"light","colors":{"bg":"#f5f5f5","fg":"#0c0a09","accent":"#292524","link":"#1d6fb8","surface":"#ffffff","border":"#e7e5e4","muted":"#777169","highlightBg":"#fff3a3","h1":"#0c0a09","h2":"#0c0a09","h3":"#0c0a09","h4":"#0c0a09","h5":"#0c0a09","h6":"#777169","bold":"#0c0a09","italic":"#0c0a09","code":"#292524","highlight":"#1a1300","comment":"#8f887e"},"radii":{"md":"8px","lg":"12px","xl":"16px"},"font":{"sans":"\\"Inter\\", system-ui, sans-serif"}}';

  it("the real stored snapshot (old muted + old bg/surface) snaps to current light", () => {
    expect(parseTheme(USER_SNAPSHOT)).toEqual(builtInTheme("light"));
  });

  it("every generation of every preset snaps to the current preset", () => {
    for (const name of ["dark", "light", "claude"] as const) {
      for (const g of retiredPresetGenerations(name)) {
        const raw = { ...builtInTheme(name), colors: g };
        expect(parseTheme(JSON.stringify(raw))).toEqual(builtInTheme(name));
      }
    }
  });

  it("gen-1 era light (old muted, current-at-the-time bg) and mid-gen (new muted, old bg) both snap", () => {
    const [mid, oldest] = retiredPresetGenerations("light");
    expect(mid.muted).toBe("#6f6a63");
    expect(mid.bg).toBe("#f5f5f5");
    expect(oldest.muted).toBe("#777169");
    for (const g of [mid, oldest]) {
      expect(parseTheme(JSON.stringify({ ...builtInTheme("light"), colors: g }))).toEqual(builtInTheme("light"));
    }
  });

  it("one custom color on top of an old snapshot never snaps", () => {
    const raw = JSON.parse(USER_SNAPSHOT);
    raw.colors.link = "#123456";
    const parsed = parseTheme(JSON.stringify(raw))!;
    expect(parsed.colors.bg).toBe("#f5f5f5");
    expect(parsed.colors.link).toBe("#123456");
  });

  it("a mix of generations (new bg, old muted) is not a real snapshot and is kept", () => {
    const raw = { ...builtInTheme("light") };
    raw.colors = { ...raw.colors, muted: "#777169", h6: "#777169" };
    expect(parseTheme(JSON.stringify(raw))!.colors.muted).toBe("#777169");
  });

  it("dark and claude current presets are unaffected; snapping is idempotent", () => {
    for (const name of ["dark", "claude"] as const) {
      expect(parseTheme(JSON.stringify(builtInTheme(name)))).toEqual(builtInTheme(name));
    }
    const once = parseTheme(USER_SNAPSHOT)!;
    expect(parseTheme(serializeTheme(once))).toEqual(once);
  });
});
