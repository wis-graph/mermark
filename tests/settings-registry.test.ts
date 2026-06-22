import { describe, it, expect, beforeEach } from "vitest";

// registerSetting = defineSetting (storage) + (iff def.ui) push {setting, ui} to
// a module-level ordered registry that groups() reads back. The panel iterates
// groups(); storage behavior is unchanged from defineSetting.

describe("registerSetting + groups", () => {
  beforeEach(() => localStorage.clear());

  it("a setting WITH ui appears in groups() under its group", async () => {
    const { registerSetting, groups } = await import("../src/settings/registry");
    registerSetting<string>({
      key: "t.a",
      default: "x",
      ui: { label: "A", group: "G1", control: { kind: "segmented", options: [{ value: "x", label: "X" }] } },
    });
    const g = groups();
    const g1 = g.find((grp) => grp.name === "G1");
    expect(g1).toBeDefined();
    expect(g1!.entries.map((e) => e.ui.label)).toContain("A");
  });

  it("a setting WITHOUT ui does not appear in groups() but still stores", async () => {
    const { registerSetting, groups } = await import("../src/settings/registry");
    const s = registerSetting<string>({ key: "t.hidden", default: "d" });
    expect(groups().some((grp) => grp.entries.some((e) => e.setting === s))).toBe(false);
    // storage still works
    s.set("z");
    expect(localStorage.getItem("t.hidden")).toBe("z");
    expect(s.get()).toBe("z");
  });

  it("groups() returns groups in registration (insertion) order", async () => {
    const { registerSetting, groups } = await import("../src/settings/registry");
    registerSetting({ key: "t.b1", default: "1", ui: { label: "B1", group: "Beta", control: { kind: "info" } } });
    registerSetting({ key: "t.a1", default: "1", ui: { label: "A1", group: "Alpha", control: { kind: "info" } } });
    registerSetting({ key: "t.b2", default: "1", ui: { label: "B2", group: "Beta", control: { kind: "info" } } });
    const names = groups().map((grp) => grp.name);
    // Beta registered first → appears before Alpha; a group only appears once.
    expect(names.indexOf("Beta")).toBeLessThan(names.indexOf("Alpha"));
    expect(names.filter((n) => n === "Beta").length).toBe(1);
    // entries within a group keep insertion order
    const beta = groups().find((grp) => grp.name === "Beta")!;
    expect(beta.entries.map((e) => e.ui.label)).toEqual(["B1", "B2"]);
  });

  it("delegates storage semantics to defineSetting (get/set/subscribe/bind/persist)", async () => {
    const { registerSetting } = await import("../src/settings/registry");
    localStorage.setItem("t.persisted", "saved");
    const s = registerSetting<string>({ key: "t.persisted", default: "d" });
    expect(s.get()).toBe("saved"); // reads persisted on construction
    const seen: string[] = [];
    const off = s.bind((v) => seen.push(v));
    expect(seen).toEqual(["saved"]); // bind fires immediately
    s.set("next");
    expect(seen).toEqual(["saved", "next"]);
    expect(localStorage.getItem("t.persisted")).toBe("next");
    off();
    s.set("after-off");
    expect(seen).toEqual(["saved", "next"]); // no notify after unsubscribe
  });
});
