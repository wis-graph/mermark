import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWelcomePane, isBlankSlate } from "../src/welcome/welcome-pane";
import { favoriteFoldersSetting, recentDocsSetting } from "../src/settings/app";

describe("isBlankSlate", () => {
  it("is true only when both favorites and recent are empty", () => {
    expect(isBlankSlate([], [])).toBe(true);
  });

  it("is false when favorites has an entry", () => {
    expect(isBlankSlate(["f"], [])).toBe(false);
  });

  it("is false when recent has an entry", () => {
    expect(isBlankSlate([], ["d"])).toBe(false);
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
    favoriteFoldersSetting.set([]);
    recentDocsSetting.set([]);
  });

  it("renders a 폴더 열기 CTA that calls onOpenFolder on click", () => {
    const onOpenFolder = vi.fn();
    const pane = createWelcomePane({
      getFavorites: () => [],
      getRecent: () => [],
      onJumpFolder: () => {},
      onOpenFile: () => {},
      onOpenFolder,
      openFolderChord: "⌘B",
    });
    host.append(pane);
    const btn = host.querySelector<HTMLButtonElement>(".welcome-cta-btn")!;
    expect(btn.textContent).toBe("폴더 열기");
    btn.click();
    expect(onOpenFolder).toHaveBeenCalledOnce();
  });

  it("shows the openFolderChord in the CTA hint", () => {
    const pane = createWelcomePane({
      getFavorites: () => [],
      getRecent: () => [],
      onJumpFolder: () => {},
      onOpenFile: () => {},
      onOpenFolder: () => {},
      openFolderChord: "⌘B",
    });
    host.append(pane);
    expect(host.querySelector(".welcome-cta-hint")?.textContent).toContain("⌘B");
  });

  it("hint still renders (without a chord segment) when openFolderChord is null", () => {
    const pane = createWelcomePane({
      getFavorites: () => [],
      getRecent: () => [],
      onJumpFolder: () => {},
      onOpenFile: () => {},
      onOpenFolder: () => {},
      openFolderChord: null,
    });
    host.append(pane);
    expect(host.querySelector(".welcome-cta-hint")).not.toBeNull();
  });

  it("omits .welcome-path for a recent doc with no directory component, keeps it when a dir exists", () => {
    const pane = createWelcomePane({
      getFavorites: () => [],
      getRecent: () => ["x.md", "a/y.md"],
      onJumpFolder: () => {},
      onOpenFile: () => {},
      onOpenFolder: () => {},
      openFolderChord: null,
    });
    host.append(pane);
    const rows = host.querySelectorAll(".welcome-file-row");
    expect(rows[0]!.querySelector(".welcome-path")).toBeNull();
    expect(rows[1]!.querySelector(".welcome-path")).not.toBeNull();
  });

  it("omits .welcome-path for a favorite folder whose basename fallback equals the path", () => {
    const pane = createWelcomePane({
      getFavorites: () => ["docs", "/a/b"],
      getRecent: () => [],
      onJumpFolder: () => {},
      onOpenFile: () => {},
      onOpenFolder: () => {},
      openFolderChord: null,
    });
    host.append(pane);
    const rows = host.querySelectorAll(".welcome-folder-row");
    expect(rows[0]!.querySelector(".welcome-path")).toBeNull();
    expect(rows[1]!.querySelector(".welcome-path")).not.toBeNull();
  });

  it("clicking a favorite row calls onJumpFolder with that path", () => {
    const onJumpFolder = vi.fn();
    const pane = createWelcomePane({
      getFavorites: () => ["/a/b"],
      getRecent: () => [],
      onJumpFolder,
      onOpenFile: () => {},
      onOpenFolder: () => {},
      openFolderChord: null,
    });
    host.append(pane);
    (host.querySelector(".welcome-folder-row") as HTMLElement).click();
    expect(onJumpFolder).toHaveBeenCalledWith("/a/b");
  });

  it("clicking a recent-doc row calls onOpenFile with that path", () => {
    const onOpenFile = vi.fn();
    const pane = createWelcomePane({
      getFavorites: () => [],
      getRecent: () => ["/a/y.md"],
      onJumpFolder: () => {},
      onOpenFile,
      onOpenFolder: () => {},
      openFolderChord: null,
    });
    host.append(pane);
    (host.querySelector(".welcome-file-row") as HTMLElement).click();
    expect(onOpenFile).toHaveBeenCalledWith("/a/y.md");
  });

  it("shows the empty states when both lists are empty", () => {
    const pane = createWelcomePane({
      getFavorites: () => [],
      getRecent: () => [],
      onJumpFolder: () => {},
      onOpenFile: () => {},
      onOpenFolder: () => {},
      openFolderChord: null,
    });
    host.append(pane);
    expect(host.querySelectorAll(".welcome-empty").length).toBe(2);
  });

  it("re-renders the favorites list when favoriteFoldersSetting changes (SSOT subscribe preserved)", () => {
    const pane = createWelcomePane({
      getFavorites: () => favoriteFoldersSetting.get(),
      getRecent: () => [],
      onJumpFolder: () => {},
      onOpenFile: () => {},
      onOpenFolder: () => {},
      openFolderChord: null,
    });
    host.append(pane);
    expect(host.querySelectorAll(".welcome-folder-row").length).toBe(0);
    favoriteFoldersSetting.set(["/a/b"]);
    expect(host.querySelectorAll(".welcome-folder-row").length).toBe(1);
  });

  it("re-renders the recent-docs list when recentDocsSetting changes (SSOT subscribe preserved)", () => {
    const pane = createWelcomePane({
      getFavorites: () => [],
      getRecent: () => recentDocsSetting.get(),
      onJumpFolder: () => {},
      onOpenFile: () => {},
      onOpenFolder: () => {},
      openFolderChord: null,
    });
    host.append(pane);
    expect(host.querySelectorAll(".welcome-file-row").length).toBe(0);
    recentDocsSetting.set(["/a/y.md"]);
    expect(host.querySelectorAll(".welcome-file-row").length).toBe(1);
  });
});

