import { describe, it, expect, vi, beforeEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { wikilinkPath, isImageTarget, sameFileHeadingAnchor, WikilinkWidget } from "../src/markdown/wikilink";
import { setDocumentOpenHandler } from "../src/markdown/document-open";
import { documentVault, REMOTE_VAULT_READONLY_MESSAGE } from "../src/document/document-vault";
import type { RemoteVault } from "../src/workspace/workspace-state";

const mockInvoke = vi.fn();
const mockOpenAsset = vi.fn();
const mockOpenUrl = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));

// document-open.ts's handler slot is a module-level singleton that outlives
// individual tests — every test that clicks a resolving wikilink must rewire
// its own spy so a leftover handler from a previous test can't leak through.
let documentOpenSpy = vi.fn();
beforeEach(() => {
  documentOpenSpy = vi.fn();
  setDocumentOpenHandler(documentOpenSpy);
});

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: (...args: any[]) => mockOpenAsset(...args),
  openUrl: (...args: any[]) => mockOpenUrl(...args),
}));

// wikilink.ts reads `view.state.facet(documentVault)` with no `?.` guard (a
// real EditorView's `.state` is never optional) — so every `toDOM` stub below
// needs a real (if extension-less) `.state`, not a bare `{}`. No
// `documentVault` extension registered ⇒ the facet combines to `undefined`,
// i.e. "local, unknown vault" — the exact behavior these fixtures had before
// the facet existed.
const localView = { state: EditorState.create({}) } as any;

describe("wikilinkPath", () => {
  const baseDir = "/home/u/notes";
  it("appends .md when no extension", () => {
    expect(wikilinkPath("foo", baseDir)).toBe("/home/u/notes/foo.md");
  });
  it("keeps an explicit extension", () => {
    expect(wikilinkPath("foo.md", baseDir)).toBe("/home/u/notes/foo.md");
  });
  it("resolves nested targets", () => {
    expect(wikilinkPath("sub/bar", baseDir)).toBe("/home/u/notes/sub/bar.md");
  });
  it("strips #heading anchors before resolving (D6)", () => {
    expect(wikilinkPath("note#section", baseDir)).toBe("/home/u/notes/note.md");
  });
  it("strips #^block refs before resolving (D6)", () => {
    expect(wikilinkPath("note#^abc123", baseDir)).toBe("/home/u/notes/note.md");
  });
  it("resolves bare [[#heading]] to the current file", () => {
    expect(wikilinkPath("#section", baseDir, "/home/u/notes/self.md")).toBe("/home/u/notes/self.md");
  });
  // txt-as-md (_workspace/01_architect_design_txt.md §0): the default
  // extension for an extensionless target stays `.md` — never `.txt` — or
  // every existing vault's [[bare]] links break. An explicit `.txt` target
  // keeps its own extension (same "explicit extension survives" rule as .md).
  it("REGRESSION: a bare (no-extension) target still defaults to .md, not .txt", () => {
    expect(wikilinkPath("note", baseDir)).toBe("/home/u/notes/note.md");
  });
  it("keeps an explicit .txt extension (does not get relabeled .md)", () => {
    expect(wikilinkPath("note.txt", baseDir)).toBe("/home/u/notes/note.txt");
  });
  // Task 8 fix round 1, finding 2: a remote vault's root note has
  // baseDir === "" (main.ts's baseDirForVault falls back to
  // currentExplorerFolder). The old `${dir}/${withExt}` join produced a
  // leading "/note.md" for that case - readable locally as an absolute
  // path, but wrong for a vault-relative remote path: remote_read_file
  // rejects it and the failure surfaces to the user as "sharing-off"
  // instead of the real cause. No leading slash should ever appear when
  // baseDir is empty.
  it("REGRESSION (remote vault root): an empty baseDir resolves without a leading slash", () => {
    expect(wikilinkPath("note", "")).toBe("note.md");
    expect(wikilinkPath("sub/note", "")).toBe("sub/note.md");
  });
});

