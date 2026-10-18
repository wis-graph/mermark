import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Stub the Tauri invoke boundary the same way clipboard.test.ts does:
// copyTextToClipboard (src/clipboard.ts) is the theme-JSON copy button's only
// clipboard path — no navigator.clipboard fallback.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

import { defineSetting } from "../src/settings/store";
import { RENDER, runTeardown, attachTeardown, createSwitch, isOverridden } from "../src/settings/panel/controls";
import { serializeTheme, parseTheme, builtInTheme } from "../src/settings/theme-schema";

beforeEach(() => localStorage.clear());

function fire(el: HTMLElement, type: string) {
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

describe("segmented control", () => {
  it("reflects setting.get(): the current value's button is pressed", () => {
    const s = defineSetting<string>({ key: "c.seg", default: "b" });
    const row = RENDER.segmented(s, {
      kind: "segmented",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    });
    const pressed = row.querySelector('[aria-pressed="true"]') as HTMLButtonElement;
    expect(pressed.textContent).toBe("B");
  });

  it("clicking an option writes setting.set with that value", () => {
    const s = defineSetting<string>({ key: "c.seg2", default: "a" });
    const row = RENDER.segmented(s, {
      kind: "segmented",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    });
    (row.querySelectorAll("button")[1] as HTMLButtonElement).click();
    expect(s.get()).toBe("b");
  });

  it("updates live when the setting changes externally (round-trip)", () => {
    const s = defineSetting<string>({ key: "c.seg3", default: "a" });
    const row = RENDER.segmented(s, {
      kind: "segmented",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    });
    s.set("b");
    const pressed = row.querySelector('[aria-pressed="true"]') as HTMLButtonElement;
    expect(pressed.textContent).toBe("B");
  });
});

describe("select control", () => {
  it("reflects setting.get() as the selected option", () => {
    const s = defineSetting<string>({ key: "c.sel", default: "y" });
    const row = RENDER.select(s, {
      kind: "select",
      options: [
        { value: "x", label: "X" },
        { value: "y", label: "Y" },
      ],
    });
    const select = row.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("y");
  });

  it("change event writes setting.set", () => {
    const s = defineSetting<string>({ key: "c.sel2", default: "x" });
    const row = RENDER.select(s, {
      kind: "select",
      options: [
        { value: "x", label: "X" },
        { value: "y", label: "Y" },
      ],
    });
    const select = row.querySelector("select") as HTMLSelectElement;
    select.value = "y";
    fire(select, "change");
    expect(s.get()).toBe("y");
  });

  it("updates live on external change", () => {
    const s = defineSetting<string>({ key: "c.sel3", default: "x" });
    const row = RENDER.select(s, {
      kind: "select",
      options: [
        { value: "x", label: "X" },
        { value: "y", label: "Y" },
      ],
    });
    s.set("y");
    expect((row.querySelector("select") as HTMLSelectElement).value).toBe("y");
  });

  it("wraps the select in .settings-select-wrap (positioning context for the themed chevron)", () => {
    const s = defineSetting<string>({ key: "c.sel4", default: "x" });
    const row = RENDER.select(s, {
      kind: "select",
      options: [{ value: "x", label: "X" }],
    });
    const wrap = row.querySelector(".settings-select-wrap");
    expect(wrap).not.toBeNull();
    expect(wrap?.querySelector("select")).not.toBeNull();
  });
});

describe("slider control", () => {
  it("reflects setting.get() as the range value", () => {
    const s = defineSetting<number>({
      key: "c.sli",
      default: 14,
      parse: (r) => (r == null ? null : Number(r)),
    });
    const row = RENDER.slider(s, { kind: "slider", min: 10, max: 24, step: 1, unit: "px" });
    expect((row.querySelector("input[type=range]") as HTMLInputElement).value).toBe("14");
  });

  it("input event writes the numeric value via setting.set", () => {
    const s = defineSetting<number>({
      key: "c.sli2",
      default: 14,
      parse: (r) => (r == null ? null : Number(r)),
    });
    const row = RENDER.slider(s, { kind: "slider", min: 10, max: 24, step: 1 });
    const range = row.querySelector("input[type=range]") as HTMLInputElement;
    range.value = "18";
    fire(range, "input");
    expect(s.get()).toBe(18);
  });

  it("updates live on external change", () => {
    const s = defineSetting<number>({
      key: "c.sli3",
      default: 14,
      parse: (r) => (r == null ? null : Number(r)),
    });
    const row = RENDER.slider(s, { kind: "slider", min: 10, max: 24, step: 1 });
    s.set(20);
    expect((row.querySelector("input[type=range]") as HTMLInputElement).value).toBe("20");
  });
});

describe("json control (theme import/export)", () => {
  function jsonSetting() {
    return defineSetting({
      key: "c.json",
      default: builtInTheme("dark"),
      parse: parseTheme,
      serialize: serializeTheme,
    });
  }

  it("reflects setting.get() as serialized JSON in the textarea", () => {
    const s = jsonSetting();
    const row = RENDER.json(s, { kind: "json" });
    const ta = row.querySelector("textarea") as HTMLTextAreaElement;
    expect(ta.value).toBe(serializeTheme(s.get()));
  });

  it("buttons use the button grammar: apply = primary, others = secondary", () => {
    const row = RENDER.json(jsonSetting(), { kind: "json" });
    expect((row.querySelector("[data-act=apply]") as HTMLElement).classList.contains("btn-primary")).toBe(true);
    for (const b of Array.from(row.querySelectorAll<HTMLElement>(".settings-json-btn:not([data-act=apply])"))) {
      expect(b.classList.contains("btn-secondary")).toBe(true);
    }
  });

  it("valid paste + 적용 → setting.set(parsed) and no error", () => {
    const s = jsonSetting();
    const row = RENDER.json(s, { kind: "json" });
    const ta = row.querySelector("textarea") as HTMLTextAreaElement;
    const next = builtInTheme("light");
    ta.value = serializeTheme(next);
    (row.querySelector("[data-act=apply]") as HTMLButtonElement).click();
    expect(s.get()).toEqual(next);
    expect((row.querySelector(".settings-json-error") as HTMLElement).textContent).toBe("");
  });

  it("malformed paste + 적용 → shows an error and does NOT call set", () => {
    const s = jsonSetting();
    const before = s.get();
    const setSpy = vi.spyOn(s, "set");
    const row = RENDER.json(s, { kind: "json" });
    const ta = row.querySelector("textarea") as HTMLTextAreaElement;
    ta.value = "{ broken json";
    (row.querySelector("[data-act=apply]") as HTMLButtonElement).click();
    expect(setSpy).not.toHaveBeenCalled();
    expect(s.get()).toEqual(before);
    expect((row.querySelector(".settings-json-error") as HTMLElement).textContent).not.toBe("");
  });

  it("external change updates the textarea live (round-trip)", () => {
    const s = jsonSetting();
    const row = RENDER.json(s, { kind: "json" });
    const ta = row.querySelector("textarea") as HTMLTextAreaElement;
    s.set(builtInTheme("light"));
    expect(ta.value).toBe(serializeTheme(builtInTheme("light")));
  });

  it("export copy writes serializeTheme(get()) via the backend IPC path, not navigator.clipboard", async () => {
    invokeMock.mockReset().mockResolvedValue(undefined);
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } } as unknown as Navigator);
    const s = jsonSetting();
    const row = RENDER.json(s, { kind: "json" });
    (row.querySelector("[data-act=copy]") as HTMLButtonElement).click();
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith("copy_to_clipboard", { text: serializeTheme(s.get()) });
    expect(writeText).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("info control", () => {
  it("renders a read-only row with the label, no input", () => {
    const s = defineSetting<string>({ key: "c.info", default: "" });
    const row = RENDER.info(s, { kind: "info" });
    expect(row.querySelector("input")).toBeNull();
    expect(row.querySelector("select")).toBeNull();
    expect(row.textContent).toContain("플러그인");
  });
});

describe("text control (P0 web-font name input)", () => {
  it("reflects setting.get() as the text input value", () => {
    const s = defineSetting<string>({ key: "c.txt", default: "Lato" });
    const row = RENDER.text(s, { kind: "text" });
    const input = row.querySelector("input[type=text]") as HTMLInputElement;
    expect(input.value).toBe("Lato");
  });

  it("input event writes the raw value via setting.set (sanitization happens downstream)", () => {
    const s = defineSetting<string>({ key: "c.txt2", default: "" });
    const row = RENDER.text(s, { kind: "text" });
    const input = row.querySelector("input[type=text]") as HTMLInputElement;
    input.value = "Noto Sans KR";
    fire(input, "input");
    expect(s.get()).toBe("Noto Sans KR");
  });

  it("updates live on external change (round-trip)", () => {
    const s = defineSetting<string>({ key: "c.txt3", default: "" });
    const row = RENDER.text(s, { kind: "text" });
    s.set("Roboto");
    expect((row.querySelector("input[type=text]") as HTMLInputElement).value).toBe("Roboto");
  });

  it("applies the placeholder and renders the help text when provided", () => {
    const s = defineSetting<string>({ key: "c.txt4", default: "" });
    const row = RENDER.text(s, { kind: "text", placeholder: "예: Noto Sans KR", help: "도움말" });
    const input = row.querySelector("input[type=text]") as HTMLInputElement;
    expect(input.placeholder).toBe("예: Noto Sans KR");
    expect(row.textContent).toContain("도움말");
  });

  it("adds settings-row-has-help when the control has help text (so CSS wraps it below the input)", () => {
    const s = defineSetting<string>({ key: "c.txt5", default: "" });
    const row = RENDER.text(s, { kind: "text", help: "도움말" });
    expect(row.classList.contains("settings-row-has-help")).toBe(true);
  });

  it("does NOT add settings-row-has-help when the control has no help text", () => {
    const s = defineSetting<string>({ key: "c.txt6", default: "" });
    const row = RENDER.text(s, { kind: "text" });
    expect(row.classList.contains("settings-row-has-help")).toBe(false);
  });
});

describe("registry controls release their subscription on runTeardown", () => {
  it("segmented stops reflecting after teardown", () => {
    const s = defineSetting<string>({ key: "td.seg", default: "a" });
    const row = RENDER.segmented(s, {
      kind: "segmented",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    });
    runTeardown(row);
    s.set("b");
    const btnB = row.querySelectorAll("button")[1] as HTMLButtonElement;
    expect(btnB.getAttribute("aria-pressed")).toBe("false");
  });

  it("select stops reflecting after teardown", () => {
    const s = defineSetting<string>({ key: "td.sel", default: "a" });
    const row = RENDER.select(s, {
      kind: "select",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    });
    const select = row.querySelector("select") as HTMLSelectElement;
    runTeardown(row);
    s.set("b");
    expect(select.value).toBe("a");
  });

  it("slider stops reflecting after teardown", () => {
    const s = defineSetting<number>({ key: "td.sld", default: 5, parse: (r) => (r == null ? null : Number(r)) });
    const row = RENDER.slider(s, { kind: "slider", min: 0, max: 10, step: 1, unit: "ms" });
    const range = row.querySelector("input") as HTMLInputElement;
    const out = row.querySelector(".settings-slider-value") as HTMLElement;
    runTeardown(row);
    s.set(9);
    expect(range.value).toBe("5");
    expect(out.textContent).toBe("5ms");
  });

  it("text stops reflecting after teardown", () => {
    const s = defineSetting<string>({ key: "td.txt", default: "a" });
    const row = RENDER.text(s, { kind: "text" });
    const input = row.querySelector("input") as HTMLInputElement;
    runTeardown(row);
    s.set("zzz");
    expect(input.value).toBe("a");
  });

  it("attachTeardown accumulates (a second registration does not drop the first) and runTeardown is idempotent", () => {
    const el = document.createElement("div");
    const u1 = vi.fn();
    const u2 = vi.fn();
    attachTeardown(el, [u1]);
    attachTeardown(el, [u2]);
    runTeardown(el);
    expect(u1).toHaveBeenCalledTimes(1);
    expect(u2).toHaveBeenCalledTimes(1);
    runTeardown(el);
    expect(u1).toHaveBeenCalledTimes(1);
    expect(u2).toHaveBeenCalledTimes(1);
  });
});

describe("switch control (D2c)", () => {
  const sw = (row: HTMLElement) => row.querySelector<HTMLButtonElement>('button[role="switch"]')!;

  it("createSwitch: button[role=switch].settings-switch > .settings-switch-thumb", () => {
    const b = createSwitch();
    expect(b.tagName).toBe("BUTTON");
    expect(b.getAttribute("role")).toBe("switch");
    expect(b.classList.contains("settings-switch")).toBe(true);
    expect(b.querySelector(":scope > .settings-switch-thumb")).not.toBeNull();
  });

  it("string pair: mount reflects aria-checked, click toggles, external set re-reflects", () => {
    const s = defineSetting<string>({ key: "c.sw1", default: "off" });
    const row = RENDER.switch(s, { kind: "switch", on: "on", off: "off" });
    expect(sw(row).getAttribute("aria-checked")).toBe("false");
    sw(row).click();
    expect(s.get()).toBe("on");
    expect(sw(row).getAttribute("aria-checked")).toBe("true");
    s.set("off");
    expect(sw(row).getAttribute("aria-checked")).toBe("false");
    sw(row).click();
    sw(row).click();
    expect(s.get()).toBe("off");
  });

  it("boolean pair works the same", () => {
    const s = defineSetting<boolean>({ key: "c.sw2", default: true });
    const row = RENDER.switch(s, { kind: "switch", on: true, off: false });
    expect(sw(row).getAttribute("aria-checked")).toBe("true");
    sw(row).click();
    expect(s.get()).toBe(false);
  });

  it("teardown unsubscribes", () => {
    const s = defineSetting<string>({ key: "c.sw3", default: "off" });
    const row = RENDER.switch(s, { kind: "switch", on: "on", off: "off" });
    runTeardown(row);
    s.set("on");
    expect(sw(row).getAttribute("aria-checked")).toBe("false");
  });

  it("aria-labelledby points at the row label element", () => {
    const s = defineSetting<string>({ key: "c.sw4", default: "off" });
    const row = RENDER.switch(s, { kind: "switch", on: "on", off: "off" });
    const id = sw(row).getAttribute("aria-labelledby")!;
    expect(id).toBeTruthy();
    expect(row.querySelector(".settings-row-label")!.id).toBe(id);
  });

  it("label click toggles exactly once (label[for] -> switch id)", () => {
    const s = defineSetting<string>({ key: "c.sw6", default: "off" });
    const row = RENDER.switch(s, { kind: "switch", on: "on", off: "off" });
    document.body.appendChild(row);
    const label = row.querySelector<HTMLLabelElement>(".settings-row-label")!;
    label.textContent = "라벨";
    expect(sw(row).id).toBeTruthy();
    expect(label.htmlFor).toBe(sw(row).id);
    label.click();
    expect(s.get()).toBe("on");
    expect(sw(row).getAttribute("aria-checked")).toBe("true");
    sw(row).click();
    expect(s.get()).toBe("off");
    row.remove();
  });

  it("switch row with help gets settings-row-switch-help; without help it does not", () => {
    const s = defineSetting<string>({ key: "c.sw7", default: "off" });
    const h = RENDER.switch(s, { kind: "switch", on: "on", off: "off", help: "x" });
    const n = RENDER.switch(s, { kind: "switch", on: "on", off: "off" });
    expect(h.classList.contains("settings-row-switch-help")).toBe(true);
    expect(n.classList.contains("settings-row-switch-help")).toBe(false);
  });

  it("CSS: switch-help row aligns label and switch on the first line", () => {
    const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles.css"), "utf8");
    const rule = (sel: string) => css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"))?.[1] ?? "";
    expect(rule(".settings-row-switch-help")).toMatch(/align-items:\s*flex-start/);
    expect(rule(".settings-row-switch-help .settings-row-control")).toMatch(/align-items:\s*flex-start/);
    expect(rule(".settings-row-switch-help .settings-row-label")).toMatch(/line-height:\s*18px/);
  });

  it("help text renders below like the other controls", () => {
    const s = defineSetting<string>({ key: "c.sw5", default: "off" });
    const row = RENDER.switch(s, { kind: "switch", on: "on", off: "off", help: "도움말" });
    expect(row.querySelector(".settings-text-help")!.textContent).toBe("도움말");
    expect(row.classList.contains("settings-row-has-help")).toBe(true);
  });
});

describe("isOverridden (D2c)", () => {
  it("true only for an own key", () => {
    expect(isOverridden({ a: "Mod+J" }, "a")).toBe(true);
    expect(isOverridden({}, "a")).toBe(false);
    expect(isOverridden({}, "toString")).toBe(false);
  });
});
