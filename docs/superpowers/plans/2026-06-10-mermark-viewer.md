# mermark Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a cross-platform desktop markdown + Mermaid viewer, launched from the CLI to open a single file, rendered read-only on a CodeMirror 6 foundation.

**Architecture:** Tauri 2 shell (Rust core + system webview). Rust `main` parses a file-path arg, resolves+validates it, and opens a new window per invocation. The frontend (TypeScript + Vite) reads the file via a Tauri command and renders it inside a read-only CodeMirror 6 editor, using CM6 decorations to draw markdown inline (Live-Preview style). Mermaid, KaTeX, callouts, footnotes, wikilinks, and images are rendered as block/inline widgets.

**Tech Stack:** Tauri 2, Rust, TypeScript, Vite, CodeMirror 6 (`@codemirror/*`, `@lezer/markdown`), `mermaid`, `katex`, `svg-pan-zoom`. UI tokens from ElevenLabs DESIGN.md (`npx getdesign@latest add elevenlabs`).

**Spec:** `docs/superpowers/specs/2026-06-10-mermark-design.md`

---

## File Structure

```
mermark/
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs          # entry: parse args, open window
│       ├── cli.rs           # arg parsing + path resolution + validation (pure, tested)
│       └── commands.rs      # #[tauri::command] read_file, open_path (new window)
├── src/                     # frontend
│   ├── main.ts              # bootstrap: get file path, load content, mount editor
│   ├── editor.ts            # CM6 editor factory (read-only + extensions)
│   ├── markdown/
│   │   ├── parser.ts        # lang-markdown + custom extensions (callout/wikilink/footnote)
│   │   ├── inline.ts        # mark decorations: hide syntax markers, style inline
│   │   ├── mermaid-widget.ts
│   │   ├── math-widget.ts
│   │   ├── callout-widget.ts
│   │   ├── footnote.ts
│   │   ├── wikilink.ts      # pure resolver + click handler
│   │   ├── image.ts         # asset-protocol src rewrite
│   │   └── codeblock.ts     # syntax-highlighted fence
│   ├── theme.ts             # OS theme detect + toggle, CM6/mermaid/katex sync
│   └── styles.css           # DESIGN.md tokens
├── tests/
│   ├── wikilink.test.ts
│   ├── parser.test.ts
│   └── image.test.ts
├── package.json
├── vite.config.ts
└── vitest.config.ts
```

---

## Task 0: Scaffold Tauri 2 + Vite + TS project

**Files:**
- Create: whole `mermark/` skeleton via scaffolder, then prune.

- [ ] **Step 1: Scaffold**

Run in the repo root (it already contains `docs/` and `.git`):

```bash
npm create tauri-app@latest . -- --template vanilla-ts --manager npm --yes
```

If the directory-not-empty prompt blocks non-interactively, scaffold in a temp dir and copy:

```bash
npm create tauri-app@latest mermark-tmp -- --template vanilla-ts --manager npm --yes
cp -r mermark-tmp/* mermark-tmp/.[!.]* . 2>/dev/null; rm -rf mermark-tmp
```

- [ ] **Step 2: Install frontend deps**

```bash
npm install
npm install @codemirror/state @codemirror/view @codemirror/language @codemirror/lang-markdown @lezer/markdown @lezer/highlight mermaid katex svg-pan-zoom
npm install -D vitest jsdom
```

- [ ] **Step 3: Verify dev build boots**

Run: `npm run tauri dev`
Expected: a window opens showing the template page. Close it. (Manual check.)

- [ ] **Step 4: Add vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "jsdom", globals: true, include: ["tests/**/*.test.ts"] },
});
```

Add to `package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold Tauri 2 + Vite TS app with CM6/mermaid/katex deps"
```

---

## Task 1: Rust CLI arg parsing + path resolution + validation

**Files:**
- Create: `src-tauri/src/cli.rs`
- Modify: `src-tauri/src/main.rs` (add `mod cli;`)

- [ ] **Step 1: Write failing tests**

Create `src-tauri/src/cli.rs`:

```rust
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq)]
pub enum CliError {
    Missing,
    NotFound(PathBuf),
}

