import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// D2 Y6 BUTTON GRAMMAR: tier x size classes are the single source of button
// metrics; legacy per-button rules keep only what is unique to that button.
const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles.css"), "utf8");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function block(sel: string): string {
  const m = css.match(new RegExp("(?:^|\\})\\s*" + esc(sel) + "\\s*\\{([^}]*)\\}", "m"));
  if (!m) throw new Error(`no rule ${sel}`);
  return m[1];
}

describe("button grammar tokens", () => {
  it(".btn = md: control-h-md / radius-md / text-md", () => {
    const b = block(".btn");
    expect(b).toContain("height: var(--control-h-md)");
    expect(b).toContain("border-radius: var(--radius-md)");
    expect(b).toContain("font-size: var(--text-md)");
  });
  it(".btn-sm = sm tokens", () => {
    const b = block(".btn-sm");
    expect(b).toContain("var(--control-h-sm)");
    expect(b).toContain("var(--radius-sm)");
    expect(b).toContain("var(--text-sm)");
  });
  it("tiers", () => {
    expect(block(".btn-primary")).toContain("color: var(--on-accent)");
    expect(block(".btn-secondary")).toContain("var(--border-strong)");
    expect(block(".btn-danger")).toContain("var(--danger)");
  });
  it.each([".version-check-btn", ".version-install-btn", ".welcome-cta-btn", ".recovery-action", ".conflict-btn"])(
    "%s has no height / accent fill of its own (grammar owns metrics)",
    (sel) => {
      const re = new RegExp("(?:^|\\})\\s*" + esc(sel) + "\\s*\\{([^}]*)\\}", "m");
      const m = css.match(re);
      if (!m) return; // rule deleted entirely is the goal
      expect(m[1]).not.toMatch(/(^|[;\s])height:/);
      expect(m[1]).not.toMatch(/background:\s*var\(--accent\)/);
    },
  );
});
