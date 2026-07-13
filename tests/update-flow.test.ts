import { describe, it, expect, beforeEach, vi } from "vitest";

// update-flow is the shared SSOT module for the update state machine (used by
// both the footer button and the settings version-pane). plugin-updater /
// plugin-process are dynamic-imported by the module under test (cold-load
// invariant — see src/update/update-flow.ts), but vi.mock intercepts dynamic
// imports the same way it does static ones, so this mocking pattern (borrowed
// from settings-version-pane.test.ts) still works.
const check = vi.fn();
const relaunch = vi.fn(() => Promise.resolve());

vi.mock("@tauri-apps/plugin-updater", () => ({ check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));

type Flow = typeof import("../src/update/update-flow");

/** Fresh module instance per test — the flow's state lives in module scope,
 *  so vi.resetModules() + a fresh dynamic import gives every test a clean
 *  idle machine (mirrors settings-app.test.ts's per-test re-import pattern). */
async function freshFlow(): Promise<Flow> {
  vi.resetModules();
  return import("../src/update/update-flow");
}

function mkUpdate(overrides: Partial<{ version: string; date: string; body: string }> = {}) {
  return {
    version: overrides.version ?? "9.9.9",
    date: overrides.date,
    body: overrides.body,
    download: vi.fn((onEvent?: (ev: unknown) => void) => {
      onEvent?.({ event: "Started", data: { contentLength: 100 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 100 } });
      onEvent?.({ event: "Finished" });
      return Promise.resolve();
    }),
    install: vi.fn(() => Promise.resolve()),
  };
}

describe("update-flow", () => {
  beforeEach(() => {
    check.mockReset();
    relaunch.mockReset().mockImplementation(() => Promise.resolve());
  });

  describe("ensureCheckedOnce", () => {
    it("only calls check() once across repeated calls (idempotent)", async () => {
      check.mockResolvedValue(null);
      const flow = await freshFlow();
      await flow.ensureCheckedOnce();
      await flow.ensureCheckedOnce();
      expect(check).toHaveBeenCalledTimes(1);
    });

    it("found update: phase becomes found, foundUpdate carries version/date/body", async () => {
      check.mockResolvedValue(mkUpdate({ version: "1.2.3", date: "2026-07-01", body: "notes" }));
      const flow = await freshFlow();
      await flow.ensureCheckedOnce();
      expect(flow.updatePhase()).toBe("found");
      expect(flow.foundUpdate()).toEqual({ version: "1.2.3", date: "2026-07-01", body: "notes" });
      expect(flow.lastCheckResult()).toBe("found");
    });

    it("null result: lastCheckResult is none, phase returns to idle", async () => {
      check.mockResolvedValue(null);
      const flow = await freshFlow();
      await flow.ensureCheckedOnce();
      expect(flow.lastCheckResult()).toBe("none");
      expect(flow.updatePhase()).toBe("idle");
    });

    it("check() rejecting: swallows the error, lastCheckResult is error, phase returns to idle", async () => {
      check.mockRejectedValue(new Error("network down"));
      const flow = await freshFlow();
      await expect(flow.ensureCheckedOnce()).resolves.toBeUndefined();
      expect(flow.lastCheckResult()).toBe("error");
      expect(flow.updatePhase()).toBe("idle");
    });
  });

  describe("checkNow", () => {
    it("dedupes concurrent calls into a single check() (in-flight sharing)", async () => {
      let resolveCheck!: (v: unknown) => void;
      check.mockReturnValue(new Promise((resolve) => (resolveCheck = resolve)));
      const flow = await freshFlow();
      const a = flow.checkNow();
      const b = flow.checkNow();
      resolveCheck(null);
      await Promise.all([a, b]);
      expect(check).toHaveBeenCalledTimes(1);
    });

    it("a manual checkNow after ensureCheckedOnce already ran performs a fresh check", async () => {
      check.mockResolvedValue(null);
      const flow = await freshFlow();
      await flow.ensureCheckedOnce();
      await flow.checkNow();
      expect(check).toHaveBeenCalledTimes(2);
    });
  });

  describe("canStartDownload / canInstall / canCheck (pure guards)", () => {
    it("canStartDownload is true only for 'found'", async () => {
      const flow = await freshFlow();
      expect(flow.canStartDownload("found")).toBe(true);
      for (const p of ["idle", "checking", "downloading", "downloaded", "installing"] as const) {
        expect(flow.canStartDownload(p)).toBe(false);
      }
    });

    it("canInstall is true only for 'downloaded'", async () => {
      const flow = await freshFlow();
      expect(flow.canInstall("downloaded")).toBe(true);
      for (const p of ["idle", "checking", "found", "downloading", "installing"] as const) {
        expect(flow.canInstall(p)).toBe(false);
      }
    });

    it("canCheck is true only for 'idle' and 'found'", async () => {
      const flow = await freshFlow();
      expect(flow.canCheck("idle")).toBe(true);
      expect(flow.canCheck("found")).toBe(true);
      for (const p of ["checking", "downloading", "downloaded", "installing"] as const) {
        expect(flow.canCheck(p)).toBe(false);
      }
    });
  });

  describe("checkNow — phase reentry guard (footer download/install in progress)", () => {
    it("is a no-op while downloading: check() isn't called again and the in-flight download completes untouched", async () => {
      const update = mkUpdate();
      check.mockResolvedValue(update);
      const flow = await freshFlow();
      await flow.ensureCheckedOnce();

      const downloading = flow.startDownload(); // not awaited — leaves phase mid-flight
      expect(flow.updatePhase()).toBe("downloading");

      check.mockClear();
      // Assert synchronously right after the call (before awaiting it) — once
      // we `await`, the already-queued download continuation's microtask
      // would run first and flip the phase to "downloaded" before we could
      // observe the reentrant checkNow() left it untouched.
      const reentrant = flow.checkNow();
      expect(check).not.toHaveBeenCalled(); // no reentrant network check
      expect(flow.updatePhase()).toBe("downloading"); // untouched by the reentrant call
      await reentrant;

      await downloading; // the original in-flight download still completes normally
      expect(flow.updatePhase()).toBe("downloaded");
    });

    it("is a no-op while downloaded: check() isn't called again, phase stays 'downloaded'", async () => {
      const update = mkUpdate();
      check.mockResolvedValue(update);
      const flow = await freshFlow();
      await flow.ensureCheckedOnce();
      await flow.startDownload();
      expect(flow.updatePhase()).toBe("downloaded");

      check.mockClear();
      await flow.checkNow();
      expect(check).not.toHaveBeenCalled();
      expect(flow.updatePhase()).toBe("downloaded");
    });

    it("still allows a fresh checkNow from 'found' (user explicitly re-checks before downloading)", async () => {
      check.mockResolvedValue(mkUpdate({ version: "1.0.0" }));
      const flow = await freshFlow();
      await flow.ensureCheckedOnce();
      expect(flow.updatePhase()).toBe("found");

      check.mockClear();
      check.mockResolvedValue(mkUpdate({ version: "1.0.1" }));
      await flow.checkNow();
      expect(check).toHaveBeenCalledTimes(1);
      expect(flow.foundUpdate()?.version).toBe("1.0.1");
    });
  });

  describe("startDownload", () => {
    it("forwards download events and transitions found -> downloading -> downloaded", async () => {
      const update = mkUpdate();
      check.mockResolvedValue(update);
      const flow = await freshFlow();
      await flow.ensureCheckedOnce();
      expect(flow.updatePhase()).toBe("found");

      const events: unknown[] = [];
      await flow.startDownload((ev) => events.push(ev));
      expect(update.download).toHaveBeenCalledTimes(1);
      expect(events).toEqual([
        { event: "Started", data: { contentLength: 100 } },
        { event: "Progress", data: { chunkLength: 100 } },
        { event: "Finished" },
      ]);
      expect(flow.updatePhase()).toBe("downloaded");
    });

    it("is a no-op when phase is not 'found'", async () => {
      const flow = await freshFlow();
      expect(flow.updatePhase()).toBe("idle");
      await flow.startDownload();
      expect(flow.updatePhase()).toBe("idle");
    });

    it("reverts to 'found' when download() rejects", async () => {
      const update = mkUpdate();
      update.download.mockImplementation(() => Promise.reject(new Error("dl failed")));
      check.mockResolvedValue(update);
      const flow = await freshFlow();
      await flow.ensureCheckedOnce();
      await flow.startDownload();
      expect(flow.updatePhase()).toBe("found");
    });
  });

  describe("installAndRelaunch", () => {
    it("calls install() then relaunch() in order when downloaded", async () => {
      const update = mkUpdate();
      check.mockResolvedValue(update);
      const flow = await freshFlow();
      await flow.ensureCheckedOnce();
      await flow.startDownload();
      expect(flow.updatePhase()).toBe("downloaded");

      const order: string[] = [];
      update.install.mockImplementation(() => {
        order.push("install");
        return Promise.resolve();
      });
      relaunch.mockImplementation(() => {
        order.push("relaunch");
        return Promise.resolve();
      });
      await flow.installAndRelaunch();
      expect(order).toEqual(["install", "relaunch"]);
    });

    it("is a no-op when phase is not 'downloaded'", async () => {
      const flow = await freshFlow();
      expect(flow.updatePhase()).toBe("idle");
      await flow.installAndRelaunch();
      expect(flow.updatePhase()).toBe("idle");
      expect(relaunch).not.toHaveBeenCalled();
    });

    it("reverts to 'downloaded' and skips relaunch when install() rejects", async () => {
      const update = mkUpdate();
      update.install.mockImplementation(() => Promise.reject(new Error("install failed")));
      check.mockResolvedValue(update);
      const flow = await freshFlow();
      await flow.ensureCheckedOnce();
      await flow.startDownload();
      await flow.installAndRelaunch();
      expect(flow.updatePhase()).toBe("downloaded");
      expect(relaunch).not.toHaveBeenCalled();
    });
  });

  describe("subscribeUpdate", () => {
    it("fires on every phase transition and stops after unsubscribe", async () => {
      check.mockResolvedValue(mkUpdate());
      const flow = await freshFlow();
      const cb = vi.fn();
      const unsubscribe = flow.subscribeUpdate(cb);
      await flow.ensureCheckedOnce(); // idle -> checking -> found
      expect(cb.mock.calls.length).toBeGreaterThanOrEqual(2);
      const callsBeforeUnsub = cb.mock.calls.length;
      unsubscribe();
      await flow.startDownload();
      expect(cb.mock.calls.length).toBe(callsBeforeUnsub);
    });
  });
});
