import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mountSettingsButton } from "../src/settings/panel/modal";
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

  it("mounting only adds the ⚙ button — no modal DOM until first open (lazy build)", () => {
    const bar = document.createElement("div");
    document.body.appendChild(bar);
    mountSettingsButton(bar);
    expect(bar.querySelector(".settings-btn")).not.toBeNull();
    expect(document.querySelector(".settings-backdrop")).toBeNull(); // not built yet
  });

  it("clicking ⚙ builds the modal, shows the backdrop, and renders sidebar categories", () => {
    const host = document.createElement("div");
    host.className = "editor-host";
    const bar = document.createElement("div");
    document.body.append(host, bar);
    mountSettingsButton(bar);
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
    mountSettingsButton(bar);
    (bar.querySelector(".settings-btn") as HTMLButtonElement).click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect((document.querySelector(".settings-backdrop") as HTMLElement).hidden).toBe(true);
    expect(host.hasAttribute("inert")).toBe(false);
  });

  it("the pane reflects the entry label in the row label cell", () => {
    const bar = document.createElement("div");
    document.body.appendChild(bar);
    mountSettingsButton(bar);
    (bar.querySelector(".settings-btn") as HTMLButtonElement).click();
    const labels = [...document.querySelectorAll(".settings-pane .settings-row-label")].map((l) => l.textContent);
    expect(labels).toContain("X");
  });
});
