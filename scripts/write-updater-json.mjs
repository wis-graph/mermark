// Writes updater.json. This is the ONLY place updater.json is written from —
// scripts/release.sh invokes this once per deploy. That single-writer rule
// is what keeps a CI push and a local mac push from racing each other on
// main.
//
// Windows is opt-in (release.sh --with-windows): WIN_EXE_NAME/WIN_SIG_CONTENT
// are only present when that flag was used and the Windows CI run + its .sig
// were verified. When absent, the platforms map gets darwin-aarch64 ONLY —
// buildUpdaterManifest never merges with the previous updater.json on disk,
// so a Windows entry from an earlier release can never survive into this
// one. That's deliberate: a missing platform entry means "no update offered
// to that platform" (safe), never "here's an update, but it's stale" (an
// active regression a signed .sig would sail right through).
//
// Usage: node scripts/write-updater-json.mjs [output-path]
//   output-path defaults to "updater.json" (what release.sh relies on).
//   Pass an explicit path — e.g. for manual/test invocations — to write
//   somewhere else instead. There is no flag to opt out of this: any argv[2]
//   given is where it writes, full stop. A hardcoded output path is exactly
//   what let a stray manual `node scripts/write-updater-json.mjs /tmp/x.json`
//   silently clobber the live updater.json instead (2026-07-14, caught before
//   any push) — the fix is that the argument is never ignored.
//
// Required environment variables:
//   VERSION            e.g. "0.5.13"
//   TAG                e.g. "v0.5.13"
//   NOTES              release notes body (may be multi-line / empty)
//   PUB_DATE           ISO 8601 UTC timestamp
//   MAC_SIG_CONTENT    contents of the macOS .sig file
//
// Optional (both must be set together, for --with-windows deploys):
//   WIN_EXE_NAME       filename of the Windows NSIS setup.exe release asset
//   WIN_SIG_CONTENT    contents of the Windows .sig file
import { writeFileSync } from "node:fs";
import {
  buildUpdaterManifest,
  darwinAarch64Platform,
  windowsX64Platform,
} from "./lib/build-updater-manifest.mjs";

function requireEnv(name) {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`missing required env var: ${name}`);
  }
  return v;
}

const version = requireEnv("VERSION");
const tag = requireEnv("TAG");
const notes = process.env.NOTES ?? "";
const pubDate = requireEnv("PUB_DATE");
const macSig = requireEnv("MAC_SIG_CONTENT");
const winExeName = process.env.WIN_EXE_NAME || "";
const winSig = process.env.WIN_SIG_CONTENT || "";

if (Boolean(winExeName) !== Boolean(winSig)) {
  throw new Error("WIN_EXE_NAME and WIN_SIG_CONTENT must both be set, or both unset");
}
const includeWindows = Boolean(winExeName && winSig);

const manifest = buildUpdaterManifest({
  version,
  notes,
  pubDate,
  platforms: {
    ...darwinAarch64Platform({ tag, signature: macSig }),
    ...(includeWindows ? windowsX64Platform({ tag, exeName: winExeName, signature: winSig }) : {}),
  },
});

const outputPath = process.argv[2] ?? "updater.json";
writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
console.log(`${outputPath} written: darwin-aarch64${includeWindows ? " + windows-x86_64" : " (윈도우 미포함 — opt-in)"}`);
