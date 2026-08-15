# TAURI BACKEND

## OVERVIEW

`src-tauri/` packages the native Rust runtime, IPC commands, custom viewer protocols, capabilities, icons, and platform bundles.

## WHERE TO LOOK

| Area | Location | Notes |
|---|---|---|
| Runtime | `src/main.rs`, `src/lib.rs` | Binary delegates to `run`; normal startup registers plugins, protocols, commands, CLI, and webview. |
| IPC/filesystem | `src/commands.rs`, `src/watcher.rs` | Frontend command names and baseline semantics are contracts. |
| Viewer backends | `src/htmlview.rs`, `src/epubview.rs`, `src/hwp.rs`, `src/sqlite.rs` | Custom protocols, sandbox/CSP, and native parsing. |
| Packaging | `Cargo.toml`, `tauri.conf.json`, `capabilities/` | CSP, permissions, updater, and bundle configuration. |

## CONVENTIONS

- Rust edition 2021; use `cargo check` and `cargo test` from this directory.
- `rusqlite` is pinned exactly at 0.39.0; `rhwp` is pinned to an exact git revision. Bump either only after deliberate diff review.
- Keep Tauri capabilities and production CSP narrow; protocol exceptions must be justified by the viewer contract.
- Native behavior differs by OS; preserve platform-specific path, clipboard, signing, and protocol fallbacks.

## ANTI-PATTERNS

- Do not weaken filesystem containment, custom-protocol token scoping, or viewer CSP to make a fixture pass.
- Do not change IPC command names or payloads without updating the frontend facade and contract tests.
- Do not treat `target/`, generated schemas, or bundle output as hand-edited source.

## NOTES

The root release script owns signing-sensitive packaging; local `tauri build` is not equivalent to a release build.
