import { describe, it, expect } from "vitest";
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
