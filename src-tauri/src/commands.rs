use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::UNIX_EPOCH;
use tauri::{WebviewUrl, WebviewWindowBuilder};

static WINDOW_SEQ: AtomicU32 = AtomicU32::new(1);
static TMP_SEQ: AtomicU64 = AtomicU64::new(1);

/// Normalize path components (resolve relative "." and "..") purely textually.
fn normalize_path(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            Component::Normal(c) => {
                normalized.push(c);
            }
            Component::RootDir => {
                normalized.push(Component::RootDir);
            }
            Component::Prefix(p) => {
                normalized.push(Component::Prefix(p));
            }
        }
    }
    normalized
}

/// Milliseconds since the UNIX epoch for a path's last modification, or 0 when
/// the filesystem can't report it (in which case conflict detection is skipped).
fn mtime_ms(path: &str) -> u64 {
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
#[derive(serde::Serialize)]
pub struct FileContent {
    pub text: String,
    pub mtime: u64,
}

/// Read a file's UTF-8 contents and its modification time. Used at startup.
#[tauri::command]
pub fn read_file(path: String) -> Result<FileContent, String> {
    let normalized = normalize_path(Path::new(&path)).to_string_lossy().into_owned();
    let text = std::fs::read_to_string(&normalized).map_err(|e| format!("read {normalized}: {e}"))?;
    Ok(FileContent { text, mtime: mtime_ms(&normalized) })
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
#[tauri::command]
pub fn write_file(path: String, text: String, baseline: u64) -> Result<u64, String> {
    let normalized = normalize_path(Path::new(&path)).to_string_lossy().into_owned();
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
    std::fs::write(&tmp, &text).map_err(|e| format!("write {tmp}: {e}"))?;
    std::fs::rename(&tmp, &normalized).map_err(|e| {
        let _ = std::fs::remove_file(&tmp); // don't leave the temp behind on failure
        format!("rename {tmp} -> {normalized}: {e}")
    })?;
    Ok(mtime_ms(&normalized))
}

/// Create a new markdown file and any missing parent directories recursively.
/// Writes a default title header `# [filename]\n`.
#[tauri::command]
pub fn create_markdown_file(path: String) -> Result<(), String> {
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

/// Check whether a path points to an existing file (used by wikilink rendering).
#[tauri::command]
pub fn path_exists(path: String) -> bool {
    let normalized = normalize_path(Path::new(&path));
    normalized.is_file()
}

/// Open another file in a brand-new window (used by wikilink clicks).
#[tauri::command]
pub fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let normalized = normalize_path(Path::new(&path));
    if !normalized.is_file() {
        return Err(format!("not a file: {}", normalized.display()));
    }
    let label = format!("w{}", WINDOW_SEQ.fetch_add(1, Ordering::Relaxed));
    let path_str = normalized.to_string_lossy().into_owned();
    let url = WebviewUrl::App(format!("index.html?file={}", urlencoding::encode(&path_str)).into());
    WebviewWindowBuilder::new(&app, label, url)
        .title("mermark")
        .inner_size(crate::DEFAULT_WINDOW.0, crate::DEFAULT_WINDOW.1)
        .min_inner_size(crate::MIN_WINDOW.0, crate::MIN_WINDOW.1)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_path(tag: &str) -> String {
        let n = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir()
            .join(format!("mermark_test_{}_{}_{tag}.md", std::process::id(), n))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn read_returns_text_and_nonzero_mtime() {
        let p = temp_path("read");
        fs::write(&p, "# hi").unwrap();
        let fc = read_file(p.clone()).unwrap();
        assert_eq!(fc.text, "# hi");
        assert!(fc.mtime > 0, "real filesystems report a modification time");
        fs::remove_file(&p).ok();
    }

    #[test]
    fn write_persists_and_returns_mtime() {
        let p = temp_path("write");
        fs::write(&p, "old").unwrap();
        let m = write_file(p.clone(), "new".into(), 0).unwrap();
        assert!(m > 0);
        assert_eq!(fs::read_to_string(&p).unwrap(), "new");
        fs::remove_file(&p).ok();
    }

    #[test]
    fn write_leaves_no_temp_file() {
        let p = temp_path("atomic");
        fs::write(&p, "x").unwrap();
        write_file(p.clone(), "y".into(), 0).unwrap();
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
        let err = write_file(p.clone(), "mine".into(), 1).unwrap_err();
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
        let m = write_file(p.clone(), "v2".into(), base).unwrap();
        assert!(m >= base);
        assert_eq!(fs::read_to_string(&p).unwrap(), "v2");
        fs::remove_file(&p).ok();
    }

    #[test]
    fn zero_baseline_skips_conflict_check() {
        let p = temp_path("zero");
        fs::write(&p, "disk").unwrap();
        // baseline=0 means "no baseline" → always allowed to write.
        assert!(write_file(p.clone(), "forced".into(), 0).is_ok());
        assert_eq!(fs::read_to_string(&p).unwrap(), "forced");
        fs::remove_file(&p).ok();
    }

    // The actual window opening (`inner_size`) needs a live webview runtime, which
    // headless CI doesn't have. Instead we lock the *constant invariant* that both
    // window builders depend on: a document window's default must never be smaller
    // than its minimum, and both must be sane positive sizes. This is what guards
    // against a magic-number regression when someone tweaks the size later.
    #[test]
    fn default_window_is_at_least_the_minimum() {
        let (dw, dh) = crate::DEFAULT_WINDOW;
        let (mw, mh) = crate::MIN_WINDOW;
        assert!(dw >= mw, "default width {dw} must be >= min width {mw}");
        assert!(dh >= mh, "default height {dh} must be >= min height {mh}");
    }

    #[test]
    fn window_sizes_are_sane_positive_values() {
        let (dw, dh) = crate::DEFAULT_WINDOW;
        let (mw, mh) = crate::MIN_WINDOW;
        // Positive and within a plausible desktop range — catches a stray 0,
        // a negative, or an absurd value slipping into the constants.
        for (label, v) in [("def-w", dw), ("def-h", dh), ("min-w", mw), ("min-h", mh)] {
            assert!(v > 0.0, "{label} must be positive, got {v}");
            assert!(v <= 10_000.0, "{label} looks implausible, got {v}");
        }
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

    #[test]
    fn test_normalize_path_resolves_dot_dot_and_dot() {
        assert_eq!(
            normalize_path(std::path::Path::new("/a/b/../c")),
            std::path::PathBuf::from("/a/c")
        );
        assert_eq!(
            normalize_path(std::path::Path::new("/a/./b/c")),
            std::path::PathBuf::from("/a/b/c")
        );
        assert_eq!(
            normalize_path(std::path::Path::new("a/b/c/../../d")),
            std::path::PathBuf::from("a/d")
        );
    }
}
