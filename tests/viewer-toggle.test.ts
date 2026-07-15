import { describe, it, expect, beforeEach, vi } from "vitest";
import { isViewerEnabled, toggleViewerDisabled } from "../src/settings/app";
import { registerViewer, viewerFor, listViewers, type Viewer } from "../src/chrome/viewer/registry";

// The domain rules a viewer on/off toggle needs (design §1/§2): a pure
// membership predicate + a pure toggle, both independent of localStorage so
// they're trivial to unit test, and the SAME functions main.ts's
// viewerForEntry filters through — no parallel "is this viewer on" logic
// anywhere else.

describe("isViewerEnabled (disabled-set membership rule)", () => {
  it("an empty disabled-set means every viewer is enabled (default = all on)", () => {
    expect(isViewerEnabled([], "image")).toBe(true);
  });

  it("a viewer id present in the disabled-set is NOT enabled", () => {
    expect(isViewerEnabled(["image"], "image")).toBe(false);
  });

  it("other viewer ids remain enabled when one is disabled", () => {
    expect(isViewerEnabled(["image"], "ext.pdf")).toBe(true);
  });
});

describe("toggleViewerDisabled (pure membership toggle)", () => {
  it("adds an id not yet in the disabled-set", () => {
    expect(toggleViewerDisabled([], "ext.pdf")).toEqual(["ext.pdf"]);
  });

  it("removes an id already in the disabled-set (round-trip back to enabled)", () => {
    expect(toggleViewerDisabled(["ext.pdf"], "ext.pdf")).toEqual([]);
  });

  it("round-trips off -> on -> off without residue", () => {
    const off = toggleViewerDisabled([], "hwp");
    const on = toggleViewerDisabled(off, "hwp");
    expect(on).toEqual([]);
  });

  it("does not mutate the input array (returns a new array)", () => {
    const input = ["image"];
    const result = toggleViewerDisabled(input, "ext.pdf");
    expect(input).toEqual(["image"]); // unchanged
    expect(result).toEqual(["image", "ext.pdf"]);
    expect(result).not.toBe(input);
  });

  it("leaves other ids untouched when toggling one", () => {
    expect(toggleViewerDisabled(["image", "hwp"], "image")).toEqual(["hwp"]);
  });
});

describe("disabledViewersSetting parse (JSON-array-corrupt-→-default guard, mirrors recentDocsSetting)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("defaults to an empty array and persists under mermark.disabledViewers", async () => {
    const { disabledViewersSetting } = await import("../src/settings/app");
    expect(disabledViewersSetting.get()).toEqual([]);
    disabledViewersSetting.set(["ext.pdf"]);
    expect(localStorage.getItem("mermark.disabledViewers")).toBe(JSON.stringify(["ext.pdf"]));
  });

  it("parses a saved JSON array", async () => {
    localStorage.setItem("mermark.disabledViewers", JSON.stringify(["image", "hwp"]));
    const { disabledViewersSetting } = await import("../src/settings/app");
    expect(disabledViewersSetting.get()).toEqual(["image", "hwp"]);
  });

  it("falls back to the default on corrupt JSON", async () => {
    localStorage.setItem("mermark.disabledViewers", "not json");
    const { disabledViewersSetting } = await import("../src/settings/app");
    expect(disabledViewersSetting.get()).toEqual([]);
  });

  it("falls back to the default on a non-array JSON value", async () => {
    localStorage.setItem("mermark.disabledViewers", "{}");
    const { disabledViewersSetting } = await import("../src/settings/app");
    expect(disabledViewersSetting.get()).toEqual([]);
  });

  it("filters out non-string entries from a saved array", async () => {
    localStorage.setItem("mermark.disabledViewers", JSON.stringify(["image", 1, null, "hwp"]));
    const { disabledViewersSetting } = await import("../src/settings/app");
    expect(disabledViewersSetting.get()).toEqual(["image", "hwp"]);
  });

  it("registers under the 뷰어 group with the viewer-toggles control", async () => {
    await import("../src/settings/app");
    const { groups } = await import("../src/settings/registry");
    const group = groups().find((g) => g.name === "뷰어");
    expect(group).toBeDefined();
    const entry = group!.entries.find((e) => e.ui.label === "뷰어");
    expect(entry).toBeDefined();
    expect(entry!.ui.control.kind).toBe("viewer-toggles");
  });
});

describe("listViewers (registry enumeration)", () => {
  it("includes a freshly registered viewer", () => {
    const v: Viewer = { id: "test.toggle.a", extensions: ["vtga"], open: () => ({ close() {} }) };
    registerViewer(v);
    expect(listViewers()).toContain(v);
  });

  it("includes multiple freshly registered viewers, in registration order", () => {
    const a: Viewer = { id: "test.toggle.b", extensions: ["vtgb"], open: () => ({ close() {} }) };
    const b: Viewer = { id: "test.toggle.c", extensions: ["vtgc"], open: () => ({ close() {} }) };
    registerViewer(a);
    registerViewer(b);
    const ids = listViewers().map((v) => v.id);
    expect(ids.indexOf(a.id)).toBeLessThan(ids.indexOf(b.id));
  });

  it("accepts an optional label without a type error and stores it on the catalog entry", () => {
    const v: Viewer = { id: "test.toggle.d", extensions: ["vtgd"], label: "Test Viewer D", open: () => ({ close() {} }) };
    registerViewer(v);
    expect(listViewers().find((x) => x.id === "test.toggle.d")?.label).toBe("Test Viewer D");
  });
});

describe("viewer-open filter rule (reproduces main.ts's viewerForEntry composition)", () => {
  it("a disabled viewer's claimed extension is treated as unclaimed (null), same as no registration", () => {
    const v: Viewer = { id: "test.toggle.e", extensions: ["vtge"], open: () => ({ close() {} }) };
    registerViewer(v);
    const claimed = viewerFor("vtge");
    expect(claimed).not.toBeNull();
    const disabled = ["test.toggle.e"];
    const gated = claimed !== null && isViewerEnabled(disabled, claimed.id) ? claimed : null;
    expect(gated).toBeNull();
  });

  it("an enabled viewer's claimed extension passes through unchanged", () => {
    const v: Viewer = { id: "test.toggle.f", extensions: ["vtgf"], open: () => ({ close() {} }) };
    registerViewer(v);
    const claimed = viewerFor("vtgf");
    const gated = claimed !== null && isViewerEnabled([], claimed.id) ? claimed : null;
    expect(gated).toBe(claimed);
  });

  it("an unclaimed extension stays null regardless of the disabled-set", () => {
    const claimed = viewerFor("test-toggle-unclaimed-ext");
    expect(claimed).toBeNull();
    const gated = claimed !== null && isViewerEnabled([], "irrelevant") ? claimed : null;
    expect(gated).toBeNull();
  });
});
