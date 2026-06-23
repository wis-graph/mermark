import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// mock tauri modules
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import { mountEditor } from "../src/editor";
import { getCM } from "@replit/codemirror-vim";

describe("Editor state config & Vim setting tests", () => {
  let host: HTMLElement;

  beforeEach(() => {
    invokeMock.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
  });

  it("mounts editor with Vim mode enabled if vimMode is on", () => {
    const editor = mountEditor(host, "hello", "/tmp", "/tmp/doc.md", {
      vimMode: "on",
    });
    // Check if the vim extension has been loaded inside editor state
    expect(getCM(editor.view)).not.toBeNull();
    editor.view.destroy();
  });

  it("exposes reloadFromFile method which resets content and baseline", () => {
    const editor = mountEditor(host, "original content", "/tmp", "/tmp/doc.md", {
      baseMtime: 100,
    });
    
    editor.reloadFromFile("new content from disk", 200);
    
    expect(editor.view.state.doc.toString()).toBe("new content from disk");
    editor.view.destroy();
  });
});
