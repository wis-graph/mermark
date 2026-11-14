import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readingWidthCapEm } from "../src/settings/app";

const css = readFileSync("src/styles.css", "utf8");
const rule = (sel: string): string => {
  const i = css.indexOf(`\n${sel} {`);
  expect(i, sel).toBeGreaterThanOrEqual(0);
  return css.slice(i, css.indexOf("}", i));
};

describe("2026-11 typography pass", () => {
  it("readingWidthCapEm: 68% = 47.5em (760px@16px), scales linearly with the slider", () => {
    expect(readingWidthCapEm(68)).toBe(47.5);
    expect(readingWidthCapEm(100)).toBeCloseTo(69.85, 1);
    expect(readingWidthCapEm(40)).toBeLessThan(readingWidthCapEm(68));
  });

  it(".cm-content caps the % measure with the em cap (zoom-following, no font-size)", () => {
    const b = rule(".cm-editor .cm-content");
    expect(b).toMatch(/max-width:\s*min\(var\(--measure, 68%\)[^;]*var\(--measure-em/);
    expect(b).not.toMatch(/[^-]font-size:/);
  });

  it("code block: borderless, non-wrapping, horizontally scrollable", () => {
    expect(rule(".cm-codeblock")).toMatch(/border:\s*0/);
    expect(rule(".cm-codeblock .cm-code-row")).toMatch(/white-space:\s*pre;/);
    expect(rule(".cm-codeblock code")).toMatch(/overflow-x:\s*auto/);
  });

  it("table: rounded separated-border frame; inline code never breaks mid-token", () => {
    const t = rule(".cm-table");
    expect(t).toMatch(/border-collapse:\s*separate/);
    expect(t).toMatch(/border-radius:\s*8px/);
    expect(css).toMatch(/\.cm-table \.cm-inline-code[^{]*\{\s*white-space:\s*nowrap/);
  });

  it("h1-h3 are bold (700) with zero tracking", () => {
    for (const h of ["h1", "h2", "h3"]) {
      expect(rule(`.cm-editor .cm-line.cm-${h}`)).toMatch(/font-weight:\s*700/);
      expect(css).toMatch(new RegExp(`--${h}-tracking:\\s*0;`));
    }
  });
});
