import { describe, it, expect, vi, beforeEach } from "vitest";

const mockOpenUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: any[]) => mockOpenUrl(...args),
}));

import { renderInlineMarkdown } from "../src/markdown/inline-render";

function html(text: string): HTMLElement {
  const host = document.createElement("div");
  host.appendChild(renderInlineMarkdown(text));
  return host;
}

describe("renderInlineMarkdown", () => {
  it("renders **bold** as strong.cm-strong", () => {
    const el = html("**bold**");
    const strong = el.querySelector("strong.cm-strong");
    expect(strong?.textContent).toBe("bold");
  });

  it("renders __bold__ as strong too", () => {
    expect(html("__b__").querySelector("strong.cm-strong")?.textContent).toBe("b");
  });

  it("renders *italic* as em.cm-em", () => {
    expect(html("*i*").querySelector("em.cm-em")?.textContent).toBe("i");
  });

  it("renders `code` as code.cm-inline-code", () => {
    expect(html("`c`").querySelector("code.cm-inline-code")?.textContent).toBe("c");
  });

  it("renders ~~strike~~ as del.cm-strike", () => {
    expect(html("~~s~~").querySelector("del.cm-strike")?.textContent).toBe("s");
  });

  it("keeps text + mark + text order for a **b** c", () => {
    const el = html("a **b** c");
    expect(el.childNodes[0].textContent).toBe("a ");
    expect((el.childNodes[1] as HTMLElement).tagName).toBe("STRONG");
    expect(el.childNodes[2].textContent).toBe(" c");
  });

  it("nests one level: **`x`** is code inside strong", () => {
    const strong = html("**`x`**").querySelector("strong.cm-strong");
    expect(strong?.querySelector("code.cm-inline-code")?.textContent).toBe("x");
  });

  it("code spans disable inner marks: `**x**` is literal", () => {
    const el = html("`**x**`");
    const code = el.querySelector("code.cm-inline-code");
    expect(code?.textContent).toBe("**x**");
    expect(el.querySelector("strong")).toBeNull();
  });

  it("honors escapes: \\*not bold\\* stays literal text", () => {
    const el = html("\\*not bold\\*");
    expect(el.querySelector("strong")).toBeNull();
    expect(el.querySelector("em")).toBeNull();
    expect(el.textContent).toBe("*not bold*");
  });

  it("is XSS-safe: <img onerror=x> never becomes an element", () => {
    const el = html("<img onerror=alert(1)> hi");
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toBe("<img onerror=alert(1)> hi");
  });

  it("leaves an unclosed marker as literal text", () => {
    const el = html("a **b");
    expect(el.querySelector("strong")).toBeNull();
    expect(el.textContent).toBe("a **b");
  });
});

