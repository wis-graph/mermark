use crate::fs::{drives, file_io, image_resolve, link_targets, listing, paths};

// Wire shapes are defined next to their domain logic in `fs/`; re-exported
// here because they ARE these commands' return types (and `remote_client.rs`
// decodes them by this path).
pub use crate::fs::drives::DriveEntry;
pub use crate::fs::file_io::FileContent;
pub use crate::fs::link_targets::LinkTarget;
pub use crate::fs::listing::{DirEntry, ScanResult};

/// IPC adapter for [`crate::fs::file_io::read_file`] (contract documented
/// there). Read a file's UTF-8 contents and its modification time. Used at startup.
#[tauri::command]
pub fn read_file(path: String) -> Result<FileContent, String> {
    file_io::read_file(path)
}

/// Write a file's UTF-8 contents and return the new modification time. Used by
/// the editor's debounced autosave.
///
/// Two safety properties:
/// - **Atomic**: writes to a sibling temp file, then renames over the target, so
///   a crash mid-write can never truncate the user's file.
/// - **Conflict-guarded**: when `baseline` (the mtime the frontend last observed)
///   is non-zero and the on-disk file is newer than it (changed by something else
///   since we last read/wrote), the write is refused with a `CONFLICT:`-prefixed
///   error instead of clobbering it.
///
/// `baseline` is a single-word arg name on purpose: it maps identically under
/// every JS↔Rust naming convention, avoiding camelCase/snake_case surprises.
///
/// After a successful write it records the bounded path/mtime/size identity on
/// the fs watcher's `WatchState`, so the watcher event our own rename provokes
/// is muted instead of being mistaken for an external change.
/// The signature the frontend sees is unchanged — `WatchState` is injected by
/// Tauri's managed state, not passed from JS — so the existing mock stays valid.
#[tauri::command]
pub fn write_file(
    path: String,
    text: String,
    baseline: u64,
    watch: tauri::State<'_, crate::watcher::WatchState>,
) -> Result<u64, String> {
    file_io::write_file_with_state(&path, &text, baseline, &watch)
}

/// Begin watching the single open file at `path` for external changes, replacing
/// any previously watched file (single slot). Thin command wrapper over
/// `watcher::set_watch`; the security-relevant invariant — exactly one file, never
/// a folder or arbitrary path tree — lives there. `path` is a single-word arg for
/// the same JS↔Rust mapping reason as `write_file`'s `baseline`.
#[tauri::command]
pub fn watch_file(
    app: tauri::AppHandle,
    path: String,
) -> Result<crate::watcher::WatchSession, String> {
    crate::watcher::set_watch(&app, path)
}

/// Stop watching the current file (teardown, or before re-watching a new path).
/// Idempotent: unwatching when nothing is watched is a harmless no-op.
#[tauri::command]
pub fn unwatch_file(app: tauri::AppHandle) -> Result<(), String> {
    crate::watcher::clear_watch(&app);
    Ok(())
}

/// IPC adapter for [`crate::fs::file_io::create_markdown_file`] (contract
/// documented there). Create a new markdown file and any missing parent
/// directories recursively. Writes a default title header `# [filename]\n`.
#[tauri::command]
pub fn create_markdown_file(path: String) -> Result<(), String> {
    file_io::create_markdown_file(path)
}

/// Write `text` to the system clipboard (⌥⌘C path.copy / ⌘⇧C bundle.copy).
///
/// This is a backend command rather than `navigator.clipboard.writeText`
/// because the webview's own clipboard API is the wrong tool here: it's gated
/// on secure-context/focus/gesture conditions that don't reliably hold in a
/// WKWebView custom-scheme app, so `navigator.clipboard` can be missing or
/// silently blocked in the shipped app even though it works in the dev/golden
/// browser (http origin) — see `wkwebview-custom-scheme-test-gap`. Routing
/// through `arboard` sidesteps that sacred-cow web surface entirely.
///
/// Write-only and text-only on purpose: there is no matching "read from
/// clipboard" command, which keeps macOS 15.4+'s pasteboard-read privacy
/// prompt out of the picture — the read path simply doesn't exist in this
/// binary. Linux X11's "clipboard is lost when the writing process exits" is
/// a known `arboard` limitation, but mermark ships macOS by default and
/// Windows only opt-in, so it doesn't apply to this app's actual targets.
#[tauri::command]
pub fn copy_to_clipboard(text: String) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text))
        .map_err(|e| e.to_string())
}

