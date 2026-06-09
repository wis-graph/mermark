# mermark — Design Spec

**Date:** 2026-06-10
**Status:** Approved (design), pending spec review

## 1. Summary

`mermark` is a cross-platform desktop **markdown + Mermaid viewer**, launched from the
CLI to open a single file. The MVP is read-only rendering. Editing and autosave are
deferred follow-up work, but the viewer is built on a **CodeMirror 6 (CM6)** foundation
so that an Obsidian-style Live Preview editor can be layered on later without rewriting
the render layer.

Name: `mermark` = Mermaid + markdown.

### Goals
- Open a single `.md` file from the terminal: `mermark <file.md>`.
- Render markdown with full feature set (GFM, math, footnotes, callouts, wikilinks).
- Render Mermaid diagrams inline with zoom/pan.
- Cross-platform: macOS, Windows, Linux.

### Non-goals (deferred)
- Editing / autosave (architecture leaves room; not in MVP).
- File explorer / vault / folder tree.
- Tabs or in-window multi-document management (each file = its own window).
- Cursor-aware syntax-marker reveal (the hard part of true Live Preview) — deferred to the editing phase.

## 2. Stack

| Layer | Choice | Reason |
|---|---|---|
| Shell | **Tauri 2** (Rust core + system webview) | Small binary, low RAM, cross-platform. Reuses OS webview instead of bundling Chromium. |
| Frontend | **TypeScript + Vite** | Standard Tauri frontend toolchain. |
| Render engine | **CodeMirror 6** | Foundation for later Live Preview editing; decoration system renders markdown inline. |
| Markdown parse | **Lezer markdown** (`@codemirror/lang-markdown`) | Native CM6 parser; integrates with editing later. Extended for callouts/wikilinks/footnotes. |
| Diagrams | **mermaid** (npm) | Required core feature. |
| Math | **KaTeX** | `$...$` inline, `$$...$$` block. |
| Code highlight | CM6 / Lezer language packages | Syntax highlight inside code fences. |
| Diagram zoom/pan | **svg-pan-zoom** (or direct SVG transform) | Per-diagram zoom and pan. |
| UI design | **ElevenLabs DESIGN.md** | Dark cinematic aesthetic, audio-waveform motifs. Pulled via `npx getdesign@latest add elevenlabs` at scaffold time. |

### Webview portability note
Tauri uses three webview engines: WebKit (macOS), WebView2/Chromium (Windows),
WebKitGTK (Linux). Mermaid, CM6, and KaTeX run on all three, but WebKit CSS quirks must
be tested. Manual render verification across all three OSes is part of the test plan.

## 3. CLI launch + multi-window

- Command: `mermark <file.md>`.
- Install: register the Tauri binary on `PATH` — symlink on macOS/Linux, PATH entry on Windows.
- Rust `main`:
  1. Parse the file-path argument.
  2. Resolve to an absolute path.
  3. Validate the file exists and is readable. On failure → write error to stderr and exit non-zero (and/or show an error window).
  4. Create a **new window** bound to that file.
- **Each invocation = an independent new window.** No single-instance plugin; running
  `mermark a.md` then `mermark b.md` yields two independent windows.
- The file's directory is recorded as the base path for resolving relative image paths and wikilinks.

## 4. Render pipeline (CM6 Live-Preview style, read-only)

Text stays in the CM6 document. There is **no whole-document HTML conversion**; everything
is drawn via CM6 decorations over the live document.

- **Parse:** Lezer markdown → syntax tree.
- **Mark decorations** (inline): bold / italic / link / inline-code styling. In the
  read-only MVP, syntax markers (`**`, `_`, backticks) are **hidden permanently**.
  Cursor-aware reveal toggling is deferred to the editing phase.
- **Widget / Replace decorations** (block-level replacement):
  - Mermaid fence → rendered SVG widget.
  - Math block (`$$`) → KaTeX widget.
  - Callout (`> [!note]`) → styled box.
  - Image → `<img>`; local paths converted through the Tauri asset protocol, resolved relative to the file's directory.
  - Code fence → syntax-highlighted block.
- **Extended parsing:** footnotes, callouts, and wikilinks are not in base Lezer markdown
  → add via custom parse extension or regex post-pass decorations.
- **Wikilinks (`[[...]]`):** resolved against the file's directory. If the target path
  exists, the link is active (clicking opens that file in a new window per §3); if not, it
  renders as a disabled/unresolved link.
- **Read-only:** `EditorState.readOnly` + `editable: false`. Text selection and copy still work.

### Markdown feature set (MVP)
Base + GFM (tables, task checkboxes, strikethrough, code fences) + KaTeX math + footnotes
+ callouts (`> [!note]`) + wikilinks. Mermaid is always included as the core feature.

## 5. Mermaid zoom/pan

- Each Mermaid widget = rendered SVG wrapped in svg-pan-zoom (or a direct transform layer).
- **Double-click** = toggle zoom (default ↔ zoomed-in).
- **Ctrl / Cmd + wheel** = zoom. Plain wheel = page scroll (avoids scroll-vs-zoom conflict).
- **Click-drag** = pan.
- Render failure (syntax error) → show an error message with the raw fence code as fallback.

## 6. Theme

- Follow OS dark/light (Tauri theme detection) + manual toggle button.
- CM6 theme, Mermaid theme, and KaTeX styling kept in sync with the active theme.
- Visual language follows the ElevenLabs DESIGN.md (dark cinematic, waveform motifs).

## 7. Testing

- **Rust:** unit tests for argument parsing, path resolution, file validation, window creation.
- **Frontend:** unit tests (vitest) for parser/decoration logic; key coverage on Mermaid
  rendering hooks and wikilink path resolution.
- **Manual:** a sample `.md` exercising every feature, render-verified on all three OSes.
- **E2E** (WebDriver / tauri-driver): deferred to a follow-up.

## 8. Phasing

1. **MVP (this spec):** read-only viewer — CLI launch, multi-window, full markdown render, Mermaid zoom/pan, theme.
2. **Editing phase (later):** drop read-only, add cursor-aware syntax-marker reveal (true Live Preview), autosave with debounce, save-on-close handling.
3. **Beyond (later):** folder mode (activates full wikilink navigation), tabs/multi-doc, E2E tests.