// ---------------------------------------------------------------------------
// G — link rendering in the table-cell / changelog inline renderer.
// ---------------------------------------------------------------------------
describe("renderInlineMarkdown — links (G)", () => {
  beforeEach(() => mockOpenUrl.mockReset());

  it("renders [label](url) as an external a.cm-link with data-href, no href attribute", () => {
    const el = html("[구글](https://google.com)");
    const a = el.querySelector("a.cm-link") as HTMLAnchorElement | null;
    expect(a).not.toBeNull();
    expect(a!.textContent).toBe("구글");
    expect(a!.dataset.href).toBe("https://google.com");
    expect(a!.hasAttribute("href")).toBe(false);
  });

  it("renders a bare https:// URL as an external a.cm-link", () => {
    const el = html("see https://example.com now");
    const a = el.querySelector("a.cm-link") as HTMLAnchorElement | null;
    expect(a).not.toBeNull();
    expect(a!.textContent).toBe("https://example.com");
    expect(a!.dataset.href).toBe("https://example.com");
  });

  it("renders [[note]] as a link-styled anchor with NO data-href (internal — out of scope)", () => {
    const el = html("[[note]]");
    const a = el.querySelector("a.cm-link") as HTMLAnchorElement | null;
    expect(a).not.toBeNull();
    expect(a!.textContent).toBe("note");
    expect(a!.hasAttribute("data-href")).toBe(false);
  });

  it("renders [[note|별칭]] using the alias as label, still no data-href", () => {
    const el = html("[[note|별칭]]");
    const a = el.querySelector("a.cm-link") as HTMLAnchorElement | null;
    expect(a).not.toBeNull();
    expect(a!.textContent).toBe("별칭");
    expect(a!.hasAttribute("data-href")).toBe(false);
  });

  it("renders [t](./rel.md) as a link-styled anchor with no data-href (relative path — internal)", () => {
    const el = html("[t](./rel.md)");
    const a = el.querySelector("a.cm-link") as HTMLAnchorElement | null;
    expect(a).not.toBeNull();
    expect(a!.hasAttribute("data-href")).toBe(false);
  });

  it("XSS: javascript:/data:/file: hrefs never get data-href or href, no innerHTML", () => {
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
    ]) {
      const el = html(`[x](${href})`);
      const a = el.querySelector("a.cm-link") as HTMLAnchorElement | null;
      expect(a).not.toBeNull();
      expect(a!.hasAttribute("data-href")).toBe(false);
      expect(a!.hasAttribute("href")).toBe(false);
      expect(el.querySelector("script")).toBeNull();
    }
  });

  it("XSS regression: <img onerror=…> stays inert text, never an element", () => {
    const el = html("<img onerror=alert(1)> hi");
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toBe("<img onerror=alert(1)> hi");
  });

  it("nests a bold run inside a link label (recursive label rendering)", () => {
    const el = html("[**bold** link](https://x.com)");
    const a = el.querySelector("a.cm-link") as HTMLAnchorElement | null;
    expect(a).not.toBeNull();
    expect(a!.querySelector("strong.cm-strong")?.textContent).toBe("bold");
    expect(a!.dataset.href).toBe("https://x.com");
  });

  it("a code span disables link parsing inside it (code-span-wins contract)", () => {
    const el = html("`[x](https://y.com)`");
    expect(el.querySelector("a.cm-link")).toBeNull();
    expect(el.querySelector("code.cm-inline-code")?.textContent).toBe("[x](https://y.com)");
  });

  it("clicking an external anchor calls openExternal (openUrl) and preventDefault", async () => {
    mockOpenUrl.mockResolvedValue(undefined);
    const el = html("[구글](https://google.com)");
    const a = el.querySelector("a.cm-link") as HTMLAnchorElement;
    const evt = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    const prevented = !a.dispatchEvent(evt); // dispatchEvent returns false if preventDefault was called
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prevented).toBe(true);
    expect(mockOpenUrl).toHaveBeenCalledWith("https://google.com");
  });

  it("clicking an internal (no data-href) anchor does NOT call openExternal (falls through)", async () => {
    const el = html("[[note]]");
    const a = el.querySelector("a.cm-link") as HTMLAnchorElement;
    a.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockOpenUrl).not.toHaveBeenCalled();
  });

  it("right-clicking an external anchor does NOT call openExternal (context menu must survive)", async () => {
    const el = html("[구글](https://google.com)");
    const a = el.querySelector("a.cm-link") as HTMLAnchorElement;
    const evt = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2 });
    const prevented = !a.dispatchEvent(evt);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prevented).toBe(false); // not swallowed — event passes through untouched
    expect(mockOpenUrl).not.toHaveBeenCalled();
  });

  it("middle-clicking an external anchor does NOT call openExternal", async () => {
    const el = html("[구글](https://google.com)");
    const a = el.querySelector("a.cm-link") as HTMLAnchorElement;
    const evt = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1 });
    const prevented = !a.dispatchEvent(evt);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prevented).toBe(false);
    expect(mockOpenUrl).not.toHaveBeenCalled();
  });

  it("Alt+clicking an external anchor does NOT call openExternal and falls through (shared edit gesture)", async () => {
    const el = html("[구글](https://google.com)");
    const a = el.querySelector("a.cm-link") as HTMLAnchorElement;
    const evt = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, altKey: true });
    const prevented = !a.dispatchEvent(evt);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prevented).toBe(false); // no preventDefault → falls through to block-entry/reveal
    expect(mockOpenUrl).not.toHaveBeenCalled();
  });

  it("sets title=href on an external anchor (hover-checkable destination before click)", () => {
    const el = html("[구글](https://google.com)");
    const a = el.querySelector("a.cm-link") as HTMLAnchorElement;
    expect(a.title).toBe("https://google.com");
  });

  it("does NOT set title on an internal ([[note]]) anchor (no data-href, no title)", () => {
    const el = html("[[note]]");
    const a = el.querySelector("a.cm-link") as HTMLAnchorElement;
    expect(a.hasAttribute("data-href")).toBe(false);
    expect(a.title).toBe("");
  });

  it("does NOT set title on a relative-path ([t](./rel.md)) anchor", () => {
    const el = html("[t](./rel.md)");
    const a = el.querySelector("a.cm-link") as HTMLAnchorElement;
    expect(a.hasAttribute("data-href")).toBe(false);
    expect(a.title).toBe("");
  });
});
