import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// plugin-updater / plugin-process / api/app are mocked directly (no Tauri
// runtime in jsdom) — the version pane's own module boundary, same pattern as
// wikilink.test.ts mocking @tauri-apps/plugin-opener.
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(() => Promise.resolve("0.5.4")),
}));

import { check } from "@tauri-apps/plugin-updater";
import { createSettingsButton } from "../src/settings/panel/modal";
import { registerSetting } from "../src/settings/registry";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("settings modal — 버전 category", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    // At least one registry group so the sidebar isn't empty (mirrors
    // settings-modal.test.ts) — 버전 itself doesn't come from the registry.
    registerSetting<string>({
      key: "m.x",
      default: "a",
      ui: {
        label: "X",
        group: "테마",
        control: { kind: "segmented", options: [{ value: "a", label: "A" }] },
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  function openModal(): HTMLElement {
    const bar = document.createElement("div");
    document.body.appendChild(bar);
    bar.append(createSettingsButton());
    (bar.querySelector(".settings-btn") as HTMLButtonElement).click();
    return document.querySelector(".settings-backdrop") as HTMLElement;
  }

  it("sidebar has a 버전 category alongside the registry groups", () => {
    const backdrop = openModal();
    const cats = [...backdrop.querySelectorAll<HTMLElement>(".settings-cat")].map((c) => c.textContent);
    expect(cats).toContain("버전");
    expect(cats).toContain("테마");
  });

  it("clicking 버전 renders the version pane (heading + check button) and marks it active", () => {
    const backdrop = openModal();
    const versionBtn = [...backdrop.querySelectorAll<HTMLButtonElement>(".settings-cat")].find(
      (b) => b.textContent === "버전",
    )!;
    versionBtn.click();

    expect(versionBtn.classList.contains("active")).toBe(true);
    expect(backdrop.querySelector(".version-pane-heading")?.textContent).toBe("mermark");
    expect(backdrop.querySelector(".version-check-btn")).not.toBeNull();
    // switching away from 테마 tears down its pane — no leftover settings-row
    expect(backdrop.querySelector(".settings-pane .settings-row")).toBeNull();
  });

  it("check() resolving null renders the up-to-date state", async () => {
    vi.mocked(check).mockResolvedValue(null);
    const backdrop = openModal();
    const versionBtn = [...backdrop.querySelectorAll<HTMLButtonElement>(".settings-cat")].find(
      (b) => b.textContent === "버전",
    )!;
    versionBtn.click();
    const checkBtn = backdrop.querySelector<HTMLButtonElement>(".version-check-btn")!;
    checkBtn.click();
    await flush();
    await flush();

    const status = backdrop.querySelector(".version-status-row.is-ok");
    expect(status?.textContent).toContain("최신 버전을 사용 중입니다");
    expect(checkBtn.disabled).toBe(false);
  });

  it("check() resolving an update renders the install card with version + actions", async () => {
    vi.mocked(check).mockResolvedValue({
      version: "9.9.9",
      date: "2026-07-01",
      downloadAndInstall: vi.fn(() => Promise.resolve()),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const backdrop = openModal();
    const versionBtn = [...backdrop.querySelectorAll<HTMLButtonElement>(".settings-cat")].find(
      (b) => b.textContent === "버전",
    )!;
    versionBtn.click();
    const checkBtn = backdrop.querySelector<HTMLButtonElement>(".version-check-btn")!;
    checkBtn.click();
    await flush();
    await flush();

    expect(backdrop.querySelector(".version-update-title")?.textContent).toBe("v9.9.9 업데이트가 있습니다");
    expect(backdrop.querySelector(".version-install-btn")).not.toBeNull();
    expect(backdrop.querySelector(".version-later-btn")).not.toBeNull();
  });

  it("mounting the pane with an already-found update (e.g. the boot auto-check) renders the install card without a click", async () => {
    // Simulates ensureCheckedOnce() having already run (boot auto-check) and
    // found an update BEFORE this pane ever mounts — update-flow is the
    // shared SSOT, so the pane just queries it at mount time (no re-check).
    vi.mocked(check).mockResolvedValue({
      version: "8.8.8",
      date: "2026-06-01",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const { checkNow } = await import("../src/update/update-flow");
    await checkNow();

    const backdrop = openModal();
    const versionBtn = [...backdrop.querySelectorAll<HTMLButtonElement>(".settings-cat")].find(
      (b) => b.textContent === "버전",
    )!;
    versionBtn.click(); // mounts the pane — no check-button click follows

    expect(backdrop.querySelector(".version-update-title")?.textContent).toBe("v8.8.8 업데이트가 있습니다");
    expect(backdrop.querySelector(".version-install-btn")).not.toBeNull();
  });

  it("mounting the pane while a download is already in progress does NOT show an install card (footer owns that state)", async () => {
    // Reproduces 04_audit_report.md #2: the footer button started a download
    // for this same found update (phase="downloading"), then the settings
    // panel is opened. Mounting must not render a stale "install now" card
    // that would no-op on click and misreport "설치 실패" — that progress
    // belongs to the footer until it resolves.
    let rejectDownload!: (err: Error) => void;
    vi.mocked(check).mockResolvedValue({
      version: "7.7.7",
      date: "2026-05-01",
      download: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectDownload = reject;
          }),
      ),
      install: vi.fn(() => Promise.resolve()),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const { checkNow, startDownload, updatePhase } = await import("../src/update/update-flow");
    await checkNow();
    const downloading = startDownload(); // not awaited — leaves phase mid-flight
    expect(updatePhase()).toBe("downloading");

    const backdrop = openModal();
    const versionBtn = [...backdrop.querySelectorAll<HTMLButtonElement>(".settings-cat")].find(
      (b) => b.textContent === "버전",
    )!;
    versionBtn.click(); // mounts the pane mid-download — no check-button click

    expect(backdrop.querySelector(".version-update-title")).toBeNull();
    expect(backdrop.querySelector(".version-install-btn")).toBeNull();

    // Restore a guard-compatible phase ("found") before the next test runs —
    // this file shares update-flow's module state across tests (no
    // vi.resetModules(), see file header note).
    rejectDownload(new Error("test cleanup"));
    await downloading;
    expect(updatePhase()).toBe("found");
  });

  it("renders the 변경 내역 section from CHANGELOG.md below the update UI", () => {
    const backdrop = openModal();
    const versionBtn = [...backdrop.querySelectorAll<HTMLButtonElement>(".settings-cat")].find(
      (b) => b.textContent === "버전",
    )!;
    versionBtn.click();

    expect(backdrop.querySelector(".version-changelog-heading")?.textContent).toBe("변경 내역");
    // CHANGELOG.md's newest entry as of this test's writing — asserts the real
    // repo file parses, not a fixture.
    expect(backdrop.querySelectorAll(".version-changelog-section").length).toBeGreaterThan(0);
    expect(backdrop.querySelector(".version-changelog-list li")).not.toBeNull();
  });

  it("renders update.body release notes inside the install card via the same bullet renderer", async () => {
    vi.mocked(check).mockResolvedValue({
      version: "9.9.9",
      date: "2026-07-01",
      body: "### Added\n\n- **새 기능**: 설명입니다.\n",
      downloadAndInstall: vi.fn(() => Promise.resolve()),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const backdrop = openModal();
    const versionBtn = [...backdrop.querySelectorAll<HTMLButtonElement>(".settings-cat")].find(
      (b) => b.textContent === "버전",
    )!;
    versionBtn.click();
    const checkBtn = backdrop.querySelector<HTMLButtonElement>(".version-check-btn")!;
    checkBtn.click();
    await flush();
    await flush();

    const notes = backdrop.querySelector(".version-update-notes");
    expect(notes?.querySelector(".version-changelog-cat")?.textContent).toBe("추가");
    const li = notes?.querySelector("li");
    expect(li?.textContent).toContain("새 기능: 설명입니다.");
    // the bold run went through renderInlineMarkdown, not textContent —
    // confirms the XSS-safe path (no innerHTML) rather than a raw string dump.
    expect(li?.querySelector("strong")?.textContent).toBe("새 기능");
  });

  it("switching back to a registry category tears down the version pane cleanly", () => {
    const backdrop = openModal();
    const cats = [...backdrop.querySelectorAll<HTMLButtonElement>(".settings-cat")];
    const versionBtn = cats.find((b) => b.textContent === "버전")!;
    const themeBtn = cats.find((b) => b.textContent === "테마")!;
    versionBtn.click();
    themeBtn.click();
    expect(backdrop.querySelector(".version-pane-heading")).toBeNull();
    expect(backdrop.querySelector(".settings-pane .settings-row")).not.toBeNull();
    expect(themeBtn.classList.contains("active")).toBe(true);
    expect(versionBtn.classList.contains("active")).toBe(false);
  });
});
