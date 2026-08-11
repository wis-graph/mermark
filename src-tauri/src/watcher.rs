//! Single-file filesystem watcher for auto-reload.
//!
//! This watches exactly the one file the current window has open — never a
//! folder, never an arbitrary path the frontend chooses freely. `watch_file`
//! is a single slot: opening a new path *replaces* the previous watcher (drops
//! it), so at most one `notify` watcher is ever live per window. That narrow
//! surface is the security posture (see 01_architect_design.md): we don't expose
//! a general "watch this directory" capability, and notify needs no Tauri
//! capability/scope entry to watch one file.
//!
//! ## self-write race
//!
//! Autosave calls `write_file`, which atomically renames over the target. That
//! rename fires a filesystem event the watcher would otherwise mistake for an
//! *external* change, causing a reload/conflict loop. `write_file` records its
//! bounded `(path, mtime, size)` identity via [`record_self_write`], and the
//! watcher callback asks [`is_self_write`] whether an event matches it. Both
//! halves are named functions with clean CQS roles so the rule never hides in
//! an inline `if` at the callback site.

use std::sync::Mutex;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

/// The fs-watch slot plus the self-write mute baseline, held as Tauri managed
/// state (`app.manage(WatchState::default())`).
///
/// - `watcher` is the *single slot*: `Some` while a file is watched, swapped
///   wholesale on `set_watch` (the old watcher drops, ending its watch) and
///   emptied on `clear_watch`. `Mutex` because `notify`'s watcher isn't `Sync`
///   on its own and both commands and the (rare) teardown touch it.
/// - `last_self_write` is the bounded `(path, mtime, size)` identity mermark
///   most recently wrote. Path prevents a tab's baseline muting another tab;
///   size distinguishes changed-size rewrites within the same mtime bucket.
#[derive(Default)]
pub struct WatchState {
    watcher: Mutex<Option<RecommendedWatcher>>,
    last_self_write: Mutex<Option<SelfWriteIdentity>>,
}

struct SelfWriteIdentity {
    path: String,
    mtime: u64,
    size: u64,
}

impl WatchState {
    /// Record the bounded identity of the file we just wrote so the watcher
    /// event from that write is recognised and ignored.
    pub fn record_self_write(&self, path: &str, mtime: u64, size: usize) {
        let Ok(size) = u64::try_from(size) else {
            return;
        };
        let identity = SelfWriteIdentity {
            path: path.to_owned(),
            mtime,
            size,
        };
        *self
            .last_self_write
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(identity);
    }

    /// Whether the event belongs to the latest self-write. Older events for the
    /// same path retain the established mute rule; an equal mtime is muted only
    /// when its O(1) metadata size also matches.
    pub fn is_self_write(&self, path: &str, event_mtime: u64, event_size: u64) -> bool {
        let identity = self
            .last_self_write
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(identity) = identity.as_ref() else {
            return false;
        };
        identity.path == path
            && (event_mtime < identity.mtime
                || (event_mtime == identity.mtime && event_size == identity.size))
    }
}

/// Replace the watch slot with a fresh non-recursive watcher on `path`,
/// dropping any previous one. Single-slot by construction: assigning the new
/// `Some(..)` drops the old `RecommendedWatcher`, which tears down its OS watch,
/// so we never accumulate watchers or watch a stale path after the window
/// re-mounts onto a different file. `NonRecursive` because we watch one file,
/// not a tree. The callback re-reads the file and emits `file-changed` for
/// genuine external edits only (self-writes are muted via `is_self_write`).
pub fn set_watch(app: &AppHandle, path: String) -> Result<(), String> {
    let app_for_cb = app.clone();
    let watched_path = path.clone();

    // The callback runs on notify's watcher thread. It must never panic (a
    // panic there would poison the watch silently), so every fallible step is
    // swallowed: a malformed event, an unreadable file, or a failed emit just
    // means we skip this notification rather than crash the watcher.
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(_event) = res else { return };
        handle_fs_event(&app_for_cb, &watched_path);
    })
    .map_err(|e| format!("create watcher for {path}: {e}"))?;

    watcher
        .watch(std::path::Path::new(&path), RecursiveMode::NonRecursive)
        .map_err(|e| format!("watch {path}: {e}"))?;

    let state = tauri_watch_state(app);
    *state
        .watcher
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(watcher);
    Ok(())
}

