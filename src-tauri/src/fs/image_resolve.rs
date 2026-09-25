use std::path::{Path, PathBuf};

use super::link_targets::is_image_ext;
use super::listing::is_excluded_scan_dir;
use super::paths::{file_target_is_within_base, normalize_path};

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

/// Canonical matching key for a basename: NFC-normalize (so NFD-decomposed and
/// NFC-composed spellings of the same text compare equal — e.g. a Korean
/// filename macOS wrote as combining jamo vs. the precomposed form the user
/// typed in `![[사진.png]]`), then ASCII-lowercase the result. Only ASCII case
/// is folded (matches `is_image_ext`'s own case policy and the APFS reality
/// that `Photo.PNG` == `photo.png`); full Unicode case-folding is out of scope
/// (YAGNI for filenames). This is a matching key only — never fed back into a
/// path or returned to the caller, since the file must still be opened by its
/// actual on-disk spelling.
fn nfc_fold(name: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    name.nfc().collect::<String>().to_ascii_lowercase()
}

/// Basename equality for the recursive image scan, normalization- and
/// case-insensitive. See `nfc_fold` for why both sides must be NFC-folded
/// before comparing — a plain `eq_ignore_ascii_case` never matches an NFD
/// disk filename against an NFC target (or vice versa) even when they're the
/// same text.
fn basename_matches(entry: &str, target: &str) -> bool {
    nfc_fold(entry) == nfc_fold(target)
}

/// Hard ceiling on directory entries visited in one `scan_match` call by
/// default (`resolve_image` always passes this; tests may pass a smaller
/// budget to exercise the cutoff directly). Paired with `max_depth`, this caps
/// the cost of a fallback scan over a pathologically large folder: once this
/// many entries have been inspected the scan gives up and returns whatever (if
/// anything) it has found. A bounded best-effort search, never a runaway walk.
/// 10,000 matches `list_files_recursive`'s own `MAX_SCAN_FILES` ceiling — a
/// vault-root image search (`![[name]]`, depth up to `MAX_IMAGE_SCAN_DEPTH`)
/// now has to cover the same ground the ⌘⇧F file finder already covers
/// routinely, so it gets the same budget.
const MAX_ENTRIES: u32 = 10_000;

/// Depth ceiling for `scan_match`. Shared by the vault-root name search
/// (`![[name]]`, which asks for this directly) and the narrower document-folder
/// fallback (`![](name)`, which clamps its own request to 3 before calling in).
/// Aligned with `list_files_recursive`'s `MAX_SCAN_DEPTH` (also 12) — the same
/// "how deep is a vault" budget applies to both scans. The frontend's
/// `VAULT_IMAGE_SCAN_DEPTH` constant (`src/markdown/image-search-root.ts`) must
/// mirror this value.
const MAX_IMAGE_SCAN_DEPTH: u8 = 12;

