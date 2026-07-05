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

// The path the (mock) watcher is currently armed on. Shared with the event mock
// (tauri-event.ts) so __mockExternalChange writes the simulated disk content
// into the in-memory store and emits a file-changed event for that path.
export let mockWatchedPath: string | null = null;
/** Simulate an external edit landing on the watched file: update the in-memory
 *  store so a subsequent read_file sees it, and return the payload the event
 *  mock should emit. Returns null when nothing is being watched. */
export function applyMockExternalChange(text: string): { text: string; mtime: number } | null {
  if (mockWatchedPath == null) return null;
  store.set(mockWatchedPath, text);
  return { text, mtime: Date.now() };
}

type Args = Record<string, unknown> | undefined;

/** One directory entry — mirrors the Rust `DirEntry` serde shape exactly
 *  (`is_dir` stays snake_case on the wire). Kept local to the mock so the
 *  browser tree lookup is typed the same as `invoke<DirEntry[]>("list_dir")`. */
interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

/** Fold a trailing `/..` textually so the mock's `list_dir` tree lookup matches
 *  the real backend's `normalize_path` parent resolution (the explorer's `..`
 *  double-click passes `${root}/..`). Only the cases the fixed TREE needs are
 *  handled — this is a deterministic stand-in, not a full path normalizer. */
function normalizeMockPath(path: string): string {
  const parts = path.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part === "." || part === "") continue;
    else out.push(part);
  }
  return "/" + out.join("/");
}

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
    case "list_link_targets": {
      // Mirrors the real `list_link_targets(dir) -> Result<Vec<LinkTarget>>`:
      // markdown notes (name = basename, no `.md`) and inlineable images
      // (name = full file name) in the given dir, sorted markdown-first then by
      // name. Deterministic so the `[[` picker golden is stable; the values line
      // up with the SAMPLE body's `[[some-note]]` and `[[diagram.png]]`. The
      // browser mock can't read a real FS, so `dir` is accepted but ignored.
      console.info("[mock] list_link_targets", a.dir);
      return [
        { name: "some-note", rel: "some-note.md", kind: "markdown" },
        { name: "diagram.png", rel: "diagram.png", kind: "image" },
      ] as T;
    }
    case "list_dir": {
      // Mirrors the real `list_dir(path) -> Result<Vec<DirEntry>>`: the immediate
      // children (one level) of `path`, folders first then name, hidden/artifact
      // entries excluded. The browser has no real FS, so the lazy tree is faked
      // with a deterministic per-path lookup — nested hover walks the table.
      // Parent (`..`) resolution is folded by normalizeMockPath, mirroring the
      // backend's normalize_path so `${root}/..` lands on the parent key.
      // `is_dir` stays snake_case to match the Rust serde shape. Roots align with
      // the golden's `?file=/mock/vault/index.md` entry point.
      const norm = normalizeMockPath(String(a.path ?? ""));
      const TREE: Record<string, DirEntry[]> = {
        "/mock/vault": [
          { name: "notes", path: "/mock/vault/notes", is_dir: true },
          { name: "index.md", path: "/mock/vault/index.md", is_dir: false },
          { name: "logo.svg", path: "/mock/vault/logo.svg", is_dir: false },
          { name: "data.json", path: "/mock/vault/data.json", is_dir: false },
          { name: "app.ts", path: "/mock/vault/app.ts", is_dir: false },
          { name: "guide.pdf", path: "/mock/vault/guide.pdf", is_dir: false },
          { name: "LICENSE", path: "/mock/vault/LICENSE", is_dir: false },
          { name: "pic.png", path: "/mock/vault/pic.png", is_dir: false },
        ],
        "/mock/vault/notes": [
          { name: "a.md", path: "/mock/vault/notes/a.md", is_dir: false },
        ],
        "/mock": [
          // `..` from /mock/vault lands here — the parent listing.
          { name: "vault", path: "/mock/vault", is_dir: true },
        ],
      };
      console.info("[mock] list_dir", a.path, "->", norm);
      return (TREE[norm] ?? []) as T;
    }
    case "watch_file":
      // Single-slot fs watcher. No real watcher in the browser — record the
      // path so __mockExternalChange (in the event mock) can target it, and
      // no-op otherwise. The real backend replaces any prior watch here.
      mockWatchedPath = String(a.path ?? "");
      console.info("[mock] watch_file", mockWatchedPath);
      return undefined as T;
    case "unwatch_file":
      mockWatchedPath = null;
      console.info("[mock] unwatch_file");
      return undefined as T;
    case "resolve_image": {
      // Mirrors the real `resolve_image(base_dir, name, max_depth) -> Option<String>`
      // (serde `string | null`). The browser has no filesystem to recurse, so the
      // scan is faked with a deterministic lookup table keyed on the reference's
      // basename: a known image name resolves to a fixed `/mock/found/...` path,
      // everything else resolves to null (not found). This lets the golden master
      // exercise the fallback path deterministically — the SAMPLE body's
      // `![local](./pic.png)` fails its literal load in a plain browser, the widget
      // calls resolve_image with name "./pic.png", and the basename "pic.png" maps
      // here to "/mock/found/pic.png", which convertFileSrc returns verbatim so the
      // swapped `img.src` is observable in the DOM. Args are camelCase to match the
      // Tauri snake→camel mapping: { baseDir, name, maxDepth }.
      const baseDir = String(a.baseDir ?? "");
      const name = String(a.name ?? "");
      const basename = name.split(/[/\\]/).pop() ?? name;
      const FOUND: Record<string, string> = {
        "pic.png": "/mock/found/pic.png",
      };
      const hit = FOUND[basename.toLowerCase()] ?? null;
      console.info("[mock] resolve_image", baseDir, name, "->", hit);
      return hit as T;
    }
    case "path_exists":
      return true as T;
    case "open_path":
    case "open_url":
      console.info("[mock] open", a.path ?? a.url);
      return undefined as T;
    case "get_version":
      return "0.4.0" as T;
    default:
      console.warn("[mock] unhandled invoke:", cmd, args);
      return undefined as T;
  }
}

export function convertFileSrc(filePath: string, _protocol?: string): string {
  // no asset:// scheme in a browser; just hand back the path (broken img is fine for debugging)
  return filePath;
}