/// Resolve the first file argument to an absolute, existing file path.
/// `cwd` is injected for testability.
pub fn resolve_target(args: &[String], cwd: &Path) -> Result<PathBuf, CliError> {
    let raw = args.first().ok_or(CliError::Missing)?;
    let p = Path::new(raw);
    let abs = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
    if abs.is_file() {
        Ok(abs)
    } else {
        Err(CliError::NotFound(abs))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn missing_arg_errors() {
        let cwd = std::env::temp_dir();
        assert_eq!(resolve_target(&[], &cwd), Err(CliError::Missing));
    }

    #[test]
    fn relative_path_resolved_against_cwd() {
        let dir = std::env::temp_dir().join("mermark_test_rel");
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.md");
        fs::write(&f, "# hi").unwrap();
        let got = resolve_target(&["a.md".into()], &dir).unwrap();
        assert_eq!(got, f);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn nonexistent_file_errors() {
        let cwd = std::env::temp_dir();
        match resolve_target(&["nope_xyz.md".into()], &cwd) {
            Err(CliError::NotFound(_)) => {}
            other => panic!("expected NotFound, got {other:?}"),
        }
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test cli`
Expected: FAIL — `cli` module not declared in `main.rs` (compile error).

- [ ] **Step 3: Wire the module**

In `src-tauri/src/main.rs`, add near the top (after the existing `#![...]` attribute):

```rust
mod cli;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test cli`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/cli.rs src-tauri/src/main.rs
git commit -m "feat(cli): resolve and validate file-path arg"
```

---

## Task 2: Tauri commands + open window per invocation

**Files:**
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`

- [ ] **Step 1: Add the read_file + open_path commands**

Create `src-tauri/src/commands.rs`:

```rust
use std::path::PathBuf;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Read a file's UTF-8 contents. Used by the frontend at startup.
#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))
}

/// Open another file in a brand-new window (used by wikilink clicks).
#[tauri::command]
pub fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let label = format!("w{}", app.webview_windows().len() + 1);
    let url = WebviewUrl::App(format!("index.html?file={}", urlencoding::encode(&path)).into());
    WebviewWindowBuilder::new(&app, label, url)
        .title("mermark")
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}
```

- [ ] **Step 2: Add the urlencoding dep**

In `src-tauri/Cargo.toml` under `[dependencies]`:

```toml
urlencoding = "2"
```

- [ ] **Step 3: Wire commands + open first window from the CLI arg**

Replace the body of `src-tauri/src/main.rs` with:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli;
mod commands;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cwd = std::env::current_dir().unwrap_or_default();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::open_path
        ])
        .setup(move |app| {
            match cli::resolve_target(&args, &cwd) {
                Ok(path) => {
                    let url = WebviewUrl::App(
                        format!("index.html?file={}", urlencoding::encode(&path.to_string_lossy())).into(),
                    );
                    WebviewWindowBuilder::new(app, "main", url)
                        .title("mermark")
                        .inner_size(900.0, 720.0)
                        .build()?;
                }
                Err(e) => {
                    eprintln!("mermark: {e:?}");
                    std::process::exit(2);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running mermark");
}
```

- [ ] **Step 4: Remove the static window from config**

In `src-tauri/tauri.conf.json`, set `app.windows` to an empty array `[]` (windows are created at runtime in `setup`). Keep `app.security.csp` permissive enough for inline styles/SVG during dev (e.g. `null` in dev).

- [ ] **Step 5: Verify it compiles and opens a window for a real file**

```bash
echo "# Hello mermark" > /tmp/smoke.md
cd src-tauri && cargo build
cargo run -- /tmp/smoke.md
```
Expected: a window titled "mermark" opens (frontend still template — content wired in Task 3). Run with no arg → exits with `mermark: Missing` on stderr, code 2.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/
git commit -m "feat(core): read_file/open_path commands, open window per CLI invocation"
```

---

## Task 3: Frontend bootstrap — load file + mount read-only CM6

**Files:**
- Create: `src/editor.ts`
- Modify: `src/main.ts`, `index.html`

- [ ] **Step 1: Editor factory**

Create `src/editor.ts`:

```ts
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";

export function mountEditor(parent: HTMLElement, doc: string): EditorView {
  const state = EditorState.create({
    doc,
    extensions: [
      markdown(),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.lineWrapping,
    ],
  });
  return new EditorView({ state, parent });
}
```

- [ ] **Step 2: Bootstrap main.ts**

Replace `src/main.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import { mountEditor } from "./editor";
import "./styles.css";

async function boot() {
  const root = document.querySelector<HTMLDivElement>("#app")!;
  const file = new URLSearchParams(location.search).get("file");
  if (!file) {
    root.textContent = "No file specified.";
    return;
  }
  try {
    const text = await invoke<string>("read_file", { path: file });
    root.innerHTML = "";
    mountEditor(root, text);
  } catch (e) {
    root.textContent = `Failed to open: ${String(e)}`;
  }
}

boot();
```

- [ ] **Step 3: Ensure index.html has the mount node**

In `index.html`, the body must contain `<div id="app"></div>` and `<script type="module" src="/src/main.ts"></script>`. Create `src/styles.css` as an empty file for now.

- [ ] **Step 4: Verify content renders**

Run: `npm run tauri dev` then in a second terminal `cd src-tauri && cargo run -- /tmp/smoke.md` (or just launch via `cargo run` against the dev server per Tauri docs).
Expected: the window shows `# Hello mermark` as editable-looking but read-only text in CM6 (no styling yet). Selecting text works; typing does nothing.

- [ ] **Step 5: Commit**

```bash
git add src/ index.html
git commit -m "feat(frontend): load file via read_file and mount read-only CM6"
```

---

## Task 4: Inline mark decorations (hide markers, style bold/italic/link/code)

**Files:**
- Create: `src/markdown/inline.ts`
- Modify: `src/editor.ts`

- [ ] **Step 1: Inline decoration plugin**

Create `src/markdown/inline.ts`. It walks the Lezer markdown tree and (a) styles content nodes, (b) hides the syntax-marker nodes (`**`, `_`, `` ` ``).

```ts
import { syntaxTree } from "@codemirror/language";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

const STYLE: Record<string, string> = {
  StrongEmphasis: "cm-strong",
  Emphasis: "cm-em",
  InlineCode: "cm-inline-code",
  Strikethrough: "cm-strike",
};
// Marker node names produced by lang-markdown / GFM.
const MARKERS = new Set([
  "EmphasisMark",
  "CodeMark",
  "StrikethroughMark",
  "HeaderMark",
  "QuoteMark",
  "LinkMark",
]);

const hide = Decoration.replace({});

// RangeSetBuilder requires ranges in ascending `from` order, so collect → sort → build.
function build(view: EditorView): DecorationSet {
  const ranges: { from: number; to: number; deco: Decoration }[] = [];
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const cls = STYLE[node.name];
        if (cls) ranges.push({ from: node.from, to: node.to, deco: Decoration.mark({ class: cls }) });
        if (MARKERS.has(node.name) && node.to > node.from)
          ranges.push({ from: node.from, to: node.to, deco: hide });
      },
    });
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) builder.add(r.from, r.to, r.deco);
  return builder.finish();
}

export const inlineDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
```

- [ ] **Step 2: Add to editor**

In `src/editor.ts`, import and add `inlineDecorations` to the `extensions` array:

```ts
import { inlineDecorations } from "./markdown/inline";
// ...extensions: [ markdown(), inlineDecorations, EditorState.readOnly.of(true), ... ]
```

- [ ] **Step 3: Add CSS**

In `src/styles.css`:

```css
.cm-strong { font-weight: 700; }
.cm-em { font-style: italic; }
.cm-strike { text-decoration: line-through; }
.cm-inline-code { font-family: ui-monospace, monospace; padding: 0 .25em; border-radius: 4px; background: rgba(127,127,127,.18); }
```

- [ ] **Step 4: Verify**

Create `/tmp/inline.md` with `**bold** _italic_ ~~strike~~ \`code\``. Run dev, open it.
Expected: markers (`**`, `_`, `~~`, backticks) are hidden; the words are styled accordingly.

- [ ] **Step 5: Commit**

```bash
git add src/markdown/inline.ts src/editor.ts src/styles.css
git commit -m "feat(render): inline mark decorations, hide markdown syntax markers"
```

---

## Task 5: Custom block parsing — callouts, wikilinks, footnotes

**Files:**
- Create: `src/markdown/parser.ts`, `tests/parser.test.ts`
- Modify: `src/editor.ts`

This task adds the parser config: GFM + the wikilink inline parser. Callouts and footnotes are detected at decoration time (Tasks 9–10) from line text, so here we only add the wikilink Lezer extension and a tested pure helper.

- [ ] **Step 1: Write failing test for the wikilink token scanner**

Create `tests/parser.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { scanWikilinks } from "../src/markdown/parser";

describe("scanWikilinks", () => {
  it("finds a single wikilink with start/end offsets and target", () => {
    const line = "see [[notes/foo]] now";
    expect(scanWikilinks(line, 0)).toEqual([{ from: 4, to: 17, target: "notes/foo", alias: "notes/foo" }]);
  });
  it("supports alias syntax [[target|alias]]", () => {
    const r = scanWikilinks("[[a/b|Bee]]", 0);
    expect(r[0]).toMatchObject({ target: "a/b", alias: "Bee" });
  });
  it("returns [] when none", () => {
    expect(scanWikilinks("no links here", 0)).toEqual([]);
  });
  it("applies a base offset to absolute positions", () => {
    const r = scanWikilinks("[[x]]", 100);
    expect(r[0].from).toBe(100);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test -- parser`
Expected: FAIL — `scanWikilinks` not exported.

- [ ] **Step 3: Implement parser.ts**

Create `src/markdown/parser.ts`:

```ts
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";

export interface WikilinkHit {
  from: number;
  to: number;
  target: string;
  alias: string;
}

const RE = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g;

/** Find all [[wikilink]] spans in one line. Offsets are absolute (line start + base). */
export function scanWikilinks(line: string, base: number): WikilinkHit[] {
  const out: WikilinkHit[] = [];
  RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(line))) {
    const target = m[1].trim();
    out.push({
      from: base + m.index,
      to: base + m.index + m[0].length,
      target,
      alias: (m[2] ?? target).trim(),
    });
  }
  return out;
}

/** The markdown language config used by the editor (GFM tables/strikethrough/tasklists). */
export function markdownLang() {
  return markdown({ extensions: [GFM] });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- parser`
Expected: PASS — 4 tests.

- [ ] **Step 5: Switch editor to GFM markdown**

In `src/editor.ts`, replace `markdown()` with `markdownLang()` imported from `./markdown/parser`.

- [ ] **Step 6: Commit**

```bash
git add src/markdown/parser.ts tests/parser.test.ts src/editor.ts
git commit -m "feat(parse): GFM markdown + tested wikilink scanner"
```

---

## Task 6: Code-fence syntax highlighting widget

**Files:**
- Create: `src/markdown/codeblock.ts`
- Modify: `src/editor.ts`

Non-mermaid fenced code blocks get highlighted via CM6's default highlight style. lang-markdown already nests common languages; here we ensure fences render in a styled block and exclude `mermaid`/`math` fences (handled later).

- [ ] **Step 1: Block-style decoration for fenced code**

Create `src/markdown/codeblock.ts`:

```ts
import { syntaxTree } from "@codemirror/language";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

const blockLine = Decoration.line({ class: "cm-code-block" });

function infoString(view: EditorView, fenceFrom: number): string {
  const line = view.state.doc.lineAt(fenceFrom);
  return line.text.replace(/^\s*`{3,}\s*/, "").trim().toLowerCase();
}

