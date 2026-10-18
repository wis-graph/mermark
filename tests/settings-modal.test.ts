import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSettingsButton, isListControl, createPaneTitle } from "../src/settings/panel/modal";
import "../src/settings/app";
import { registerSetting } from "../src/settings/registry";

// matchMedia is provided by tests/setup.ts; the registry needs at least one
// ui-bearing setting to render a category. We register a throwaway one here so
// the modal has content regardless of import order with app.ts.

describe("settings modal (mount + open/close)", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    registerSetting<string>({
      key: "m.x",
      default: "a",
      ui: {
        label: "X",
        group: "테마",
        control: {
          kind: "segmented",
          options: [
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ],
        },
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("creating only builds the ⚙ button — no modal DOM until first open (lazy build), and it is not appended anywhere", () => {
    const bar = document.createElement("div");
    document.body.appendChild(bar);
    const btn = createSettingsButton(() => []);
    expect(btn.classList.contains("settings-btn")).toBe(true);
    expect(btn.parentElement).toBeNull(); // caller positions it — createSettingsButton doesn't append
    expect(document.querySelector(".settings-backdrop")).toBeNull(); // not built yet
  });

  it("clicking ⚙ builds the modal, shows the backdrop, and renders sidebar categories", () => {
    const host = document.createElement("div");
    host.className = "editor-host";
    const bar = document.createElement("div");
    document.body.append(host, bar);
    const btn = createSettingsButton(() => []);
    bar.append(btn);
    (bar.querySelector(".settings-btn") as HTMLButtonElement).click();

    const backdrop = document.querySelector(".settings-backdrop") as HTMLElement;
    expect(backdrop).not.toBeNull();
    expect(backdrop.hidden).toBe(false);
    // sidebar has at least the 테마 category (from the registry)
    const cats = [...backdrop.querySelectorAll<HTMLElement>(".settings-cat")].map((c) => c.textContent);
    expect(cats).toContain("테마");
    // first category active, pane populated
    expect(backdrop.querySelector(".settings-cat.active")).not.toBeNull();
    expect(backdrop.querySelector(".settings-pane .settings-row")).not.toBeNull();
    // editor host is inert while the modal is up
    expect(host.hasAttribute("inert")).toBe(true);
  });

  it("ESC closes the modal and clears editor inert", () => {
    const host = document.createElement("div");
    host.className = "editor-host";
    const bar = document.createElement("div");
    document.body.append(host, bar);
    bar.append(createSettingsButton(() => []));
    (bar.querySelector(".settings-btn") as HTMLButtonElement).click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect((document.querySelector(".settings-backdrop") as HTMLElement).hidden).toBe(true);
    expect(host.hasAttribute("inert")).toBe(false);
  });

  it("the pane reflects the entry label in the row label cell", () => {
    const bar = document.createElement("div");
    document.body.appendChild(bar);
    bar.append(createSettingsButton(() => []));
    (bar.querySelector(".settings-btn") as HTMLButtonElement).click();
    const labels = [...document.querySelectorAll(".settings-pane .settings-row-label")].map((l) => l.textContent);
    expect(labels).toContain("X");
  });

  function openModal(): HTMLElement {
    const bar = document.createElement("div");
    document.body.appendChild(bar);
    bar.append(createSettingsButton(() => []));
    (bar.querySelector(".settings-btn") as HTMLButtonElement).click();
    return document.querySelector(".settings-backdrop") as HTMLElement;
  }
  function selectCat(backdrop: HTMLElement, name: string): HTMLElement {
    const b = [...backdrop.querySelectorAll<HTMLElement>(".settings-cat")].find((c) => c.textContent === name)!;
    b.click();
    return backdrop.querySelector(".settings-pane") as HTMLElement;
  }

  it("the pane starts with an h2.settings-pane-title carrying the group name", () => {
    const backdrop = openModal();
    const pane = selectCat(backdrop, "에디터");
    const first = pane.firstElementChild as HTMLElement;
    expect(first.tagName).toBe("H2");
    expect(first.classList.contains("settings-pane-title")).toBe(true);
    expect(first.textContent).toBe("에디터");
    expect(createPaneTitle("X").className).toBe("settings-pane-title");
  });

  it("list-type controls (keybind, viewer-toggles) get no label cell text; others keep theirs", () => {
    const backdrop = openModal();
    for (const name of ["단축키", "뷰어"]) {
      const pane = selectCat(backdrop, name);
      const list = pane.querySelector(".settings-row-keybind, .settings-row-viewer-toggles") as HTMLElement;
      expect(list.querySelector(".settings-row-label")!.textContent).toBe("");
    }
    const pane = selectCat(backdrop, "에디터");
    expect(pane.querySelector(".settings-row-label")!.textContent).not.toBe("");
  });

  it("isListControl: only keybind and viewer-toggles", () => {
    expect(isListControl("keybind")).toBe(true);
    expect(isListControl("viewer-toggles")).toBe(true);
    for (const k of ["segmented", "select", "slider", "text", "json", "info", "switch"] as const) expect(isListControl(k)).toBe(false);
  });
});
