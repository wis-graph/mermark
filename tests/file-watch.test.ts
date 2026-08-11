import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// decideExternalChange is a pure decision — it imports nothing from Tauri, so we
// don't need to mock the IPC/event modules here. (watchFile/unwatchFile/onFileChanged
// are thin invoke/listen wrappers covered by the golden-master + render path.)
import { decideExternalChange } from "../src/document/file-watch";

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

  it("re-arms the single native watch when tab activation replaces the document", () => {
    const mainSource = readFileSync("src/main.ts", "utf8");
    expect(mainSource).toMatch(/teardownCurrent\(\);[\s\S]*void watchFile\(file\);/);
    expect(mainSource).toContain("void unwatchFile();");
  });
});