function build(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "FencedCode") return;
        const lang = infoString(view, node.from);
        if (lang === "mermaid" || lang === "math") return; // handled by widgets
        let pos = node.from;
        while (pos <= node.to) {
          const line = view.state.doc.lineAt(pos);
          b.add(line.from, line.from, blockLine);
          if (line.to >= node.to) break;
          pos = line.to + 1;
        }
      },
    });
  }
  return b.finish();
}

export const codeBlocks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(v: EditorView) { this.decorations = build(v); }
    update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.decorations = build(u.view); }
  },
  { decorations: (v) => v.decorations },
);
```

- [ ] **Step 2: Add to editor + CSS**

In `src/editor.ts` add `codeBlocks` to extensions. In `src/styles.css`:

```css
.cm-code-block { background: rgba(127,127,127,.10); font-family: ui-monospace, monospace; }
```

- [ ] **Step 3: Verify**

Open a file with a ```js fenced block. Expected: the block lines get the shaded monospace background; lang-markdown highlights JS tokens.

- [ ] **Step 4: Commit**

```bash
git add src/markdown/codeblock.ts src/editor.ts src/styles.css
git commit -m "feat(render): styled fenced code blocks (excluding mermaid/math)"
```

---

## Task 7: Mermaid block widget

**Files:**
- Create: `src/markdown/mermaid-widget.ts`
- Modify: `src/editor.ts`

- [ ] **Step 1: Mermaid replace-widget**

