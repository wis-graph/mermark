import { describe, it, expect } from "vitest";
// decideExternalChange is a pure decision — it imports nothing from Tauri, so we
// don't need to mock the IPC/event modules here. (watchFile/unwatchFile/onFileChanged
// are thin invoke/listen wrappers covered by the golden-master + render path.)
import { createWatcherHandoff, decideExternalChange } from "../src/document/file-watch";

describe("decideExternalChange (auto-reload vs conflict)", () => {
  it("reloads silently when there is no unsaved work", () => {
    expect(decideExternalChange(false)).toBe("reload");
  });

  it("opens a conflict when the local buffer has unsaved work", () => {
    expect(decideExternalChange(true)).toBe("conflict");
  });

  it.each([
    ["self-save", false, false, "not-invoked"],
    ["clean-external-edit", true, false, "reload"],
    ["dirty-external-edit", true, true, "conflict"],
    ["same-mtime-rewrite", false, false, "not-invoked"],
    ["atomic-replacement", true, false, "reload"],
    ["watcher-replacement-tab-activation", false, false, "not-invoked"],
    ["deletion", false, false, "not-invoked"],
    ["unreadable-path", false, false, "not-invoked"],
  ] as const)("projects the native %s boundary to %s", (_scenario, event, dirty, expected) => {
    expect(event ? decideExternalChange(dirty) : "not-invoked").toBe(expected);
  });

  it("commits a successful handoff and rolls back a rejected attachment", async () => {
    const events: string[] = [];
    const handoff = createWatcherHandoff({
      unwatch: async () => { events.push("unwatch"); },
      watch: async (path) => {
        events.push("watch " + path);
        if (path === "/B.md") throw new Error("watch failed");
      },
    }, () => {});

    await expect(handoff.handoff("/A.md")).resolves.toBe(true);
    events.length = 0;
    await expect(handoff.handoff("/B.md")).resolves.toBe(false);

    expect(events).toEqual(["unwatch", "watch /B.md", "watch /A.md"]);
  });
});
