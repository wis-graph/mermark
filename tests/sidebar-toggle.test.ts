import { describe, it, expect } from "vitest";
import { renderSidebarButton } from "../src/sidebar/toggle";
import { createWorkspaceSidebar } from "../src/workspace/workspace-sidebar";
import { WorkspaceStore } from "../src/workspace/workspace-state";

// The shared sidebar toggle: fixed identity icon (per view) + disclosure ARIA.
// State (open/closed) rides in aria-expanded alone — no icon swap — so each
// sidebar (explorer/recent/outline) stays visually distinguishable even though
// they share one left region.

describe("renderSidebarButton (N)", () => {
  it("closed → identity icon fixed, aria-expanded=false + aria-controls", () => {
    const b = document.createElement("button");
    renderSidebarButton(b, "folder", "탐색기", false, "explorer-aside");
    expect(b.querySelector(".icon-folder")).toBeTruthy();
    expect(b.getAttribute("aria-expanded")).toBe("false");
    expect(b.getAttribute("aria-controls")).toBe("explorer-aside");
    expect(b.querySelector(".chrome-btn-label")?.textContent).toBe("탐색기");
  });

  it("open → SAME identity icon (no swap), aria-expanded=true, label preserved", () => {
    const b = document.createElement("button");
    renderSidebarButton(b, "folder", "탐색기", true, "explorer-aside");
    expect(b.querySelector(".icon-folder")).toBeTruthy();
    expect(b.getAttribute("aria-expanded")).toBe("true");
    expect(b.querySelector(".chrome-btn-label")?.textContent).toBe("탐색기");
  });

  it("each sidebar gets a distinct identity icon (explorer ≠ recent ≠ outline ≠ workspace)", () => {
    const explorer = document.createElement("button");
    const recent = document.createElement("button");
    const outline = document.createElement("button");
    const workspace = createWorkspaceSidebar({ store: new WorkspaceStore(), onSelectVault: () => undefined });
    renderSidebarButton(explorer, "folder", "탐색기", false, "explorer-aside");
    renderSidebarButton(recent, "history", "최근", false, "recent-aside");
    renderSidebarButton(outline, "list", "목차", false, "outline-aside");
    expect(explorer.querySelector(".icon-folder")).toBeTruthy();
    expect(recent.querySelector(".icon-history")).toBeTruthy();
    expect(outline.querySelector(".icon-list")).toBeTruthy();
    // no cross-contamination
    expect(explorer.querySelector(".icon-history")).toBeNull();
    expect(explorer.querySelector(".icon-list")).toBeNull();
    expect(recent.querySelector(".icon-folder")).toBeNull();
    expect(recent.querySelector(".icon-list")).toBeNull();
    expect(outline.querySelector(".icon-folder")).toBeNull();
    expect(outline.querySelector(".icon-history")).toBeNull();
    expect(workspace.button.querySelector(".icon-list-tree")).toBeTruthy();
    expect(workspace.button.querySelector(".icon-list")).toBeNull();
  });

  it("re-rendering does not accumulate stale glyphs/labels", () => {
    const b = document.createElement("button");
    renderSidebarButton(b, "list", "목차", false, "outline-aside");
    renderSidebarButton(b, "list", "목차", true, "outline-aside");
    expect(b.querySelectorAll("svg")).toHaveLength(1);
    expect(b.querySelectorAll(".chrome-btn-label")).toHaveLength(1);
  });
});
