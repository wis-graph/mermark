import { describe, it, expect } from "vitest";
import {
  parseFrontmatterScalars,
  FrontmatterWidget,
} from "../src/markdown/frontmatter-widget";

describe("parseFrontmatterScalars", () => {
  it("parses flat key: value scalars, dropping fences", () => {
    const src = "---\ntitle: Hi\ntags: a\n---";
    expect(parseFrontmatterScalars(src)).toEqual([
      { key: "title", value: "Hi" },
      { key: "tags", value: "a" },
    ]);
  });

  it("keeps a key with an empty value", () => {
    expect(parseFrontmatterScalars("---\naliases:\n---")).toEqual([
      { key: "aliases", value: "" },
    ]);
  });

  it("skips list items, nested/indented lines (first-pass scope)", () => {
    const src = "---\ntitle: Hi\ntags:\n  - x\n  - y\nnested:\n  a: b\n---";
    // `tags:` and `nested:` keep as empty-value keys; their indented children skip
    expect(parseFrontmatterScalars(src)).toEqual([
      { key: "title", value: "Hi" },
      { key: "tags", value: "" },
      { key: "nested", value: "" },
    ]);
  });

  it("returns no rows for an empty frontmatter", () => {
    expect(parseFrontmatterScalars("---\n---")).toEqual([]);
  });
});

describe("FrontmatterWidget.toDOM", () => {
  it("renders a key/value table, one row per scalar", () => {
    const dom = new FrontmatterWidget("---\ntitle: Hi\ntags: a\n---").toDOM();
    expect(dom.classList.contains("cm-frontmatter")).toBe(true);
    expect(dom.querySelector("table.cm-frontmatter-table")).not.toBeNull();
    const rows = dom.querySelectorAll("tbody tr");
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector("th")?.textContent).toBe("title");
    expect(rows[0].querySelector("td")?.textContent).toBe("Hi");
  });

  it("is XSS-safe: a value with HTML stays literal text (textContent, no innerHTML)", () => {
    const dom = new FrontmatterWidget("---\nx: <img onerror=alert(1)>\n---").toDOM();
    expect(dom.querySelector("img")).toBeNull();
    expect(dom.querySelector("td")?.textContent).toBe("<img onerror=alert(1)>");
  });

  it("eq() compares on source", () => {
    const a = new FrontmatterWidget("---\nk: v\n---");
    expect(a.eq(new FrontmatterWidget("---\nk: v\n---"))).toBe(true);
    expect(a.eq(new FrontmatterWidget("---\nk: w\n---"))).toBe(false);
  });
});
