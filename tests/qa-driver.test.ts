// Dev-only QA bridge driver (single-window-opening Todo 6, Stage F). This
// suite is intentionally narrow: it locks the driver's two PURE seams —
// parseBridgeEnv (the VITE_QA_BRIDGE env shape both this driver and
// scripts/qa-driver-bridge.mjs agree on) and resolveCommand (the fixed
// 7-name command vocabulary, design branch 3). Actual network I/O
// (pollBridgeCommands) and real @tauri-apps/api calls are exercised by the
// native harness itself (scripts/window-routing-smoke.mjs) against a real
// debug binary + real WKWebView — not here, and not with a browser mock
// (mermark-frontend skill: a browser mock cannot prove native behavior).
import { describe, expect, it } from "vitest";
import { parseBridgeEnv, resolveCommand } from "../src/qa/native-smoke-driver";

describe("parseBridgeEnv", () => {
  it("splits a valid \"url#token\" bridge env value", () => {
    expect(parseBridgeEnv("http://127.0.0.1:9999#abc123")).toEqual({
      url: "http://127.0.0.1:9999",
      token: "abc123",
    });
  });

  it.each([
    [undefined, "missing env"],
    [null, "null env"],
    ["", "empty string"],
    ["http://127.0.0.1:9999", "no # separator"],
    ["#abc123", "empty url"],
    ["http://127.0.0.1:9999#", "empty token"],
    ["not-a-url#abc123", "unparsable url"],
  ])("returns null for %s (%s)", (raw) => {
    expect(parseBridgeEnv(raw)).toBeNull();
  });
});

describe("resolveCommand", () => {
  it.each([
    "openPath",
    "minimizeSelf",
    "closeSelf",
    "queryDoc",
    "runAction",
    "seedVault",
    "invokeRaw",
  ])("has a registered handler for the fixed vocabulary entry %s", (name) => {
    expect(typeof resolveCommand(name)).toBe("function");
  });

  it("returns undefined for a name outside the fixed 7-command vocabulary", () => {
    expect(resolveCommand("eval")).toBeUndefined();
    expect(resolveCommand("shellExec")).toBeUndefined();
    expect(resolveCommand("")).toBeUndefined();
  });
});
