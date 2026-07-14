// Writes updater.json. This is the ONLY place updater.json is written from —
// scripts/release.sh invokes this once, after it has confirmed both the
// macOS assets (uploaded directly) and the Windows assets (uploaded by
// .github/workflows/release-windows.yml, then signature-verified by
// release.sh) exist on the GitHub release. That single-writer rule is what
// keeps a CI push and a local mac push from racing each other on main.
//
// Required environment variables:
//   VERSION            e.g. "0.5.13"
//   TAG                e.g. "v0.5.13"
//   NOTES              release notes body (may be multi-line / empty)
//   PUB_DATE           ISO 8601 UTC timestamp
//   MAC_SIG_CONTENT    contents of the macOS .sig file
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
const winExeName = requireEnv("WIN_EXE_NAME");
const winSig = requireEnv("WIN_SIG_CONTENT");

const manifest = buildUpdaterManifest({
  version,
  notes,
  pubDate,
  platforms: {
    ...darwinAarch64Platform({ tag, signature: macSig }),
    ...windowsX64Platform({ tag, exeName: winExeName, signature: winSig }),
  },
});

writeFileSync("updater.json", JSON.stringify(manifest, null, 2) + "\n", "utf-8");
console.log("updater.json written: darwin-aarch64 + windows-x86_64");
