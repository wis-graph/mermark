import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The Tauri CSP is baked in at compile time and is NOT exercised by jsdom, so
// pin the one directive remote-video playback depends on: media-src must allow
// blob: object URLs (loadRemoteVideo -> <video src=blob:>), without loosening
// anything else.
const conf = JSON.parse(readFileSync(resolve(__dirname, "../src-tauri/tauri.conf.json"), "utf8"));
const csp: string = conf.app.security.csp;
const directive = (name: string): string[] =>
  (csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? "").split(/\s+/).slice(1);

describe("tauri.conf.json CSP", () => {
  it("media-src allows blob: and keeps its existing sources, no wildcard", () => {
    const media = directive("media-src");
    for (const t of ["blob:", "'self'", "asset:", "data:", "https:"]) expect(media).toContain(t);
    expect(media).not.toContain("*");
  });
  it("script-src is not weakened", () => {
    expect(directive("script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
  });
});