describe("createWelcomePane blank-slate hero (2026-07-12 design-polish pass, tour-11)", () => {
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    favoriteFoldersSetting.set([]);
    recentDocsSetting.set([]);
  });

  it("has is-blank-slate and a .welcome-mark when both lists are empty at mount", () => {
    const pane = createWelcomePane({
      getFavorites: () => [],
      getRecent: () => [],
      onJumpFolder: () => {},
      onOpenFile: () => {},
      onOpenFolder: () => {},
      openFolderChord: null,
    });
    host.append(pane);
    expect(pane.classList.contains("is-blank-slate")).toBe(true);
    expect(pane.querySelector(".welcome-mark")).not.toBeNull();
  });

  it("has no is-blank-slate when a favorite exists at mount", () => {
    const pane = createWelcomePane({
      getFavorites: () => ["/a/b"],
      getRecent: () => [],
      onJumpFolder: () => {},
      onOpenFile: () => {},
      onOpenFolder: () => {},
      openFolderChord: null,
    });
    host.append(pane);
    expect(pane.classList.contains("is-blank-slate")).toBe(false);
  });

  it("drops is-blank-slate once favoriteFoldersSetting gains an entry (subscribe reflects the transition)", () => {
    const pane = createWelcomePane({
      getFavorites: () => favoriteFoldersSetting.get(),
      getRecent: () => [],
      onJumpFolder: () => {},
      onOpenFile: () => {},
      onOpenFolder: () => {},
      openFolderChord: null,
    });
    host.append(pane);
    expect(pane.classList.contains("is-blank-slate")).toBe(true);
    favoriteFoldersSetting.set(["/a/b"]);
    expect(pane.classList.contains("is-blank-slate")).toBe(false);
  });

  it("drops is-blank-slate once recentDocsSetting gains an entry (subscribe reflects the transition)", () => {
    const pane = createWelcomePane({
      getFavorites: () => [],
      getRecent: () => recentDocsSetting.get(),
      onJumpFolder: () => {},
      onOpenFile: () => {},
      onOpenFolder: () => {},
      openFolderChord: null,
    });
    host.append(pane);
    expect(pane.classList.contains("is-blank-slate")).toBe(true);
    recentDocsSetting.set(["/a/y.md"]);
    expect(pane.classList.contains("is-blank-slate")).toBe(false);
  });
});
