use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::UNIX_EPOCH;
use tauri::{WebviewUrl, WebviewWindowBuilder};

static WINDOW_SEQ: AtomicU32 = AtomicU32::new(1);
static TMP_SEQ: AtomicU64 = AtomicU64::new(1);

/// Expand a leading `~` (bare `~` or `~/…`) to the user's home directory, then
/// hand the rest off to `normalize_path`. This exists because the path-shape
/// pipeline (`normalize_path`) treats `~` as a *literal* component, so a typed
/// path like `~/notes/x.md` would otherwise resolve to a directory named `~`
/// and fail. The footer "open path" feature lets users type `~/…`, so the
/// tilde rule belongs here as one named function rather than an inline branch.
///
/// Conservative by design:
/// - `~` alone → the home directory.
/// - `~/rest` → `<home>/rest` (the `~` is the *whole* first component).
/// - `~user/…` (tilde immediately followed by a non-separator, i.e. a named
///   account like `~bob/…`) is left **untouched** — we don't resolve other
///   users' homes, so we never over-expand a path we can't safely interpret.
/// - Anything not starting with `~`, and the fallback when the home directory
///   is unknown (e.g. headless test env with no `$HOME`), is returned verbatim.
///
/// Returns an absolute, normalized `PathBuf` (the home dir is itself absolute),
/// so this opens no new write surface and can't be used to escape via `..`:
/// `normalize_path` collapses `..`/`.` exactly as it does for every other path.
fn expand_home(path: &str) -> PathBuf {
    let expanded = if path == "~" {
        home_dir().map(|h| h.to_string_lossy().into_owned())
    } else if let Some(rest) = path.strip_prefix("~/") {
        // `~/rest`: the tilde is its own first component → safe to expand.
        home_dir().map(|h| h.join(rest).to_string_lossy().into_owned())
    } else {
        // `~user/…` or no leading tilde at all → leave verbatim.
        None
    };
    normalize_path(Path::new(expanded.as_deref().unwrap_or(path)))
}

/// The current user's home directory, or `None` when the environment can't
/// report it. Reads `$HOME` (set on every macOS/Linux desktop session) via the
/// standard library so no extra crate is pulled in just for one lookup; `None`
/// makes `expand_home` fall back to leaving the path verbatim.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Normalize path components (resolve relative "." and "..") purely textually.
/// `pub(crate)` so `bundle.rs` reuses the *same* `..`/`.` collapse the file
/// commands use when resolving wikilink targets — one source of truth for path
/// shape, so a bundled link resolves to the same place the editor would open.
pub(crate) fn normalize_path(path: &Path) -> PathBuf {
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
#[derive(serde::Serialize)]
pub struct FileContent {
    pub text: String,
    pub mtime: u64,
}

/// Read a file's UTF-8 contents and its modification time. Used at startup.
#[tauri::command]
pub fn read_file(path: String) -> Result<FileContent, String> {
    let normalized = expand_home(&path).to_string_lossy().into_owned();
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
///
/// After a successful write it records the new mtime as a self-write on the fs
/// watcher's `WatchState`, so the watcher event our own rename provokes is muted
/// instead of being mistaken for an external change (the auto-reload loop guard).
/// The signature the frontend sees is unchanged — `WatchState` is injected by
/// Tauri's managed state, not passed from JS — so the existing mock stays valid.
#[tauri::command]
pub fn write_file(
    path: String,
    text: String,
    baseline: u64,
    watch: tauri::State<'_, crate::watcher::WatchState>,
) -> Result<u64, String> {
    write_file_with_state(&path, &text, baseline, &watch)
}

/// Pure core of `write_file`, threading the `WatchState` explicitly so tests can
/// inject a fresh one and assert the self-write was recorded. The atomic
/// temp-rename and `CONFLICT:` conflict-guard live here unchanged; the only added
/// behaviour over the old body is `record_self_write` right before returning.
fn write_file_with_state(
    path: &str,
    text: &str,
    baseline: u64,
    watch: &crate::watcher::WatchState,
) -> Result<u64, String> {
    let normalized = normalize_path(Path::new(path)).to_string_lossy().into_owned();
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
        let _ = std::fs::remove_file(&tmp); // don't leave the temp behind on failure
        format!("rename {tmp} -> {normalized}: {e}")
    })?;
    let new_mtime = mtime_ms(&normalized);
    // Mute the watcher event this write is about to trigger: record our own
    // post-write mtime so `is_self_write(new_mtime)` returns true on the callback.
    watch.record_self_write(new_mtime);
    Ok(new_mtime)
}