describe("sameFileHeadingAnchor", () => {
  it("resolves a bare heading anchor", () => {
    expect(sameFileHeadingAnchor("#Sec")).toBe("Sec");
  });
  it("trims whitespace around the anchor text", () => {
    expect(sameFileHeadingAnchor("# Spaced Title ")).toBe("Spaced Title");
  });
  it("returns null when a file part precedes the anchor (cross-file, out of scope)", () => {
    expect(sameFileHeadingAnchor("file#Sec")).toBeNull();
  });
  it("returns null for a block reference (not a heading)", () => {
    expect(sameFileHeadingAnchor("#^abc123")).toBeNull();
  });
  it("returns null for a bare hash with no anchor text", () => {
    expect(sameFileHeadingAnchor("#")).toBeNull();
  });
  it("returns null for an empty target", () => {
    expect(sameFileHeadingAnchor("")).toBeNull();
  });
});

describe("isImageTarget", () => {
  it("recognizes image extensions", () => {
    expect(isImageTarget("pic.png")).toBe(true);
    expect(isImageTarget("photo.JPEG")).toBe(true);
    expect(isImageTarget("note")).toBe(false);
    expect(isImageTarget("doc.md")).toBe(false);
  });
  it("REGRESSION: .txt is never treated as an image target", () => {
    expect(isImageTarget("x.txt")).toBe(false);
  });
});

