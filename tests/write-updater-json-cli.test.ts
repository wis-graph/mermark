import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/write-updater-json.mjs used to hardcode its output path to
// "updater.json" and silently ignore any argv given — a manual/test
// invocation with a path argument would look like it worked but actually
// clobber the live repo's updater.json (2026-07-14, caught before any push).
// These tests run the script as a real subprocess (not an import — the
// module has top-level side effects) with cwd pinned to a scratch directory,
// so the real repo's updater.json is never at risk even if this regresses.
const scriptPath = join(process.cwd(), "scripts", "write-updater-json.mjs");
const baseEnv = {
  ...process.env,
  VERSION: "9.9.9",
  TAG: "v9.9.9",
  NOTES: "probe",
  PUB_DATE: "2026-08-01T00:00:00Z",
  MAC_SIG_CONTENT: "MACSIG",
};

let scratchDir: string;
afterEach(() => {
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

describe("write-updater-json.mjs CLI", () => {
  it("writes to the argv path when one is given, and does not create updater.json alongside it", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "mermark-updater-cli-"));
    const outPath = join(scratchDir, "probe-output.json");

    execFileSync("node", [scriptPath, outPath], { cwd: scratchDir, env: baseEnv });

    expect(existsSync(outPath)).toBe(true);
    const written = JSON.parse(readFileSync(outPath, "utf-8"));
    expect(written.version).toBe("9.9.9");

    // The whole point of the bug: an argv path must not ALSO (or instead)
    // land in the default location.
    expect(existsSync(join(scratchDir, "updater.json"))).toBe(false);
  });

  it("defaults to updater.json in cwd when no argv path is given", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "mermark-updater-cli-"));

    execFileSync("node", [scriptPath], { cwd: scratchDir, env: baseEnv });

    const defaultPath = join(scratchDir, "updater.json");
    expect(existsSync(defaultPath)).toBe(true);
    const written = JSON.parse(readFileSync(defaultPath, "utf-8"));
    expect(written.version).toBe("9.9.9");
  });
});