/// Begin watching the single open file at `path` for external changes, replacing
/// any previously watched file (single slot). Thin command wrapper over
/// `watcher::set_watch`; the security-relevant invariant — exactly one file, never
/// a folder or arbitrary path tree — lives there. `path` is a single-word arg for
/// the same JS↔Rust mapping reason as `write_file`'s `baseline`.
#[tauri::command]
pub fn watch_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    crate::watcher::set_watch(&app, path)
}

/// Stop watching the current file (teardown, or before re-watching a new path).
/// Idempotent: unwatching when nothing is watched is a harmless no-op.
#[tauri::command]
pub fn unwatch_file(app: tauri::AppHandle) -> Result<(), String> {
    crate::watcher::clear_watch(&app);
    Ok(())
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
    let normalized = expand_home(&path);
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

/// Package the file at `path` plus its one-hop wikilinked documents into an XML
/// bundle string for an LLM (⌘⇧C in the editor). A thin wrapper over
/// `bundle::bundle_to_string`, which owns the scan/containment/format spec so
/// this command and the `mermark bundle` CLI produce identical output. Read-only.
#[tauri::command]
pub fn bundle_doc(path: String) -> Result<String, String> {
    crate::bundle::bundle_to_string(&path)
}

/// A `[[`-pickable target in a directory: a markdown note or an inlineable image.
/// `name` is the insertion label, `rel` is the directory-relative path (always the
/// file name today — non-recursive — but kept so a future recursive scan can fill
/// `sub/note.md` without changing the shape), and `kind` lets the frontend branch
/// its insertion rule. The frontend mirrors this exact shape in
/// `src/mocks/tauri-core.ts` and its `invoke<LinkTarget[]>("list_link_targets")`.
#[derive(serde::Serialize)]
pub struct LinkTarget {
    /// Insertion label: a markdown note's basename (no `.md`), or an image's full
    /// file name (extension included, Obsidian embed convention).
    pub name: String,
    /// Path relative to the listed directory. Equals the file name today (current
    /// folder only); reserved for a future recursive scan / duplicate-name split.
    pub rel: String,
    /// `"markdown"` or `"image"` — the frontend's `![[…]]`-vs-`[[…]]` branch.
    pub kind: String,
}

/// Whether `ext` (without the dot) names an image mermark can inline. This is the
/// Rust half of one truth shared with `wikilink.ts`'s `isImageTarget` regex
/// (`png|jpe?g|gif|webp|svg|avif|bmp`); the two sets must stay identical so the
/// picker and the embed renderer agree on what counts as an image. Case-insensitive
/// to match the TS `/i` flag.
fn is_image_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "avif" | "bmp"
    )
}

/// The basename (final path component) of a possibly-pathful image reference.
/// `foo/bar.png` → `bar.png`, `./pic.png` → `pic.png`, bare `pic.png` → `pic.png`.
/// One named place for the "what filename are we hunting for" rule, so the scan
/// never re-derives it inline. Works for both `/` and the platform separator via
/// `Path::file_name`; falls back to the whole string if there is no final
/// component (e.g. a trailing separator), which simply won't match any real file.
fn image_basename(name: &str) -> &str {
    Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(name)
}

/// Case-insensitive basename equality, the single matching rule for the recursive
/// image scan. ASCII fold (`eq_ignore_ascii_case`) matches `is_image_ext`'s own
/// case policy and the APFS reality that `Photo.PNG` and `photo.png` are the same
/// file — a case-*sensitive* match would miss files the OS itself considers equal.
/// Unicode case-folding is deliberately out of scope (YAGNI for filenames).
fn basename_matches(entry: &str, target: &str) -> bool {
    entry.eq_ignore_ascii_case(target)
}

/// The path-escape guard: is `candidate` contained within `base`? Both are
/// normalized (`..`/`.` collapsed) before a prefix check, so a candidate can never
/// resolve above the base directory. This is the single source of truth for the
/// "anti-vault / no parent escape" invariant — the BFS only ever descends into
/// children, but this prefix check is the structural second line of defence (and
/// the one that catches a symlink target pointing outside the base).
fn is_within_base(base: &Path, candidate: &Path) -> bool {
    let base = normalize_path(base);
    let candidate = normalize_path(candidate);
    candidate.starts_with(&base)
}

