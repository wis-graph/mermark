import { describe, it, expect, vi, beforeEach } from "vitest";

// Tauri's invoke is called by image/wikilink widgets; stub it so jsdom doesn't error.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(false)),
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));

import { mountEditor } from "../src/editor";

const DOC = `# Title

| A | B |
|:--|--:|
| 1 | 2 |

- [x] done
- [ ] todo

\`\`\`mermaid
graph TD
  A-->B
\`\`\`

Inline $e=mc^2$ and block:

$$
\\int_0^1 x\\,dx
$$

> [!note] hi
> body

Ref[^1] and [[wikilink]] and ![alt](pic.png).

[^1]: def
`;

describe("full-editor render smoke", () => {
  let host: HTMLElement;
  beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); });

  it("mounts and renders the feature-rich doc without throwing", () => {
    expect(() => {
      const view = mountEditor(host, DOC, "/tmp");
      // force the view to build decorations / run measure
      view.dispatch({ selection: { anchor: 0 } });
      (view as unknown as { measure(): void }).measure();
      view.destroy();
    }).not.toThrow();
  });
});
