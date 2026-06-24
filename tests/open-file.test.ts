import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOpenPathPrompt } from "../src/open-file/path-prompt";

/** The open-by-path footer prompt is the INPUT SURFACE: it collects a typed
 *  path and reports failures back into its row. The actual resolve→read→re-mount
 *  is the caller's onOpen — here stubbed — so these tests pin the UI contract
 *  (toggle, submit, error-keeps-open, cancel) without a real editor. The
 *  re-mount itself is exercised by render-smoke (mountEditor) + path.test
 *  (resolveOpenPath); a full boot() re-mount needs a Tauri window, out of jsdom. */

function press(input: HTMLInputElement, key: string) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

describe("open-path footer prompt", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("builds a status-bar button with the folder-open icon + label", () => {
    const { button } = createOpenPathPrompt({ onOpen: async () => {} });
    expect(button.classList.contains("status-btn")).toBe(true);
    expect(button.classList.contains("open-path")).toBe(true);
    expect(button.querySelector(".icon-folder-open")).not.toBeNull();
    expect(button.textContent).toContain("경로 열기");
  });

  it("starts with the input row hidden and reveals + focuses it on button click", () => {
    const { button, row } = createOpenPathPrompt({ onOpen: async () => {} });
    host.append(button, row);
    expect(row.hidden).toBe(true);
    button.click();
    expect(row.hidden).toBe(false);
    const input = row.querySelector<HTMLInputElement>(".open-path-input")!;
    expect(document.activeElement).toBe(input);
  });

  it("toggles the row closed on a second button click", () => {
    const { button, row } = createOpenPathPrompt({ onOpen: async () => {} });
    host.append(button, row);
    button.click();
    button.click();
    expect(row.hidden).toBe(true);
  });

  it("calls onOpen with the raw typed path on Enter", () => {
    const onOpen = vi.fn(async () => {});
    const { button, row } = createOpenPathPrompt({ onOpen });
    host.append(button, row);
    button.click();
    const input = row.querySelector<HTMLInputElement>(".open-path-input")!;
    input.value = "~/notes/x.md";
    press(input, "Enter");
    expect(onOpen).toHaveBeenCalledWith("~/notes/x.md");
  });

  it("closes the row after a successful open", async () => {
    let resolve!: () => void;
    const onOpen = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const { button, row } = createOpenPathPrompt({ onOpen });
    host.append(button, row);
    button.click();
    const input = row.querySelector<HTMLInputElement>(".open-path-input")!;
    input.value = "/a/b.md";
    press(input, "Enter");
    resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(row.hidden).toBe(true);
  });

  it("shows the error and KEEPS the row open when onOpen rejects (missing file)", async () => {
    const onOpen = vi.fn(async () => {
      throw new Error("파일 없음");
    });
    const { button, row } = createOpenPathPrompt({ onOpen });
    host.append(button, row);
    button.click();
    const input = row.querySelector<HTMLInputElement>(".open-path-input")!;
    input.value = "/nope.md";
    press(input, "Enter");
    await Promise.resolve();
    await Promise.resolve();
    const error = row.querySelector<HTMLElement>(".open-path-error")!;
    expect(row.hidden).toBe(false);
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("파일 없음");
  });

  it("cancels (closes row, clears value, no onOpen) on Esc", () => {
    const onOpen = vi.fn(async () => {});
    const { button, row } = createOpenPathPrompt({ onOpen });
    host.append(button, row);
    button.click();
    const input = row.querySelector<HTMLInputElement>(".open-path-input")!;
    input.value = "/a/b.md";
    press(input, "Escape");
    expect(row.hidden).toBe(true);
    expect(input.value).toBe("");
    expect(onOpen).not.toHaveBeenCalled();
  });
});
