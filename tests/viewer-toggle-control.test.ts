import { describe, it, expect, beforeEach } from "vitest";
import { defineSetting } from "../src/settings/store";
import { RENDER, runTeardown, viewerDisplayName } from "../src/settings/panel/controls";
import { registerViewer, type Viewer } from "../src/chrome/viewer/registry";

// The viewer-toggles control renders one row per registered viewer off a
// single disabled-set setting (mirrors tests/keybind-control.test.ts's shape
// for the keybind control, which renders one row per SHORTCUT_ACTION off a
// single override-map setting).

function disabledSetting(key: string) {
  return defineSetting<string[]>({
    key,
    default: [],
    parse: (raw) => {
      if (raw == null) return null;
      try {
        const a = JSON.parse(raw);
        return Array.isArray(a) ? a.filter((x) => typeof x === "string") : null;
      } catch {
        return null;
      }
    },
    serialize: (v) => JSON.stringify(v),
  });
}

function rowFor(root: HTMLElement, id: string): HTMLElement {
  return root.querySelector<HTMLElement>(`.settings-vtoggle-item[data-id="${id}"]`)!;
}
function onBtn(root: HTMLElement, id: string): HTMLButtonElement {
  return rowFor(root, id).querySelectorAll<HTMLButtonElement>(".settings-seg-btn")[0];
}
function offBtn(root: HTMLElement, id: string): HTMLButtonElement {
  return rowFor(root, id).querySelectorAll<HTMLButtonElement>(".settings-seg-btn")[1];
}

let counter = 0;
function uniqueViewer(overrides: Partial<Viewer> = {}): Viewer {
  counter += 1;
  const id = overrides.id ?? `test.vtc.${counter}`;
  const ext = `vtc${counter}`;
  const v: Viewer = { id, extensions: [ext], open: () => ({ close() {} }), ...overrides };
  registerViewer(v);
  return v;
}

describe("viewer-toggles control", () => {
  beforeEach(() => localStorage.clear());

  it("renders a row for every registered viewer (structural regression gate — design §회귀 게이트)", () => {
    const v1 = uniqueViewer({ label: "Viewer One" });
    const v2 = uniqueViewer({ label: "Viewer Two" });
    const s = disabledSetting("vtc.a");
    const row = RENDER["viewer-toggles"](s, { kind: "viewer-toggles" });
    expect(rowFor(row, v1.id)).toBeTruthy();
    expect(rowFor(row, v2.id)).toBeTruthy();
  });

  it("a viewer without a label falls back to the id+extensions derived display name", () => {
    const v = uniqueViewer(); // no label
    const s = disabledSetting("vtc.b");
    const row = RENDER["viewer-toggles"](s, { kind: "viewer-toggles" });
    const label = rowFor(row, v.id).querySelector(".settings-vtoggle-label")!.textContent;
    expect(label).toBe(viewerDisplayName(v));
    expect(label).toBe(`${v.id} (${v.extensions.join(", ")})`);
  });

  it("mount reflects enabled state (aria-pressed) from the setting", () => {
    const v = uniqueViewer();
    const s = disabledSetting("vtc.c");
    s.set([v.id]);
    const row = RENDER["viewer-toggles"](s, { kind: "viewer-toggles" });
    expect(onBtn(row, v.id).getAttribute("aria-pressed")).toBe("false");
    expect(offBtn(row, v.id).getAttribute("aria-pressed")).toBe("true");
  });

  it("clicking off adds the id to the disabled-set; clicking on removes it (round-trip)", () => {
    const v = uniqueViewer();
    const s = disabledSetting("vtc.d");
    const row = RENDER["viewer-toggles"](s, { kind: "viewer-toggles" });
    offBtn(row, v.id).click();
    expect(s.get()).toContain(v.id);
    expect(onBtn(row, v.id).getAttribute("aria-pressed")).toBe("false");
    onBtn(row, v.id).click();
    expect(s.get()).not.toContain(v.id);
    expect(onBtn(row, v.id).getAttribute("aria-pressed")).toBe("true");
  });

  it("an external setting.set updates the row (subscribe/reflect contract)", () => {
    const v = uniqueViewer();
    const s = disabledSetting("vtc.e");
    const row = RENDER["viewer-toggles"](s, { kind: "viewer-toggles" });
    expect(offBtn(row, v.id).getAttribute("aria-pressed")).toBe("false");
    s.set([v.id]);
    expect(offBtn(row, v.id).getAttribute("aria-pressed")).toBe("true");
  });

  it("teardown unsubscribes: a later external set no longer updates the DOM", () => {
    const v = uniqueViewer();
    const s = disabledSetting("vtc.f");
    const row = RENDER["viewer-toggles"](s, { kind: "viewer-toggles" });
    runTeardown(row);
    s.set([v.id]);
    expect(offBtn(row, v.id).getAttribute("aria-pressed")).toBe("false"); // stale reflect, no longer wired
  });
});
