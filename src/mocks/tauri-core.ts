// Browser-only mock for @tauri-apps/api/core.
// Injected via Vite alias ONLY in `--mode browser` (see vite.config.ts).
// Lets the frontend run in a plain browser (Vite dev server) with no Rust backend,
// so CDP / Playwright / DevTools debugging works without WKWebView limits.

const SAMPLE = `# Mermark — browser mock

This file is served by the **browser mock**, not the Rust backend.
Edit it, hit save (⌘S) — changes round-trip in-memory until reload.

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

## Links

- Wikilink: [[some-note]]
- External: [tauri](https://tauri.app)
- Image (won't load in browser, that's expected): ![local](./pic.png)
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
      return (store.get(path) ?? SAMPLE) as T;
    }
    case "write_file": {
      store.set(String(a.path ?? ""), String(a.text ?? ""));
      console.info("[mock] write_file", a.path, `${String(a.text ?? "").length} chars`);
      return undefined as T;
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
