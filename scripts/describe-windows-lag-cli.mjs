#!/usr/bin/env node
// CLI wrapper around scripts/lib/describe-windows-lag.mjs for release.sh.
//
// Usage: printf "%s %s\n" ... (lines of "<tag> <true|false>", newest-first,
// current in-flight release excluded) | node scripts/describe-windows-lag-cli.mjs
//
// Prints one line: "<staleCount> <lastWindowsTag-or-dash>"
import { describeWindowsLag } from "./lib/describe-windows-lag.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

const raw = await readStdin();
const releases = raw
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const [tag, hasWindows] = line.split(/\s+/);
    return { tag, hasWindows: hasWindows === "true" };
  });

const { staleCount, lastWindowsTag } = describeWindowsLag(releases);
console.log(`${staleCount} ${lastWindowsTag ?? "-"}`);
