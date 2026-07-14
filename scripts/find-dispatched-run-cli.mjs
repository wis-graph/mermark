#!/usr/bin/env node
// CLI wrapper around scripts/lib/find-dispatched-run.mjs for use from
// release.sh (bash has no clean way to do the timestamp comparison itself).
//
// Usage: gh run list --workflow=X --json databaseId,createdAt,event \
//          | node scripts/find-dispatched-run-cli.mjs <since-iso8601>
//
// Prints the matching run's databaseId and exits 0, or prints nothing and
// exits 1 if no run has appeared yet (release.sh polls by re-running this).
import { findDispatchedRun } from "./lib/find-dispatched-run.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

const since = process.argv[2];
if (!since) {
  console.error("usage: find-dispatched-run-cli.mjs <since-iso8601> < runs.json");
  process.exit(2);
}

const raw = await readStdin();
let runs;
try {
  runs = JSON.parse(raw || "[]");
} catch (e) {
  console.error(`오류: stdin이 유효한 JSON이 아닙니다: ${e.message}`);
  process.exit(2);
}

const match = findDispatchedRun(runs, since);
if (!match) {
  process.exit(1);
}
// String(), NOT the raw number: console.log routes a non-string through
// util.inspect, which COLORIZES numbers when stdout is a TTY — and release.sh
// captures this in `$(...)`, which is a pipe under a plain shell but a pty
// under some runners. The run id then carried \x1b[33m…\x1b[39m into
// `gh run watch`, which died on "invalid control character in URL" (2026-07-14,
// the first real v0.6.0 release attempt). A pipe-vs-pty difference is exactly
// the kind of bug a unit test run through a pipe can never see.
console.log(String(match.databaseId));