/// Deterministic, bounded, children-only recursive search for an image file whose
/// basename matches `target_basename`, rooted at `base` and descending at most
/// `max_depth` levels (clamped to `MAX_IMAGE_SCAN_DEPTH`). Returns the first match
/// in a stable order: shallower directories first, then path-ascending within a
/// level (so the same tree always yields the same hit) — this ordering is a
/// contract, not an implementation detail, and is pinned by `resolve_is_deterministic`
/// / `resolve_prefers_shallower_match`. Read-only; never follows directory symlinks
/// (which could escape `base`) and never follows a file symlink whose target lands
/// outside `base` (`is_within_base`). Any unreadable directory is silently skipped
/// rather than aborting the whole scan — this is a best-effort fallback, not a
/// command the user explicitly invoked, so it degrades to `None` instead of erroring.
/// Directories named in `EXCLUDED_SCAN_DIRS` (`node_modules`, `.git`, etc.) are never
/// descended into — they aren't where attachments live and would otherwise burn the
/// entry budget. Dot-directories are *not* filtered as a class (unlike
/// `list_files_recursive`'s `show_hidden` gate): a vault's own attachment folder
/// (`.attachments/`) is itself a dot-directory and must stay reachable.
/// `max_entries` is a caller-supplied visited-entry ceiling (`resolve_image` always
/// passes `MAX_ENTRIES`; tests pass smaller budgets to exercise the cutoff).
fn scan_match(base: &Path, target_basename: &str, max_depth: u8, max_entries: u32) -> Option<PathBuf> {
    // Clamp depth to the documented ceiling so a caller can never request an
    // unbounded walk. `max_depth` counts levels *below* `base` (depth 1 = direct
    // children).
    let max_depth = max_depth.min(MAX_IMAGE_SCAN_DEPTH);
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
            if visited > max_entries {
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
        // they're the one way a children-only walk could still escape `base`. Names
        // in `EXCLUDED_SCAN_DIRS` are skipped too — they burn the entry budget on
        // heavy generated trees and are never where an attachment lives. Note this
        // is *not* a dot-directory filter: `.attachments` itself is untouched.
        if depth < max_depth {
            for path in &children {
                let meta = match std::fs::symlink_metadata(path) {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                // `symlink_metadata` reports the link itself: a symlinked dir has
                // `is_symlink()` true and we skip it; a real dir is descended into.
                if meta.file_type().is_dir() && !meta.file_type().is_symlink() {
                    let file_name = match path.file_name().and_then(|n| n.to_str()) {
                        Some(n) => n,
                        None => continue,
                    };
                    if is_excluded_scan_dir(file_name) {
                        continue;
                    }
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
pub(crate) fn resolve_image(base_dir: String, name: String, max_depth: u8) -> Option<String> {
    let target = image_basename(&name);
    let base = normalize_path(Path::new(&base_dir));
    scan_match(&base, target, max_depth, MAX_ENTRIES).map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use crate::fs::test_support::temp_dir;

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
        let at2 = scan_match(&dir, "pic.png", 2, MAX_ENTRIES);
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
        // base/pic.png wins over base/zzz/pic.png AND base/.attachments/pic.png
        // because shallow comes first. The `.attachments` sibling is included
        // specifically to lock that a dot-directory match at the same depth as
        // `zzz/` is treated identically — no special-casing either way — while
        // the depth-1 root file still wins over both (design 분기 4's shadowing
        // scenario, locked here at the backend layer).
        let dir = temp_dir("resolve_shallow");
        fs::create_dir_all(dir.join("zzz")).unwrap();
        fs::create_dir_all(dir.join(".attachments")).unwrap();
        fs::write(dir.join("zzz/pic.png"), "deep").unwrap();
        fs::write(dir.join(".attachments/pic.png"), "deep-dot").unwrap();
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
    fn basename_matches_folds_nfc_and_ascii_case_both_ways() {
        // Pure unit-level lock on the matching rule itself, independent of the
        // filesystem: NFD vs NFC and ASCII case must both fold to equal.
        use unicode_normalization::UnicodeNormalization;
        let nfc = "사진.png".to_string();
        let nfd: String = "사진.png".nfd().collect();
        assert!(basename_matches(&nfd, &nfc), "NFD entry must match an NFC target");
        assert!(basename_matches(&nfc, &nfd), "NFC entry must match an NFD target");
        assert!(basename_matches("Pic.PNG", "pic.png"), "ASCII case-fold policy preserved");
        assert!(!basename_matches("pic.png", "other.png"), "unrelated names still differ");
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

    #[test]
    fn resolve_matches_nfd_disk_file_against_nfc_target() {
        // Disk filename written in NFD (decomposed jamo, the form macOS/HFS+
        // history often produces), target name typed in NFC (precomposed, what
        // a user types in `![[사진.png]]`). Without NFC-folding both sides
        // before comparing, this never matches even though it's the same text.
        use unicode_normalization::UnicodeNormalization;
        let dir = temp_dir("resolve_nfd_disk");
        let nfd_name: String = "사진.png".nfd().collect();
        let nfc_target = "사진.png".to_string(); // already NFC as typed in source
        assert_ne!(nfd_name, nfc_target, "fixture must actually differ byte-for-byte");
        let target_path = dir.join(&nfd_name);
        fs::write(&target_path, "img").unwrap();
        let got = resolve_image(dir.to_string_lossy().into_owned(), nfc_target, 3);
        // The returned path must be the disk's actual (NFD) spelling, not a
        // normalized substitute — otherwise convertFileSrc can't open it.
        assert_eq!(
            got,
            Some(normalize_path(&target_path).to_string_lossy().into_owned()),
            "NFD disk file must be found by an NFC target, and returned in its disk form"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_matches_nfc_disk_file_against_nfd_target() {
        // The flip side: disk filename in NFC (APFS preserves creation form, so
        // a directly-typed `사진.png` stays NFC), target spelled in NFD (e.g. a
        // link pasted from a source that decomposed it). Must match either way.
        use unicode_normalization::UnicodeNormalization;
        let dir = temp_dir("resolve_nfc_disk");
        let nfc_name = "사진.png".to_string();
        let nfd_target: String = "사진.png".nfd().collect();
        assert_ne!(nfc_name, nfd_target, "fixture must actually differ byte-for-byte");
        let target_path = dir.join(&nfc_name);
        fs::write(&target_path, "img").unwrap();
        let got = resolve_image(dir.to_string_lossy().into_owned(), nfd_target, 3);
        assert_eq!(
            got,
            Some(normalize_path(&target_path).to_string_lossy().into_owned()),
            "NFC disk file must be found by an NFD target, and returned in its disk form"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_reaches_vault_depth() {
        // A vault-root search (`![[name]]`) must reach far deeper than the old
        // document-folder fallback's depth-3 clamp: base/a/b/c/d/e/pic.png is
        // depth 6, requested with max_depth=12 (MAX_IMAGE_SCAN_DEPTH). This is
        // the depth the frontend's vault scope actually asks for.
        let dir = temp_dir("resolve_vault_depth");
        fs::create_dir_all(dir.join("a/b/c/d/e")).unwrap();
        let buried = dir.join("a/b/c/d/e/pic.png");
        fs::write(&buried, "img").unwrap();
        let got = resolve_image(dir.to_string_lossy().into_owned(), "pic.png".into(), 12);
        assert_eq!(
            got,
            Some(normalize_path(&buried).to_string_lossy().into_owned()),
            "depth 6 must be reachable at max_depth=12"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_skips_excluded_scan_dirs() {
        // node_modules/pic.png and zsrc/pic.png are both depth 2, and
        // "node_modules" sorts before "zsrc" — without the exclusion, the old
        // BFS would visit node_modules first and return its (wrong) match.
        // EXCLUDED_SCAN_DIRS must keep the walk from ever descending into
        // node_modules at all, so zsrc/pic.png is the only candidate found.
        let dir = temp_dir("resolve_excluded_dirs");
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::create_dir_all(dir.join("zsrc")).unwrap();
        fs::write(dir.join("node_modules/pic.png"), "decoy").unwrap();
        fs::write(dir.join("zsrc/pic.png"), "real").unwrap();
        let got = resolve_image(dir.to_string_lossy().into_owned(), "pic.png".into(), 3);
        assert_eq!(
            got,
            Some(normalize_path(&dir.join("zsrc/pic.png")).to_string_lossy().into_owned()),
            "node_modules must never be descended into, even though it sorts first"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_scans_dot_directories() {
        // Dot-directories are not filtered as a class — `.attachments` is a
        // vault's own attachment folder and must stay reachable. Regression
        // guard: EXCLUDED_SCAN_DIRS is an explicit unconditional list, not a
        // hidden-entry gate, so this must keep passing.
        let dir = temp_dir("resolve_dot_dir");
        fs::create_dir_all(dir.join(".attachments")).unwrap();
        let target = dir.join(".attachments/pic.png");
        fs::write(&target, "img").unwrap();
        let got = resolve_image(dir.to_string_lossy().into_owned(), "pic.png".into(), 3);
        assert_eq!(got, Some(normalize_path(&target).to_string_lossy().into_owned()));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scan_gives_up_at_entry_budget() {
        // Five files where the match ("zzz.png") sorts last by name; a budget
        // of 3 must give up before ever reaching it — proving the ceiling is a
        // hard visited-entry cutoff, not merely "nothing matched".
        let dir = temp_dir("scan_budget");
        for name in ["a.png", "b.png", "c.png", "d.png", "zzz.png"] {
            fs::write(dir.join(name), "img").unwrap();
        }
        let starved = scan_match(&dir, "zzz.png", 3, 3);
        assert_eq!(starved, None, "a small entry budget must give up before finding a later match");
        // A generous budget finds it fine — proves the fixture itself is valid
        // and the starved result above is really the budget's doing.
        let generous = scan_match(&dir, "zzz.png", 3, MAX_ENTRIES);
        assert_eq!(
            generous,
            Some(normalize_path(&dir.join("zzz.png"))),
            "the same fixture must resolve under the default budget"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    #[ignore = "perf measurement, not a correctness assertion — run manually: \
                cargo test --lib -- --ignored --nocapture scan_perf (release build's test \
                harness is broken by the pre-existing debug_assertions-gated QA seam, so this \
                measures the debug/unoptimized build — a real production binary is faster)"]
    fn scan_perf_measures_worst_case_vault_walk() {
        // Approximates the worst case a real vault-root `![[name]]` search
        // (depth 12, budget MAX_ENTRIES=10,000) can hit: ~6,000 files spread
        // across 400 directories at depth 2, none matching, so the walk must
        // inspect close to the full budget without an early hit rather than
        // stopping short. Printed (`--nocapture`), not asserted — see
        // `_workspace/02_backend_vaultimage_changes.md` for the number this
        // measured on the developer's machine; the assertion below only pins
        // "did not silently truncate the fixture", not a latency budget (CI
        // hardware varies too much for a hard ms assertion to be meaningful).
        let dir = temp_dir("scan_perf");
        let mut n = 0usize;
        'outer: for a in 0..20u32 {
            for b in 0..20u32 {
                let sub = dir.join(format!("d{a}/d{b}"));
                fs::create_dir_all(&sub).unwrap();
                for f in 0..15u32 {
                    fs::write(sub.join(format!("f{f}.png")), "x").unwrap();
                    n += 1;
                    if n >= 6000 {
                        break 'outer;
                    }
                }
            }
        }
        let start = std::time::Instant::now();
        let got = scan_match(&dir, "does-not-exist.png", 12, MAX_ENTRIES);
        let elapsed = start.elapsed();
        assert_eq!(got, None, "the target basename must not exist in the fixture");
        eprintln!("scan_perf: {n} files, depth 12, budget {MAX_ENTRIES} -> {elapsed:?} (no match, full walk)");
        fs::remove_dir_all(&dir).ok();
    }
}
