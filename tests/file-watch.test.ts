import { describe, it, expect } from "vitest";

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
});
