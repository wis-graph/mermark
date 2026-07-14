import { describe, it, expect } from "vitest";
import { TableWidget } from "../src/markdown/table-widget";

describe("TableWidget — inline links in cells (G)", () => {
  it("renders a link inside a td as a.cm-link[data-href]", () => {
    const src = "| A | B |\n|---|---|\n| [구글](https://google.com) | plain |";
    const widget = new TableWidget(src);
    const dom = widget.toDOM();
    const a = dom.querySelector("td a.cm-link") as HTMLAnchorElement | null;
    expect(a).not.toBeNull();
    expect(a!.dataset.href).toBe("https://google.com");
    expect(a!.textContent).toBe("구글");
  });

  it("renders a link inside a th (header cell) the same way", () => {
    const src = "| [문서](https://x.com) | B |\n|---|---|\n| 1 | 2 |";
    const widget = new TableWidget(src);
    const dom = widget.toDOM();
    const a = dom.querySelector("th a.cm-link") as HTMLAnchorElement | null;
    expect(a).not.toBeNull();
    expect(a!.dataset.href).toBe("https://x.com");
  });

  it("an internal wikilink cell renders link-styled with no data-href (out of scope, falls through to block entry)", () => {
    const src = "| A | B |\n|---|---|\n| [[note]] | plain |";
    const widget = new TableWidget(src);
    const dom = widget.toDOM();
    const a = dom.querySelector("td a.cm-link") as HTMLAnchorElement | null;
    expect(a).not.toBeNull();
    expect(a!.hasAttribute("data-href")).toBe(false);
  });

  it("ignoreEvent stays true (block-entry click routing is centralized in core.ts clickEntry)", () => {
    const widget = new TableWidget("| A |\n|---|\n| 1 |");
    expect(widget.ignoreEvent()).toBe(true);
  });
});
