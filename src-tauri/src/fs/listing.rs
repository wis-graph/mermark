use std::path::{Path, PathBuf};

use super::paths::{expand_home, normalize_path};

/// Whether a file name is a mermark scratch/recovery artifact that must never be
/// offered as a link target. Mirrors the autosave temp suffix (`.mermark-tmp.`)
/// and the recovery marker (`.mermark-recovered`) so the picker doesn't surface
/// the editor's own working files. Named so the exclusion rule reads as one fact.
pub(crate) fn is_mermark_artifact(file_name: &str) -> bool {
    file_name.contains(".mermark-tmp.") || file_name.contains(".mermark-recovered")
}

/// One entry in a directory listing for the file explorer. Unlike `LinkTarget`
/// (the `[[`-picker's shape), the explorer shows the *literal* filesystem name —
/// `name` is the full file name including any `.md` extension (not a stem) — plus
/// the entry's normalized absolute `path` (fed back into `read_file` on a file
/// click, or `list_dir` on a folder hover) and an `is_dir` flag (folders sort
/// first and are hover-expandable). The frontend mirrors this exact shape in
/// `src/mocks/tauri-core.ts` and its `invoke<DirEntry[]>("list_dir")`; serde
/// serializes the field names verbatim, so `is_dir` stays snake_case on the wire.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct DirEntry {
    /// Full file/folder name, extension included (`note.md`, not `note`).
    pub name: String,
    /// Normalized absolute path — a file click's `read_file` arg, a folder
    /// hover's `list_dir` arg.
    pub path: String,
    /// Folder vs file: folders sort first and are hover-expandable.
    pub is_dir: bool,
}

/// Whether a directory entry should be shown as a folder. `file_type()` reports
/// the entry as it sits in *this* directory, so a symlink reads as a symlink
/// (not a dir) even when it points at one; when that's the case we follow the
/// link once (`path.is_dir()`) so a symlink-to-directory shows as an expandable
/// folder — the explorer's `..`/symlink following is user-intended navigation.
/// A plain directory is reported directly. One named rule so "is this an
/// expandable folder" isn't re-derived inline. Reading only one level here means
/// a symlink cycle can't runaway — deeper reads happen only on user hover.
fn entry_is_dir(file_type: std::fs::FileType, path: &Path) -> bool {
    if file_type.is_symlink() {
        path.is_dir() // follows the link once; false for a broken/file symlink
    } else {
        file_type.is_dir()
    }
}

/// Whether a directory entry is hidden by mermark's listing policy: any name
/// beginning with `.` (`.git/`, `.DS_Store`, `.hidden.md`). Pulled out so the
/// "dotfiles are excluded" rule reads as one named fact rather than an inline
/// `starts_with('.')` buried in the classifier. Note `.test/` — user data — is
/// also a dotfile and thus excluded from the listing; the command is read-only,
/// so an excluded directory is never modified regardless.
pub(crate) fn is_hidden_entry(file_name: &str) -> bool {
    file_name.starts_with('.')
}

/// Sort key for a deterministic explorer listing: folders before files, then
/// case-insensitively by name. Pulled out so the "folders first, then name"
/// ordering is one named rule (mirroring `link_target_sort_key`), not an inline
/// closure. `is_dir == true` ranks 0 (before) so folders lead the list.
fn dir_entry_sort_key(e: &DirEntry) -> (u8, String) {
    (if e.is_dir { 0 } else { 1 }, e.name.to_ascii_lowercase())
}

/// Classify a single directory entry into a `DirEntry`, or `None` when the
/// listing policy hides it. The domain rule lives here as one named function
/// instead of being scattered through `list_dir`, and is two *independent*
/// exclusions rather than one combined check, because they obey different
/// rules: mermark's own scratch/recovery artifacts are excluded
/// **unconditionally** (invariant — the toggle below has no say over them),
/// while hidden dotfiles are excluded only when the caller has not opted into
/// seeing them (`show_hidden == false`, the explorer's "표시 숨김 파일" toggle
/// off). Everything else — files *and* directories, of any type — is kept and
/// shown by its full name. `is_dir` is passed in from the entry's
/// `file_type()` (not re-derived from `path`) so a symlink-to-directory
/// reports `is_dir = true` without the classifier following the link. `path`
/// is normalized to a `..`/`.`-collapsed absolute path.
fn classify_dir_entry(path: &Path, is_dir: bool, show_hidden: bool) -> Option<DirEntry> {
    let file_name = path.file_name()?.to_str()?.to_owned();
    // Invariant: mermark's own artifacts are never listed, regardless of the
    // show_hidden toggle — the toggle controls user dotfiles, not editor
    // internals.
    if is_mermark_artifact(&file_name) {
        return None;
    }
    if !show_hidden && is_hidden_entry(&file_name) {
        return None;
    }
    Some(DirEntry {
        name: file_name,
        path: normalize_path(path).to_string_lossy().into_owned(),
        is_dir,
    })
}

