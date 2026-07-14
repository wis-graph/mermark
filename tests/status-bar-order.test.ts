import { describe, it, expect } from "vitest";
import { arrangeStatusBar } from "../src/chrome/status-bar";

// The status-bar (footer) layout contract, reduced by M2 (sidebar toggles /
// open-path / mode / theme / settings all moved up to the title-bar): footer
// left→right is now 브레드크럼 슬롯 · spacer · update · width · save · pos, with
// pos landing at the far right. The update button (found update only, hidden
// otherwise) leads the right cluster, followed by the reading-width slider —
// both are quick footer controls mirroring Settings-panel state.

function mk(id: string): HTMLElement {
  const e = document.createElement("button");
  e.dataset.id = id;
  return e;
}

function mkParts() {
  return {
    breadcrumb: mk("breadcrumb"),
    spacer: mk("spacer"),
    update: mk("update"),
    width: mk("width"),
    save: mk("save"),
    pos: mk("pos"),
  };
}

describe("arrangeStatusBar", () => {
  it("lays the footer out left→right: breadcrumb · spacer · update · width · save · pos", () => {
    const bar = document.createElement("div");
    const parts = mkParts();
    arrangeStatusBar(bar, parts);
    const ids = [...bar.children].map((c) => (c as HTMLElement).dataset.id);
    expect(ids).toEqual(["breadcrumb", "spacer", "update", "width", "save", "pos"]);
  });

  it("pos is the last (far-right) child", () => {
    const bar = document.createElement("div");
    const parts = mkParts();
    arrangeStatusBar(bar, parts);
    expect(bar.lastElementChild).toBe(parts.pos);
  });
});
