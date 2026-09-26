use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use super::paths::{expand_home, normalize_path};

pub(super) static TMP_SEQ: AtomicU64 = AtomicU64::new(1);

/// Milliseconds since the UNIX epoch for a path's last modification, or 0 when
/// the filesystem can't report it (in which case conflict detection is skipped).
/// `pub(crate)` so the fs watcher reuses the *same* mtime computation the write
/// conflict-guard uses — self-write detection compares against this exact value,
/// so a second definition would risk the two drifting apart.
pub(crate) fn mtime_ms(path: &str) -> u64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A file's contents plus the modification time observed when it was read.
/// The frontend keeps `mtime` as the baseline and hands it back on write so the
/// backend can detect an external change before overwriting.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct FileContent {
    pub text: String,
    pub mtime: u64,
}

/// Read a file's UTF-8 contents and its modification time. Used at startup.
pub(crate) fn read_file(path: String) -> Result<FileContent, String> {
    let normalized = expand_home(&path).to_string_lossy().into_owned();
    let text = std::fs::read_to_string(&normalized).map_err(|e| format!("read {normalized}: {e}"))?;
    Ok(FileContent { text, mtime: mtime_ms(&normalized) })
}

/// Domain rule (Task 10 fix round 1, Critical): `write_file` may only ever
/// target an absolute path. Every legitimate caller already has one —
/// `read_file`'s own path, the `.mermark-recovered` sibling and `saveAs`
/// targets are built client-side by appending to / replacing an absolute
/// path, and CLI/reload routing resolves through `canonicalize_path` first.
/// A relative path reaching this command is not a legitimate use with a
/// harmlessly-different meaning — it is exactly the shape a *remote* vault's
/// document name has (`"노트.md"`, vault-relative, no host-local counterpart
/// at all — v1's remote client has no write command by design). Without this
/// guard, a frontend mistake that lets a remote document reach `write_file`
/// silently creates or **overwrites** a same-named file under whatever the
/// process's working directory happens to be, instead of failing loudly.
/// Named and unit-tested on its own (not just inline in
/// `write_file_with_state`) so the rule stays visible and a future edit
/// can't quietly drop the check while touching the function around it.
fn requires_absolute_write_path(path: &Path) -> bool {
    path.is_absolute()
}

/// Whether the write's original target has genuinely vanished from disk
/// since the frontend read it (R1 fix round). `mtime_ms`'s "unmeasurable
/// means 0, skip the check" contract stays exactly as-is — that function
/// still doesn't distinguish "missing" from any other reason a filesystem
/// can't report a time — but that ambiguity is precisely what let an
/// autosave racing a user delete slip through the conflict guard: with the
/// original gone, `mtime_ms` returns 0, `0 > baseline` is false, and the old
/// code happily recreated the deleted file. This predicate asks the
/// narrower, stronger question directly via `symlink_metadata` (not
/// `metadata`, so a dangling symlink counts as vanished too, consistent with
/// how the rest of this module treats broken links) rather than inferring
/// "missing" from a zero mtime.
///
/// `baseline == 0` never counts as vanished, regardless of what's on disk:
/// it means "no baseline" (a new file, save-as, a `.mermark-recovered`
/// copy), not "the file existed and disappeared" — those callers must keep
/// creating freely. Named and unit-tested on its own (mirrors
/// `requires_absolute_write_path`'s shape) so the rule stays visible.
fn original_vanished_since_read(path: &str, baseline: u64) -> bool {
    if baseline == 0 {
        return false;
    }
    matches!(
        std::fs::symlink_metadata(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound
    )
}

/// Pure core of `write_file`, threading the `WatchState` explicitly so tests can
/// inject a fresh one and assert the self-write was recorded. The atomic
/// temp-rename and `CONFLICT:` conflict-guard live here unchanged; the only added
/// behaviour over the old body is `record_self_write` right before returning.
pub(crate) fn write_file_with_state(
    path: &str,
    text: &str,
    baseline: u64,
    watch: &crate::watcher::WatchState,
) -> Result<u64, String> {
    if !requires_absolute_write_path(Path::new(path)) {
        return Err(format!("INVALID_PATH: write_file requires an absolute path, got \"{path}\""));
    }
    let normalized = normalize_path(Path::new(path)).to_string_lossy().into_owned();
    if original_vanished_since_read(&normalized, baseline) {
        return Err(format!("MISSING: file no longer exists on disk (baseline={baseline})"));
    }
    if baseline != 0 {
        // `>` (strictly newer) flags an external change without false-positiving
        // on our own writes. Caveat: on coarse-resolution filesystems (HFS+ 1s,
        // FAT 2s) an external edit within the same time bucket can round equal and
        // slip through; modern APFS/ext4/NTFS carry sub-second mtimes, so this is
        // exact there. The atomic temp-rename below is the hard no-corruption
        // guarantee regardless of clock resolution.
        let current = mtime_ms(&normalized);
        if current > baseline {
            return Err(format!(
                "CONFLICT: file changed on disk since it was opened (baseline={baseline}, disk={current})"
            ));
        }
    }

    let tmp = format!("{normalized}.mermark-tmp.{}", TMP_SEQ.fetch_add(1, Ordering::Relaxed));
    std::fs::write(&tmp, text).map_err(|e| format!("write {tmp}: {e}"))?;
    std::fs::rename(&tmp, &normalized).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename {tmp} -> {normalized}: {e}")
    })?;
    let new_mtime = mtime_ms(&normalized);
    // Mute the watcher event this write is about to trigger: record our own
    // post-write identity so the callback recognises this exact file event.
    watch.record_self_write(&normalized, new_mtime, text.len());
    Ok(new_mtime)
}