/// List the immediate children (one level only — non-recursive) of `path` for
/// the file explorer's lazy tree. Mermark artifacts are always excluded;
/// hidden dotfiles are excluded unless `show_hidden` is true (the explorer's
/// "숨김 파일 표시" setting). Folders sort first, then case-insensitively by
/// name.
///
/// Graceful by design (mirrors `list_link_targets`): a missing/unreadable
/// directory returns `Err(String)` (never panics) — the user explicitly opened
/// this folder, so the failure is surfaced rather than swallowed. An individual
/// unreadable entry (broken symlink, permission hiccup) is skipped via
/// `filter_map(ok)` so one bad entry can't sink the whole list. An empty
/// directory yields `Ok(vec![])`.
///
/// Read-only: enumerates directories, never writes, so the atomic-write /
/// conflict-guard machinery doesn't apply. Unlike `resolve_image`, there is
/// **no** `is_within_base` fence: the explorer's `..` navigation and symlink
/// following are *user-intended* moves (an explicit double-click / hover), not
/// an automatic scan, so arbitrary read-only listing above the base is allowed
/// (a symlink-to-dir is shown as an expandable folder via `entry_is_dir`).
/// Parent (`..`) resolution is done here by `normalize_path` (a `${root}/..`
/// arg is folded), keeping path-shape a single source of truth rather than
/// splitting `..` handling across the TS and Rust sides. Symlink cycles can't
/// runaway because this reads only one level — deeper reads happen only when the
/// user hovers, so there is no automatic recursive walk to loop.
///
/// `path` and `show_hidden` are single-word args; Tauri maps them to `path`
/// and `showHidden` on the JS side (snake_case → camelCase), which the
/// `invoke` call and the browser mock (`src/mocks/tauri-core.ts`) must mirror.
pub(crate) fn list_dir(path: String, show_hidden: bool) -> Result<Vec<DirEntry>, String> {
    let normalized = expand_home(&path);
    let entries = std::fs::read_dir(&normalized)
        .map_err(|e| format!("list {}: {e}", normalized.display()))?;
    let mut result: Vec<DirEntry> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            let is_dir = entry
                .file_type()
                .map(|t| entry_is_dir(t, &path))
                .unwrap_or(false);
            classify_dir_entry(&path, is_dir, show_hidden)
        })
        .collect();
    result.sort_by_key(dir_entry_sort_key);
    Ok(result)
}

/// Hard ceiling on directory nesting depth for `list_files_recursive`'s walk.
/// A defensive invariant (not a user preference — see the design's SSOT
/// judgment), so it's a named Rust constant rather than a setting. Depth 0 is
/// `root` itself: a directory reached at depth `MAX_SCAN_DEPTH` is still
/// walked for its own files, but its children are not descended into.
const MAX_SCAN_DEPTH: u32 = 12;

/// Hard ceiling on the number of files `list_files_recursive` returns. Once
/// reached, the walk stops outright — never "scan everything then truncate a
/// sorted list" — so the caller's `truncated: true` reflects a genuinely
/// incomplete scan, not a silently re-ordered one.
const MAX_SCAN_FILES: usize = 10_000;

/// Directory names excluded from `list_files_recursive` **unconditionally**,
/// regardless of `show_hidden` — heavy/generated trees that would blow the
/// scan budget on a real project checkout, not user content the hidden-files
/// toggle is meant to govern.
const EXCLUDED_SCAN_DIRS: &[&str] =
    &["node_modules", ".git", "target", "dist", "build", "__pycache__", ".venv"];

/// Whether a directory name is one of the unconditionally-excluded scan
/// roots. Pulled into a named function (mirroring `is_hidden_entry`/
/// `is_mermark_artifact`) so the exclusion rule is one fact, not re-derived
/// inline inside the walk loop.
pub(super) fn is_excluded_scan_dir(name: &str) -> bool {
    EXCLUDED_SCAN_DIRS.contains(&name)
}

