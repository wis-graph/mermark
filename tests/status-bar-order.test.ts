import { describe, it, expect } from "vitest";
import { arrangeStatusBar } from "../src/status-bar";

// The status-bar layout contract: left→right order is
// 탐색기 · 최근 · 경로열기 · 목차 · [pos · spacer · save] · 모드 · 테마.
// arrangeStatusBar is the single ordering rule; this pins it with plain elements
// (no editor boot needed).

function mk(id: string): HTMLElement {
  const e = document.createElement("button");
  e.dataset.id = id;
  return e;
}

describe("arrangeStatusBar", () => {
  it("lays the chrome out left→right in the canonical order", () => {
    const bar = document.createElement("div");
    const parts = {
      explorer: mk("explorer"),
      recent: mk("recent"),
      openPath: mk("openPath"),
      outline: mk("outline"),
      pos: mk("pos"),
      spacer: mk("spacer"),
      save: mk("save"),
      mode: mk("mode"),
      theme: mk("theme"),
    };
    arrangeStatusBar(bar, parts);
    const ids = [...bar.children].map((c) => (c as HTMLElement).dataset.id);
    expect(ids).toEqual([
      "explorer",
      "recent",
      "openPath",
      "outline",
      "pos",
      "spacer",
      "save",
      "mode",
      "theme",
    ]);
  });

  it("places the mode toggle in the right cluster (after save, before theme)", () => {
    const bar = document.createElement("div");
    const parts = {
      explorer: mk("explorer"),
      recent: mk("recent"),
      openPath: mk("openPath"),
      outline: mk("outline"),
      pos: mk("pos"),
      spacer: mk("spacer"),
      save: mk("save"),
      mode: mk("mode"),
      theme: mk("theme"),
    };
    arrangeStatusBar(bar, parts);
    const ids = [...bar.children].map((c) => (c as HTMLElement).dataset.id);
    expect(ids.indexOf("mode")).toBeGreaterThan(ids.indexOf("save"));
    expect(ids.indexOf("mode")).toBeLessThan(ids.indexOf("theme"));
    // the nav group sits left of the center cluster
    expect(ids.indexOf("outline")).toBeLessThan(ids.indexOf("pos"));
  });
});
