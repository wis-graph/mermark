# mermark

A lightweight, cross-platform desktop **Markdown + Mermaid editor**, launched from the
command line to open a single file. Obsidian-style live preview, fast, built on
Tauri 2 + CodeMirror 6. Opens in reader mode; `⌘E` toggles editing with debounced
autosave straight back to the file.

```
mermark notes.md
```

## Features

- **Markdown** rendered inline (CodeMirror 6 decorations, Obsidian Live-Preview style): bold/italic/strikethrough/inline-code with hidden syntax markers.
- **GFM**: tables (rendered as HTML grids), task-list checkboxes, strikethrough, fenced code with syntax highlighting.
- **Mermaid** diagrams with **zoom & pan**: double-click toggles zoom, `Ctrl`/`Cmd`+wheel zooms toward the cursor, click-drag pans. Syntax errors fall back to the raw source.
- **Math** via KaTeX: inline `$…$` and block `$$…$$`. `$` inside code blocks is left alone.
- **Callouts** (`> [!note]` / `[!warning]` / `[!danger]`) as tinted boxes.
- **Footnotes** rendered as superscripts with dimmed definitions.
- **Images**: local (via the Tauri asset protocol, resolved relative to the file) and remote.
- **Wikilinks** `[[target]]` / `[[target|alias]]`: active (opens the target in a new window) when the file exists, struck-through when missing.
- **Theme**: follows the OS light/dark setting with a manual toggle; visual tokens from the ElevenLabs DESIGN.md.
- One independent **window per invocation** — run `mermark a.md` then `mermark b.md` for two windows.
- **Edit + autosave**: `⌘E` switches between reader and editor; edits debounce-save to the file. Writes are atomic (temp file + rename, never a half-written file), and if the file changed on disk since it was opened the save is held back with a **강제 저장** (overwrite) escape hatch — your buffer is never silently lost.

## Build

Requires Node + Rust (cargo) toolchains.

```bash
npm install
npm run tauri build
```

The binary lands at `src-tauri/target/release/mermark` (plus a platform bundle).

## Install the `mermark` command

**macOS / Linux** — symlink the binary onto your PATH:

```bash
./scripts/install-cli.sh            # links to /usr/local/bin/mermark
./scripts/install-cli.sh ~/bin/mermark   # or a custom destination
```

**Windows** — add `src-tauri\target\release\` to your `PATH`, then `mermark file.md`.

## Usage

```bash
mermark path/to/file.md
```

Running with no file prints usage and exits with code 2. Wikilinks open their target
in a new window. Relative image and wikilink paths resolve against the opened file's
directory.

### Development

`tauri dev` runs the binary with no argument (so it prints usage and exits). Pass a file
after `--`:

```bash
npm run tauri dev -- docs/sample.md
```

`docs/sample.md` exercises every renderer.

## Scope

A focused single-file editor. Editing and autosave are in; a folder/vault sidebar, tabs,
and multi-file search are intentionally out of scope — **multiple documents = multiple
windows**. The renderer is a CodeMirror 6 foundation; the Obsidian-style live preview is
layered on top of it. See `docs/superpowers/specs/2026-06-10-mermark-design.md`.

## Tests

```bash
npm test        # vitest: pure resolvers + a full-editor render smoke test
```

The smoke test mounts the whole editor on a feature-rich document and asserts it renders
without throwing — it guards against CodeMirror decoration regressions (e.g. block
decorations must come from a StateField, not a ViewPlugin).
