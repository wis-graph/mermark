import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Stub the Tauri core: convertFileSrc echoes its input (so an asset URL equals
// its path, making the src swap observable), invoke is a spy we assert against.
const invokeSpy = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => p,
  invoke: (...args: unknown[]) => invokeSpy(...args),
}));

import {
  resolveImageSrc,
  resolveImageUrl,
  ImageWidget,
  viewerSourceFor,
  isRemoteSrc,
  clearImageSearchCache,
  clearVaultDowngradeReports,
} from "../src/markdown/image";
import { setImageSearchRoot, owningVaultRoot, VAULT_IMAGE_SCAN_DEPTH } from "../src/markdown/image-search-root";
import { recursiveImageSearchSetting } from "../src/settings/app";
import { setImageOpenHandler } from "../src/markdown/image-open";
import type { EditorView } from "@codemirror/view";

// The click handler's `attachAltClickEdit` only ever touches `view` when a
// MOUSEDOWN carries Alt (not exercised by these click-only tests), so a stub
// that satisfies the type without a real editor is enough here — mounting a
// full EditorView per test would test nothing this file doesn't already
// cover elsewhere (wikilink*.test.ts owns the real Alt+click-edit assertion).
const fakeView = {} as unknown as EditorView;

describe("resolveImageSrc", () => {
  const baseDir = "/home/u/notes";
  it("leaves absolute http(s) urls untouched", () => {
    expect(resolveImageSrc("https://x.com/a.png", baseDir)).toBe("https://x.com/a.png");
  });
  it("joins a relative path onto the base dir", () => {
    expect(resolveImageSrc("img/a.png", baseDir)).toBe("/home/u/notes/img/a.png");
  });
  it("keeps an absolute filesystem path as-is", () => {
    expect(resolveImageSrc("/abs/a.png", baseDir)).toBe("/abs/a.png");
  });
});

describe("isRemoteSrc", () => {
  it("true for http(s) and data: URLs, false for local paths", () => {
    expect(isRemoteSrc("https://x.com/a.png")).toBe(true);
    expect(isRemoteSrc("http://x.com/a.png")).toBe(true);
    expect(isRemoteSrc("data:image/png;base64,AAAA")).toBe(true);
    expect(isRemoteSrc("img/a.png")).toBe(false);
    expect(isRemoteSrc("/abs/a.png")).toBe(false);
  });
});

// Regression (04_audit_report_imgclick.md 🟡②): resolveImageSrc/resolveImageUrl
// used to each inline their own remote-URL test (one of them a DRIFTED
// variant, `/^https?:|^data:/i` — no `//` required). Both now delegate to
// isRemoteSrc; these pin the pre-existing behavior for every well-formed
// input so the unification is provably not a behavior change.
describe("resolveImageSrc/resolveImageUrl (unified on isRemoteSrc — no behavior change)", () => {
  it("resolveImageSrc still passes http(s)/data URLs through untouched", () => {
    expect(resolveImageSrc("http://x.com/a.png", "/docs")).toBe("http://x.com/a.png");
    expect(resolveImageSrc("data:image/png;base64,AAAA", "/docs")).toBe("data:image/png;base64,AAAA");
  });
  it("resolveImageUrl still passes http(s)/data URLs through untouched (no convertFileSrc)", () => {
    expect(resolveImageUrl("https://x.com/a.png", "/docs")).toBe("https://x.com/a.png");
    expect(resolveImageUrl("data:image/png;base64,AAAA", "/docs")).toBe("data:image/png;base64,AAAA");
  });
  it("resolveImageUrl still converts a local path via convertFileSrc", () => {
    expect(resolveImageUrl("a.png", "/docs")).toBe("/docs/a.png"); // convertFileSrc mock echoes input
  });
});

describe("viewerSourceFor", () => {
  const baseDir = "/docs";
  it("resolves a local relative rawSrc against baseDir", () => {
    expect(viewerSourceFor("cat.png", baseDir, null)).toBe("/docs/cat.png");
  });
  it("passes a remote URL through untouched", () => {
    expect(viewerSourceFor("https://ex.com/c.png", baseDir, null)).toBe("https://ex.com/c.png");
  });
  it("prefers the recursive-search resolvedPath over the literal rawSrc", () => {
    expect(viewerSourceFor("cat.png", baseDir, "/docs/img/cat.png")).toBe("/docs/img/cat.png");
  });
  it("null for an empty rawSrc (legacy no-arg constructor default)", () => {
    expect(viewerSourceFor("", baseDir, null)).toBeNull();
  });
});