/// One file found by a recursive scan (`list_files_recursive`), for the
/// sidebar's fuzzy file-finder (⌘⇧F). The frontend mirrors this exact shape
/// in `src/mocks/tauri-core.ts` and its `invoke<ScanResult>`.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct FileHit {
    /// File name only (`note.md`), for display.
    pub name: String,
    /// Normalized absolute path — fed back into `read_file` on open.
    pub path: String,
    /// Path relative to the scan root (`sub/note.md`), forward-slash joined —
    /// the frontend's fuzzy-match input and the sort/display key.
    pub rel_path: String,
}

/// Result of a recursive scan: the files found (sorted by `rel_path`) plus
/// whether the walk hit a defensive ceiling (`MAX_SCAN_DEPTH`/
/// `MAX_SCAN_FILES`) and so is a partial, not exhaustive, listing.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct ScanResult {
    pub files: Vec<FileHit>,
    pub truncated: bool,
}

/// Pure core of `list_files_recursive`, taking the ceilings as parameters so
/// tests can exercise truncation with small numbers instead of building a
/// 10,000-file fixture. Walks with an **explicit stack, never recursion**, so
/// nesting depth is bounded by a `u32` counter rather than the call stack.
///
/// Directory symlinks are never followed — an automatic scan is not the
/// *user-intended navigation* `list_dir`'s one-level symlink-follow is
/// designed for (the dual of that reasoning: cycle-safety wins here). File
/// symlinks are listed like ordinary files, the same convention `list_dir`
/// uses. An unreadable directory is skipped, not fatal, so one bad entry
/// can't sink the whole scan (mirrors `scan_match`).
fn walk_files_recursive(
    root: &Path,
    show_hidden: bool,
    max_depth: u32,
    max_files: usize,
) -> (Vec<FileHit>, bool) {
    let root = normalize_path(root);
    let mut files: Vec<FileHit> = Vec::new();
    let mut truncated = false;
    let mut stack: Vec<(PathBuf, u32)> = vec![(root.clone(), 0)];

    'walk: while let Some((dir, depth)) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue, // unreadable dir → skip, don't abort the scan
        };
        let mut children: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
        children.sort();

        for path in &children {
            let file_name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n,
                None => continue,
            };
            let meta = match std::fs::symlink_metadata(path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let is_symlink = meta.file_type().is_symlink();
            // Mirrors entry_is_dir: a symlink-to-dir follows once to classify,
            // but (below) is never pushed onto the walk stack.
            let is_dir = if is_symlink { path.is_dir() } else { meta.file_type().is_dir() };

            if is_dir {
                if is_symlink {
                    continue; // never follow a directory symlink into the walk
                }
                if is_excluded_scan_dir(file_name) {
                    continue; // unconditional, regardless of show_hidden
                }
                if !show_hidden && is_hidden_entry(file_name) {
                    continue;
                }
                if depth + 1 > max_depth {
                    truncated = true; // a deeper subtree exists but isn't walked
                    continue;
                }
                stack.push((path.clone(), depth + 1));
                continue;
            }

            // File entry: same two exclusion rules `classify_dir_entry` applies —
            // mermark's own artifacts unconditionally, dotfiles unless show_hidden.
            if is_mermark_artifact(file_name) {
                continue;
            }
            if !show_hidden && is_hidden_entry(file_name) {
                continue;
            }
            if files.len() >= max_files {
                truncated = true;
                break 'walk; // ceiling reached → stop the entire walk, not just this dir
            }
            let normalized = normalize_path(path);
            let rel_path = normalized
                .strip_prefix(&root)
                .unwrap_or(&normalized)
                .to_string_lossy()
                .into_owned();
            files.push(FileHit {
                name: file_name.to_owned(),
                path: normalized.to_string_lossy().into_owned(),
                rel_path,
            });
        }
    }

    // rel_path ascending: deterministic for tests; the frontend's fuzzy
    // scorer re-ranks for display, this is just a stable baseline order.
    files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    (files, truncated)
}

