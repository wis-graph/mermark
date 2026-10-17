import { describe, it, expect, vi } from "vitest";
import { builtinFileActions } from "../src/chrome/file-actions/builtin";
import { IMAGE_EXTENSIONS } from "../src/sidebar/explorer/file-icons";

const open = () => vi.fn(() => Promise.resolve());

describe("builtinFileActions", () => {
  it("non-mac platform registers nothing", () => {
    expect(builtinFileActions("other", open())).toEqual([]);
  });

  it("mac: preview then browser, with labels", () => {
    const a = builtinFileActions("mac", open());
    expect(a.map((x) => x.id)).toEqual(["preview", "browser"]);
    expect(a.map((x) => x.label)).toEqual(["미리보기로 열기", "브라우저로 열기"]);
  });

  it("extension mapping", () => {
    const [preview, browser] = builtinFileActions("mac", open());
    for (const e of ["png", "jpg", "pdf", "heic"]) expect(preview.extensions).toContain(e);
    for (const e of ["svg", "html"]) expect(preview.extensions).not.toContain(e);
    for (const e of ["html", "htm", "svg", "pdf", "png"]) expect(browser.extensions).toContain(e);
    for (const e of ["md", "txt", "xlsx"]) expect(browser.extensions).not.toContain(e);
  });

  it("every non-svg IMAGE_EXTENSION is in both (derivation drift guard)", () => {
    const [preview, browser] = builtinFileActions("mac", open());
    for (const e of IMAGE_EXTENSIONS) {
      if (e === "svg") continue;
      expect(preview.extensions).toContain(e);
      expect(browser.extensions).toContain(e);
    }
  });

  it("run delegates to open(path, target)", () => {
    const o = open();
    const [preview, browser] = builtinFileActions("mac", o);
    preview.run("/a/b.png");
    browser.run("/a/b.png");
    expect(o).toHaveBeenNthCalledWith(1, "/a/b.png", "preview");
    expect(o).toHaveBeenNthCalledWith(2, "/a/b.png", "browser");
  });

  it("a rejecting open does not escape run (console.error instead)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const o = vi.fn(() => Promise.reject(new Error("x")));
    const [preview] = builtinFileActions("mac", o);
    await expect(Promise.resolve(preview.run("/a.png"))).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
