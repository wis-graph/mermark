import { describe, it, expect, beforeEach } from "vitest";
import { defineSetting } from "../src/settings/store";
import { RENDER, runTeardown } from "../src/settings/panel/controls";
import { bindKeybindings, effectiveBinding } from "../src/shortcuts/registry";
import { displayChord } from "../src/shortcuts/keys";
import "../src/settings/app"; // registers the 단축키 category into the registry
import { groups } from "../src/settings/registry";

// The keybind control renders one row per SHORTCUT_ACTION off a single setting
// (the override map). effectiveBinding/findConflict read the registry, so the
// control's setting must be the registry-bound one — bindKeybindings wires it.

function keybindSetting(key: string) {
  return defineSetting<Record<string, string>>({
    key,
    default: {},
    parse: (raw) => {
      if (raw == null) return null;
      try {
        const o = JSON.parse(raw);
        return o && typeof o === "object" && !Array.isArray(o) ? o : null;
      } catch {
        return null;
      }
    },
    serialize: (v) => JSON.stringify(v),
  });
}

function rowFor(root: HTMLElement, id: string): HTMLElement {
  return root.querySelector<HTMLElement>(`.keybind-item[data-id="${id}"]`)!;
}
function chordText(root: HTMLElement, id: string): string {
  return rowFor(root, id).querySelector<HTMLElement>(".keybind-chord")!.textContent ?? "";
}
function captureBtn(root: HTMLElement, id: string): HTMLButtonElement {
  return rowFor(root, id).querySelector<HTMLButtonElement>(".keybind-capture")!;
}
function pressWindow(init: Partial<KeyboardEventInit> & { code: string }) {
  window.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }));
}

describe("keybind control", () => {
  beforeEach(() => localStorage.clear());

  it("mount reflects effectiveBinding per action (default + unbound)", () => {
    const s = keybindSetting("kbc.a");
    bindKeybindings(s);
    const row = RENDER.keybind(s, { kind: "keybind" });
    expect(chordText(row, "mode.toggle")).toBe(displayChord(effectiveBinding("mode.toggle")!));
    expect(chordText(row, "vim.toggle")).toBe("미지정"); // null default
  });

  it("capture writes the pressed chord into the setting and reflects it", () => {
    const s = keybindSetting("kbc.b");
    bindKeybindings(s);
    const row = RENDER.keybind(s, { kind: "keybind" });
    captureBtn(row, "vim.toggle").click();
    pressWindow({ metaKey: true, code: "KeyJ" }); // Mod+J — unused
    expect(s.get()["vim.toggle"]).toBe("Mod+J");
    expect(chordText(row, "vim.toggle")).toBe(displayChord("Mod+J"));
  });

  it("rejects a conflicting chord (no write) and shows a warning", () => {
    const s = keybindSetting("kbc.c");
    bindKeybindings(s);
    const row = RENDER.keybind(s, { kind: "keybind" });
    captureBtn(row, "outline.toggle").click();
    pressWindow({ metaKey: true, code: "KeyE" }); // Mod+E is mode.toggle's default
    expect(s.get()["outline.toggle"]).toBeUndefined();
    const warn = rowFor(row, "outline.toggle").querySelector<HTMLElement>(".keybind-warning")!;
    expect(warn.hidden).toBe(false);
    expect(warn.textContent).toContain("이미");
  });

  it("Esc cancels the capture without writing", () => {
    const s = keybindSetting("kbc.d");
    bindKeybindings(s);
    const row = RENDER.keybind(s, { kind: "keybind" });
    const btn = captureBtn(row, "vim.toggle");
    btn.click();
    expect(btn.textContent).toBe("키를 누르세요…");
    pressWindow({ code: "Escape" });
    expect(s.get()["vim.toggle"]).toBeUndefined();
    expect(btn.textContent).toBe("재정의");
  });

  it("individual reset removes the override (falls back to default)", () => {
    const s = keybindSetting("kbc.e");
    bindKeybindings(s);
    s.set({ "explorer.toggle": "Mod+L" });
    const row = RENDER.keybind(s, { kind: "keybind" });
    rowFor(row, "explorer.toggle").querySelector<HTMLButtonElement>(".keybind-reset")!.click();
    expect(s.get()["explorer.toggle"]).toBeUndefined();
    expect(chordText(row, "explorer.toggle")).toBe(displayChord("Mod+B")); // back to default
  });

  it("전체 리셋 clears all overrides", () => {
    const s = keybindSetting("kbc.f");
    bindKeybindings(s);
    s.set({ "explorer.toggle": "Mod+L", "vim.toggle": "Mod+J" });
    const row = RENDER.keybind(s, { kind: "keybind" });
    row.querySelector<HTMLButtonElement>(".keybind-reset-all")!.click();
    expect(s.get()).toEqual({});
  });

  it("teardown unsubscribes: a later set no longer updates the DOM", () => {
    const s = keybindSetting("kbc.g");
    bindKeybindings(s);
    const row = RENDER.keybind(s, { kind: "keybind" });
    runTeardown(row);
    s.set({ "vim.toggle": "Mod+J" });
    expect(chordText(row, "vim.toggle")).toBe("미지정"); // reflect closure is dead
  });

  it("registers a 단축키 settings category", () => {
    expect(groups().some((g) => g.name === "단축키")).toBe(true);
  });
});
