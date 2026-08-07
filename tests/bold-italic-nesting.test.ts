// 2026-08 golden-master fix (`_workspace/03_qa2_report.md`): `.cm-strong.cm-em`
// was DEAD CSS — a compound selector requiring one element to carry BOTH
// classes, but the parser/text-styles.ts pipeline never produces such an
// element. `Emphasis`/`StrongEmphasis` are always ONE NESTED INSIDE THE OTHER,
// so live-preview renders two NESTED <span>s. A pure CSS-text regex test (the
// kind `tests/sidebar-contrast.test.ts`/`theme-css-fallback-parity.test.ts`
// use) cannot catch a selector that's syntactically fine but never matches any
// real element — this file asserts against the ACTUAL MOUNTED DOM, using the
// real `element.matches()`/`querySelector()` DOM API, which is selector-syntax
// aware independent of any loaded stylesheet.
import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) =>
    cmd === "read_file"
      ? Promise.resolve({ text: "", mtime: 1 })
      : cmd === "write_file"
        ? Promise.resolve(1)
        : Promise.resolve(false),
  ),
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), openPath: vi.fn() }));

import { mountEditor } from "../src/editor";

function mountRead(doc: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const { view } = mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: "read" });
  (view as unknown as { measure(): void }).measure();
  return { view, host };
}

describe("bold+italic combined markup: real nested-span DOM (not a compound-class element)", () => {
  it("NEVER produces a single element carrying both .cm-strong and .cm-em (the dead-selector shape)", () => {
    const cases = ["a ***매우 중요한*** b", "a **_매우 중요한_** b", "a _**매우 중요한**_ b", "a *__매우 중요한__* b", "a __*매우 중요한*__ b"];
    for (const doc of cases) {
      const { view, host } = mountRead(doc);
      expect(
        view.contentDOM.querySelector(".cm-strong.cm-em"),
        `"${doc}" produced a single .cm-strong.cm-em element — this is the shape .cm-strong.cm-em in CSS assumed and it never occurs in practice`,
      ).toBeNull();
      view.destroy();
      host.remove();
    }
  });

  it("***x*** / _**x**_ / *__x__* nest strong INSIDE em (.cm-em .cm-strong matches a real element)", () => {
    for (const doc of ["a ***매우 중요한*** b", "a _**매우 중요한**_ b", "a *__매우 중요한__* b"]) {
      const { view, host } = mountRead(doc);
      const strong = view.contentDOM.querySelector(".cm-em .cm-strong");
      expect(strong, `"${doc}" should nest .cm-strong inside .cm-em`).not.toBeNull();
      expect(strong!.textContent).toBe("매우 중요한");
      // the reverse selector must NOT match anything for this direction
      expect(view.contentDOM.querySelector(".cm-strong .cm-em")).toBeNull();
      view.destroy();
      host.remove();
    }
  });

  it("**_x_** / __*x*__ nest em INSIDE strong (.cm-strong .cm-em matches a real element)", () => {
    for (const doc of ["a **_매우 중요한_** b", "a __*매우 중요한*__ b"]) {
      const { view, host } = mountRead(doc);
      const em = view.contentDOM.querySelector(".cm-strong .cm-em");
      expect(em, `"${doc}" should nest .cm-em inside .cm-strong`).not.toBeNull();
      expect(em!.textContent).toBe("매우 중요한");
      expect(view.contentDOM.querySelector(".cm-em .cm-strong")).toBeNull();
      view.destroy();
      host.remove();
    }
  });

  // Regression guard for the fix itself: the styles.css rule text must target
  // the real nested shapes, not the dead compound selector. Combined with the
  // DOM-matching tests above, this closes the exact gap the QA report named
  // ("텍스트 대조라 이걸 못 잡았다") — text-parity is now paired with DOM-parity.
  it("styles.css no longer declares the dead .cm-strong.cm-em compound selector", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { fileURLToPath } = require("node:url") as typeof import("node:url");
    const { dirname, resolve } = require("node:path") as typeof import("node:path");
    const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles.css");
    const css = readFileSync(cssPath, "utf8");
    expect(css).not.toMatch(/\.cm-strong\.cm-em\s*\{/);
    expect(css).toMatch(/\.cm-em \.cm-strong\s*[,{]/);
    expect(css).toMatch(/\.cm-strong \.cm-em\s*[,{]/);
  });
});
