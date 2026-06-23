// Browser-only mock for @tauri-apps/api/core.
// Injected via Vite alias ONLY in `--mode browser` (see vite.config.ts).
// Lets the frontend run in a plain browser (Vite dev server) with no Rust backend,
// so CDP / Playwright / DevTools debugging works without WKWebView limits.

const SAMPLE = `# Mermark — markdown kitchen sink

Served by the **browser mock**, not the Rust backend. Edit it, hit save (⌘S) — changes round-trip in-memory until reload. This first paragraph is deliberately one long unbroken line with no hard wraps so you can confirm the reading column wraps soft text correctly and that the ~68ch measure holds: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est laborum.

## Headings

### H3 level
#### H4 level
##### H5 level
###### H6 level

## Inline styles

**bold**, *italic*, ***bold italic***, ~~strikethrough~~, \`inline code\`, and a [labeled link](https://tauri.app). Autolink: https://github.com . Wikilink: [[some-note]] and an image wikilink: [[diagram.png]].

## Blockquote

> Top-level quote.
>
> > Nested quote with **bold** inside.

## Lists

Unordered, nested:

- Fruit
  - Apple
  - Pear
- Veg
  - Carrot

Ordered:

1. First
2. Second
   1. Second-a
   2. Second-b
3. Third

Task list:

- [x] Wire the browser mock
- [x] Fix baseDir char-eat bug
- [ ] Cover every markdown construct

## Table

| Feature   | Status | Note            |
| --------- | :----: | --------------- |
| Mermaid   |   ✅   | renders in box  |
| Math      |   ✅   | KaTeX           |
| Wikilinks |   ✅   | \`[[target]]\`    |

---

## Code block

\`\`\`ts
export function dirOf(path: string): string {
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\\\"));
  return sep >= 0 ? path.slice(0, sep) : "";
}
\`\`\`

## Mermaid

\`\`\`mermaid
flowchart LR
  A[Browser] -- invoke --> B{mock}
  B -->|read_file| C[dummy md]
  B -->|write_file| D[in-memory]
\`\`\`

## Math

Inline $E = mc^2$ and block:

$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$

## Image

Local image (won't load in a plain browser — expected): ![local](./pic.png)
`;

// in-memory FS so write_file -> read_file round-trips during a session
const store = new Map<string, string>();

type Args = Record<string, unknown> | undefined;

export async function invoke<T = unknown>(cmd: string, args?: Args): Promise<T> {
  const a = (args ?? {}) as Record<string, unknown>;
  // strip plugin prefix e.g. "plugin:opener|open_url" -> "open_url"
  const name = cmd.includes("|") ? cmd.split("|")[1] : cmd;

  switch (name) {
    case "read_file": {
      const path = String(a.path ?? "");
      const text = store.get(path) ?? SAMPLE;
      return { text, mtime: Date.now() } as T;
    }
    case "write_file": {
      store.set(String(a.path ?? ""), String(a.text ?? ""));
      console.info("[mock] write_file", a.path, `${String(a.text ?? "").length} chars`);
      // mirror the real command: return the new mtime (no conflict in-memory)
      return Date.now() as T;
    }
    case "bundle_doc": {
      // Mirrors the real `bundle_doc(path) -> Result<String, String>`: returns
      // the LLM bundle envelope as a string. Deterministic so golden/clipboard
      // checks are stable. The browser mock can't traverse a real FS, so it
      // wraps just the requested doc (root-only) in the same <documents> shape.
      const path = String(a.path ?? "");
      const title = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
      const rel = path.split("/").pop() ?? path;
      const body = store.get(path) ?? SAMPLE;
      console.info("[mock] bundle_doc", path);
      return `<documents>\n<document path="${rel}" title="${title}">\n${body}\n</document>\n</documents>` as T;
    }
    case "path_exists":
      return true as T;
    case "open_path":
    case "open_url":
      console.info("[mock] open", a.path ?? a.url);
      return undefined as T;
    default:
      console.warn("[mock] unhandled invoke:", cmd, args);
      return undefined as T;
  }
}

export function convertFileSrc(filePath: string, _protocol?: string): string {
  // no asset:// scheme in a browser; just hand back the path (broken img is fine for debugging)
  return filePath;
}
