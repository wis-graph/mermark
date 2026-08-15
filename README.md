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
- **Wikilinks** `[[target]]` / `[[target|alias]]`: active (opens the target safely in the current window) when the file exists, struck-through when missing.
- **Local document links** `[label](./note.md)`: inside a permanent vault only, a relative `.md`/`.txt` link that stays inside that vault (after symlink resolution) opens safely in the current window; unlike wikilinks, a missing target is never auto-created. Anything else — absolute/drive/UNC paths, `..` escapes, unknown schemes, or no vault context — is rejected with a visible reason instead of opening or creating a file.
- **Vault image attachments** (`image.attach`): in a permanent vault, pick an image and it's copied atomically into `.attachments/` (no-clobber, never overwrites an existing file) and inserted as `![name](vault:.attachments/name.ext)`. `vault:` references resolve by exact path within that vault only — no basename search.
- **Theme**: follows the OS light/dark setting with a manual toggle; visual tokens from the ElevenLabs DESIGN.md.
- **Window routing**: an ordinary `mermark file.md` reuses your last-focused mermark window (or respawns `main` if none is open) — it does **not** spawn a new window. `mermark -` (stdin) and `mermark --right` always launch an independent process/window, and `⌘`/`Ctrl`+click (or `⌘Enter`) in the explorer/file-finder sidebars always forces a brand-new window.
- **Edit + autosave**: `⌘E` switches between reader and editor; edits debounce-save to the file. Writes are atomic (temp file + rename, never a half-written file), and if the file changed on disk since it was opened the save is held back with a **강제 저장** (overwrite) escape hatch — your buffer is never silently lost.

## Build

Requires Node + Rust (cargo) toolchains.

```bash
npm install
npm run tauri build
```

The binary lands at `src-tauri/target/release/mermark` (plus a platform bundle).

## Install the `mermark` command

**macOS / Linux** — install a wrapper script onto your PATH (a symlink would
break the in-app updater for CLI-launched instances):

```bash
./scripts/install-cli.sh            # installs /usr/local/bin/mermark
./scripts/install-cli.sh ~/bin/mermark   # or a custom destination
```

**Windows** — add `src-tauri\target\release\` to your `PATH`, then `mermark file.md`.

## Usage

```bash
mermark path/to/file.md
```

Running with no file opens a window on the welcome pane. A second `mermark file.md`
invocation is routed to your last-focused mermark window rather than opening a new one
(see "Window routing" above); `mermark -` and `mermark --right` are the exceptions and
always open independently. Wikilinks open their target in the current window. Relative
image and wikilink paths resolve against the opened file's directory.

### Development

`tauri dev` runs the binary with no argument (so it prints usage and exits). Pass a file
after `--`:

```bash
npm run tauri dev -- path/to/note.md
```

In browser mode (`npm run dev:browser`) the Tauri backend is mocked and a built-in
fixture document (`SAMPLE` in `src/mocks/tauri-core.ts`) is loaded instead — that
fixture is what the CDP golden scripts measure, and it exercises every renderer.

## Scope

A focused editor, not a general file manager. Opening a new document from the CLI, a
wikilink, a local document link, or the sidebar all land in your current mermark window
by default (see "Window routing" above) — an explicit gesture (⌘/Ctrl+click, `⌘Enter`,
`mermark -`, `mermark --right`) is what gets you a second window. The renderer is a
CodeMirror 6 foundation; the Obsidian-style live preview is layered on top of it. See
`docs/superpowers/specs/2026-06-10-mermark-design.md` and `docs/FEATURES.md`.

## Tests

```bash
npm test        # vitest: pure resolvers + a full-editor render smoke test
```

The smoke test mounts the whole editor on a feature-rich document and asserts it renders
without throwing — it guards against CodeMirror decoration regressions (e.g. block
decorations must come from a StateField, not a ViewPlugin).