describe("WikilinkWidget toDOM click behaviors", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockOpenAsset.mockReset();
    mockOpenUrl.mockReset();
  });

  it("resolves bare same-file link immediately with no path_exists call", () => {
    const widget = new WikilinkWidget("alias", "");
    const dom = widget.toDOM(localView);
    expect(dom.className).toContain("cm-wikilink-active");
    expect(dom.className).not.toContain("cm-wikilink-pending");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("checks existence and sets active class if existing markdown file", async () => {
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === "path_exists") return Promise.resolve(true);
      return Promise.resolve();
    });

    const widget = new WikilinkWidget("alias", "existing.md");
    const dom = widget.toDOM(localView);

    // wait for promise microtasks
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockInvoke).toHaveBeenCalledWith("path_exists", { path: "existing.md" });
    expect(dom.className).toContain("cm-wikilink-active");
    expect(dom.className).not.toContain("cm-wikilink-missing");

    dom.click();
    expect(documentOpenSpy).toHaveBeenCalledWith({ kind: "resolved-document", path: "existing.md" });
    expect(mockInvoke).not.toHaveBeenCalledWith("open_path", expect.any(Object));
  });

  it("checks existence and opens non-markdown asset via openAsset if existing", async () => {
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === "path_exists") return Promise.resolve(true);
      return Promise.resolve();
    });
    mockOpenAsset.mockResolvedValue(undefined);

    const widget = new WikilinkWidget("alias", "existing.pdf");
    const dom = widget.toDOM(localView);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dom.className).toContain("cm-wikilink-active");

    dom.click();
    expect(mockOpenAsset).toHaveBeenCalledWith("existing.pdf");
    expect(mockInvoke).not.toHaveBeenCalledWith("open_path", expect.any(Object));
  });

  it("auto-creates and opens when missing markdown file is clicked", async () => {
    let exists = false;
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === "path_exists") return Promise.resolve(exists);
      if (cmd === "create_markdown_file") {
        exists = true;
        return Promise.resolve();
      }
      return Promise.resolve();
    });

    const widget = new WikilinkWidget("alias", "missing.md");
    const dom = widget.toDOM(localView);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dom.className).toContain("cm-wikilink-missing");

    // Simulate clicking the missing file link
    dom.click();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockInvoke).toHaveBeenCalledWith("create_markdown_file", { path: "missing.md" });
    expect(documentOpenSpy).toHaveBeenCalledWith({ kind: "resolved-document", path: "missing.md" });
    expect(mockInvoke).not.toHaveBeenCalledWith("open_path", expect.any(Object));
    expect(dom.className).toContain("cm-wikilink-active");
    expect(dom.className).not.toContain("cm-wikilink-missing");
  });

  // txt-as-md (_workspace/01_architect_design_txt.md §4): [[note.txt]] opens
  // via the current-window seam (mermark's own window), same as [[note.md]]
  // — NOT openAsset (the external-app path a pre-txt .txt target used to
  // take). single-window-opening Todo 3: the seam replaces the old
  // `invoke("open_path", …)` new-window call.
  it("[[note.txt]] existing target opens via the current-window seam (mermark window), not openAsset", async () => {
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === "path_exists") return Promise.resolve(true);
      return Promise.resolve();
    });

    const widget = new WikilinkWidget("alias", "existing.txt");
    const dom = widget.toDOM(localView);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dom.className).toContain("cm-wikilink-active");

    dom.click();
    expect(documentOpenSpy).toHaveBeenCalledWith({ kind: "resolved-document", path: "existing.txt" });
    expect(mockInvoke).not.toHaveBeenCalledWith("open_path", expect.any(Object));
    expect(mockOpenAsset).not.toHaveBeenCalled();
  });

  it("[[note.txt]] missing target auto-creates via create_markdown_file then opens (same as .md)", async () => {
    let exists = false;
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === "path_exists") return Promise.resolve(exists);
      if (cmd === "create_markdown_file") {
        exists = true;
        return Promise.resolve();
      }
      return Promise.resolve();
    });

    const widget = new WikilinkWidget("alias", "missing.txt");
    const dom = widget.toDOM(localView);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dom.className).toContain("cm-wikilink-missing");

    dom.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockInvoke).toHaveBeenCalledWith("create_markdown_file", { path: "missing.txt" });
    expect(documentOpenSpy).toHaveBeenCalledWith({ kind: "resolved-document", path: "missing.txt" });
    expect(mockInvoke).not.toHaveBeenCalledWith("open_path", expect.any(Object));
    expect(dom.className).toContain("cm-wikilink-active");
  });

  it("shows error and does not auto-create if missing asset is clicked", async () => {
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === "path_exists") return Promise.resolve(false);
      return Promise.resolve();
    });

    const widget = new WikilinkWidget("alias", "missing.pdf");
    const dom = widget.toDOM(localView);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dom.className).toContain("cm-wikilink-missing");

    dom.click();

    expect(mockInvoke).not.toHaveBeenCalledWith("create_markdown_file", expect.any(Object));
    expect(dom.className).toContain("cm-wikilink-error");
    expect(dom.title).toContain("마크다운 파일만 자동 생성 가능");
  });

  it("[[#heading]] anchor: cm-wikilink-active immediately, zero IPC (path skipped entirely)", () => {
    const widget = new WikilinkWidget("x", "", "Target");
    const dom = widget.toDOM(localView);
    expect(dom.className).toContain("cm-wikilink-active");
    expect(dom.className).not.toContain("cm-wikilink-pending");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("regression: a real path (unaffected by the anchor branch) still opens via the current-window seam", async () => {
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === "path_exists") return Promise.resolve(true);
      return Promise.resolve();
    });
    const widget = new WikilinkWidget("x", "/abs/note.md");
    const dom = widget.toDOM(localView);
    await new Promise((resolve) => setTimeout(resolve, 0));
    dom.click();
    expect(documentOpenSpy).toHaveBeenCalledWith({ kind: "resolved-document", path: "/abs/note.md" });
    expect(mockInvoke).not.toHaveBeenCalledWith("open_path", expect.any(Object));
  });
});