/// Create a new markdown file and any missing parent directories recursively.
/// Writes a default title header `# [filename]\n`.
pub(crate) fn create_markdown_file(path: String) -> Result<(), String> {
    let normalized = normalize_path(Path::new(&path));
    if normalized.exists() {
        if normalized.is_dir() {
            return Err(format!("A directory already exists at path: {}", normalized.display()));
        }
        return Ok(()); // already exists, no-op
    }
    if let Some(parent) = normalized.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("failed to create directory: {e}"))?;
        }
    }
    let title = normalized.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled");
    let content = format!("# {title}\n");
    std::fs::write(&normalized, content).map_err(|e| format!("failed to write file: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use crate::fs::paths::path_exists;
    use crate::fs::test_support::temp_path;

    #[test]
    fn read_returns_text_and_nonzero_mtime() {
        let p = temp_path("read");
        fs::write(&p, "# hi").unwrap();
        let fc = read_file(p.clone()).unwrap();
        assert_eq!(fc.text, "# hi");
        assert!(fc.mtime > 0, "real filesystems report a modification time");
        fs::remove_file(&p).ok();
    }

    /// A fresh `WatchState` for tests: `write_file_with_state` records its
    /// self-write into it, but with no live watcher attached nothing else fires.
    fn fresh_watch_state() -> crate::watcher::WatchState {
        crate::watcher::WatchState::default()
    }

    #[test]
    fn write_persists_and_returns_mtime() {
        let p = temp_path("write");
        fs::write(&p, "old").unwrap();
        let m = write_file_with_state(&p, "new", 0, &fresh_watch_state()).unwrap();
        assert!(m > 0);
        assert_eq!(fs::read_to_string(&p).unwrap(), "new");
        fs::remove_file(&p).ok();
    }

    #[test]
    fn write_records_its_mtime_as_a_self_write() {
        // After a successful write, the returned mtime is recorded on the
        // WatchState so the watcher mutes the event our own rename triggers.
        let p = temp_path("selfwrite");
        fs::write(&p, "old").unwrap();
        let state = fresh_watch_state();
        let m = write_file_with_state(&p, "new", 0, &state).unwrap();
        assert!(
            state.is_self_write(&p, m, 3),
            "the write's own identity must be muted"
        );
        assert!(
            !state.is_self_write(&p, m + 1, 3),
            "a strictly-newer mtime is still external"
        );
        fs::remove_file(&p).ok();
    }

    #[test]
    fn write_rejects_a_relative_path_and_touches_no_file() {
        // The Critical fix: a relative path (e.g. a remote vault's
        // vault-relative document name) must never reach fs::write/rename —
        // it would land under the process's CWD instead of failing.
        let cwd_before: Vec<_> = fs::read_dir(std::env::current_dir().unwrap())
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name()))
            .collect();
        let err = write_file_with_state("mermark_relative_write_probe.md", "x", 0, &fresh_watch_state())
            .unwrap_err();
        assert!(err.starts_with("INVALID_PATH:"), "got: {err}");
        let cwd_after: Vec<_> = fs::read_dir(std::env::current_dir().unwrap())
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name()))
            .collect();
        assert_eq!(cwd_before, cwd_after, "a rejected relative write must create nothing");
    }

    #[test]
    fn requires_absolute_write_path_accepts_absolute_rejects_relative() {
        assert!(requires_absolute_write_path(Path::new(&temp_path("abs"))));
        assert!(!requires_absolute_write_path(Path::new("relative/노트.md")));
        assert!(!requires_absolute_write_path(Path::new("노트.md")));
    }

    #[test]
    fn write_leaves_no_temp_file() {
        let p = temp_path("atomic");
        fs::write(&p, "x").unwrap();
        write_file_with_state(&p, "y", 0, &fresh_watch_state()).unwrap();
        let dir = std::path::Path::new(&p).parent().unwrap();
        let stem = std::path::Path::new(&p).file_name().unwrap().to_string_lossy();
        let leftovers: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let n = e.file_name().to_string_lossy().into_owned();
                n.starts_with(&*stem) && n.contains(".mermark-tmp.")
            })
            .collect();
        assert!(leftovers.is_empty(), "temp file must be renamed away, found {leftovers:?}");
        fs::remove_file(&p).ok();
    }

    #[test]
    fn stale_baseline_is_a_conflict() {
        let p = temp_path("conflict");
        fs::write(&p, "disk").unwrap();
        // baseline=1ms is far older than any real file mtime → external change.
        let err = write_file_with_state(&p, "mine", 1, &fresh_watch_state()).unwrap_err();
        assert!(err.starts_with("CONFLICT"), "got: {err}");
        // the refused write must NOT have touched the file
        assert_eq!(fs::read_to_string(&p).unwrap(), "disk");
        fs::remove_file(&p).ok();
    }

    #[test]
    fn matching_baseline_writes() {
        let p = temp_path("match");
        fs::write(&p, "v1").unwrap();
        let base = read_file(p.clone()).unwrap().mtime; // baseline == disk mtime
        let m = write_file_with_state(&p, "v2", base, &fresh_watch_state()).unwrap();
        assert!(m >= base);
        assert_eq!(fs::read_to_string(&p).unwrap(), "v2");
        fs::remove_file(&p).ok();
    }

    #[test]
    fn zero_baseline_skips_conflict_check() {
        let p = temp_path("zero");
        fs::write(&p, "disk").unwrap();
        // baseline=0 means "no baseline" → always allowed to write.
        assert!(write_file_with_state(&p, "forced", 0, &fresh_watch_state()).is_ok());
        assert_eq!(fs::read_to_string(&p).unwrap(), "forced");
        fs::remove_file(&p).ok();
    }

    #[test]
    fn write_rejects_a_baseline_write_to_a_vanished_original_and_does_not_recreate_it() {
        // R1: an autosave racing a user delete must never resurrect the file.
        // baseline != 0 (the frontend read the file, so it had a real mtime),
        // but the target has since vanished — mtime_ms(missing) is 0, which
        // would otherwise make `current > baseline` false and let the write
        // sail through as if nothing happened (the bug this guards against).
        let p = temp_path("vanished");
        fs::write(&p, "v1").unwrap();
        let base = read_file(p.clone()).unwrap().mtime;
        fs::remove_file(&p).unwrap(); // the "user deleted it" step
        let err = write_file_with_state(&p, "resurrected", base, &fresh_watch_state()).unwrap_err();
        assert!(err.starts_with("MISSING:"), "got: {err}");
        assert!(!std::path::Path::new(&p).exists(), "a rejected write must not recreate the file");
    }

    #[test]
    fn baseline_zero_write_still_creates_a_missing_file() {
        // GREEN lock: `original_vanished_since_read` must never block a
        // baseline=0 write (new file, save-as, `.mermark-recovered` copy) —
        // "no baseline" is not "the file existed and vanished".
        let p = temp_path("zero_missing");
        assert!(!std::path::Path::new(&p).exists());
        assert!(write_file_with_state(&p, "brand new", 0, &fresh_watch_state()).is_ok());
        assert_eq!(fs::read_to_string(&p).unwrap(), "brand new");
        fs::remove_file(&p).ok();
    }

    #[test]
    fn original_vanished_since_read_is_true_only_for_a_missing_path_with_a_nonzero_baseline() {
        let p = temp_path("predicate_missing");
        assert!(!std::path::Path::new(&p).exists());
        assert!(original_vanished_since_read(&p, 123));
    }

    #[test]
    fn original_vanished_since_read_is_false_when_baseline_is_zero_even_if_missing() {
        let p = temp_path("predicate_zero_baseline");
        assert!(!std::path::Path::new(&p).exists());
        assert!(!original_vanished_since_read(&p, 0));
    }

    #[test]
    fn create_markdown_file_creates_file_and_folders() {
        let parent = std::env::temp_dir()
            .join(format!("mermark_test_{}_nested", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let path = format!("{}/nested/new_file.md", parent);
        assert!(!path_exists(path.clone()));

        create_markdown_file(path.clone()).unwrap();

        assert!(path_exists(path.clone()));
        let contents = fs::read_to_string(&path).unwrap();
        assert_eq!(contents, "# new_file\n");

        fs::remove_dir_all(&parent).ok();
    }

    #[test]
    fn create_markdown_file_relative_path() {
        let path = "relative_file_test.md".to_string();
        if std::path::Path::new(&path).exists() {
            fs::remove_file(&path).ok();
        }
        assert!(!path_exists(path.clone()));

        create_markdown_file(path.clone()).unwrap();

        assert!(path_exists(path.clone()));
        let contents = fs::read_to_string(&path).unwrap();
        assert_eq!(contents, "# relative_file_test\n");

        fs::remove_file(&path).ok();
    }

    #[test]
    fn create_markdown_file_fails_if_dir_exists() {
        let parent = std::env::temp_dir()
            .join(format!("mermark_test_{}_dir_exists", std::process::id()))
            .to_string_lossy()
            .into_owned();
        fs::create_dir_all(&parent).unwrap();

        let res = create_markdown_file(parent.clone());
        assert!(res.is_err());
        assert_eq!(res.unwrap_err(), format!("A directory already exists at path: {}", parent));

        fs::remove_dir_all(&parent).ok();
    }
}