/// Whether a *matched file candidate* truly stays inside `base`, accounting for
/// symlinks. The lexical `is_within_base` is enough for a real file (its path is
/// already where it lives), but a **file symlink** can name a path lexically under
/// `base` while pointing at a target outside it (`base/evil.png` → `/etc/secret`).
/// The directory walk refuses to follow directory symlinks; this is the symmetric
/// guard for file symlinks, closing the one remaining escape: when the candidate is
/// a symlink we `canonicalize` it and re-check the *resolved target* against `base`.
/// A broken/unreadable symlink (canonicalize fails) is treated as outside — fail
/// closed. A plain file skips the extra syscall (lexical containment suffices).
/// `meta` is the candidate's `symlink_metadata`, already fetched by the caller.
fn file_target_is_within_base(base: &Path, candidate: &Path, meta: &std::fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        // Resolve the link's real target and pen *that* inside base; a link whose
        // target escapes (or can't be resolved) is rejected. The base is
        // canonicalized too so both sides are compared in fully-resolved form —
        // otherwise an OS-level symlinked ancestor (e.g. macOS `/var` →
        // `/private/var`) would make an in-base target spuriously fail the prefix
        // check. If the base itself can't be canonicalized, fail closed.
        match (std::fs::canonicalize(candidate), std::fs::canonicalize(base)) {
            (Ok(resolved), Ok(real_base)) => resolved.starts_with(&real_base),
            _ => false, // broken/dangling symlink or unresolvable base → fail closed
        }
    } else {
        // A real file lives exactly where its path says; lexical check is enough.
        is_within_base(base, candidate)
    }
}

/// Hard ceiling on directory entries visited in one `scan_match` call. Paired with
/// `max_depth`, this caps the cost of a fallback scan over a pathologically large
/// folder: once this many entries have been inspected the scan gives up and returns
/// whatever (if anything) it has found. A bounded best-effort search, never a
/// runaway walk. 2000 is comfortably above any realistic note folder's image count
/// while still bounding worst-case latency to a few milliseconds.
const MAX_ENTRIES: u32 = 2000;

/// Deterministic, bounded, children-only recursive search for an image file whose
/// basename matches `target_basename`, rooted at `base` and descending at most
/// `max_depth` levels (clamped to 3). Returns the first match in a stable order:
/// shallower directories first, then path-ascending within a level (so the same
/// tree always yields the same hit). Read-only; never follows directory symlinks
/// (which could escape `base`) and never follows a file symlink whose target lands
/// outside `base` (`is_within_base`). Any unreadable directory is silently skipped
/// rather than aborting the whole scan — this is a best-effort fallback, not a
/// command the user explicitly invoked, so it degrades to `None` instead of erroring.
fn scan_match(base: &Path, target_basename: &str, max_depth: u8) -> Option<PathBuf> {
    // Clamp depth to the documented ceiling so a caller can never request an
    // unbounded walk. `max_depth` counts levels *below* `base` (depth 1 = direct
    // children).
    let max_depth = max_depth.min(3);
    if target_basename.is_empty() {
        return None;
    }
    let base = normalize_path(base);

    // BFS by level so "shallower first" is structural, not a post-sort. Each queue
    // entry is (directory, depth-of-that-directory). `base` itself is depth 0.
    let mut queue: std::collections::VecDeque<(PathBuf, u8)> =
        std::collections::VecDeque::new();
    queue.push_back((base.clone(), 0));
    let mut visited: u32 = 0;

    while let Some((dir, depth)) = queue.pop_front() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue, // unreadable dir → skip, don't abort the scan
        };
        // Collect + sort this directory's entries so iteration order is stable
        // regardless of the filesystem's native read_dir ordering.
        let mut children: Vec<PathBuf> =
            entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
        children.sort();

        // First pass: look for a matching image file at this level (so a hit in a
        // shallower directory always wins over one deeper down).
        for path in &children {
            visited += 1;
            if visited > MAX_ENTRIES {
                return None; // cost ceiling reached → bounded best-effort gives up
            }
            // A symlink whose metadata says "file" is fine *if* its resolved path
            // stays within base; `symlink_metadata` avoids following it blindly.
            let meta = match std::fs::symlink_metadata(path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if !meta.file_type().is_dir() {
                let file_name = match path.file_name().and_then(|n| n.to_str()) {
                    Some(n) => n,
                    None => continue,
                };
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                if is_image_ext(ext)
                    && basename_matches(file_name, target_basename)
                    && file_target_is_within_base(&base, path, &meta)
                {
                    return Some(path.clone());
                }
            }
        }

        // Second pass: enqueue child directories for the next level, unless we're
        // already at the depth ceiling. Directory *symlinks* are never followed —
        // they're the one way a children-only walk could still escape `base`.
        if depth < max_depth {
            for path in &children {
                let meta = match std::fs::symlink_metadata(path) {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                // `symlink_metadata` reports the link itself: a symlinked dir has
                // `is_symlink()` true and we skip it; a real dir is descended into.
                if meta.file_type().is_dir() && !meta.file_type().is_symlink() {
                    queue.push_back((path.clone(), depth + 1));
                }
            }
        }
    }
    None
}

