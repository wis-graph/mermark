# FRONTEND DOMAIN

## OVERVIEW

The `src/` tree is the strict TypeScript frontend: CodeMirror editor, Markdown rendering, application chrome, settings, workspace state, and viewer adapters.

## WHERE TO LOOK

| Area | Files | Contract |
|---|---|---|
| Composition | `main.ts`, `editor.ts`, `styles.css` | Keep boot wiring and global layout decisions centralized. |
| Public extension surface | `api/index.ts`, `extensions/index.ts` | Extensions import only `../api` or npm packages; load heavy dependencies inside `open()`. |
| Document lifecycle | `document/`, `workspace/` | Conflict recovery, reload handoff, navigation, and vault persistence live here. |
| UI shell | `chrome/`, `sidebar/`, `settings/`, `shortcuts/` | DOM order and CSS selectors are tested as contracts. |

## CONVENTIONS

- Settings are stores with sinks/subscriptions; preserve the single-source-of-truth direction when adding a setting.
- Tauri calls are isolated behind the existing API/mocks and should retain exact command names and argument shapes.
- Browser-only behavior must remain usable through Vite's `src/mocks/` aliases.
- User-visible features require a matching `docs/FEATURES.md` update under the root convention.

## ANTI-PATTERNS

- Do not import frontend internals from an extension; use the public API facade.
- Do not use `innerHTML` for untrusted content. Existing uses are limited to trusted/generated SVG or clearing nodes.
- Do not make the body the scrolling surface; the shell owns viewport scrolling in `styles.css`.

## NOTES

The frontend has no project ESLint/Prettier configuration; the enforced compiler gate is `tsc` through the root build.