/// Recursively enumerate the files under `root` (files only — no directory
/// rows, since a picker opens files) for the sidebar's fuzzy file-finder
/// (⌘⇧F). A command of its own rather than the frontend repeatedly calling
/// `list_dir`: a real project tree is many directories deep, and one IPC
/// round-trip per directory would stall the UI for seconds on a large vault
/// while re-implementing the depth/exclusion policy in TS. The ceilings
/// (`MAX_SCAN_DEPTH`, `MAX_SCAN_FILES`) and the excluded-directory list are
/// enforced *inside* the walk (`walk_files_recursive`), so a huge or cyclic
/// tree can never hang the UI.
///
/// `show_hidden` reuses the exact policy `list_dir`'s "숨김 파일 표시" toggle
/// applies (`is_hidden_entry`); `EXCLUDED_SCAN_DIRS` and mermark's own
/// scratch/recovery artifacts (`is_mermark_artifact`) are excluded
/// **unconditionally**, regardless of that toggle.
///
/// Read-only: enumerates directories, never writes, so the atomic-write /
/// conflict-guard machinery doesn't apply (same posture as `list_dir` /
/// `list_link_targets`). A missing/unreadable root is a graceful `Err` — the
/// user explicitly picked this root (the explorer's current tree root), so
/// the failure is surfaced rather than swallowed, mirroring `list_dir`.
///
/// `root` and `show_hidden` are single-word args; Tauri maps them to `root`
/// and `showHidden` on the JS side, which the `invoke` call and the browser
/// mock (`src/mocks/tauri-core.ts`) must mirror.
pub(crate) fn list_files_recursive(root: String, show_hidden: bool) -> Result<ScanResult, String> {
    let normalized = expand_home(&root);
    std::fs::read_dir(&normalized).map_err(|e| format!("list {}: {e}", normalized.display()))?;
    let (files, truncated) = walk_files_recursive(&normalized, show_hidden, MAX_SCAN_DEPTH, MAX_SCAN_FILES);
    Ok(ScanResult { files, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use crate::fs::test_support::temp_dir;

    // --- list_dir (file explorer lazy tree, one level) ---
    //
    // Each test owns an isolated fixture under temp_dir() and tears it down.
    // The `.test/` directory is never touched — read-only listing only.

    #[test]
    fn list_dir_sorts_folders_first_then_name() {
        let dir = temp_dir("ld_sort");
        fs::write(dir.join("z.md"), "x").unwrap();
        fs::write(dir.join("a.md"), "x").unwrap();
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::create_dir_all(dir.join("Beta")).unwrap();
        let got = list_dir(dir.to_string_lossy().into_owned(), false).unwrap();
        let order: Vec<&str> = got.iter().map(|e| e.name.as_str()).collect();
        // folders first (case-insensitive name), then files (case-insensitive name).
        assert_eq!(order, vec!["Beta", "sub", "a.md", "z.md"]);
        // is_dir flags are accurate per entry.
        assert!(got.iter().find(|e| e.name == "Beta").unwrap().is_dir);
        assert!(got.iter().find(|e| e.name == "sub").unwrap().is_dir);
        assert!(!got.iter().find(|e| e.name == "a.md").unwrap().is_dir);
        assert!(!got.iter().find(|e| e.name == "z.md").unwrap().is_dir);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn list_dir_empty_dir_returns_empty() {
        let dir = temp_dir("ld_empty");
        let got = list_dir(dir.to_string_lossy().into_owned(), false).unwrap();
        assert!(got.is_empty(), "an empty directory yields an empty vec");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn list_dir_missing_dir_is_graceful_err() {
        // A path that doesn't exist must return Err (graceful), never panic.
        let missing = std::env::temp_dir()
            .join(format!("mermark_ld_missing_{}", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let res = list_dir(missing, false);
        assert!(res.is_err(), "missing directory is a graceful error");
    }

    #[test]
    fn list_dir_parent_resolves_via_normalize() {
        // `${sub}/..` must resolve back to `base` (parent handling lives in
        // normalize_path — single source of truth, not split across TS/Rust).
        let base = temp_dir("ld_parent");
        fs::write(base.join("root.md"), "x").unwrap();
        let sub = base.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let up = format!("{}/..", sub.to_string_lossy());
        let got = list_dir(up, false).unwrap();
        let names: Vec<&str> = got.iter().map(|e| e.name.as_str()).collect();
        // Listing base: its file `root.md` and its child dir `sub`.
        assert!(names.contains(&"root.md"), "parent listing sees root.md, got {names:?}");
        assert!(names.contains(&"sub"), "parent listing sees sub/, got {names:?}");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn list_dir_excludes_hidden_and_artifacts() {
        let dir = temp_dir("ld_hidden");
        fs::create_dir_all(dir.join(".git")).unwrap(); // hidden dir
        fs::write(dir.join(".hidden.md"), "x").unwrap(); // dotfile
        fs::write(dir.join("x.md.mermark-tmp.1"), "x").unwrap(); // autosave temp
        fs::write(dir.join("y.md.mermark-recovered"), "x").unwrap(); // recovery marker
        fs::write(dir.join("real.md"), "x").unwrap(); // valid file
        fs::create_dir_all(dir.join("sub")).unwrap(); // valid dir
        let got = list_dir(dir.to_string_lossy().into_owned(), false).unwrap();
        let order: Vec<&str> = got.iter().map(|e| e.name.as_str()).collect();
        // hidden + artifacts excluded; folder first, then file.
        assert_eq!(order, vec!["sub", "real.md"]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn list_dir_show_hidden_includes_dotfiles_but_never_artifacts() {
        // Same fixture as list_dir_excludes_hidden_and_artifacts, but called
        // with show_hidden=true: dotfiles must now appear, while mermark's own
        // artifacts (never dotfiles themselves) must still be absent — proving
        // the artifact exclusion is unconditional, not accidentally covered by
        // the dotfile check.
        let dir = temp_dir("ld_show_hidden");
        fs::create_dir_all(dir.join(".git")).unwrap(); // hidden dir
        fs::write(dir.join(".hidden.md"), "x").unwrap(); // dotfile
        fs::write(dir.join("x.md.mermark-tmp.1"), "x").unwrap(); // autosave temp
        fs::write(dir.join("y.md.mermark-recovered"), "x").unwrap(); // recovery marker
        fs::write(dir.join("real.md"), "x").unwrap(); // valid file
        fs::create_dir_all(dir.join("sub")).unwrap(); // valid dir
        let got = list_dir(dir.to_string_lossy().into_owned(), true).unwrap();
        let order: Vec<&str> = got.iter().map(|e| e.name.as_str()).collect();
        // dotfiles now included (folders first, then files — each group's own
        // dotfile sorts first ascii-wise); artifacts still excluded.
        assert_eq!(order, vec![".git", "sub", ".hidden.md", "real.md"]);
        fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn list_dir_shows_symlink_dir_without_recursing() {
        use std::os::unix::fs::symlink;
        // base/ contains a symlink `link` -> an outside dir holding `secret.md`.
        // `link` must appear as is_dir=true (not blocked, unlike resolve_image),
        // but list_dir reads only one level — `secret.md` never leaks into the result.
        let base = temp_dir("ld_symlink");
        let outside = temp_dir("ld_symlink_outside");
        fs::write(outside.join("secret.md"), "x").unwrap();
        symlink(&outside, base.join("link")).unwrap();
        let got = list_dir(base.to_string_lossy().into_owned(), false).unwrap();
        let link = got.iter().find(|e| e.name == "link").expect("symlink dir is shown");
        assert!(link.is_dir, "symlink-to-dir reports is_dir=true");
        assert!(
            !got.iter().any(|e| e.name == "secret.md"),
            "one level only — the symlink's target contents don't leak in"
        );
        fs::remove_dir_all(&base).ok();
        fs::remove_dir_all(&outside).ok();
    }

    // --- list_files_recursive / walk_files_recursive (⌘⇧F fuzzy file-finder scan) ---

    #[test]
    fn scan_returns_nested_files_sorted_by_rel_path() {
        let dir = temp_dir("scan_nested");
        fs::create_dir_all(dir.join("sub/deep")).unwrap();
        fs::write(dir.join("z.md"), "x").unwrap();
        fs::write(dir.join("sub/a.md"), "x").unwrap();
        fs::write(dir.join("sub/deep/b.md"), "x").unwrap();
        let got = list_files_recursive(dir.to_string_lossy().into_owned(), false).unwrap();
        assert!(!got.truncated);
        let rels: Vec<&str> = got.files.iter().map(|f| f.rel_path.as_str()).collect();
        // files only (no directory rows), rel_path-ascending.
        assert_eq!(rels, vec!["sub/a.md", "sub/deep/b.md", "z.md"]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scan_excludes_heavy_dirs_unconditionally() {
        let dir = temp_dir("scan_excluded");
        fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join("node_modules/pkg/index.js"), "x").unwrap();
        fs::write(dir.join(".git/HEAD"), "x").unwrap();
        fs::write(dir.join("real.md"), "x").unwrap();
        // show_hidden=true does NOT override the unconditional exclusion.
        let got = list_files_recursive(dir.to_string_lossy().into_owned(), true).unwrap();
        let rels: Vec<&str> = got.files.iter().map(|f| f.rel_path.as_str()).collect();
        assert_eq!(rels, vec!["real.md"], "node_modules/.git contents never surface");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scan_dotfiles_follow_show_hidden_policy() {
        let dir = temp_dir("scan_dotfiles");
        fs::write(dir.join(".hidden.md"), "x").unwrap();
        fs::write(dir.join("real.md"), "x").unwrap();
        let off = list_files_recursive(dir.to_string_lossy().into_owned(), false).unwrap();
        assert_eq!(
            off.files.iter().map(|f| f.rel_path.as_str()).collect::<Vec<_>>(),
            vec!["real.md"],
            "dotfiles excluded when show_hidden=false"
        );
        let on = list_files_recursive(dir.to_string_lossy().into_owned(), true).unwrap();
        assert_eq!(
            on.files.iter().map(|f| f.rel_path.as_str()).collect::<Vec<_>>(),
            vec![".hidden.md", "real.md"],
            "dotfiles included when show_hidden=true"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scan_excludes_mermark_artifacts_unconditionally() {
        let dir = temp_dir("scan_artifacts");
        fs::write(dir.join("x.md.mermark-tmp.1"), "x").unwrap();
        fs::write(dir.join("y.md.mermark-recovered"), "x").unwrap();
        fs::write(dir.join("real.md"), "x").unwrap();
        let got = list_files_recursive(dir.to_string_lossy().into_owned(), true).unwrap();
        assert_eq!(
            got.files.iter().map(|f| f.rel_path.as_str()).collect::<Vec<_>>(),
            vec!["real.md"]
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scan_stops_at_max_files_and_reports_truncated() {
        let dir = temp_dir("scan_maxfiles");
        for name in ["a.md", "b.md", "c.md", "d.md", "e.md"] {
            fs::write(dir.join(name), "x").unwrap();
        }
        // max_files=3 on a flat 5-file dir: the walk stops after the 3rd push
        // (children are visited in sorted order within one directory).
        let (files, truncated) = walk_files_recursive(&dir, false, MAX_SCAN_DEPTH, 3);
        assert_eq!(files.len(), 3, "walk stops exactly at the ceiling");
        assert!(truncated, "hitting the ceiling must be reported honestly");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scan_stops_at_max_depth_and_reports_truncated() {
        let dir = temp_dir("scan_maxdepth");
        // depth: dir(0)/a(1)/b(2)/c(3)/deep.md — deep.md sits in a dir reached
        // at depth 3, one level past max_depth=2.
        fs::create_dir_all(dir.join("a/b/c")).unwrap();
        fs::write(dir.join("a/b/c/deep.md"), "x").unwrap();
        fs::write(dir.join("shallow.md"), "x").unwrap();
        let (files, truncated) = walk_files_recursive(&dir, false, 2, MAX_SCAN_FILES);
        let rels: Vec<&str> = files.iter().map(|f| f.rel_path.as_str()).collect();
        assert!(rels.contains(&"shallow.md"), "within-depth file is included");
        assert!(!rels.contains(&"a/b/c/deep.md"), "past-ceiling file is excluded, got {rels:?}");
        assert!(truncated, "hitting the depth ceiling must be reported honestly");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scan_missing_root_is_graceful_err() {
        let missing = std::env::temp_dir()
            .join(format!("mermark_scan_missing_{}", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let res = list_files_recursive(missing, false);
        assert!(res.is_err(), "missing root is a graceful error, never a panic");
    }

    #[cfg(unix)]
    #[test]
    fn scan_does_not_follow_directory_symlinks() {
        use std::os::unix::fs::symlink;
        // base/link -> outside/, which holds a file that must never surface.
        let base = temp_dir("scan_symlink_base");
        let outside = temp_dir("scan_symlink_outside");
        fs::write(outside.join("leak.md"), "x").unwrap();
        symlink(&outside, base.join("link")).unwrap();
        fs::write(base.join("real.md"), "x").unwrap();
        let got = list_files_recursive(base.to_string_lossy().into_owned(), false).unwrap();
        let rels: Vec<&str> = got.files.iter().map(|f| f.rel_path.as_str()).collect();
        assert_eq!(rels, vec!["real.md"], "symlinked directory is never walked into");
        fs::remove_dir_all(&base).ok();
        fs::remove_dir_all(&outside).ok();
    }
}
