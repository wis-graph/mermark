import { describe, it, expect, beforeEach, vi } from "vitest";
import { defineSetting } from "../src/settings/store";
import { RENDER } from "../src/settings/panel/controls";
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

  it("export copy uses serializeTheme(get())", async () => {
    const s = jsonSetting();
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } } as unknown as Navigator);
    const row = RENDER.json(s, { kind: "json" });
    (row.querySelector("[data-act=copy]") as HTMLButtonElement).click();
    expect(writeText).toHaveBeenCalledWith(serializeTheme(s.get()));
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
});
