import { describe, it, expect } from "vitest";
import { icon } from "../src/icons";
import { renderSidebarButton } from "../src/sidebar-toggle";

// The shared sidebar toggle: swap the panel-left icon pair by open/closed state
// and set the disclosure ARIA. One rule, used by both the explorer and outline.

describe("icons: panel-left pair (E)", () => {
  it("icons.ts exposes panel-left-open / panel-left-close as Lucide-canvas SVGs", () => {
    for (const name of ["panel-left-open", "panel-left-close"] as const) {
      const svg = icon(name);
      expect(svg.tagName.toLowerCase()).toBe("svg");
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg.getAttribute("stroke")).toBe("currentColor");
      expect(svg.querySelector("path, rect")).not.toBeNull();
    }
  });
});

describe("renderSidebarButton (E)", () => {
  it("closed → panel-left-open + aria-expanded=false + aria-controls", () => {
    const b = document.createElement("button");
    renderSidebarButton(b, "탐색기", false, "explorer-aside");
    expect(b.querySelector(".icon-panel-left-open")).toBeTruthy();
    expect(b.querySelector(".icon-panel-left-close")).toBeNull();
    expect(b.getAttribute("aria-expanded")).toBe("false");
    expect(b.getAttribute("aria-controls")).toBe("explorer-aside");
    expect(b.querySelector(".status-btn-label")?.textContent).toBe("탐색기");
  });

  it("open → panel-left-close + aria-expanded=true, label preserved", () => {
    const b = document.createElement("button");
    renderSidebarButton(b, "탐색기", true, "explorer-aside");
    expect(b.querySelector(".icon-panel-left-close")).toBeTruthy();
    expect(b.querySelector(".icon-panel-left-open")).toBeNull();
    expect(b.getAttribute("aria-expanded")).toBe("true");
    expect(b.querySelector(".status-btn-label")?.textContent).toBe("탐색기");
  });

  it("re-rendering replaces the icon (no accumulation of stale glyphs)", () => {
    const b = document.createElement("button");
    renderSidebarButton(b, "목차", false, "outline-aside");
    renderSidebarButton(b, "목차", true, "outline-aside");
    expect(b.querySelectorAll("svg")).toHaveLength(1);
    expect(b.querySelectorAll(".status-btn-label")).toHaveLength(1);
  });
});