/// Resolve an image reference that failed to load from its literal path by scanning
/// `base_dir` and up to `max_depth` levels of subdirectories for a file with the
/// same basename. Returns the found absolute path, or `None` when nothing matches.
///
/// `Option` (not `Result`) on purpose: "not found" is the *normal* outcome of a
/// best-effort fallback (the image simply stays broken, as it does today), not an
/// error to surface. An unreadable directory is absorbed into `None` rather than
/// propagated — unlike `list_link_targets`, the user never explicitly asked for
/// this scan, so it must degrade silently.
///
/// Read-only: enumerates directories, never writes, so the atomic-write /
/// conflict-guard machinery doesn't apply. Security: the search is penned inside
/// `base_dir` by `is_within_base` and never follows directory symlinks, so a match
/// can never resolve above the base directory (the anti-vault invariant).
///
/// `base_dir`/`name`/`max_depth` are single-/clear-word args; Tauri maps them to
/// `baseDir`/`name`/`maxDepth` on the JS side, which the `invoke` call and the
/// browser mock must mirror.
#[tauri::command]
pub fn resolve_image(base_dir: String, name: String, max_depth: u8) -> Option<String> {
    let target = image_basename(&name);
    let base = normalize_path(Path::new(&base_dir));
    scan_match(&base, target, max_depth).map(|p| p.to_string_lossy().into_owned())
}

/// Whether a file name is a mermark scratch/recovery artifact that must never be
/// offered as a link target. Mirrors the autosave temp suffix (`.mermark-tmp.`)
/// and the recovery marker (`.mermark-recovered`) so the picker doesn't surface
/// the editor's own working files. Named so the exclusion rule reads as one fact.
fn is_mermark_artifact(file_name: &str) -> bool {
    file_name.contains(".mermark-tmp.") || file_name.contains(".mermark-recovered")
}

/// Classify a single directory entry into a `LinkTarget`, or `None` when it isn't
/// a pickable target. The domain rule lives here as one named function instead of
/// being scattered through `list_link_targets`: a `.md` file becomes a markdown
/// target labeled by its stem; a file with an image extension becomes an image
/// target labeled by its full name; everything else — directories, dotfiles,
/// mermark artifacts, and non-target files — is excluded. `path` is expected to be
/// directory-local (a single entry name); `rel` is set to that file name.
fn classify_link_target(path: &Path) -> Option<LinkTarget> {
    if path.is_dir() {
        return None;
    }
    let file_name = path.file_name()?.to_str()?.to_owned();
    // Hidden dotfiles and the editor's own scratch/recovery files are never targets.
    if file_name.starts_with('.') || is_mermark_artifact(&file_name) {
        return None;
    }
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if ext.eq_ignore_ascii_case("md") {
        let stem = path.file_stem()?.to_str()?.to_owned();
        return Some(LinkTarget { name: stem, rel: file_name, kind: "markdown".into() });
    }
    if is_image_ext(ext) {
        return Some(LinkTarget { name: file_name.clone(), rel: file_name, kind: "image".into() });
    }
    None
}

/// Display rank for the "markdown first, then images" ordering. Encoded as an
/// explicit ordinal rather than relying on the alphabetical order of the `kind`
/// string — `"image"` sorts *before* `"markdown"` lexically, which is the opposite
/// of what we want, so the intent ("notes before images") gets its own number.
fn link_target_kind_rank(kind: &str) -> u8 {
    match kind {
        "markdown" => 0,
        _ => 1, // images (and any future kinds) after notes
    }
}

/// Sort key for a deterministic picker list: markdown targets before images
/// (by `link_target_kind_rank`), then case-insensitively by `name`. Pulled out so
/// the "markdown first, then name" ordering is one named rule, not an inline closure.
fn link_target_sort_key(t: &LinkTarget) -> (u8, String) {
    (link_target_kind_rank(&t.kind), t.name.to_ascii_lowercase())
}