// ---------------------------------------------------------------------------
// E — [[https://…]] external URL wikilinks. Zero IPC of any kind: never
// touches path_exists/create_markdown_file/open_path (the bug this branch
// exists to prevent — a pasted URL becoming a junk on-disk file).
// ---------------------------------------------------------------------------
describe("WikilinkWidget external URL branch (E)", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockOpenAsset.mockReset();
    mockOpenUrl.mockReset();
  });

  it("renders cm-wikilink-active + cm-wikilink-external, no cm-wikilink-pending, zero IPC", () => {
    const widget = new WikilinkWidget("구글", "", null, "https://example.com");
    const dom = widget.toDOM(localView);
    expect(dom.className).toContain("cm-wikilink-active");
    expect(dom.className).toContain("cm-wikilink-external");
    expect(dom.className).not.toContain("cm-wikilink-pending");
    expect(dom.textContent).toBe("구글");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("click opens via openUrl (plugin-opener) and never touches path_exists/create_markdown_file/open_path", async () => {
    mockOpenUrl.mockResolvedValue(undefined);
    const widget = new WikilinkWidget("구글", "", null, "https://example.com");
    const dom = widget.toDOM(localView);
    dom.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockOpenUrl).toHaveBeenCalledWith("https://example.com");
    expect(mockInvoke).not.toHaveBeenCalledWith("path_exists", expect.any(Object));
    expect(mockInvoke).not.toHaveBeenCalledWith("create_markdown_file", expect.any(Object));
    expect(mockInvoke).not.toHaveBeenCalledWith("open_path", expect.any(Object));
  });
});

// ---------------------------------------------------------------------------
// F — Ruling 8 / task-8a item 1: a remote vault is READ-ONLY. Clicking a
// missing [[link]] must never call create_markdown_file (which would write a
// stray file onto THIS machine's local disk while viewing a remote vault),
// and must show a visible notice instead of silently doing nothing.
// ---------------------------------------------------------------------------
describe("WikilinkWidget remote-vault read-only guard (F, Ruling 8)", () => {
  const remoteVault: RemoteVault = {
    vaultId: "vault-remote-1",
    workspaceId: "workspace-default",
    displayName: "원격 볼트",
    rootPath: null,
    persistenceKind: "remote",
    explorerRoot: "remote://wis-macmini/",
    host: "wis-macmini",
    remoteVaultId: "rv-1",
  };
  const remoteView = { state: EditorState.create({ extensions: [documentVault.of(remoteVault)] }) } as any;

  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("clicking a missing [[link]] in a remote vault never calls create_markdown_file, and shows the read-only notice", async () => {
    mockInvoke.mockImplementation((cmd) => (cmd === "path_exists" ? Promise.resolve(false) : Promise.resolve()));

    const widget = new WikilinkWidget("alias", "missing.md");
    const dom = widget.toDOM(remoteView);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dom.className).toContain("cm-wikilink-missing");

    dom.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockInvoke).not.toHaveBeenCalledWith("create_markdown_file", expect.any(Object));
    expect(dom.className).toContain("cm-wikilink-error");
    expect(dom.title).toBe(REMOTE_VAULT_READONLY_MESSAGE);
  });

  it("REGRESSION: a local (no facet / undefined vault) document still auto-creates as before", async () => {
    let exists = false;
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === "path_exists") return Promise.resolve(exists);
      if (cmd === "create_markdown_file") {
        exists = true;
        return Promise.resolve();
      }
      return Promise.resolve();
    });
    const widget = new WikilinkWidget("alias", "missing.md");
    const dom = widget.toDOM(localView); // no documentVault extension registered — same "local" fixture every other test in this file uses
    await new Promise((resolve) => setTimeout(resolve, 0));
    dom.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockInvoke).toHaveBeenCalledWith("create_markdown_file", { path: "missing.md" });
  });
});