/// Empty the watch slot, dropping the live watcher (and so ending its OS watch).
/// Idempotent: clearing an already-empty slot is a no-op. Called on teardown /
/// before re-watching a new path; dropping the `WatchState` would also clear it,
/// but an explicit `unwatch_file` lets the frontend stop watching deterministically.
pub fn clear_watch(app: &AppHandle) {
    let state = tauri_watch_state(app);
    *state
        .watcher
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

/// Re-read the watched file and emit `file-changed` for a genuine external edit.
/// Pulled out of the callback closure so the "ignore self-writes, otherwise emit
/// the new content+mtime" rule is one named step, not inline logic on the watcher
/// thread. Events matching the latest bounded self-write identity emit nothing.
/// A vanished/unreadable file (e.g. an editor mid-atomic-rename) is skipped
/// silently rather than emitting a spurious change.
fn handle_fs_event(app: &AppHandle, path: &str) {
    if !std::path::Path::new(path).exists() {
        let _ = app.emit("file-unavailable", FileUnavailable { kind: "deleted", detail: format!("file deleted: {path}") });
        return;
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        let _ = app.emit("file-unavailable", FileUnavailable { kind: "unreadable", detail: format!("file unreadable: {path}") });
        return;
    };
    let Ok(metadata) = std::fs::metadata(path) else {
        return;
    };
    let mtime = crate::commands::mtime_ms(path);
    let state = tauri_watch_state(app);
    // Self-write (our own autosave) → stay silent, no reload loop.
    if state.is_self_write(path, mtime, metadata.len()) {
        return;
    }
    // Genuine external change → carry the new content + mtime so the frontend
    // doesn't have to round-trip a second read_file.
    let _ = app.emit("file-changed", FileChanged { text, mtime });
}

#[cfg(test)]
pub(super) fn read_external_change(
    state: &WatchState,
    path: &std::path::Path,
) -> Option<FileChanged> {
    let path_string = path.to_string_lossy();
    let metadata = std::fs::metadata(path).ok()?;
    let mtime = crate::commands::mtime_ms(&path_string);
    if state.is_self_write(&path_string, mtime, metadata.len()) {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    Some(FileChanged { text, mtime })
}

/// Payload for the `file-changed` event: the file's new contents plus the mtime
/// the watcher observed, so the frontend can reload and re-baseline without a
/// second `read_file` round-trip. Field names (`text`, `mtime`) match
/// `commands::FileContent` and the `src/mocks/tauri-core.ts` simulation hook.
#[derive(Clone, serde::Serialize)]
pub struct FileChanged {
    pub text: String,
    pub mtime: u64,
}

#[derive(Clone, serde::Serialize)]
pub struct FileUnavailable {
    pub kind: &'static str,
    pub detail: String,
}

#[cfg(test)]
#[path = "watcher_characterization.rs"]
mod characterization;

/// Borrow the managed `WatchState`. One helper so every call site reaches the
/// state the same way and the `tauri::Manager` import stays local to this module.
fn tauri_watch_state(app: &AppHandle) -> tauri::State<'_, WatchState> {
    use tauri::Manager;
    app.state::<WatchState>()
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- is_self_write / record_self_write (the mute baseline) ---
    //
    // These cover the self-write *decision* logic in isolation — the part the
    // architect plan flagged as unit-testable. The actual notify firing (real
    // inotify/FSEvents → callback → emit) needs a live OS watch and a Tauri
    // AppHandle, so it's covered by manual/golden verification, not here.

    #[test]
    fn equal_mtime_is_a_self_write() {
        let state = WatchState::default();
        state.record_self_write("/note.md", 100, 4);
        assert!(
            state.is_self_write("/note.md", 100, 4),
            "an event at the recorded identity is our own write"
        );
    }

    #[test]
    fn newer_mtime_is_an_external_change() {
        // Strictly newer than our last write → something else touched the file.
        let state = WatchState::default();
        state.record_self_write("/note.md", 100, 4);
        assert!(
            !state.is_self_write("/note.md", 101, 4),
            "a strictly-newer mtime is an external edit"
        );
    }

    #[test]
    fn older_mtime_is_a_self_write() {
        // An mtime below the baseline can't be a fresh external edit relative to
        // our last write, so it's muted too (defensive against clock jitter /
        // out-of-order events).
        let state = WatchState::default();
        state.record_self_write("/note.md", 100, 4);
        assert!(
            state.is_self_write("/note.md", 99, 4),
            "an older-than-baseline mtime is not an external change"
        );
    }

    #[test]
    fn record_self_write_round_trips_through_identity() {
        let state = WatchState::default();
        assert!(
            !state.is_self_write("/note.md", 50, 4),
            "a fresh state mutes nothing"
        );
        state.record_self_write("/note.md", 50, 4);
        assert!(
            state.is_self_write("/note.md", 50, 4),
            "the recorded identity is a self-write"
        );
        assert!(
            !state.is_self_write("/note.md", 51, 4),
            "but 51 is still external"
        );
    }

    #[test]
    fn default_baseline_treats_any_write_as_external() {
        // With no self-write recorded yet, the very first external edit (any
        // positive mtime) must be seen as external, not muted by a stale 0.
        let state = WatchState::default();
        assert!(
            !state.is_self_write("/note.md", 1, 4),
            "a fresh state mutes nothing"
        );
    }

    #[test]
    fn last_self_write_wins_when_recorded_repeatedly() {
        // Autosave records on every write; only the latest baseline matters.
        let state = WatchState::default();
        state.record_self_write("/note.md", 100, 4);
        state.record_self_write("/note.md", 200, 8);
        assert!(
            state.is_self_write("/note.md", 150, 4),
            "150 < latest baseline 200 → self-write"
        );
        assert!(
            state.is_self_write("/note.md", 200, 8),
            "the latest identity is a self-write"
        );
        assert!(
            !state.is_self_write("/note.md", 201, 8),
            "201 > latest baseline → external"
        );
    }
}
