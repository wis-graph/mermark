// D1 (_workspace/01_architect_design.md §4.1 H1): the smoke bridge's
// `watch_file` must return a Rust-shaped `WatchSession { path, generation }`
// (watcher.rs's `set_watch`), not `null` — golden scripts build the
// `file-unavailable`/`file-changed` payload FROM this session, and
// `createWatcherHandoff.accepts()` (file-watch.ts) silently drops any event
// whose path/generation don't match the live session.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startWorkspaceSmokeBridge } from "../scripts/lib/workspace-smoke-bridge.mjs";

async function post(url: string, token: string, command: string, args: Record<string, unknown>): Promise<{ ok: boolean; body: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Mermark-Smoke-Token": token },
    body: JSON.stringify({ command, args }),
  });
  const text = await response.text();
  return { ok: response.ok, body: text ? JSON.parse(text) : null };
}

describe("workspace smoke bridge watch_file contract", () => {
  let bridge: Awaited<ReturnType<typeof startWorkspaceSmokeBridge>> | undefined;
  let fixtureRoot = "";

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = "";
  });

  it("returns an incrementing WatchSession for watch_file (raw path, not resolved) and clears it on unwatch_file", async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "mermark-bridge-test-"));
    const token = "test-token";
    bridge = await startWorkspaceSmokeBridge({ roots: [resolve("."), fixtureRoot], token, events: [] });
    const fixturePath = join(fixtureRoot, "a.md");

    const first = await post(bridge.url, token, "watch_file", { path: fixturePath });
    expect(first.ok).toBe(true);
    expect(first.body).toEqual({ path: fixturePath, generation: "1" });
    expect(bridge.snapshot().session).toEqual({ path: fixturePath, generation: "1" });

    const second = await post(bridge.url, token, "watch_file", { path: fixturePath });
    expect(second.body).toEqual({ path: fixturePath, generation: "2" });
    expect(bridge.snapshot().session).toEqual({ path: fixturePath, generation: "2" });

    await post(bridge.url, token, "unwatch_file", { path: fixturePath });
    expect(bridge.snapshot().session).toBeNull();
  });
});