/// List the markdown notes and inlineable images directly inside `dir` (current
/// folder only — non-recursive) as `[[`-pickable targets. Read-only: enumerates,
/// never writes, so the atomic-write/conflict-guard machinery doesn't apply.
///
/// Graceful by design: a missing/unreadable directory returns `Err(String)`
/// (never panics), while an individual unreadable entry (broken symlink, permission
/// hiccup) is skipped via `filter_map(ok)` so one bad entry can't sink the whole
/// list. An empty directory yields `Ok(vec![])`. Output is sorted (markdown first,
/// then case-insensitive name) for stable tests and golden snapshots.
#[tauri::command]
pub fn list_link_targets(dir: String) -> Result<Vec<LinkTarget>, String> {
    let normalized = normalize_path(Path::new(&dir));
    let entries = std::fs::read_dir(&normalized)
        .map_err(|e| format!("list {}: {e}", normalized.display()))?;
    let mut targets: Vec<LinkTarget> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| classify_link_target(&entry.path()))
        .collect();
    targets.sort_by_key(link_target_sort_key);
    Ok(targets)
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
        assert!(state.is_self_write(m), "the write's own mtime must be muted as a self-write");
        assert!(!state.is_self_write(m + 1), "a strictly-newer mtime is still external");
        fs::remove_file(&p).ok();
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

    // --- expand_home (`~` tilde expansion for typed open-path) ---
    //
    // These tests set `$HOME` to a known value so home expansion is
    // deterministic regardless of the machine running them. `expand_home` reads
    // `$HOME` through `home_dir()`, so they assert against that exact root.

    #[test]
    fn expand_home_replaces_leading_tilde_slash() {
        std::env::set_var("HOME", "/home/tester");
        assert_eq!(
            expand_home("~/notes/x.md"),
            PathBuf::from("/home/tester/notes/x.md")
        );
    }

    #[test]
    fn expand_home_bare_tilde_is_the_home_dir() {
        std::env::set_var("HOME", "/home/tester");
        assert_eq!(expand_home("~"), PathBuf::from("/home/tester"));
    }

    #[test]
    fn expand_home_leaves_absolute_path_unchanged() {
        std::env::set_var("HOME", "/home/tester");
        // No leading tilde → returned verbatim (only normalized).
        assert_eq!(expand_home("/abs/x.md"), PathBuf::from("/abs/x.md"));
    }

    #[test]
    fn expand_home_leaves_relative_path_unchanged() {
        std::env::set_var("HOME", "/home/tester");
        // Relative paths carry no tilde → normalized but not anchored to home.
        assert_eq!(expand_home("sub/x.md"), PathBuf::from("sub/x.md"));
    }

    #[test]
    fn expand_home_does_not_expand_named_user_tilde() {
        std::env::set_var("HOME", "/home/tester");
        // `~bob/…` is a *different* user's home, which we never resolve — left
        // verbatim so we don't over-expand a path we can't safely interpret.
        assert_eq!(expand_home("~bob/x.md"), PathBuf::from("~bob/x.md"));
    }

    #[test]
    fn expand_home_normalizes_after_expansion() {
        std::env::set_var("HOME", "/home/tester");
        // `..` inside an expanded path is collapsed by normalize_path, so a
        // tilde path can't escape via `..` any more than a literal one can.
        assert_eq!(
            expand_home("~/notes/../x.md"),
            PathBuf::from("/home/tester/x.md")
        );
    }

    // --- list_link_targets (`[[` file picker enumeration) ---

    /// A fresh, isolated directory for picker tests, PID- and tag-keyed so
    /// concurrent test binaries don't collide.
    fn temp_dir(tag: &str) -> PathBuf {
        let n = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir()
            .join(format!("mermark_links_{}_{}_{tag}", std::process::id(), n));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lists_md_and_image_targets() {
        let dir = temp_dir("md_and_img");
        fs::write(dir.join("a.md"), "x").unwrap();
        fs::write(dir.join("note.md"), "x").unwrap();
        fs::write(dir.join("pic.png"), "x").unwrap();
        let got = list_link_targets(dir.to_string_lossy().into_owned()).unwrap();
        assert_eq!(got.len(), 3, "two md + one image");
        // markdown is labeled by stem (no `.md`); image by full file name.
        let a = got.iter().find(|t| t.rel == "a.md").unwrap();
        assert_eq!(a.name, "a");
        assert_eq!(a.kind, "markdown");
        let pic = got.iter().find(|t| t.rel == "pic.png").unwrap();
        assert_eq!(pic.name, "pic.png");
        assert_eq!(pic.kind, "image");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn excludes_non_targets() {
        let dir = temp_dir("non_targets");
        fs::write(dir.join("data.json"), "x").unwrap();
        fs::write(dir.join("script.ts"), "x").unwrap();
        fs::write(dir.join("readme.txt"), "x").unwrap();
        let got = list_link_targets(dir.to_string_lossy().into_owned()).unwrap();
        assert!(got.is_empty(), "non-md/non-image files are excluded, got {:?}", got.iter().map(|t| &t.rel).collect::<Vec<_>>());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn excludes_dirs_and_dotfiles_and_artifacts() {
        let dir = temp_dir("excludes");
        fs::create_dir_all(dir.join("sub")).unwrap(); // a subdirectory
        fs::write(dir.join("sub/buried.md"), "x").unwrap(); // not recursed into
        fs::write(dir.join(".hidden.md"), "x").unwrap(); // dotfile
        fs::write(dir.join("x.md.mermark-tmp.1"), "x").unwrap(); // autosave temp
        fs::write(dir.join("y.md.mermark-recovered"), "x").unwrap(); // recovery marker
        fs::write(dir.join("real.md"), "x").unwrap(); // the only valid target
        let got = list_link_targets(dir.to_string_lossy().into_owned()).unwrap();
        assert_eq!(got.len(), 1, "only real.md survives, got {:?}", got.iter().map(|t| &t.rel).collect::<Vec<_>>());
        assert_eq!(got[0].name, "real");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_dir_returns_empty() {
        let dir = temp_dir("empty");
        let got = list_link_targets(dir.to_string_lossy().into_owned()).unwrap();
        assert!(got.is_empty(), "an empty directory yields an empty vec");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_dir_is_graceful_err() {
        // A path that doesn't exist must return Err (graceful), never panic.
        let missing = std::env::temp_dir()
            .join(format!("mermark_links_missing_{}", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let res = list_link_targets(missing);
        assert!(res.is_err(), "missing directory is a graceful error");
    }

    #[test]
    fn sorted_markdown_first_then_name() {
        let dir = temp_dir("sorted");
        fs::write(dir.join("z.md"), "x").unwrap();
        fs::write(dir.join("a.png"), "x").unwrap();
        fs::write(dir.join("b.md"), "x").unwrap();
        let got = list_link_targets(dir.to_string_lossy().into_owned()).unwrap();
        // kind asc (markdown before image), then name asc (case-insensitive).
        let order: Vec<&str> = got.iter().map(|t| t.rel.as_str()).collect();
        assert_eq!(order, vec!["b.md", "z.md", "a.png"], "markdown first, then by name");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn image_ext_set_matches_isimagetarget() {
        // Every extension wikilink.ts's isImageTarget accepts must classify as an
        // image here too, case-insensitively — one shared truth across the boundary.
        let dir = temp_dir("img_exts");
        for name in ["t.PNG", "t.jpeg", "t.webp", "t.svg", "t.avif", "t.bmp", "t.gif", "t.jpg"] {
            fs::write(dir.join(name), "x").unwrap();
        }
        let got = list_link_targets(dir.to_string_lossy().into_owned()).unwrap();
        assert_eq!(got.len(), 8, "all eight image extensions are recognized");
        assert!(got.iter().all(|t| t.kind == "image"), "all classify as image kind");
        fs::remove_dir_all(&dir).ok();
    }

    // --- resolve_image (recursive image fallback search) ---
    //
    // Each test builds an isolated fixture tree under temp_dir() and tears it
    // down. The `.test/` directory is never touched — these own their fixtures.

    #[test]
    fn resolve_finds_basename_in_subdir() {
        // baseDir/sub/deep/pic.png is found by basename, returning its abs path.
        let dir = temp_dir("resolve_subdir");
        fs::create_dir_all(dir.join("sub/deep")).unwrap();
        let target = dir.join("sub/deep/pic.png");
        fs::write(&target, "img").unwrap();
        let got = resolve_image(dir.to_string_lossy().into_owned(), "pic.png".into(), 3);
        assert_eq!(got, Some(normalize_path(&target).to_string_lossy().into_owned()));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_finds_basename_from_pathful_name() {
        // A name carrying a stale path (`old/dir/pic.png`) is matched by its
        // basename `pic.png` wherever it actually lives now.
        let dir = temp_dir("resolve_pathful");
        fs::create_dir_all(dir.join("assets")).unwrap();
        let target = dir.join("assets/pic.png");
        fs::write(&target, "img").unwrap();
        let got = resolve_image(
            dir.to_string_lossy().into_owned(),
            "../old/dir/pic.png".into(),
            3,
        );
        assert_eq!(got, Some(normalize_path(&target).to_string_lossy().into_owned()));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_respects_depth_limit() {
        // The depth ceiling is exact, not off-by-one. A file at depth 3
        // (base/a/b/c/pic.png) is reachable at max_depth=3 but NOT at max_depth=2,
        // which pins the level counting precisely (depth 1 = direct children).
        let dir = temp_dir("resolve_depth");
        fs::create_dir_all(dir.join("a/b/c")).unwrap();
        let buried = dir.join("a/b/c/pic.png");
        fs::write(&buried, "img").unwrap();

        let at3 = resolve_image(dir.to_string_lossy().into_owned(), "pic.png".into(), 3);
        assert_eq!(
            at3,
            Some(normalize_path(&buried).to_string_lossy().into_owned()),
            "a depth-3 file is reachable at max_depth=3"
        );

        // One level shallower than needed → unreachable (proves no off-by-one).
        let at2 = scan_match(&dir, "pic.png", 2);
        assert_eq!(at2, None, "a depth-3 file must be invisible at max_depth=2");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_blocks_path_escape() {
        // A same-named file in a *sibling* of base (outside the search root) must
        // never be returned. baseDir is `root/base`; the decoy is `root/sibling`.
        let root = temp_dir("resolve_escape");
        fs::create_dir_all(root.join("base")).unwrap();
        fs::create_dir_all(root.join("sibling")).unwrap();
        fs::write(root.join("sibling/secret.png"), "outside").unwrap();
        let base = root.join("base");
        // Even a name that tries to climb out resolves only by basename within base.
        let got = resolve_image(
            base.to_string_lossy().into_owned(),
            "../sibling/secret.png".into(),
            3,
        );
        assert_eq!(got, None, "a file outside baseDir must never be resolved");
        fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn resolve_does_not_follow_directory_symlink_out_of_base() {
        // A directory symlink inside base pointing OUTSIDE base must not be
        // descended into, or the scan could escape the vault. Unix-only because
        // symlink creation differs on Windows (skip there).
        use std::os::unix::fs::symlink;
        let root = temp_dir("resolve_symlink");
        fs::create_dir_all(root.join("base")).unwrap();
        fs::create_dir_all(root.join("outside")).unwrap();
        fs::write(root.join("outside/leak.png"), "secret").unwrap();
        // base/link -> ../outside  (a dir symlink escaping base)
        symlink(root.join("outside"), root.join("base/link")).unwrap();
        let base = root.join("base");
        let got = resolve_image(base.to_string_lossy().into_owned(), "leak.png".into(), 3);
        assert_eq!(got, None, "directory symlinks must not be followed out of base");
        fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn resolve_does_not_follow_file_symlink_out_of_base() {
        // A *file* symlink inside base whose target is OUTSIDE base must not be
        // returned: it names a path lexically under base but resolves elsewhere.
        // This is the symmetric guard to the directory-symlink test — without
        // canonicalizing the candidate, the lexical containment check would wrongly
        // accept base/evil.png. Unix-only (symlink semantics differ on Windows).
        use std::os::unix::fs::symlink;
        let root = temp_dir("resolve_file_symlink");
        fs::create_dir_all(root.join("base")).unwrap();
        fs::create_dir_all(root.join("outside")).unwrap();
        let secret = root.join("outside/secret.png");
        fs::write(&secret, "secret").unwrap();
        // base/evil.png -> ../outside/secret.png (a file symlink escaping base)
        symlink(&secret, root.join("base/evil.png")).unwrap();
        let base = root.join("base");
        let got = resolve_image(base.to_string_lossy().into_owned(), "evil.png".into(), 3);
        assert_eq!(got, None, "a file symlink resolving outside base must never be returned");
        fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn resolve_follows_file_symlink_that_stays_within_base() {
        // The flip side: a file symlink whose target is still INSIDE base is a
        // legitimate hit — the canonicalized target passes is_within_base. Proves
        // the guard rejects only escapes, not all symlinks.
        use std::os::unix::fs::symlink;
        let base = temp_dir("resolve_file_symlink_ok");
        fs::create_dir_all(base.join("real")).unwrap();
        let real = base.join("real/actual.png");
        fs::write(&real, "img").unwrap();
        // base/pic.png -> real/actual.png (in-base symlink)
        symlink(&real, base.join("pic.png")).unwrap();
        let got = resolve_image(base.to_string_lossy().into_owned(), "pic.png".into(), 3);
        // The returned path is the symlink's own path (the match candidate), which
        // is within base; convertFileSrc resolves it to the in-base target.
        assert_eq!(got, Some(normalize_path(&base.join("pic.png")).to_string_lossy().into_owned()));
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn resolve_filters_by_extension() {
        // pic.txt / pic.md share the basename stem but aren't images; only the
        // real image extension is a candidate (is_image_ext reuse).
        let dir = temp_dir("resolve_ext");
        fs::write(dir.join("pic.txt"), "x").unwrap();
        fs::write(dir.join("pic.md"), "x").unwrap();
        let none = resolve_image(dir.to_string_lossy().into_owned(), "pic.txt".into(), 3);
        assert_eq!(none, None, "a .txt is never an image candidate");
        // Now add the real image and confirm it's the one that resolves.
        fs::write(dir.join("pic.png"), "img").unwrap();
        let some = resolve_image(dir.to_string_lossy().into_owned(), "pic.png".into(), 3);
        assert_eq!(some, Some(normalize_path(&dir.join("pic.png")).to_string_lossy().into_owned()));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_is_deterministic() {
        // The same basename in two sibling folders (a/pic.png, b/pic.png) always
        // resolves to the same first match (shallow-first, then path-ascending),
        // across repeated calls. Both are at depth 2, so the tie-break is path order.
        let dir = temp_dir("resolve_determ");
        fs::create_dir_all(dir.join("a")).unwrap();
        fs::create_dir_all(dir.join("b")).unwrap();
        fs::write(dir.join("a/pic.png"), "a").unwrap();
        fs::write(dir.join("b/pic.png"), "b").unwrap();
        let first = resolve_image(dir.to_string_lossy().into_owned(), "pic.png".into(), 3);
        let expected = normalize_path(&dir.join("a/pic.png")).to_string_lossy().into_owned();
        assert_eq!(first, Some(expected.clone()), "path-ascending tie-break picks a/ over b/");
        // Repeated calls are stable.
        for _ in 0..5 {
            let again = resolve_image(dir.to_string_lossy().into_owned(), "pic.png".into(), 3);
            assert_eq!(again, Some(expected.clone()), "resolution must be deterministic");
        }
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_prefers_shallower_match() {
        // A hit directly in base outranks a deeper hit, regardless of name order:
        // base/pic.png wins over base/zzz/pic.png because shallow comes first.
        let dir = temp_dir("resolve_shallow");
        fs::create_dir_all(dir.join("zzz")).unwrap();
        fs::write(dir.join("zzz/pic.png"), "deep").unwrap();
        fs::write(dir.join("pic.png"), "shallow").unwrap();
        let got = resolve_image(dir.to_string_lossy().into_owned(), "pic.png".into(), 3);
        assert_eq!(got, Some(normalize_path(&dir.join("pic.png")).to_string_lossy().into_owned()));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_empty_or_missing_dir_is_none() {
        // An empty directory and a non-existent baseDir both yield None (graceful,
        // never a panic) — there's simply nothing to find.
        let empty = temp_dir("resolve_empty");
        assert_eq!(
            resolve_image(empty.to_string_lossy().into_owned(), "pic.png".into(), 3),
            None,
            "empty dir → None"
        );
        fs::remove_dir_all(&empty).ok();

        let missing = std::env::temp_dir()
            .join(format!("mermark_resolve_missing_{}", std::process::id()));
        assert_eq!(
            resolve_image(missing.to_string_lossy().into_owned(), "pic.png".into(), 3),
            None,
            "missing baseDir → None, not a panic"
        );
    }

    #[test]
    fn resolve_basename_is_case_insensitive() {
        // A file stored as Pic.PNG is found when searching for pic.png, matching
        // APFS's own case-insensitive view of the filesystem (eq_ignore_ascii_case).
        let dir = temp_dir("resolve_case");
        fs::write(dir.join("Pic.PNG"), "img").unwrap();
        let got = resolve_image(dir.to_string_lossy().into_owned(), "pic.png".into(), 3);
        assert_eq!(got, Some(normalize_path(&dir.join("Pic.PNG")).to_string_lossy().into_owned()));
        fs::remove_dir_all(&dir).ok();
    }
}