describe("WikilinkWidget external URL branch (E) — eq()", () => {
  it("eq() is false when externalUrl differs", () => {
    const a = new WikilinkWidget("x", "", null, "https://a.com");
    const b = new WikilinkWidget("x", "", null, "https://b.com");
    expect(a.eq(b)).toBe(false);
    expect(a.eq(new WikilinkWidget("x", "", null, "https://a.com"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// [[#heading]] click navigation — mounted integration. The anchor is resolved
// against the LIVE document at click time (findHeadingByText), so this needs a
// real EditorView with the markdown parser, not a bare toDOM(localView) stub.
// ---------------------------------------------------------------------------
import { mountEditor } from "../src/editor";

describe("[[#heading]] click navigation (mounted integration)", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "read_file"
        ? Promise.resolve({ text: "", mtime: 1 })
        : cmd === "write_file"
          ? Promise.resolve(1)
          : Promise.resolve(false),
    );
  });

  function mount(doc: string) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const { view } = mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: "edit" });
    return { host, view };
  }

  it("clicking a matching anchor moves the caret to the heading line, with zero IPC", () => {
    const doc = "# Target\n\nSee [[#Target]] here.";
    const { host, view } = mount(doc);
    try {
      const link = view.contentDOM.querySelector<HTMLAnchorElement>(".cm-wikilink");
      expect(link).not.toBeNull();
      expect(link!.className).toContain("cm-wikilink-active");
      link!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(view.state.selection.main.head).toBe(doc.indexOf("# Target"));
      expect(mockInvoke).not.toHaveBeenCalledWith("path_exists", expect.any(Object));
      expect(mockInvoke).not.toHaveBeenCalledWith("open_path", expect.any(Object));
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("clicking an anchor with no matching heading is a graceful no-op (selection unchanged, zero IPC)", () => {
    const doc = "# Other\n\nSee [[#Nope]] here.";
    const { host, view } = mount(doc);
    try {
      // Keep the caret on line 1 ("# Other"), NOT the wikilink's own line 3 —
      // touching that line would reveal the raw `[[#Nope]]` source (conceal
      // drops on the cursor's line) and there would be no widget DOM to click.
      view.dispatch({ selection: { anchor: 0 } });
      const before = view.state.selection.main.head;
      const link = view.contentDOM.querySelector<HTMLAnchorElement>(".cm-wikilink");
      expect(link).not.toBeNull();
      link!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(view.state.selection.main.head).toBe(before);
      expect(mockInvoke).not.toHaveBeenCalledWith("path_exists", expect.any(Object));
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("Alt+click on an anchor widget edits the raw source instead of jumping (D-J3 restore)", () => {
    const doc = "# Target\n\nSee [[#Target]] here.";
    const { host, view } = mount(doc);
    try {
      const link = view.contentDOM.querySelector<HTMLAnchorElement>(".cm-wikilink");
      expect(link).not.toBeNull();
      const before = view.state.selection.main.head;
      link!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, altKey: true }));
      // Alt+click places the caret at the link's own position (edit the raw
      // [[#Target]]), which is NOT the heading's landing (pos 0) and not the
      // untouched caret either — it's wherever the widget sits in the doc.
      expect(view.state.selection.main.head).not.toBe(doc.indexOf("# Target"));
      expect(view.state.selection.main.head).not.toBe(before);
    } finally {
      view.destroy();
      host.remove();
    }
  });
});

// ---------------------------------------------------------------------------
// [[https://…]] external URL wikilinks (mounted integration) — Alt+click needs
// a real EditorView (attachAltClickEdit calls view.dispatch/posAtDOM), unlike
// the bare-toDOM tests above.
// ---------------------------------------------------------------------------
describe("[[https://…]] external URL (mounted integration, E)", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "read_file"
        ? Promise.resolve({ text: "", mtime: 1 })
        : cmd === "write_file"
          ? Promise.resolve(1)
          : Promise.resolve(false),
    );
  });

  function mount(doc: string) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const { view } = mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: "edit" });
    return { host, view };
  }

  it("Alt+click edits the raw source instead of opening (attachAltClickEdit contract preserved)", () => {
    const doc = "top\n\nSee [[https://example.com|구글]] here.";
    const { host, view } = mount(doc);
    try {
      view.dispatch({ selection: { anchor: 0 } }); // caret off the wikilink's own line
      (view as unknown as { measure(): void }).measure();
      const link = view.contentDOM.querySelector<HTMLAnchorElement>(".cm-wikilink-external");
      expect(link).not.toBeNull();
      const before = view.state.selection.main.head;
      link!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, altKey: true }));
      expect(view.state.selection.main.head).not.toBe(before); // caret moved into raw source
      expect(mockInvoke).not.toHaveBeenCalledWith("path_exists", expect.any(Object));
    } finally {
      view.destroy();
      host.remove();
    }
  });
});