/// IPC adapter for [`crate::fs::paths::path_exists`] (contract documented
/// there). Check whether a path points to an existing file (used by wikilink
/// rendering).
#[tauri::command]
pub fn path_exists(path: String) -> bool {
    paths::path_exists(path)
}

/// IPC adapter for [`crate::fs::paths::directory_exists`] (contract
/// documented there).
#[tauri::command]
pub fn directory_exists(path: String) -> bool {
    paths::directory_exists(path)
}

/// IPC adapter for [`crate::fs::paths::canonicalize_path`] (contract
/// documented there).
#[tauri::command]
pub fn canonicalize_path(path: String) -> Result<String, String> {
    paths::canonicalize_path(path)
}

/// IPC adapter for [`crate::window::open_path`] (contract documented there).
/// Open another file in a brand-new window (used by wikilink clicks).
#[tauri::command]
pub fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    crate::window::open_path(app, path)
}

/// Package the file at `path` plus its one-hop wikilinked documents into an XML
/// bundle string for an LLM (⌘⇧C in the editor). A thin wrapper over
/// `bundle::bundle_to_string`, which owns the scan/containment/format spec so
/// this command and the `mermark bundle` CLI produce identical output. Read-only.
#[tauri::command]
pub fn bundle_doc(path: String) -> Result<String, String> {
    crate::bundle::bundle_to_string(&path)
}

/// IPC adapter for [`crate::fs::image_resolve::resolve_image`] (contract
/// documented there).
///
/// `base_dir`/`name`/`max_depth` are single-/clear-word args; Tauri maps them to
/// `baseDir`/`name`/`maxDepth` on the JS side, which the `invoke` call and the
/// browser mock must mirror.
#[tauri::command]
pub fn resolve_image(base_dir: String, name: String, max_depth: u8) -> Option<String> {
    image_resolve::resolve_image(base_dir, name, max_depth)
}

/// IPC adapter for [`crate::fs::link_targets::list_link_targets`] (contract
/// documented there).
#[tauri::command]
pub fn list_link_targets(dir: String) -> Result<Vec<LinkTarget>, String> {
    link_targets::list_link_targets(dir)
}

/// IPC adapter for [`crate::fs::listing::list_dir`] (contract and arg-name
/// mapping are documented there).
#[tauri::command]
pub fn list_dir(path: String, show_hidden: bool) -> Result<Vec<DirEntry>, String> {
    listing::list_dir(path, show_hidden)
}

/// IPC adapter for [`crate::fs::listing::list_files_recursive`] (contract and
/// arg-name mapping are documented there).
#[tauri::command]
pub fn list_files_recursive(root: String, show_hidden: bool) -> Result<ScanResult, String> {
    listing::list_files_recursive(root, show_hidden)
}

/// IPC adapter for [`crate::fs::drives::list_drives`] (contract documented
/// there).
#[tauri::command]
pub fn list_drives() -> Vec<DriveEntry> {
    drives::list_drives()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::test_support::temp_path;
    use std::fs;

    #[test]
    fn bundle_doc_wraps_a_file_in_an_envelope() {
        // Smoke test for the IPC wrapper: a real file round-trips through the
        // shared bundle core and comes back wrapped in the <documents> envelope
        // with a root-relative path attribute.
        let p = temp_path("bundledoc");
        fs::write(&p, "# solo\nbody, no links").unwrap();
        let out = bundle_doc(p.clone()).unwrap();
        assert!(out.starts_with("<documents>"), "got: {out}");
        assert!(out.contains("<document "), "got: {out}");
        assert!(out.contains("body, no links"), "got: {out}");
        fs::remove_file(&p).ok();
    }

    // --- copy_to_clipboard ---
    //
    // Ignored by default: this test mutates the *real* OS clipboard, which is
    // hostile to an unattended `cargo test` sweep (and to whatever the
    // developer happens to have copied). Run it manually:
    //   cargo test -- --ignored clipboard
    #[test]
    #[ignore = "mutates the real OS clipboard; run manually: cargo test -- --ignored"]
    fn clipboard_roundtrip_writes_the_exact_text() {
        copy_to_clipboard("mermark-clipboard-roundtrip".into()).unwrap();
        let got = arboard::Clipboard::new().unwrap().get_text().unwrap();
        assert_eq!(got, "mermark-clipboard-roundtrip");
    }
}
