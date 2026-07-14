import { describe, it, expect } from "vitest";
import {
  buildUpdaterManifest,
  darwinAarch64Platform,
  windowsX64Platform,
} from "../scripts/lib/build-updater-manifest.mjs";

describe("buildUpdaterManifest", () => {
  it("includes both platforms when both are given", () => {
    const manifest = buildUpdaterManifest({
      version: "0.6.0",
      notes: "notes",
      pubDate: "2026-08-01T00:00:00Z",
      platforms: {
        ...darwinAarch64Platform({ tag: "v0.6.0", signature: "MAC_SIG" }),
        ...windowsX64Platform({ tag: "v0.6.0", exeName: "mermark_0.6.0_x64-setup.exe", signature: "WIN_SIG" }),
      },
    });

    expect(Object.keys(manifest.platforms).sort()).toEqual(["darwin-aarch64", "windows-x86_64"]);
    expect(manifest.platforms["darwin-aarch64"]).toEqual({
      signature: "MAC_SIG",
      url: "https://github.com/wis-graph/mermark/releases/download/v0.6.0/mermark.app.tar.gz",
    });
    expect(manifest.platforms["windows-x86_64"]).toEqual({
      signature: "WIN_SIG",
      url: "https://github.com/wis-graph/mermark/releases/download/v0.6.0/mermark_0.6.0_x64-setup.exe",
    });
    expect(manifest.version).toBe("0.6.0");
    expect(manifest.pub_date).toBe("2026-08-01T00:00:00Z");
  });

  it("never carries a stale platform forward across versions (no merge with old state)", () => {
    // Simulates: v0.6.0 shipped both platforms, but v0.6.1 is only built for
    // one of them (e.g. a manual re-run that only re-signs macOS). The
    // manifest for v0.6.1 must contain exactly what it was given — nothing
    // left over from a previous call/version.
    buildUpdaterManifest({
      version: "0.6.0",
      pubDate: "2026-08-01T00:00:00Z",
      notes: "",
      platforms: {
        ...darwinAarch64Platform({ tag: "v0.6.0", signature: "MAC_SIG_OLD" }),
        ...windowsX64Platform({ tag: "v0.6.0", exeName: "old-setup.exe", signature: "WIN_SIG_OLD" }),
      },
    });

    const next = buildUpdaterManifest({
      version: "0.6.1",
      pubDate: "2026-08-02T00:00:00Z",
      notes: "",
      platforms: {
        ...darwinAarch64Platform({ tag: "v0.6.1", signature: "MAC_SIG_NEW" }),
      },
    });

    expect(Object.keys(next.platforms)).toEqual(["darwin-aarch64"]);
    expect(next.platforms["darwin-aarch64"].signature).toBe("MAC_SIG_NEW");
    expect(next.platforms["windows-x86_64"]).toBeUndefined();
  });

  it("windows is opt-in: building without it means platforms has no windows-x86_64 key at all", () => {
    // This is the safety property the "--with-windows opt-in" design leans
    // on entirely: a release.sh run without --with-windows never calls
    // windowsX64Platform(), so the key is structurally absent here — not
    // present-but-stale. A missing platform entry means the updater offers
    // that platform's users no update (safe). A present-but-stale entry
    // would mean handing them an old, validly-signed installer while
    // claiming it's the new version (the exact incident this guards
    // against).
    const manifest = buildUpdaterManifest({
      version: "0.6.3",
      pubDate: "2026-08-03T00:00:00Z",
      notes: "",
      platforms: {
        ...darwinAarch64Platform({ tag: "v0.6.3", signature: "MAC_SIG" }),
      },
    });

    expect(Object.keys(manifest.platforms)).toEqual(["darwin-aarch64"]);
    expect("windows-x86_64" in manifest.platforms).toBe(false);
    expect(manifest.platforms["windows-x86_64"]).toBeUndefined();
  });

  it("rejects an empty platforms map", () => {
    expect(() =>
      buildUpdaterManifest({ version: "0.6.0", pubDate: "2026-08-01T00:00:00Z", notes: "", platforms: {} }),
    ).toThrow(/platforms must include/);
  });

  it("rejects a platform entry missing signature or url", () => {
    expect(() =>
      buildUpdaterManifest({
        version: "0.6.0",
        pubDate: "2026-08-01T00:00:00Z",
        notes: "",
        platforms: { "windows-x86_64": { signature: "", url: "https://example.com/x" } },
      }),
    ).toThrow(/missing signature or url/);
  });
});
