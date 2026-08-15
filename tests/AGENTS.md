# TEST DOMAIN

## OVERVIEW

Tests are a flat Vitest suite in jsdom, with filenames organized by behavior rather than mirroring source directories.

## WHERE TO LOOK

- `setup.ts`: global `matchMedia` and `Range` geometry shims.
- Markdown/editor tests: parser, live preview, widgets, links, editor state, autosave, and render smoke.
- Shell/settings/workspace tests: DOM order, persistence, sinks, navigation, sidebar, and viewer contracts.
- Viewer tests: parsing, registration, bytes, protocol URLs, and structural/layout envelopes.

## CONVENTIONS

- Use Vitest globals and `describe`/`it`/`expect`; clear localStorage and reset mocks in setup paths.
- Mock Tauri modules at the boundary with `vi.mock`; assert exact command names, arguments, keys, selectors, and IDs.
- Synthetic geometry is acceptable for jsdom contracts, not visual proof.
- `render-smoke.test.ts` is the broad frontend regression gate.

## ANTI-PATTERNS

- Do not delete or weaken a failing test to obtain green output.
- Do not claim browser layout, native IPC, or Rust behavior from jsdom alone.
- Run the relevant `scripts/*-golden.mjs` harness for viewer, selection, CSS, or visual changes.

## NOTES

The normal include pattern is `tests/**/*.test.ts`; scripts and embedded Rust tests require separate commands.
