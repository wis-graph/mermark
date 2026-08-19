import { describe, it, expect, beforeEach, vi } from "vitest";
import { downloadStat } from "../src/update/update-progress";

// The footer update button is a persistent chrome sink subscribed to the real
// update-flow SSOT (not a mock of the flow itself — only the underlying Tauri
// plugins are mocked, same pattern as update-flow.test.ts / settings-version-
// pane.test.ts). Each test gets a fresh module graph via vi.resetModules() so
// the flow's module-scope state starts at "idle".
const check = vi.fn();
const relaunch = vi.fn(() => Promise.resolve());
vi.mock("@tauri-apps/plugin-updater", () => ({ check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));

type StatusBarUpdateModule = typeof import("../src/chrome/status-bar/update");
type FlowModule = typeof import("../src/update/update-flow");

async function freshModules(): Promise<{ statusBarUpdate: StatusBarUpdateModule; flow: FlowModule }> {
  vi.resetModules();
  const flow = await import("../src/update/update-flow");
  const statusBarUpdate = await import("../src/chrome/status-bar/update");
  return { statusBarUpdate, flow };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function mkFoundUpdate(version: string) {
  return {
    version,
    date: undefined as string | undefined,
    body: undefined as string | undefined,
    download: vi.fn(() => Promise.resolve()),
    install: vi.fn(() => Promise.resolve()),
  };
}

describe("makeUpdateButton (footer)", () => {
  beforeEach(() => {
    check.mockReset();
    relaunch.mockReset().mockImplementation(() => Promise.resolve());
  });

  it("is hidden while idle (no update found yet)", async () => {
    const { statusBarUpdate } = await freshModules();
    const { el } = statusBarUpdate.makeUpdateButton();
    expect(el.hidden).toBe(true);
  });

  it("shows an accent button labeled with the version once an update is found", async () => {
    check.mockResolvedValue(mkFoundUpdate("2.0.0"));
    const { statusBarUpdate, flow } = await freshModules();
    const { el } = statusBarUpdate.makeUpdateButton();
    await flow.ensureCheckedOnce();

    expect(el.hidden).toBe(false);
    const btn = el.querySelector("button");
    expect(btn?.textContent).toContain("2.0.0");
  });

  it("clicking a found update starts the download and shows live progress", async () => {
    let resolveDownload!: () => void;
    const update = {
      version: "2.0.0",
      date: undefined as string | undefined,
      body: undefined as string | undefined,
      download: vi.fn((onEvent?: (ev: unknown) => void) => {
        onEvent?.({ event: "Started", data: { contentLength: 100 } });
        onEvent?.({ event: "Progress", data: { chunkLength: 50 } });
        return new Promise<void>((resolve) => {
          resolveDownload = resolve;
        });
      }),
      install: vi.fn(() => Promise.resolve()),
    };
    check.mockResolvedValue(update);
    const { statusBarUpdate, flow } = await freshModules();
    const { el } = statusBarUpdate.makeUpdateButton();
    await flow.ensureCheckedOnce();

    const btn = el.querySelector<HTMLButtonElement>("button")!;
    btn.click();
    expect(update.download).toHaveBeenCalledTimes(1);
    expect(btn.textContent).toBe("다운로드 중...");

    // Regression guard for the real-app duplication bug (스크린샷으로 확인:
    // "다운로드 중...   다운로드 중... 53% (...)"): the caption must be the
    // prefix-free numeric readout only — the button already carries the state
    // word, so the caption must never repeat it.
    const caption = el.querySelector(".status-update-caption");
    expect(caption?.textContent).toBe(downloadStat(50, 100));
    expect(caption?.textContent).not.toContain("다운로드 중");

    resolveDownload();
    await flush();
    expect(btn.textContent).toContain("설치하고 재시작");
  });

  it("does not repeat a state word in the Finished caption either (버튼=상태, 캡션=부연)", async () => {
    let resolveDownload!: () => void;
    const update = {
      version: "2.0.0",
      date: undefined as string | undefined,
      body: undefined as string | undefined,
      download: vi.fn((onEvent?: (ev: unknown) => void) => {
        onEvent?.({ event: "Started", data: { contentLength: 100 } });
        onEvent?.({ event: "Finished" });
        return new Promise<void>((resolve) => {
          resolveDownload = resolve;
        });
      }),
      install: vi.fn(() => Promise.resolve()),
    };
    check.mockResolvedValue(update);
    const { statusBarUpdate, flow } = await freshModules();
    const { el } = statusBarUpdate.makeUpdateButton();
    await flow.ensureCheckedOnce();

    const btn = el.querySelector<HTMLButtonElement>("button")!;
    btn.click();
    const caption = el.querySelector(".status-update-caption");
    // Finished fires while the button still reads "다운로드 중..." (download()
    // hasn't resolved yet) — the caption must not ALSO claim "설치 중...".
    expect(btn.textContent).toBe("다운로드 중...");
    expect(caption?.textContent).not.toContain("설치 중");
    expect(caption?.textContent).not.toContain("다운로드 중");

    resolveDownload();
    await flush();
  });

  it("clicking a downloaded update installs and relaunches", async () => {
    const update = mkFoundUpdate("2.0.0");
    check.mockResolvedValue(update);
    const { statusBarUpdate, flow } = await freshModules();
    const { el } = statusBarUpdate.makeUpdateButton();
    await flow.ensureCheckedOnce();

    const btn = el.querySelector<HTMLButtonElement>("button")!;
    btn.click(); // start download
    await flush();
    expect(btn.textContent).toContain("설치하고 재시작");

    btn.click(); // install
    await flush();
    expect(update.install).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("carries an accessible name on the button", async () => {
    check.mockResolvedValue(mkFoundUpdate("2.0.0"));
    const { statusBarUpdate, flow } = await freshModules();
    const { el } = statusBarUpdate.makeUpdateButton();
    await flow.ensureCheckedOnce();

    const btn = el.querySelector("button");
    expect(btn?.getAttribute("aria-label")).toBeTruthy();
  });
});
