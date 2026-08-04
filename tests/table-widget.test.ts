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

// Report-style table (team-lead spec, 2026-07-20): explicit markdown
// alignment (`:---`/`---:`/`:--:`) MUST win over the auto-numeric-align
// class — table-widget.ts sets alignment as an INLINE style (which always
// outranks a CSS class), and only adds `is-num` for the CSS auto-align to
// show through on columns with NO explicit spec. This pins that ordering so
// a future change can't accidentally make the class fight the inline style.
describe("TableWidget — is-num auto-align vs. explicit markdown alignment (report-style table)", () => {
  it("a numeric column with NO explicit align spec gets is-num and no inline style — CSS does the align", () => {
    const src = "| name | amount |\n|---|---|\n| a | 1,234 |";
    const dom = new TableWidget(src).toDOM();
    const cells = dom.querySelectorAll("td");
    expect(cells[1].classList.contains("is-num")).toBe(true);
    expect(cells[1].style.textAlign).toBe(""); // no inline style — .is-num's CSS rule is what right-aligns it
  });

  it("a non-numeric column with no explicit align gets neither is-num nor an inline style", () => {
    const src = "| name |\n|---|\n| Kim |";
    const dom = new TableWidget(src).toDOM();
    const td = dom.querySelector("td") as HTMLElement;
    expect(td.classList.contains("is-num")).toBe(false);
    expect(td.style.textAlign).toBe("");
  });

  it("an explicit right-align spec (---:) on a numeric column sets the inline style AND still carries is-num", () => {
    const src = "| amount |\n|---:|\n| 1 |";
    const dom = new TableWidget(src).toDOM();
    const td = dom.querySelector("td") as HTMLElement;
    expect(td.classList.contains("is-num")).toBe(true); // detection still fires
    expect(td.style.textAlign).toBe("right"); // explicit spec wins via inline style
  });

  it("an explicit LEFT-align spec (:---) on a numeric column keeps left via inline style, even though is-num is present", () => {
    const src = "| amount |\n|:---|\n| 1234 |";
    const dom = new TableWidget(src).toDOM();
    const td = dom.querySelector("td") as HTMLElement;
    expect(td.classList.contains("is-num")).toBe(true); // CSS class present...
    expect(td.style.textAlign).toBe("left"); // ...but inline style wins the cascade
  });

  it("a header cell (th) gets the same is-num treatment as a data cell", () => {
    const src = "| 1,000 | name |\n|---|---|\n| a | b |";
    const dom = new TableWidget(src).toDOM();
    const ths = dom.querySelectorAll("th");
    expect(ths[0].classList.contains("is-num")).toBe(true);
    expect(ths[1].classList.contains("is-num")).toBe(false);
  });
});

// Bug fix (2026-08-05, team-lead report): splitRow used to split on every
// `|`, so an escaped pipe (`\|`) inside a cell — including inside a code
// span, where GFM requires `\|` to show a literal pipe — shattered one row
// into many cells instead of keeping the escaped pipe as literal text.
describe("TableWidget — escaped pipes (\\|) do not split cells", () => {
  it("a code span with multiple escaped pipes inside a cell stays one cell, unescaped in the rendered text", () => {
    const src =
      "| **머리글 줄과 `\\|---\\|---\\|---\\|`** | 표로 안 그려지고 막대기 섞인 글자로 남습니다 |\n" +
      "|---|---|\n" +
      "| a | b |";
    const dom = new TableWidget(src).toDOM();
    const ths = dom.querySelectorAll("th");
    expect(ths.length).toBe(2); // exactly 2 cells, not shattered into 6-7
    expect(ths[0].querySelector("code")?.textContent).toBe("|---|---|---|");
    expect(ths[1].textContent).toBe("표로 안 그려지고 막대기 섞인 글자로 남습니다");
  });

  it("an escaped pipe in the middle of plain cell text stays literal and does not split the cell", () => {
    const src = "| A | B |\n|---|---|\n| left\\|right | plain |";
    const dom = new TableWidget(src).toDOM();
    const tds = dom.querySelectorAll("td");
    expect(tds.length).toBe(2);
    expect(tds[0].textContent).toBe("left|right");
  });

  it("a row ending in an escaped pipe keeps the trailing pipe as literal cell content, not a delimiter", () => {
    const src = "| A | B |\n|---|---|\n| foo | bar\\| |";
    const dom = new TableWidget(src).toDOM();
    const tds = dom.querySelectorAll("td");
    expect(tds.length).toBe(2);
    expect(tds[1].textContent).toBe("bar|");
  });

  it("an escaped backslash before a separator pipe (\\\\|) still splits — only the backslash is escaped, the pipe is real", () => {
    const src = "| A | B |\n|---|---|\n| foo\\\\ | bar |";
    const dom = new TableWidget(src).toDOM();
    const tds = dom.querySelectorAll("td");
    expect(tds.length).toBe(2);
    expect(tds[0].textContent).toBe("foo\\");
    expect(tds[1].textContent).toBe("bar");
  });

  it("a plain table with no escapes renders exactly as before (regression)", () => {
    const src = "| name | amount |\n|---|---|\n| a | 1,234 |";
    const dom = new TableWidget(src).toDOM();
    const ths = dom.querySelectorAll("th");
    const tds = dom.querySelectorAll("td");
    expect(ths.length).toBe(2);
    expect(ths[0].textContent).toBe("name");
    expect(ths[1].textContent).toBe("amount");
    expect(tds[0].textContent).toBe("a");
    expect(tds[1].textContent).toBe("1,234");
  });

  it("an empty cell between escaped-pipe content still counts as its own cell", () => {
    const src = "| A | B | C |\n|---|---|---|\n| x |  | z |";
    const dom = new TableWidget(src).toDOM();
    const tds = dom.querySelectorAll("td");
    expect(tds.length).toBe(3);
    expect(tds[1].textContent).toBe("");
  });

  it("a row without leading/trailing pipes still splits correctly (GFM allows omitting outer pipes)", () => {
    const src = "A | B\n---|---\nleft\\|lit | plain";
    const dom = new TableWidget(src).toDOM();
    const tds = dom.querySelectorAll("td");
    expect(tds.length).toBe(2);
    expect(tds[0].textContent).toBe("left|lit");
    expect(tds[1].textContent).toBe("plain");
  });
});
