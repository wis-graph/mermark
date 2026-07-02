import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOpenPathPrompt } from "../src/open-file/path-prompt";

/** The open-by-path prompt is "bar-becomes-input": clicking the button toggles
 *  `.path-editing` on its host bar and turns it into a full-width path input (no
 *  separate row opens below). M2 moved the host bar from the footer/status-bar
 *  up to the title-bar (main.ts wires `bar: titleBar.el`); this module is
 *  bar-agnostic (no logic change), so these tests exercise it against a plain
 *  `.title-bar` element — the CSS contract these pin lives in
 *  `.title-bar.path-editing` selectors (styles.css). Enter submits, Esc/blur
 *  cancels. These tests pin that UI contract (toggle, submit, error-keeps-editing,
 *  cancel) without a real editor — the resolve→read→re-mount is the caller's
 *  onOpen. */

function press(input: HTMLInputElement, key: string) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

describe("open-path title-bar prompt (inline / bar-becomes-input)", () => {
  let bar: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = "";
    bar = document.createElement("div");
    bar.className = "title-bar";
    document.body.appendChild(bar);
  });

  it("builds a chrome button with the folder-open icon + label", () => {
    const { button } = createOpenPathPrompt({ bar, onOpen: async () => {} });
    expect(button.classList.contains("chrome-btn")).toBe(true);
    expect(button.classList.contains("open-path")).toBe(true);
    expect(button.querySelector(".icon-folder-open")).not.toBeNull();
    expect(button.textContent).toContain("경로 열기");
  });

  it("appends the input into the bar and starts NOT in path-editing", () => {
    const { input } = createOpenPathPrompt({ bar, onOpen: async () => {} });
    expect(input.parentElement).toBe(bar);
    expect(bar.classList.contains("path-editing")).toBe(false);
  });

  it("enters path-editing (bar class + input focus) on button click", () => {
    const { button, input } = createOpenPathPrompt({ bar, onOpen: async () => {} });
    bar.appendChild(button);
    button.click();
    expect(bar.classList.contains("path-editing")).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it("toggles back out of path-editing on a second button click", () => {
    const { button } = createOpenPathPrompt({ bar, onOpen: async () => {} });
    bar.appendChild(button);
    button.click();
    button.click();
    expect(bar.classList.contains("path-editing")).toBe(false);
  });

  it("calls onOpen with the raw typed path on Enter", () => {
    const onOpen = vi.fn(async () => {});
    const { button, input } = createOpenPathPrompt({ bar, onOpen });
    bar.appendChild(button);
    button.click();
    input.value = "~/notes/x.md";
    press(input, "Enter");
    expect(onOpen).toHaveBeenCalledWith("~/notes/x.md");
  });

  it("restores the bar after a successful open", async () => {
    let resolve!: () => void;
    const onOpen = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const { button, input } = createOpenPathPrompt({ bar, onOpen });
    bar.appendChild(button);
    button.click();
    input.value = "/a/b.md";
    press(input, "Enter");
    resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(bar.classList.contains("path-editing")).toBe(false);
  });

  it("shows the error and STAYS in path-editing when onOpen rejects", async () => {
    const onOpen = vi.fn(async () => {
      throw new Error("파일 없음");
    });
    const { button, input } = createOpenPathPrompt({ bar, onOpen });
    bar.appendChild(button);
    button.click();
    input.value = "/nope.md";
    press(input, "Enter");
    await Promise.resolve();
    await Promise.resolve();
    const error = bar.querySelector<HTMLElement>(".open-path-error")!;
    expect(bar.classList.contains("path-editing")).toBe(true);
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("파일 없음");
  });

  it("cancels (leaves path-editing, clears value, no onOpen) on Esc", () => {
    const onOpen = vi.fn(async () => {});
    const { button, input } = createOpenPathPrompt({ bar, onOpen });
    bar.appendChild(button);
    button.click();
    input.value = "/a/b.md";
    press(input, "Escape");
    expect(bar.classList.contains("path-editing")).toBe(false);
    expect(input.value).toBe("");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("cancels on blur", () => {
    const { button, input } = createOpenPathPrompt({ bar, onOpen: async () => {} });
    bar.appendChild(button);
    button.click();
    expect(bar.classList.contains("path-editing")).toBe(true);
    input.dispatchEvent(new FocusEvent("blur"));
    expect(bar.classList.contains("path-editing")).toBe(false);
  });
});
