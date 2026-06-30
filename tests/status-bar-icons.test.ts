import { describe, it, expect, beforeEach } from "vitest";
import { icon } from "../src/icons";
import { makeThemeToggle } from "../src/theme";
import { mountSettingsButton } from "../src/settings/panel/modal";

// Guards the footer redesign: the status-bar chrome renders Lucide inline SVGs,
// not emoji glyphs (✎👁☾☀⚙✕). If a refactor reverts a button to textContent,
// these assertions catch the regression — the buttons must carry an <svg>, and the
// SVG must be the Lucide canvas (viewBox 0 0 24 24, stroke=currentColor) so token
// colors (--muted → --fg) drive it for free.

const EMOJI = /[✎👁☾☀⚙✕✓●⚠]/;

describe("status-bar icons (Lucide SVG, no emoji)", () => {
  it("icon() builds a Lucide-canvas SVG that inherits currentColor", () => {
    const svg = icon("square-pen");
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.querySelector("path, circle")).not.toBeNull(); // has real geometry
  });

  it("theme toggle renders an SVG glyph, not an emoji, in both themes", () => {
    const { btn, render } = makeThemeToggle(() => {});
    render("dark");
    expect(btn.querySelector("svg.icon-moon")).not.toBeNull();
    expect(btn.textContent ?? "").not.toMatch(EMOJI);
    render("light");
    expect(btn.querySelector("svg.icon-sun")).not.toBeNull();
    expect(btn.textContent ?? "").not.toMatch(EMOJI);
    render("claude");
    expect(btn.querySelector("svg.icon-palette")).not.toBeNull();
    expect(btn.textContent ?? "").not.toMatch(EMOJI);
  });

  it("palette icon is a Lucide-canvas SVG (claude theme glyph)", () => {
    const svg = icon("palette");
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.querySelector("path, circle")).not.toBeNull();
  });

  it("settings button renders the gear SVG plus a '설정' label, no emoji", () => {
    document.body.innerHTML = "";
    const bar = document.createElement("div");
    document.body.appendChild(bar);
    mountSettingsButton(bar);
    const btn = bar.querySelector(".settings-btn") as HTMLButtonElement;
    expect(btn.querySelector("svg.icon-settings")).not.toBeNull();
    expect(btn.querySelector(".status-btn-label")?.textContent).toBe("설정");
    expect(btn.textContent ?? "").not.toMatch(EMOJI);
  });
});

beforeEach(() => {
  document.body.innerHTML = "";
});