Create `src/markdown/mermaid-widget.ts`:

```ts
import { syntaxTree } from "@codemirror/language";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import mermaid from "mermaid";

mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });

let idSeq = 0;

class MermaidWidget extends WidgetType {
  constructor(readonly code: string) { super(); }
  eq(o: MermaidWidget) { return o.code === this.code; }
  toDOM(): HTMLElement {
    const host = document.createElement("div");
    host.className = "cm-mermaid";
    const id = `mmd-${idSeq++}`;
    mermaid
      .render(id, this.code)
      .then(({ svg, bindFunctions }) => {
        host.innerHTML = svg;
        bindFunctions?.(host);
        host.dispatchEvent(new CustomEvent("mermaid-rendered", { bubbles: true }));
      })
      .catch((err) => {
        host.innerHTML = "";
        const pre = document.createElement("pre");
        pre.className = "cm-mermaid-error";
        pre.textContent = `Mermaid error: ${err?.message ?? err}\n\n${this.code}`;
        host.appendChild(pre);
      });
    return host;
  }
  ignoreEvent() { return true; }
}

/** Extract the inner code of a FencedCode node, dropping the ``` fences. */
function fenceBody(view: EditorView, from: number, to: number): string {
  const first = view.state.doc.lineAt(from);
  const last = view.state.doc.lineAt(to);
  const startLine = first.number + 1;
  const endLine = last.text.trim().startsWith("```") ? last.number - 1 : last.number;
  if (endLine < startLine) return "";
  return view.state.doc.sliceString(view.state.doc.line(startLine).from, view.state.doc.line(endLine).to);
}