describe("ImageWidget recursive-search fallback", () => {
  const baseDir = "/home/u/notes";

  beforeEach(() => {
    invokeSpy.mockReset();
    recursiveImageSearchSetting.set("on");
    clearImageSearchCache(); // fresh slate — several cases below reuse the same rawSrc/baseDir pair
    setImageSearchRoot(() => null); // no vault-scope tests in this describe; every widget here is default "folder" scope
  });

  // Mount the widget DOM and fire its onerror as the browser would on a failed
  // literal load.
  const mountImg = (rawSrc: string, literalUrl = `${baseDir}/${rawSrc}`) => {
    const w = new ImageWidget(literalUrl, "alt", rawSrc, baseDir);
    const img = w.toDOM(fakeView) as HTMLImageElement;
    return img;
  };
  const fireError = (img: HTMLImageElement) => img.onerror?.(new Event("error"));
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("literal-first: a successful literal load never invokes resolve_image", () => {
    mountImg("pic.png"); // no onerror fired = the literal path loaded
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("on load failure, calls resolve_image with {baseDir,name,maxDepth:3} and swaps src", async () => {
    invokeSpy.mockResolvedValue("/mock/found/pic.png");
    const img = mountImg("pic.png");
    fireError(img);
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    expect(invokeSpy).toHaveBeenCalledWith("resolve_image", {
      baseDir,
      name: "pic.png",
      maxDepth: 3,
    });
    await flush();
    expect(img.src).toContain("/mock/found/pic.png");
  });

  it("when resolve_image returns null, the broken image is left as-is", async () => {
    invokeSpy.mockResolvedValue(null);
    const img = mountImg("missing.png");
    fireError(img);
    await flush();
    expect(img.src).toContain(`${baseDir}/missing.png`); // unchanged literal
  });

  it("infinite-fallback guard: a second onerror does not re-invoke", () => {
    invokeSpy.mockResolvedValue("/mock/found/pic.png");
    const img = mountImg("pic.png");
    fireError(img);
    fireError(img); // resolved src also fails → must not re-resolve
    expect(invokeSpy).toHaveBeenCalledTimes(1);
  });

  it("setting off: onerror does not invoke resolve_image", () => {
    recursiveImageSearchSetting.set("off");
    const img = mountImg("pic.png");
    fireError(img);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("remote src: onerror does not invoke resolve_image", () => {
    const img = mountImg("https://x.com/a.png", "https://x.com/a.png");
    fireError(img);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("data: src: onerror does not invoke resolve_image", () => {
    const img = mountImg("data:image/png;base64,AAAA", "data:image/png;base64,AAAA");
    fireError(img);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("eq() includes rawSrc/baseDir so a stale-base rebuild is not reused", () => {
    const a = new ImageWidget("u", "alt", "pic.png", "/a");
    expect(a.eq(new ImageWidget("u", "alt", "pic.png", "/a"))).toBe(true);
    expect(a.eq(new ImageWidget("u", "alt", "pic.png", "/b"))).toBe(false);
    expect(a.eq(new ImageWidget("u", "alt", "other.png", "/a"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Vault-scope search root routing (`vault:` withdrawal + name-based image
// resolution, _workspace/00_request_vaultimage_fix.md). `searchScope`
// deliberately reads image-search-root.ts's OWNING vault root — never "the
// active vault" — so a document's `![[name]]` resolution can never change
// just because the sidebar's active vault changed (the exact bug this
// change reverts). Distinct rawSrc basenames per case below avoid
// module-level searchCache collisions between cases (see the promise-cache
// tests, which deliberately reuse a name WITHIN one test).
// ---------------------------------------------------------------------------

describe("ImageWidget vault-scope search root", () => {
  const docFolder = "/vault/notes/deep";

  beforeEach(() => {
    invokeSpy.mockReset();
    invokeSpy.mockResolvedValue(null); // default: "not found" unless a case overrides it
    recursiveImageSearchSetting.set("on");
    clearImageSearchCache();
    clearVaultDowngradeReports();
    setImageSearchRoot(() => null);
  });

  const mountScoped = (rawSrc: string, scope: "vault" | "folder" = "vault", baseDir = docFolder) => {
    const w = new ImageWidget(`${baseDir}/${rawSrc}`, "alt", rawSrc, baseDir, scope);
    return w.toDOM(fakeView) as HTMLImageElement;
  };
  const fireError = (img: HTMLImageElement) => img.onerror?.(new Event("error"));
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("vault scope with a resolved owning root calls resolve_image with {baseDir: root, maxDepth: VAULT_IMAGE_SCAN_DEPTH}", () => {
    setImageSearchRoot(() => "/vault");
    const img = mountScoped("pic-root.png");
    fireError(img);
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    expect(invokeSpy).toHaveBeenCalledWith("resolve_image", {
      baseDir: "/vault",
      name: "pic-root.png",
      maxDepth: VAULT_IMAGE_SCAN_DEPTH,
    });
  });

  it("vault scope with no owning root (global vault / outside every vault) falls back to folder-scope args", () => {
    setImageSearchRoot(() => null);
    const img = mountScoped("pic-noroot.png");
    fireError(img);
    expect(invokeSpy).toHaveBeenCalledWith("resolve_image", {
      baseDir: docFolder,
      name: "pic-noroot.png",
      maxDepth: 3,
    });
  });

  // Regression (01_architect_design.md 결함 B): the vault->folder downgrade
  // above used to be silent — no signal at all that a `![[…]]`'s contracted
  // whole-vault search got demoted. Pin that the downgrade is now observable
  // and carries the values a developer needs to diagnose it (name, the
  // document's own baseDir, and the plan actually applied).
  describe("vault-scope downgrade diagnostic (결함 B)", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("warns when vault scope has no owning root, naming the target, baseDir, and the applied plan", () => {
      setImageSearchRoot(() => null);
      const img = mountScoped("pic-noroot.png");
      fireError(img);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const msg = warnSpy.mock.calls[0].join(" ");
      expect(msg).toContain("pic-noroot.png");
      expect(msg).toContain(docFolder);
      expect(msg).toContain("3"); // downgraded maxDepth
    });

    it("does not warn when vault scope resolves an owning root (no downgrade happened)", () => {
      setImageSearchRoot(() => "/vault");
      const img = mountScoped("pic-root.png");
      fireError(img);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("does not warn for folder scope (never contracted to search the vault, so no downgrade)", () => {
      setImageSearchRoot(() => null);
      const img = mountScoped("pic-folder.png", "folder");
      fireError(img);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("dedupes repeated onerror firings for the same (baseDir, name)", () => {
      setImageSearchRoot(() => null);
      const imgA = mountScoped("pic-dupe.png");
      fireError(imgA);
      const imgB = mountScoped("pic-dupe.png"); // second widget, same target
      fireError(imgB);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("folder scope ignores an owning vault root even when one is wired", () => {
    setImageSearchRoot(() => "/vault");
    const img = mountScoped("pic-folderscope.png", "folder");
    fireError(img);
    expect(invokeSpy).toHaveBeenCalledWith("resolve_image", {
      baseDir: docFolder,
      name: "pic-folderscope.png",
      maxDepth: 3,
    });
  });

  it("setting off: vault scope with an owning root still invokes (the setting only gates folder-scope fallback)", () => {
    recursiveImageSearchSetting.set("off");
    setImageSearchRoot(() => "/vault");
    const img = mountScoped("pic-off-vault.png");
    fireError(img);
    expect(invokeSpy).toHaveBeenCalledTimes(1);
  });

  it("setting off: folder scope still does not invoke (unchanged)", () => {
    recursiveImageSearchSetting.set("off");
    setImageSearchRoot(() => "/vault");
    const img = mountScoped("pic-off-folder.png", "folder");
    fireError(img);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("promise cache: two widgets for the same (root, name) share one invoke", async () => {
    setImageSearchRoot(() => "/vault");
    let resolveInvoke: (v: string | null) => void = () => {};
    invokeSpy.mockImplementation(
      () =>
        new Promise((r) => {
          resolveInvoke = r;
        }),
    );
    const imgA = mountScoped("pic-dedup.png");
    const imgB = mountScoped("pic-dedup.png");
    fireError(imgA);
    fireError(imgB);
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    resolveInvoke("/mock/found/pic-dedup.png");
    await flush();
    expect(imgA.src).toContain("/mock/found/pic-dedup.png");
    expect(imgB.src).toContain("/mock/found/pic-dedup.png");
  });

  it("promise cache: a null resolution clears the entry so a later widget retries", async () => {
    setImageSearchRoot(() => "/vault");
    invokeSpy.mockResolvedValueOnce(null);
    const imgA = mountScoped("pic-retry.png");
    fireError(imgA);
    await flush();
    expect(invokeSpy).toHaveBeenCalledTimes(1);

    invokeSpy.mockResolvedValueOnce("/mock/found/pic-retry.png");
    const imgB = mountScoped("pic-retry.png");
    fireError(imgB);
    await flush();
    expect(invokeSpy).toHaveBeenCalledTimes(2); // retried, not served from a stale negative cache
    expect(imgB.src).toContain("/mock/found/pic-retry.png");
  });

  it("regression (00_request_vaultimage_fix.md 결함1), end-to-end through the render path: resolve_image's baseDir is the SAME regardless of simulated active-vault switching", () => {
    // main.ts wires setImageSearchRoot(() => owningVaultRoot(dirOf(currentFile),
    // permanentRootsOf(workspaceStore.get()))) — reproduce that EXACT composition
    // here (not a stubbed imageSearchRoot()) so this exercises owningVaultRoot on
    // the actual render path (onerror -> searchPlanFor -> imageSearchRoot() ->
    // owningVaultRoot -> invoke), not just image-search-root.test.ts's isolated
    // pure-function unit tests. `owningVaultRoot` has no "active vault" parameter
    // at all, so the only channel a vault switch COULD leak through is the order
    // of the registered-roots list — flip it (simulating "/proj" vs "/proj/sub"
    // selected as active) and the resolved search root must not move.
    const documentDir = "/proj/sub/notes";
    const rootsAsIfProjActive = ["/proj", "/proj/sub"];
    const rootsAsIfSubActive = ["/proj/sub", "/proj"];

    setImageSearchRoot(() => owningVaultRoot(documentDir, rootsAsIfProjActive));
    const imgA = mountScoped("pic-e2e.png", "vault", documentDir);
    fireError(imgA);
    expect(invokeSpy).toHaveBeenCalledWith("resolve_image", {
      baseDir: "/proj/sub",
      name: "pic-e2e.png",
      maxDepth: VAULT_IMAGE_SCAN_DEPTH,
    });

    clearImageSearchCache(); // force a fresh lookup under the "switched" state — a cache hit would prove nothing
    invokeSpy.mockClear();
    setImageSearchRoot(() => owningVaultRoot(documentDir, rootsAsIfSubActive));
    const imgB = mountScoped("pic-e2e.png", "vault", documentDir);
    fireError(imgB);
    expect(invokeSpy).toHaveBeenCalledWith("resolve_image", {
      baseDir: "/proj/sub",
      name: "pic-e2e.png",
      maxDepth: VAULT_IMAGE_SCAN_DEPTH,
    });
  });

  it("eq() includes searchScope — a scope-only rebuild is not reused", () => {
    const a = new ImageWidget("u", "alt", "pic.png", "/a", "vault");
    expect(a.eq(new ImageWidget("u", "alt", "pic.png", "/a", "vault"))).toBe(true);
    expect(a.eq(new ImageWidget("u", "alt", "pic.png", "/a", "folder"))).toBe(false);
  });
});

describe("ImageWidget click → open viewer (_workspace/01_architect_design_imgclick.md)", () => {
  const baseDir = "/home/u/notes";
  let openSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    openSpy = vi.fn();
    setImageOpenHandler(openSpy);
  });

  const mountImg = (rawSrc: string) => {
    const w = new ImageWidget(`${baseDir}/${rawSrc}`, "alt", rawSrc, baseDir);
    return w.toDOM(fakeView) as HTMLImageElement;
  };

  const clickAt = (img: HTMLImageElement, x: number, y: number, opts: Partial<MouseEventInit> = {}) => {
    img.dispatchEvent(new MouseEvent("mousedown", { clientX: x, clientY: y, bubbles: true }));
    img.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y, bubbles: true, ...opts }));
  };

  it("a plain click requests the viewer to open with the resolved local source", () => {
    const img = mountImg("cat.png");
    clickAt(img, 10, 10);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(`${baseDir}/cat.png`);
  });

  it("a remote rawSrc is handed to the viewer untouched (no baseDir join)", () => {
    const img = mountImg("https://ex.com/c.png");
    clickAt(img, 10, 10);
    expect(openSpy).toHaveBeenCalledWith("https://ex.com/c.png");
  });

  it("Alt+click does not open the viewer (falls through to source-edit instead)", () => {
    const img = mountImg("cat.png");
    clickAt(img, 10, 10, { altKey: true });
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("a click whose pointer moved past the drag slop (>4px) is treated as a drag release, not a click", () => {
    const img = mountImg("cat.png");
    img.dispatchEvent(new MouseEvent("mousedown", { clientX: 0, clientY: 0, bubbles: true }));
    img.dispatchEvent(new MouseEvent("click", { clientX: 10, clientY: 0, bubbles: true }));
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("a click within the drag slop (≤4px) still opens the viewer", () => {
    const img = mountImg("cat.png");
    img.dispatchEvent(new MouseEvent("mousedown", { clientX: 0, clientY: 0, bubbles: true }));
    img.dispatchEvent(new MouseEvent("click", { clientX: 3, clientY: 0, bubbles: true }));
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it("after the recursive-search fallback resolves, a click opens the RESOLVED file, not the failed literal", async () => {
    invokeSpy.mockReset();
    invokeSpy.mockResolvedValue("/mock/found/pic.png");
    recursiveImageSearchSetting.set("on");
    const img = mountImg("pic.png");
    img.onerror?.(new Event("error"));
    await new Promise((r) => setTimeout(r, 0));
    clickAt(img, 10, 10);
    expect(openSpy).toHaveBeenCalledWith("/mock/found/pic.png");
  });
});
