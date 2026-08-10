import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWelcomePane, isBlankSlate } from "../src/chrome/welcome/welcome-pane";
import { recentDocsSetting } from "../src/settings/app";

describe("isBlankSlate", () => {
  it("is true when there are no recent documents", () => {
    expect(isBlankSlate([])).toBe(true);
  });

  it("is false when a recent document exists", () => {
    expect(isBlankSlate(["note.md"])).toBe(false);
  });
});

describe("createWelcomePane", () => {
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    recentDocsSetting.set([]);
  });

  const makePane = (overrides: Partial<Parameters<typeof createWelcomePane>[0]> = {}) =>
    createWelcomePane({
      getRecent: () => [],
      onOpenFile: vi.fn(),
      onOpenFolder: vi.fn(),
      openFolderChord: null,
      ...overrides,
    });

  it("renders the folder CTA and invokes it", () => {
    const onOpenFolder = vi.fn();
    const pane = makePane({ onOpenFolder, openFolderChord: "⌘B" });
    host.append(pane);

    const button = host.querySelector<HTMLButtonElement>(".welcome-cta-btn");
    expect(button?.textContent).toBe("폴더 열기");
    button?.click();
    expect(onOpenFolder).toHaveBeenCalledOnce();
    expect(host.querySelector(".welcome-cta-hint")?.textContent).toContain("⌘B");
  });

  it("renders no favorite section or folder interaction", () => {
    const pane = makePane();
    host.append(pane);

    expect(pane.textContent).not.toContain("즐겨찾기");
    expect(pane.querySelector(".welcome-folder-row")).toBeNull();
    expect(pane.querySelector(".welcome-section")).not.toBeNull();
  });

  it("renders recent documents and opens one when selected", () => {
    const onOpenFile = vi.fn();
    const pane = makePane({ getRecent: () => ["/a/y.md"], onOpenFile });
    host.append(pane);

    const row = host.querySelector<HTMLElement>(".welcome-file-row");
    row?.click();
    expect(onOpenFile).toHaveBeenCalledWith("/a/y.md");
    expect(pane.classList.contains("is-blank-slate")).toBe(false);
  });

  it("re-renders recent documents from the live setting", () => {
    const pane = makePane({ getRecent: () => recentDocsSetting.get() });
    host.append(pane);
    expect(pane.querySelectorAll(".welcome-file-row")).toHaveLength(0);

    recentDocsSetting.set(["/a/y.md"]);
    expect(pane.querySelectorAll(".welcome-file-row")).toHaveLength(1);
    expect(pane.classList.contains("is-blank-slate")).toBe(false);
  });
});