function infoLang(view: EditorView, from: number): string {
  return view.state.doc.lineAt(from).text.replace(/^\s*`{3,}\s*/, "").trim().toLowerCase();
}

function build(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "FencedCode" || infoLang(view, node.from) !== "mermaid") return;
        const code = fenceBody(view, node.from, node.to);
        b.add(node.from, node.to, Decoration.replace({ widget: new MermaidWidget(code), block: true }));
      },
    });
  }
  return b.finish();
}

export const mermaidBlocks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(v: EditorView) { this.decorations = build(v); }
    update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.decorations = build(u.view); }
  },
  { decorations: (v) => v.decorations },
);
```

- [ ] **Step 2: Add to editor (before codeBlocks so mermaid wins) + CSS**

In `src/editor.ts` add `mermaidBlocks` to extensions. In `src/styles.css`:

```css
.cm-mermaid { display: block; margin: 1em 0; overflow: hidden; border: 1px solid rgba(127,127,127,.25); border-radius: 8px; }
.cm-mermaid svg { display: block; width: 100%; height: auto; }
.cm-mermaid-error { color: #ff6b6b; white-space: pre-wrap; padding: .75em; }
```

- [ ] **Step 3: Verify**

Open a file with a ```mermaid block (e.g. `graph TD; A-->B;`). Expected: a rendered diagram replaces the fence. A broken diagram shows the red error + raw code.

- [ ] **Step 4: Commit**

```bash
git add src/markdown/mermaid-widget.ts src/editor.ts src/styles.css
git commit -m "feat(render): mermaid fenced-block widget with error fallback"
```

---

## Task 8: Mermaid zoom/pan

**Files:**
- Modify: `src/markdown/mermaid-widget.ts`, `src/styles.css`

- [ ] **Step 1: Wire svg-pan-zoom into the widget**

In `src/markdown/mermaid-widget.ts`, import at top:

```ts
import svgPanZoom from "svg-pan-zoom";
```

Replace the `.then(...)` success body in `toDOM` with:

```ts
      .then(({ svg, bindFunctions }) => {
        host.innerHTML = svg;
        bindFunctions?.(host);
        const el = host.querySelector("svg");
        if (!el) return;
        el.removeAttribute("height");
        el.style.width = "100%";
        const pz = svgPanZoom(el, {
          panEnabled: true,
          zoomEnabled: true,
          mouseWheelZoomEnabled: false, // we gate wheel on Ctrl/Cmd manually
          dblClickZoomEnabled: false,
          fit: true,
          center: true,
        });
        let zoomed = false;
        host.addEventListener("dblclick", (e) => {
          e.preventDefault();
          if (zoomed) { pz.reset(); zoomed = false; } else { pz.zoomBy(2); zoomed = true; }
        });
        host.addEventListener(
          "wheel",
          (e) => {
            if (!(e.ctrlKey || e.metaKey)) return; // plain wheel = page scroll
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            pz.zoomAtPointBy(e.deltaY < 0 ? 1.15 : 0.87, point);
          },
          { passive: false },
        );
      })
```

- [ ] **Step 2: CSS for grab cursor**

In `src/styles.css`:

```css
.cm-mermaid svg { cursor: grab; }
.cm-mermaid svg:active { cursor: grabbing; }
```

- [ ] **Step 3: Verify**

Open the mermaid sample. Expected:
- Click-drag pans.
- Ctrl/Cmd + wheel zooms toward the cursor; plain wheel scrolls the page.
- Double-click toggles between fit and 2× zoom.

- [ ] **Step 4: Commit**

```bash
git add src/markdown/mermaid-widget.ts src/styles.css
git commit -m "feat(mermaid): svg-pan-zoom — drag pan, Ctrl/Cmd-wheel zoom, dblclick toggle"
```

---

## Task 9: KaTeX math widgets (inline + block)

**Files:**
- Create: `src/markdown/math-widget.ts`
- Modify: `src/editor.ts`, `index.html`

- [ ] **Step 1: Load KaTeX CSS**

In `index.html` `<head>`:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" />
```

(Or import the bundled `katex/dist/katex.min.css` in `styles.css` to stay offline — preferred for a desktop app: add `@import "katex/dist/katex.min.css";` at the top of `styles.css`.)

- [ ] **Step 2: Math decorations**

Create `src/markdown/math-widget.ts`. Block math: lines `$$...$$`. Inline math: `$...$` within a line.

```ts
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import katex from "katex";

class KatexWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean) { super(); }
  eq(o: KatexWidget) { return o.tex === this.tex && o.display === this.display; }
  toDOM() {
    const span = document.createElement(this.display ? "div" : "span");
    span.className = this.display ? "cm-math-block" : "cm-math-inline";
    try {
      katex.render(this.tex, span, { displayMode: this.display, throwOnError: false });
    } catch (e) {
      span.textContent = `$${this.tex}$`;
    }
    return span;
  }
  ignoreEvent() { return true; }
}

const BLOCK = /\$\$([\s\S]+?)\$\$/g;
const INLINE = /(?<!\$)\$([^$\n]+?)\$(?!\$)/g;

function build(view: EditorView): DecorationSet {
  const ranges: { from: number; to: number; deco: Decoration }[] = [];
  const text = view.state.doc.toString();
  let m: RegExpExecArray | null;
  BLOCK.lastIndex = 0;
  const blockSpans: [number, number][] = [];
  while ((m = BLOCK.exec(text))) {
    blockSpans.push([m.index, m.index + m[0].length]);
    ranges.push({ from: m.index, to: m.index + m[0].length, deco: Decoration.replace({ widget: new KatexWidget(m[1].trim(), true), block: true }) });
  }
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(text))) {
    const start = m.index;
    if (blockSpans.some(([a, b]) => start >= a && start < b)) continue; // inside a block-math span
    ranges.push({ from: start, to: start + m[0].length, deco: Decoration.replace({ widget: new KatexWidget(m[1].trim(), false) }) });
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const b = new RangeSetBuilder<Decoration>();
  for (const r of ranges) b.add(r.from, r.to, r.deco);
  return b.finish();
}

export const mathBlocks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(v: EditorView) { this.decorations = build(v); }
    update(u: ViewUpdate) { if (u.docChanged) this.decorations = build(u.view); }
  },
  { decorations: (v) => v.decorations },
);
```

- [ ] **Step 3: Add to editor**

In `src/editor.ts` add `mathBlocks` to extensions.

- [ ] **Step 4: Verify**

Open a file with `$e=mc^2$` inline and a `$$\int_0^1 x\,dx$$` block. Expected: both render as math.

- [ ] **Step 5: Commit**

```bash
git add src/markdown/math-widget.ts src/editor.ts index.html src/styles.css
git commit -m "feat(render): KaTeX inline and block math"
```

---

## Task 10: Callout boxes (`> [!note]`)

**Files:**
- Create: `src/markdown/callout-widget.ts`
- Modify: `src/editor.ts`, `src/styles.css`

- [ ] **Step 1: Callout line decorations**

Create `src/markdown/callout-widget.ts`. Detect blockquotes whose first line matches `> [!type] optional title`, tag those lines with a class and a `data-callout` type.

```ts
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

const HEAD = /^>\s*\[!(\w+)\]\s*(.*)$/;

function build(view: EditorView): DecorationSet {
  const ranges: { from: number; to: number; deco: Decoration }[] = [];
  const doc = view.state.doc;
  let n = 1;
  while (n <= doc.lines) {
    const line = doc.line(n);
    const h = HEAD.exec(line.text);
    if (h) {
      const type = h[1].toLowerCase();
      ranges.push({ from: line.from, to: line.from, deco: Decoration.line({ class: `cm-callout cm-callout-${type} cm-callout-head`, attributes: { "data-callout": type } }) });
      // following blockquote lines belong to the same callout
      let k = n + 1;
      while (k <= doc.lines && doc.line(k).text.startsWith(">")) {
        ranges.push({ from: doc.line(k).from, to: doc.line(k).from, deco: Decoration.line({ class: `cm-callout cm-callout-${type}` }) });
        k++;
      }
      n = k;
    } else {
      n++;
    }
  }
  ranges.sort((a, b) => a.from - b.from);
  const b = new RangeSetBuilder<Decoration>();
  for (const r of ranges) b.add(r.from, r.to, r.deco);
  return b.finish();
}

export const callouts = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(v: EditorView) { this.decorations = build(v); }
    update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.decorations = build(u.view); }
  },
  { decorations: (v) => v.decorations },
);
```

- [ ] **Step 2: Add to editor + CSS**

In `src/editor.ts` add `callouts`. In `src/styles.css`:

```css
.cm-callout { background: rgba(80,130,255,.10); border-left: 3px solid #5082ff; padding-left: .75em; }
.cm-callout-head { font-weight: 700; }
.cm-callout-warning { background: rgba(255,180,0,.12); border-left-color: #ffb400; }
.cm-callout-danger { background: rgba(255,80,80,.12); border-left-color: #ff5050; }
```

- [ ] **Step 3: Verify**

Open a file with:
```
> [!note] Heads up
> body line
```
Expected: the block renders as a tinted callout box; warning/danger types get their colors.

- [ ] **Step 4: Commit**

```bash
git add src/markdown/callout-widget.ts src/editor.ts src/styles.css
git commit -m "feat(render): callout boxes for > [!type] blockquotes"
```

---

## Task 11: Footnotes

**Files:**
- Create: `src/markdown/footnote.ts`
- Modify: `src/editor.ts`, `src/styles.css`

Render `[^id]` references as superscripts and style the `[^id]: text` definition lines. No navigation in MVP — visual only.

- [ ] **Step 1: Footnote decorations**

Create `src/markdown/footnote.ts`:

```ts
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

class SupWidget extends WidgetType {
  constructor(readonly label: string) { super(); }
  eq(o: SupWidget) { return o.label === this.label; }
  toDOM() {
    const s = document.createElement("sup");
    s.className = "cm-footnote-ref";
    s.textContent = this.label;
    return s;
  }
}

const DEF = /^\[\^([^\]]+)\]:\s/;
const REF = /\[\^([^\]]+)\]/g;

function build(view: EditorView): DecorationSet {
  const ranges: { from: number; to: number; deco: Decoration }[] = [];
  const doc = view.state.doc;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (DEF.test(line.text)) {
      ranges.push({ from: line.from, to: line.from, deco: Decoration.line({ class: "cm-footnote-def" }) });
      continue; // don't turn the def's own [^id] into a sup
    }
    let m: RegExpExecArray | null;
    REF.lastIndex = 0;
    while ((m = REF.exec(line.text))) {
      const from = line.from + m.index;
      ranges.push({ from, to: from + m[0].length, deco: Decoration.replace({ widget: new SupWidget(m[1]) }) });
    }
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const b = new RangeSetBuilder<Decoration>();
  for (const r of ranges) b.add(r.from, r.to, r.deco);
  return b.finish();
}

export const footnotes = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(v: EditorView) { this.decorations = build(v); }
    update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.decorations = build(u.view); }
  },
  { decorations: (v) => v.decorations },
);
```

- [ ] **Step 2: Add to editor + CSS**

Add `footnotes` to extensions. In `src/styles.css`:

```css
.cm-footnote-ref { color: #5082ff; cursor: default; }
.cm-footnote-def { font-size: .9em; opacity: .8; }
```

- [ ] **Step 3: Verify**

Open a file with `Text[^1]` and a line `[^1]: the note`. Expected: `[^1]` becomes a small superscript `1`; the definition line is dimmed.

- [ ] **Step 4: Commit**

```bash
git add src/markdown/footnote.ts src/editor.ts src/styles.css
git commit -m "feat(render): footnote refs as superscripts + dimmed definitions"
```

---

## Task 12: Local images via Tauri asset protocol

**Files:**
- Create: `src/markdown/image.ts`, `tests/image.test.ts`
- Modify: `src/editor.ts`, `src/main.ts`, `src-tauri/tauri.conf.json`

- [ ] **Step 1: Failing test for src resolution**

Create `tests/image.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveImageSrc } from "../src/markdown/image";

describe("resolveImageSrc", () => {
  const baseDir = "/home/u/notes";
  it("leaves absolute http(s) urls untouched", () => {
    expect(resolveImageSrc("https://x.com/a.png", baseDir)).toBe("https://x.com/a.png");
  });
  it("joins a relative path onto the base dir", () => {
    expect(resolveImageSrc("img/a.png", baseDir)).toBe("/home/u/notes/img/a.png");
  });
  it("keeps an absolute filesystem path as-is", () => {
    expect(resolveImageSrc("/abs/a.png", baseDir)).toBe("/abs/a.png");
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test -- image`
Expected: FAIL — `resolveImageSrc` not exported.

- [ ] **Step 3: Implement image.ts**

Create `src/markdown/image.ts`:

```ts
import { syntaxTree } from "@codemirror/language";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { convertFileSrc } from "@tauri-apps/api/core";

/** Resolve a markdown image target to an absolute filesystem path (or pass through URLs). */
export function resolveImageSrc(src: string, baseDir: string): string {
  if (/^https?:\/\//i.test(src) || src.startsWith("data:")) return src;
  if (src.startsWith("/")) return src;
  return `${baseDir.replace(/\/$/, "")}/${src}`;
}

class ImageWidget extends WidgetType {
  constructor(readonly url: string, readonly alt: string) { super(); }
  eq(o: ImageWidget) { return o.url === this.url; }
  toDOM() {
    const img = document.createElement("img");
    img.className = "cm-image";
    img.alt = this.alt;
    img.src = this.url;
    return img;
  }
  ignoreEvent() { return true; }
}

const IMG = /!\[([^\]]*)\]\(([^)]+)\)/g;

export function imagePlugin(baseDir: string) {
  function build(view: EditorView): DecorationSet {
    const ranges: { from: number; to: number; deco: Decoration }[] = [];
    const doc = view.state.doc;
    for (let n = 1; n <= doc.lines; n++) {
      const line = doc.line(n);
      let m: RegExpExecArray | null;
      IMG.lastIndex = 0;
      while ((m = IMG.exec(line.text))) {
        const abs = resolveImageSrc(m[2].trim(), baseDir);
        const url = /^https?:|^data:/i.test(abs) ? abs : convertFileSrc(abs);
        const from = line.from + m.index;
        ranges.push({ from, to: from + m[0].length, deco: Decoration.replace({ widget: new ImageWidget(url, m[1]) }) });
      }
    }
    ranges.sort((a, b) => a.from - b.from || a.to - b.to);
    const b = new RangeSetBuilder<Decoration>();
    for (const r of ranges) b.add(r.from, r.to, r.deco);
    return b.finish();
  }
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(v: EditorView) { this.decorations = build(v); }
      update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.decorations = build(u.view); }
    },
    { decorations: (v) => v.decorations },
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- image`
Expected: PASS — 3 tests. (`convertFileSrc` is not exercised by the pure tests.)

- [ ] **Step 5: Thread baseDir through editor + enable asset protocol**

In `src/editor.ts`, change `mountEditor(parent, doc)` to `mountEditor(parent, doc, baseDir: string)` and add `imagePlugin(baseDir)` to extensions. In `src/main.ts`, compute `baseDir` from the file path (`file.slice(0, Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")))`) and pass it. In `src-tauri/tauri.conf.json`, enable the asset protocol and scope it:

```json
"app": {
  "security": {
    "assetProtocol": { "enable": true, "scope": ["**"] }
  }
}
```

(Scope `**` is acceptable for a local single-user viewer; tighten to the opened file's directory later if desired.)

- [ ] **Step 6: Verify**

Open a markdown file next to an image, referencing `![alt](pic.png)`. Expected: the image renders. An `https://` image also renders.

- [ ] **Step 7: Commit**

```bash
git add src/markdown/image.ts tests/image.test.ts src/editor.ts src/main.ts src-tauri/tauri.conf.json
git commit -m "feat(render): local + remote images via asset protocol"
```

---

## Task 13: Wikilink rendering + click-to-open

**Files:**
- Create: `src/markdown/wikilink.ts`, add cases to `tests/wikilink.test.ts`
- Modify: `src/editor.ts`

- [ ] **Step 1: Failing test for target path resolution**

Create `tests/wikilink.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { wikilinkPath } from "../src/markdown/wikilink";

describe("wikilinkPath", () => {
  const baseDir = "/home/u/notes";
  it("appends .md when no extension", () => {
    expect(wikilinkPath("foo", baseDir)).toBe("/home/u/notes/foo.md");
  });
  it("keeps an explicit extension", () => {
    expect(wikilinkPath("foo.md", baseDir)).toBe("/home/u/notes/foo.md");
  });
  it("resolves nested targets", () => {
    expect(wikilinkPath("sub/bar", baseDir)).toBe("/home/u/notes/sub/bar.md");
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test -- wikilink`
Expected: FAIL — `wikilinkPath` not exported.

- [ ] **Step 3: Implement wikilink.ts**

Create `src/markdown/wikilink.ts`. Uses the tested `scanWikilinks` from `parser.ts`. Resolves a target to a path, checks existence via a Tauri command, renders existing links active (click → `open_path` new window) and missing links as disabled.

```ts
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { invoke } from "@tauri-apps/api/core";
import { scanWikilinks } from "./parser";

/** Resolve a wikilink target to an absolute .md path under baseDir. */
export function wikilinkPath(target: string, baseDir: string): string {
  const withExt = /\.[a-z0-9]+$/i.test(target) ? target : `${target}.md`;
  return `${baseDir.replace(/\/$/, "")}/${withExt}`;
}

class WikilinkWidget extends WidgetType {
  constructor(readonly alias: string, readonly path: string, readonly baseDir: string) { super(); }
  eq(o: WikilinkWidget) { return o.path === this.path && o.alias === this.alias; }
  toDOM() {
    const a = document.createElement("a");
    a.className = "cm-wikilink cm-wikilink-pending";
    a.textContent = this.alias;
    // existence check; toggle active/missing
    invoke<boolean>("path_exists", { path: this.path }).then((exists) => {
      a.classList.remove("cm-wikilink-pending");
      a.classList.add(exists ? "cm-wikilink-active" : "cm-wikilink-missing");
      if (exists) {
        a.addEventListener("click", (e) => {
          e.preventDefault();
          invoke("open_path", { path: this.path });
        });
      }
    });
    return a;
  }
  ignoreEvent() { return true; }
}

export function wikilinkPlugin(baseDir: string) {
  function build(view: EditorView): DecorationSet {
    const ranges: { from: number; to: number; deco: Decoration }[] = [];
    const doc = view.state.doc;
    for (let n = 1; n <= doc.lines; n++) {
      const line = doc.line(n);
      for (const hit of scanWikilinks(line.text, line.from)) {
        const path = wikilinkPath(hit.target, baseDir);
        ranges.push({ from: hit.from, to: hit.to, deco: Decoration.replace({ widget: new WikilinkWidget(hit.alias, path, baseDir) }) });
      }
    }
    ranges.sort((a, b) => a.from - b.from || a.to - b.to);
    const b = new RangeSetBuilder<Decoration>();
    for (const r of ranges) b.add(r.from, r.to, r.deco);
    return b.finish();
  }
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(v: EditorView) { this.decorations = build(v); }
      update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.decorations = build(u.view); }
    },
    { decorations: (v) => v.decorations },
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- wikilink`
Expected: PASS — 3 tests.

- [ ] **Step 5: Add the path_exists command**

In `src-tauri/src/commands.rs` add:

```rust
#[tauri::command]
pub fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).is_file()
}
```

Register it in `main.rs` `generate_handler![...]` alongside the others.

- [ ] **Step 6: Add plugin to editor + CSS**

In `src/editor.ts` add `wikilinkPlugin(baseDir)` to extensions. In `src/styles.css`:

```css
.cm-wikilink-active { color: #5082ff; cursor: pointer; text-decoration: none; }
.cm-wikilink-active:hover { text-decoration: underline; }
.cm-wikilink-missing { color: #999; text-decoration: line-through dotted; cursor: default; }
.cm-wikilink-pending { color: #777; }
```

- [ ] **Step 7: Verify**

In a folder with `a.md` containing `[[b]]` and a sibling `b.md`: open `a.md`. Expected: `[[b]]` renders as a blue link; clicking opens `b.md` in a new window. `[[nope]]` renders struck-through grey, not clickable.

- [ ] **Step 8: Commit**

```bash
git add src/markdown/wikilink.ts tests/wikilink.test.ts src/editor.ts src-tauri/src/commands.rs src-tauri/src/main.rs src/styles.css
git commit -m "feat(render): wikilinks — active when target exists, open in new window"
```

---

## Task 14: Theme — OS follow + toggle, DESIGN.md tokens

**Files:**
- Create: `src/theme.ts`
- Modify: `src/main.ts`, `src/markdown/mermaid-widget.ts`, `src/styles.css`, `index.html`

- [ ] **Step 1: Pull DESIGN.md tokens**

Run:

```bash
npx getdesign@latest add elevenlabs
```

This writes a `DESIGN.md` (and possibly token files). Translate its color/spacing/typography values into CSS custom properties at the top of `src/styles.css`, e.g.:

```css
:root {
  --bg: #0a0a0b; --fg: #e8e8ea; --accent: #5082ff;
  --surface: rgba(255,255,255,.04); --border: rgba(255,255,255,.12);
  --font-sans: "Inter", system-ui, sans-serif;
}
:root[data-theme="light"] { --bg: #ffffff; --fg: #16161a; --surface: rgba(0,0,0,.04); --border: rgba(0,0,0,.12); }
body { background: var(--bg); color: var(--fg); font-family: var(--font-sans); margin: 0; }
```

Update earlier hard-coded colors (callout, code-block, wikilink) to reference these vars where reasonable.

- [ ] **Step 2: Theme controller**

Create `src/theme.ts`:

```ts
import mermaid from "mermaid";

export type Theme = "dark" | "light";

export function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: t === "light" ? "default" : "dark" });
}

/** Mount a toggle button; returns nothing. */
export function mountThemeToggle(initial: Theme) {
  const btn = document.createElement("button");
  btn.className = "theme-toggle";
  let cur = initial;
  const label = () => (btn.textContent = cur === "dark" ? "☾" : "☀");
  label();
  btn.addEventListener("click", () => {
    cur = cur === "dark" ? "light" : "dark";
    applyTheme(cur);
    label();
    // re-render is required for mermaid theme change; simplest is reload
    location.reload();
  });
  document.body.appendChild(btn);
}
```

- [ ] **Step 3: Initialize theme before mounting editor**

In `src/main.ts`, before reading the file:

```ts
import { systemTheme, applyTheme, mountThemeToggle } from "./theme";
const theme = systemTheme();
applyTheme(theme);
mountThemeToggle(theme);
```

Remove the `mermaid.initialize` call from `mermaid-widget.ts` (theme.ts now owns initialization) — keep the import and `mermaid.render` usage.

- [ ] **Step 4: Toggle CSS**

In `src/styles.css`:

```css
.theme-toggle { position: fixed; top: 8px; right: 8px; z-index: 10; background: var(--surface); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; width: 30px; height: 30px; cursor: pointer; }
```

- [ ] **Step 5: Verify**

Open any file. Expected: app respects OS dark/light at launch; clicking the toggle flips theme (page reloads, mermaid recolors).

- [ ] **Step 6: Commit**

```bash
git add src/theme.ts src/main.ts src/markdown/mermaid-widget.ts src/styles.css index.html DESIGN.md
git commit -m "feat(theme): OS-follow + toggle, ElevenLabs DESIGN.md tokens"
```

---

## Task 15: CLI install + cross-OS manual verification

**Files:**
- Create: `scripts/install-cli.sh`, `docs/sample.md`
- Modify: `README.md`

- [ ] **Step 1: Build a release binary**

```bash
npm run tauri build
```
Expected: a platform binary/bundle under `src-tauri/target/release/`.

- [ ] **Step 2: Install helper (macOS/Linux)**

Create `scripts/install-cli.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
BIN="$(pwd)/src-tauri/target/release/mermark"
DEST="${1:-/usr/local/bin/mermark}"
if [ ! -x "$BIN" ]; then echo "build first: npm run tauri build" >&2; exit 1; fi
ln -sf "$BIN" "$DEST"
echo "linked $DEST -> $BIN"
```

Make executable: `chmod +x scripts/install-cli.sh`. On Windows, document adding `src-tauri\target\release\` to PATH in the README.

- [ ] **Step 3: Comprehensive sample doc**

Create `docs/sample.md` exercising every feature: headings, **bold**/_italic_/~~strike~~/`code`, a GFM table, task list, a fenced JS block, a ```mermaid graph, inline `$x^2$` and block `$$...$$` math, a `> [!warning]` callout, a footnote `[^1]` + definition, a local `![img](sample.png)`, and a `[[sample]]` self-wikilink.

- [ ] **Step 4: Cross-OS manual verification matrix**

On each of macOS, Windows, Linux, run `mermark docs/sample.md` and confirm:

| Check | Pass? |
|---|---|
| Window opens, content renders | |
| Inline styles, markers hidden | |
| GFM table + task list render | |
| JS code block highlighted | |
| Mermaid renders; drag-pan; Ctrl/Cmd-wheel zoom; dblclick toggle | |
| Inline + block math render | |
| Callout box styled | |
| Footnote superscript + dimmed def | |
| Local + remote image render | |
| Wikilink active (existing) / struck (missing); click opens new window | |
| Theme follows OS; toggle works | |
| Second `mermark other.md` opens an independent window | |

Record results in the PR description.

- [ ] **Step 5: README**

Create/append `README.md` with: what mermark is, build (`npm install` + `npm run tauri build`), install (`./scripts/install-cli.sh` or PATH on Windows), usage (`mermark file.md`), and the deferred-features note (editing/autosave, folder mode, tabs).

- [ ] **Step 6: Commit**

```bash
git add scripts/install-cli.sh docs/sample.md README.md
git commit -m "feat(cli): install helper, sample doc, cross-OS verification matrix, README"
```

---

## Notes for the implementer

- **Decoration ordering:** CM6's `RangeSetBuilder` requires ranges added in ascending order. Every plugin here collects ranges into an array, sorts, then builds — keep that pattern when adding features.
- **Block widgets must not overlap** other decorations on the same range. Mermaid/math/image use `Decoration.replace` over their whole span; don't also run inline styling inside them (the plugins key off different node types/regexes, so they don't collide in practice — verify if you add more).
- **Read-only is load-bearing for MVP:** widgets call `ignoreEvent()`/`block: true`; once editing is added (phase 2), these need cursor-aware reveal logic — out of scope here.
- **Offline KaTeX/mermaid:** prefer bundled imports over CDN for a desktop app (see Task 9 Step 1 note).
