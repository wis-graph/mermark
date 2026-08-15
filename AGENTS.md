# PROJECT KNOWLEDGE BASE

**Generated:** 2026-08-11
**Commit:** e3cd43d
**Branch:** main

## OVERVIEW

mermark is a Tauri 2 desktop Markdown editor: a strict TypeScript/Vite/CodeMirror frontend backed by Rust commands, file watching, and format-specific viewers.

## STRUCTURE

```text
mermark/
├── src/              # TypeScript frontend and UI domains
├── src-tauri/        # Rust/Tauri runtime, IPC, protocols, packaging
├── tests/             # Flat Vitest/jsdom contract and rendering tests
├── scripts/           # Release, golden-browser, CLI, and updater tooling
├── docs/              # Product, design, architecture, and review records
├── mock-assets/       # Browser-mode fixture files
└── .github/           # Manual Windows release workflow
```

Generated or operational trees are not source boundaries: `node_modules/`, `dist/`, `src-tauri/target/`, `.git/`, `.omc/`, `.omo/`, `.superpowers/`, archived `_workspace*`, and `.claude/worktrees/`.

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| Frontend boot and composition | `index.html`, `src/main.ts` | `index.html → main.ts → boot()`; main wires settings, chrome, workspace, extensions, and editor. |
| Editor and Markdown | `src/editor.ts`, `src/markdown/` | CodeMirror 6 with live-preview extensions and feature registry. |
| Viewer integrations | `src/chrome/viewer/`, `src/extensions/` | Shell/registry in chrome; format implementations in extensions. |
| Native startup and IPC | `src-tauri/src/main.rs`, `lib.rs`, `commands.rs` | CLI short-circuit, protocols, command registration, then webview. |
| Configuration and design | `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `DESIGN.md` | Executable toolchain and visual source of truth. |
| User-visible feature inventory | `docs/FEATURES.md` | Update in the same change set when the feature surface changes. |

## CODE MAP

| Symbol | Type | Location | Role |
|---|---|---|---|
| `boot` | frontend entry | `src/main.ts` | Initializes settings, UI chrome, extensions, and document opening. |
| `activateExtensions` | registry bootstrap | `src/extensions/index.ts` | Registers built-in format viewers through the public API. |
| `mountEditor` | editor factory | `src/editor.ts` | Creates CodeMirror state/view and autosave behavior. |
| `run` | native entry | `src-tauri/src/lib.rs` | Configures Tauri, protocols, commands, CLI, and event loop. |
| `read_file` / `write_file` | IPC commands | `src-tauri/src/commands.rs` | Frontend file access and baseline-guarded atomic persistence. |

Symbol centrality was not measured: the configured TypeScript/Rust LSP requests timed out and no callable codegraph interface was exposed.

## CONVENTIONS

- TypeScript is strict, no-emit, bundler-resolved, and checks unused locals/parameters; `npm run build` runs `tsc` before Vite.
- Browser mode is a separate Vite mode on port 1430 with Tauri modules aliased to `src/mocks/`; native mode uses port 1420.
- The normal frontend test surface is Vitest in jsdom; real layout, painting, native IPC, and font metrics require golden scripts or a native run.
- `CLAUDE.md` governs feature-change orchestration; this file records repository facts, not a replacement workflow.

## ANTI-PATTERNS (THIS PROJECT)

- Do not inject untrusted Markdown/HTML/SVG into the app DOM; use DOM construction or the prescribed sandbox/protocol boundary.
- Do not rename persisted command, shortcut, sidebar, or viewer IDs; registries intentionally use first-claim-wins and no unregister path.
- Keep file writes atomic and conflict-aware; never silently discard an unsaved buffer.
- Do not replace the pinned official-CDN SheetJS tarball with npm's stale `xlsx` package.
- Do not inline design hex values or use gradient tokens as button, text, or card surfaces.

## COMMANDS

```bash
npm test
npm run build
npm run dev
npm run dev:browser
npm run tauri dev -- path/to/note.md
(cd src-tauri && cargo test)
(cd src-tauri && cargo check)
```

Release automation is macOS-first and signing-sensitive: use `./scripts/release.sh` and inspect its gates before invoking release actions. Windows is a manual `workflow_dispatch` path.

## NOTES

- `src-tauri/target/` and `dist/` are generated; do not document or edit them.
- `DESIGN.md`, `docs/FEATURES.md`, `CLAUDE.md`, and the scoped files below are the authoritative project-specific references.
