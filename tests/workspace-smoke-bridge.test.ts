// D1 (_workspace/01_architect_design.md §4.1 H1): the smoke bridge's
// `watch_file` must return a Rust-shaped `WatchSession { path, generation }`
// (watcher.rs's `set_watch`), not `null` — golden scripts build the
// `file-unavailable`/`file-changed` payload FROM this session, and
// `createWatcherHandoff.accepts()` (file-watch.ts) silently drops any event
// whose path/generation don't match the live session.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
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
  // An error response (see startWorkspaceSmokeBridge's catch branch) writes
  // the raw Error#message as PLAIN TEXT, not JSON — parsing it here would
  // throw a SyntaxError that masks the actual assertion failure below.
  if (!response.ok) return { ok: false, body: text };
  return { ok: true, body: text ? JSON.parse(text) : null };
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

// D4/R1 (_workspace/01_architect_design.md §4.3): the real backend
// (src-tauri/src/fs/file_io.rs's write_file_with_state) rejects a
// baseline!=0 write whose target has vanished since the read with
// `Err("MISSING: file no longer exists on disk (baseline={baseline})")`
// instead of silently recreating the file. The bridge must produce the SAME
// error text (message-prefix parity a golden script can match on) rather
// than the raw ENOENT `stat()` throws today.
describe("workspace smoke bridge write_file MISSING contract", () => {
  let bridge: Awaited<ReturnType<typeof startWorkspaceSmokeBridge>> | undefined;
  let fixtureRoot = "";

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = "";
  });

  it("rejects a baseline!=0 write to a vanished original with MISSING:, matching the Rust write_file contract", async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "mermark-bridge-test-"));
    const token = "test-token";
    bridge = await startWorkspaceSmokeBridge({ roots: [resolve("."), fixtureRoot], token, events: [] });
    const fixturePath = join(fixtureRoot, "a.md"); // never created — stands in for "deleted after read"

    const result = await post(bridge.url, token, "write_file", { path: fixturePath, text: "x", baseline: 1 });

    expect(result.ok).toBe(false);
    expect(result.body).toBe("MISSING: file no longer exists on disk (baseline=1)");
  });

  it("still creates a new file when baseline is 0 (new file / save-as / recovered-copy — unaffected by the MISSING guard)", async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "mermark-bridge-test-"));
    const token = "test-token";
    bridge = await startWorkspaceSmokeBridge({ roots: [resolve("."), fixtureRoot], token, events: [] });
    const fixturePath = join(fixtureRoot, "new.md");

    const result = await post(bridge.url, token, "write_file", { path: fixturePath, text: "x", baseline: 0 });

    expect(result.ok).toBe(true);
    expect(typeof result.body).toBe("number");
  });
});

// Audit 🟡-3 (_workspace/04_audit_report.md): the bridge's write_file used to
// unconditionally `mkdir(dirname(path), { recursive: true })` before every
// write. The real backend (file_io.rs's write_file_with_state) never creates
// parent directories — only create_markdown_file (an entirely different
// command, for wikilink auto-create) does. That divergence is the SAME kind
// of harness-masking as R1: after a whole folder is deleted, "save recovered
// copy" / "save as" fails in the real app but silently succeeds in this
// golden bridge, because the bridge quietly recreates the missing folder.
describe("workspace smoke bridge write_file parent-directory parity", () => {
  let bridge: Awaited<ReturnType<typeof startWorkspaceSmokeBridge>> | undefined;
  let fixtureRoot = "";

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = "";
  });

  it("does not create a missing parent directory for write_file (Rust's write_file_with_state never does either)", async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "mermark-bridge-test-"));
    const token = "test-token";
    bridge = await startWorkspaceSmokeBridge({ roots: [resolve("."), fixtureRoot], token, events: [] });
    const targetInMissingFolder = join(fixtureRoot, "gone-folder", "note.md.mermark-recovered");

    const result = await post(bridge.url, token, "write_file", { path: targetInMissingFolder, text: "x", baseline: 0 });

    expect(result.ok).toBe(false);
    // The folder itself must stay absent — a bridge that swallowed the
    // ENOENT and mkdir'd anyway would pass the assertion above too if it
    // then failed for some OTHER reason, so check the actual side effect.
    await expect(readdir(join(fixtureRoot, "gone-folder"))).rejects.toThrow();
  });
});
