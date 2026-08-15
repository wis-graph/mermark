# VIEWER SHELL

## OVERVIEW

The viewer subsystem owns the common content shell, viewer registry, file-byte facade, zoom, and built-in image/Mermaid/EPUB/HWP/SQLite viewers.

## WHERE TO LOOK

- `registry.ts`: stable viewer IDs, extension claims, and first-claim-wins resolution.
- `shell.ts`: content pane, header/status chrome, local zoom, and flex/scroll ownership.
- `file-bytes.ts`: the boundary for reading viewer input.
- `epub-viewer.ts`, `hwp-viewer.ts`, `html-viewer` adapters: security-sensitive isolation contracts.

## CONVENTIONS

- Viewer IDs are persisted settings keys; never rename them.
- Viewer-local zoom belongs to the shell and must not fan out through global font scale.
- Viewer DOM/layout tests assert exact selectors, ordering, and size envelopes; real rendering belongs to browser golden scripts.

## ANTI-PATTERNS

- EPUB chapter HTML never enters the app DOM; use its protocol iframe boundary.
- HWP pages enter the DOM as base64 image data URLs, not raw inline SVG.
- Do not add registry unregister behavior or change conflict resolution without updating the plugin contract.

## NOTES

Viewer adapters under `src/extensions/` must reach this shell through `src/api/index.ts`, not internal imports.
