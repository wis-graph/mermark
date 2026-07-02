import { describe, it, expect } from "vitest";
import { arrangeStatusBar } from "../src/status-bar";

// The status-bar (footer) layout contract, reduced by M2 (sidebar toggles /
// open-path / mode / theme / settings all moved up to the title-bar): footer
// left→right is now 브레드크럼 슬롯 · spacer · save · pos, with pos landing at
// the far right (the "M2 title-bar redesign" moved pos from the center).

function mk(id: string): HTMLElement {
  const e = document.createElement("button");
  e.dataset.id = id;
  return e;
}

describe("arrangeStatusBar", () => {
  it("lays the reduced footer out left→right: breadcrumb · spacer · save · pos", () => {
    const bar = document.createElement("div");
    const parts = {
      breadcrumb: mk("breadcrumb"),
      spacer: mk("spacer"),
      save: mk("save"),
      pos: mk("pos"),
    };
    arrangeStatusBar(bar, parts);
    const ids = [...bar.children].map((c) => (c as HTMLElement).dataset.id);
    expect(ids).toEqual(["breadcrumb", "spacer", "save", "pos"]);
  });

  it("pos is the last (far-right) child", () => {
    const bar = document.createElement("div");
    const parts = {
      breadcrumb: mk("breadcrumb"),
      spacer: mk("spacer"),
      save: mk("save"),
      pos: mk("pos"),
    };
    arrangeStatusBar(bar, parts);
    expect(bar.lastElementChild).toBe(parts.pos);
  });
});
