# RUST SOURCE

## OVERVIEW

Rust modules implement the Tauri event loop, CLI routing, file operations, watchers, document bundles, viewer protocols, and SQLite/HWP/HTML/EPUB backends.

## WHERE TO LOOK

- `lib.rs`: module registration, `invoke_handler`, protocol registration, setup, and window creation.
- `commands.rs`: filesystem, paths, watchers, clipboard, bundles, and recursive scans.
- `htmlview.rs`, `epubview.rs`: custom protocol handlers and frame security policy.
- `hwp.rs`, `epubview.rs`, `sqlite.rs`: native document/viewer parsing and state.
- `cli.rs`: `--version`, bundle/headless routes, stdin, and file targets.

## CONVENTIONS

- Keep path containment and atomic write behavior explicit; baseline checks prevent silent external-change overwrites.
- Embedded Rust tests are part of the module contract and should be run with `cargo test`.
- Protocol handlers must retain platform-specific URL parsing and per-open token scoping.
- `unsafe-inline`/`unsafe-eval` exceptions are viewer-specific; EPUB CSP tests intentionally forbid them.

## ANTI-PATTERNS

- Never broaden an HTML/EPUB protocol root beyond the armed document directory.
- Do not remove the Windows release console suppression comment in `main.rs`.
- Do not bump pinned native dependencies incidentally.

## NOTES

The frontend startup target is selected in `lib.rs` before the webview is created; CLI changes can alter both native and browser-visible behavior.
