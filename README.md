# mermark

**[한국어 README](./README.ko.md)**

A fast desktop reader and editor for local documents — Markdown with Obsidian-style
live preview, Mermaid diagrams and math, plus built-in viewers for PDF, EPUB, Office
files, HWP and SQLite. Built on Tauri 2 + CodeMirror 6, so it starts cold in well under
a second and keeps your files as plain files on disk.

Opens in reader mode; `⌘E` switches to editing with debounced autosave straight back to
the file.

```bash
mermark notes.md
```

---

## Install

Download the latest build from **[Releases](https://github.com/wis-graph/mermark/releases/latest)**:

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `mermark_<version>_aarch64.dmg` — signed and notarized |
| Windows (x64) | `mermark_<version>_x64-setup.exe` |

The app updates itself: it checks quietly on launch, and when a new version is found an
update button appears in the status bar. Downloads install and relaunch automatically —
pending edits are committed to disk first, and if that fails the relaunch is held back
rather than losing your buffer.

### The `mermark` command

**macOS / Linux** — install a wrapper script onto your PATH (a symlink breaks the
in-app updater for CLI-launched instances):

```bash
./scripts/install-cli.sh                 # installs /usr/local/bin/mermark
./scripts/install-cli.sh ~/bin/mermark   # or a custom destination
```

**Windows** — add `src-tauri\target\release\` to your `PATH`, then `mermark file.md`.

---

## What it does

### Markdown, rendered as you type

- **Live preview** in the CodeMirror 6 editor: bold, italic, strikethrough and inline
  code render inline with their syntax markers hidden, revealing again when the cursor
  enters them.
- **GFM**: tables as real HTML grids, task-list checkboxes, fenced code with syntax
  highlighting.
- **Mermaid** diagrams with zoom and pan — double-click toggles zoom, `Ctrl`/`⌘`+wheel
  zooms toward the cursor, drag pans. A syntax error falls back to the raw source
  instead of blanking the block.
- **Math** through KaTeX: inline `$…$` and block `$$…$$`, left alone inside code blocks.
- **Callouts** (`> [!note]`, `[!warning]`, `[!danger]`) as tinted boxes, and
  **footnotes** as superscripts with dimmed definitions.
- **Images**, local (resolved relative to the file, then searched by name inside the
  owning vault) and remote.

### Links that stay inside your vault

- **Wikilinks** `[[target]]` / `[[target|alias]]` open in the current window when the
  file exists, and render struck-through when it doesn't.
- **Relative document links** `[label](./note.md)` open only when they stay inside the
  vault after symlink resolution. Absolute paths, `..` escapes and unknown schemes are
  refused with a visible reason instead of silently opening or creating a file.
- **Image attachments**: pick an image and it is inserted as `![[name.ext]]`. Already
  inside the vault, nothing is copied; otherwise it is copied atomically into
  `.attachments/` without ever overwriting an existing file.

### Viewers for everything else

Non-Markdown files open in a full-pane viewer beside the editor — the document you were
reading keeps its state and scroll position behind it.

| Format | Notes |
|---|---|
| **PDF** | page rendering with zoom |
| **EPUB** | served entry-by-entry straight out of the zip, no temp extraction |
| **Word** (`.docx`) | |
| **Excel** (`.xlsx`, `.xls`, `.csv`) | sheet tabs |
| **HWP / HWPX** | native parse and per-page SVG render |
| **SQLite** (`.sqlite`, `.db`, `.db3`) | pages read off disk, so a multi-GB database opens instantly |
| **HTML** | optional JavaScript execution, isolated behind a per-open token origin |
| **Images** | |

`mermark report.pdf` works from the terminal too — the CLI hands the path to the same
viewer registry the explorer uses.

### Workspaces, vaults and the explorer

- Register folders as **vaults**, group them into **workspaces**, and open documents in
  **tabs**.
- The **file explorer** (`⌘B`) is a lazy tree: folders load a level at a time, hidden
  files are toggleable, and `⌘`/`Ctrl`+click opens a file in a brand-new window.
- **"My Computer"** — press `..` at a filesystem root to get the drive list (`C:`, `D:`
  on Windows; `/` and mounted volumes on macOS), then pick one to jump into it.
- **Right-click a file** for: open in the default browser / Preview / default app,
  open in a new window, reveal in Finder, and copy path.
- **Find files by name** with `⌘⇧F` (VS Code `⌘P`-style fuzzy search), with recent
  documents and favorites in their own panels.

### Remote vaults

Read the vaults on another machine — your desktop's documents from your laptop — over
[Tailscale](https://tailscale.com), with an `ssh -L` tunnel as the fallback for people
who don't use it.

- **Read-only, and explicitly shared.** The host serves only the vaults you check, and
  every request passes two containment gates (lexical resolution, then symlink
  re-validation) before touching the disk.
- **Pairing is a six-digit code**, typed once, exchanged for a long-lived device token.
  The token never enters the webview — commands carry only the host and vault name, and
  Rust looks the token up.
- Markdown, images, PDF, Word, Excel and HTML all open remotely. Broken connections get
  a retry button on the vault row, and badges refresh themselves when the host comes
  back.

### Editing that doesn't lose work

- `⌘E` toggles reader and editor; edits debounce-save to the file.
- Writes are **atomic** (temp file + rename) — never a half-written file.
- If the file changed on disk since you opened it, the save is **held back** with a
  「강제 저장」 (force save) escape hatch. Your buffer is never silently overwritten,
  and recovered content lands in a `.mermark-recovered` file.
- An external edit to the open file is picked up by a watcher and reloaded.

### Themes and typography

Follows the OS light/dark setting with a manual toggle, three built-in presets (Dark,
Light, Claude), and a theme editor where clicking an element in a live preview selects
what you're recoloring. Reading width, font stacks (Pretendard, Inter, Georgia,
Paperlogy) and heading fonts are all settings, and the body-width slider sits in the
footer for one-drag adjustment.

---

## Window routing

An ordinary `mermark file.md` **reuses your last-focused mermark window** rather than
spawning a new one. Two gestures are the exceptions and always open independently:

- `mermark -` (stdin) and `mermark --right` (right half of the screen) launch their own
  process
- `⌘`/`Ctrl`+click or `⌘Enter` in the explorer and file-finder sidebars

Everything else — wikilinks, local document links, recent documents, favorites — opens
in your current window.

A path that doesn't exist is an error, not an invitation: `mermark missing.md` prints
`mermark: missing.md does not exist.` and exits rather than creating the file.

---

## Build from source

Requires the Node and Rust (cargo) toolchains.

```bash
npm install
npm run tauri dev -- path/to/note.md   # dev, with a file
npm run tauri build                    # local build (see the note below)
```

The binary lands at `src-tauri/target/release/mermark` plus a platform bundle.

> **Releasing is owned by `scripts/release.sh`**, which builds, signs, notarizes,
> uploads and writes `updater.json` behind a set of gates. Don't run `npm run tauri
> build` to produce a release: it signs the updater with whatever
> `TAURI_SIGNING_PRIVATE_KEY` is in your shell, which breaks auto-update for every
> existing user.

### Browser mode

```bash
npm run dev:browser
```

The Tauri backend is mocked and a built-in fixture document (`SAMPLE` in
`src/mocks/tauri-core.ts`) is loaded instead. That fixture is what the CDP golden
scripts measure, and it exercises every renderer.

### Tests

```bash
npm test                     # vitest: pure resolvers + a full-editor render smoke test
npx tsc --noEmit             # types
cd src-tauri && cargo test   # backend
```

The smoke test mounts the whole editor on a feature-rich document and asserts it renders
without throwing — it guards against CodeMirror decoration regressions (block
decorations must come from a `StateField`, not a `ViewPlugin`).

---

## Scope

A focused document reader and editor, not a general file manager. The renderer is a
CodeMirror 6 foundation with the Obsidian-style live preview layered on top.

For the full feature inventory by architectural layer, see
[`docs/FEATURES.md`](./docs/FEATURES.md); for design records, `docs/design/` and
`docs/superpowers/specs/`.
