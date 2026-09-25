use std::path::{Path, PathBuf};

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
///   is unknown, is returned **verbatim** (only textually normalized).
///
/// That last case is a deliberate contract, not an oversight: when `home_dir()`
/// can't resolve a home (a headless test env, or — pre-fix — every plain
/// Windows session, which never set `$HOME`) there is no safe *absolute*
/// value to invent, so `expand_home("~")` degrades to returning the literal
/// `"~"` as a plain, relative path component — exactly like any other
/// relative input this function already leaves untouched
/// (`expand_home_leaves_relative_path_unchanged`). It is emphatically NOT
/// promoted to an absolute path. Callers that need "home, or give up cleanly"
/// (rather than "home, or silently misinterpret `~` as a relative path") must
/// check the result themselves — see `resolveHomeRoot` in `src/main.ts`,
/// which is exactly this case: it feeds `expand_home`'s output (via
/// `canonicalize_path`) to the explorer as a root and rejects it unless it's
/// still absolute afterwards.
///
/// Returns an absolute, normalized `PathBuf` when expansion succeeds (the home
/// dir is itself absolute), so a *successful* expansion opens no new write
/// surface and can't be used to escape via `..`: `normalize_path` collapses
/// `..`/`.` exactly as it does for every other path.
pub(crate) fn expand_home(path: &str) -> PathBuf {
    expand_home_with(path, home_dir())
}

/// `expand_home`'s actual logic, taking the home directory as a plain
/// argument instead of looking it up itself — the same wrapper/logic split
/// `remote_share.rs`'s `tailscale_ipv4_via(program)` uses, and for the same
/// reason: a test that wants to exercise "home is unresolvable" must be able
/// to pass `None` directly rather than mutating `$HOME` process-globally.
/// The env var is process-wide state, so removing/restoring it around a test
/// races every other test running in parallel that happens to touch a home
/// path in the same window (fix round: `cargo test` flaked roughly 1 in 3
/// full runs, and 4 in 5 in isolation, purely from this race — `HOME` is not
/// this test's own private variable no matter how carefully it's saved and
/// restored). `expand_home` itself keeps its one-argument shape; nothing
/// downstream of it (`read_file`/`write_file`/`canonicalize_path`/... or
/// their IPC signatures) changes.
fn expand_home_with(path: &str, home: Option<PathBuf>) -> PathBuf {
    let expanded = if path == "~" {
        home.as_ref().map(|h| h.to_string_lossy().into_owned())
    } else if let Some(rest) = path.strip_prefix("~/") {
        // `~/rest`: the tilde is its own first component → safe to expand.
        home.as_ref().map(|h| h.join(rest).to_string_lossy().into_owned())
    } else {
        // `~user/…` or no leading tilde at all → leave verbatim.
        None
    };
    normalize_path(Path::new(expanded.as_deref().unwrap_or(path)))
}

/// The current user's home directory, or `None` when the environment can't
/// report it. Platform-picked between the two pure rules below via
/// `#[cfg(windows)]`/`#[cfg(unix)]`; `None` makes `expand_home` fall back to
/// leaving the path verbatim (see that function's doc for why that fallback
/// is safe). No extra crate is pulled in just for this lookup.
fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        resolve_home_dir_windows(|k: &str| std::env::var_os(k))
    }
    #[cfg(not(windows))]
    {
        resolve_home_dir_unix(|k: &str| std::env::var_os(k))
    }
}

/// Unix home-directory rule: `$HOME`, set on every macOS/Linux desktop
/// session. Not `#[cfg]`-gated itself (only `home_dir` picks a platform) so
/// this rule can be unit-tested on any host, including a macOS CI runner that
/// will never actually compile the Windows target.
fn resolve_home_dir_unix(var: impl for<'a> Fn(&'a str) -> Option<std::ffi::OsString>) -> Option<PathBuf> {
    var("HOME").map(PathBuf::from)
}

/// Windows home-directory rule: `%USERPROFILE%` first — the canonical
/// per-user home Windows sets on every interactive login session — falling
/// back to `%HOMEDRIVE%` + `%HOMEPATH%` (the older/lower-level pair Windows
/// also populates) only when `USERPROFILE` is unset or empty.
///
/// Deliberately does NOT consult `$HOME` on Windows, even though some
/// third-party shells (Git Bash/MSYS) set it: those populate it with a
/// Unix-style value like `/c/Users/name`, which is not a valid Windows path
/// and would silently break every `Path::join`/`rename` downstream — worse
/// than not resolving home at all, since `expand_home` already has a defined
/// "resolution failed" contract (return the input verbatim) to fall back to.
///
/// This is the fix for the real bug this function exists to close: the old
/// `home_dir()` only ever read `$HOME`, which a plain Windows session never
/// sets, so home resolution always failed there and a literal `~` leaked out
/// as a relative path (see `expand_home`'s doc and `resolveHomeRoot` in
/// `src/main.ts`, which now guards against exactly that on the frontend too).
///
/// Not `#[cfg]`-gated itself, for the same cross-platform-testability reason
/// as `resolve_home_dir_unix`.
fn resolve_home_dir_windows(var: impl for<'a> Fn(&'a str) -> Option<std::ffi::OsString>) -> Option<PathBuf> {
    if let Some(profile) = var("USERPROFILE") {
        if !profile.is_empty() {
            return Some(PathBuf::from(profile));
        }
    }
    let drive = var("HOMEDRIVE")?;
    let path = var("HOMEPATH")?;
    if drive.is_empty() || path.is_empty() {
        return None;
    }
    let mut combined = drive;
    combined.push(&path);
    Some(PathBuf::from(combined))
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

/// Strip a Windows verbatim (`\\?\`) prefix so a path string handed to the
/// frontend is safe for the frontend's slash-tolerant, string-based `..`/join
/// logic (`normalize_path` in `src/document/path.ts` doesn't understand
/// verbatim paths and would otherwise corrupt them — see design notes).
///
/// **Every point in this codebase that turns a `canonicalize`d path into a
/// `String` for the frontend must route through this function.** Today that
/// is `canonicalize_path` alone (verified by grep across the crate); if a
/// future command starts exporting another `canonicalize` result as a
/// `String`, funnel it through here too rather than re-deriving the rule.
///
/// Only the two verbatim shapes `canonicalize` actually produces are
/// rewritten; anything else (including verbatim forms this function doesn't
/// recognize, e.g. `\\?\Volume{...}`) is returned unchanged rather than
/// partially mangled:
/// - `\\?\C:\...` → `C:\...` (verbatim drive)
/// - `\\?\UNC\srv\share\...` → `\\srv\share\...` (verbatim UNC)
pub(crate) fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        let is_drive = rest.len() >= 2
            && rest.as_bytes()[0].is_ascii_alphabetic()
            && rest.as_bytes()[1] == b':';
        if is_drive {
            return rest.to_string();
        }
    }
    path.to_string()
}

#[cfg(test)]
mod strip_verbatim_prefix_tests {
    use super::strip_verbatim_prefix;

    #[test]
    fn strips_verbatim_drive_prefix() {
        assert_eq!(strip_verbatim_prefix(r"\\?\C:\Users\x"), r"C:\Users\x");
    }

    #[test]
    fn strips_verbatim_unc_prefix() {
        assert_eq!(strip_verbatim_prefix(r"\\?\UNC\srv\share\d"), r"\\srv\share\d");
    }

    #[test]
    fn preserves_unrecognized_verbatim_shapes() {
        assert_eq!(
            strip_verbatim_prefix(r"\\?\Volume{abc}\x"),
            r"\\?\Volume{abc}\x"
        );
    }

    #[test]
    fn preserves_bare_verbatim_prefix_with_empty_rest() {
        assert_eq!(strip_verbatim_prefix(r"\\?\"), r"\\?\");
    }

    #[test]
    fn preserves_device_paths() {
        assert_eq!(strip_verbatim_prefix(r"\\.\pipe\x"), r"\\.\pipe\x");
    }

    #[test]
    fn leaves_non_verbatim_paths_unchanged() {
        assert_eq!(strip_verbatim_prefix("/Users/x"), "/Users/x");
        assert_eq!(strip_verbatim_prefix(r"C:\x"), r"C:\x");
        assert_eq!(strip_verbatim_prefix(r"\\srv\share"), r"\\srv\share");
        assert_eq!(strip_verbatim_prefix(""), "");
    }
}

/// Check whether a path points to an existing file (used by wikilink rendering).
pub(crate) fn path_exists(path: String) -> bool {
    let normalized = expand_home(&path);
    normalized.is_file()
}

pub(crate) fn directory_exists(path: String) -> bool {
    expand_home(&path).is_dir()
}

pub(crate) fn canonicalize_path(path: String) -> Result<String, String> {
    std::fs::canonicalize(expand_home(&path))
        .map(|canonical| strip_verbatim_prefix(&canonical.to_string_lossy()))
        .map_err(|error| format!("cannot canonicalize vault path {path}: {error}"))
}

/// Locks `canonicalize_path`'s two semantics that Todo 3's vault-escape
/// detection (`isPathInsideRoot` on the frontend) rests on: symlinks are
/// resolved all the way to their real target — so a symlink planted inside
/// a vault that points outside it canonicalizes to a path outside the
/// vault, which is exactly what makes the escape detectable — and a path
/// that doesn't exist on disk is an `Err`, never a best-effort guess.
#[cfg(test)]
mod canonicalize_path_tests {
    use super::canonicalize_path;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    fn temp_root(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "mermark_canonicalize_{}_{}_{tag}",
            std::process::id(),
            TEST_SEQ.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[cfg(unix)]
    #[test]
    fn canonicalize_resolves_symlinks_to_the_real_path() {
        let root = temp_root("symlink");
        let vault = root.join("vault");
        let outside = root.join("outside");
        fs::create_dir_all(&vault).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let real_file = outside.join("real.md");
        fs::write(&real_file, "# real").unwrap();
        let link = vault.join("escape.md");
        std::os::unix::fs::symlink(&real_file, &link).unwrap();

        let resolved = canonicalize_path(link.to_string_lossy().into_owned()).unwrap();
        let expected = super::strip_verbatim_prefix(
            &fs::canonicalize(&real_file).unwrap().to_string_lossy(),
        );
        assert_eq!(resolved, expected);
        // The resolved path lands outside the vault directory the symlink
        // was planted in — the fact the frontend's escape check depends on.
        assert!(!resolved.starts_with(&vault.to_string_lossy().into_owned()));
        // No verbatim prefix leaks to the frontend (no-op on macOS/Linux;
        // gains teeth once Windows CI exists).
        assert!(!resolved.starts_with(r"\\?\"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn canonicalize_errors_on_missing_paths() {
        let root = temp_root("missing");
        let missing = root.join("does-not-exist.md");
        // Deliberately do not create `root` or `missing` — the path must
        // not resolve to anything on disk.

        let result = canonicalize_path(missing.to_string_lossy().into_owned());
        assert!(result.is_err());
    }
}

#[cfg(test)]
mod workspace_directory_exists_tests {
    use super::directory_exists;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn directory_exists_accepts_directories_but_not_files_or_missing_paths() {
        let root = std::env::temp_dir().join(format!(
            "mermark_directory_exists_{}_{}",
            std::process::id(),
            TEST_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let directory = root.join("vault");
        let file = root.join("note.md");
        fs::create_dir_all(&directory).unwrap();
        fs::write(&file, "# note").unwrap();

        assert!(directory_exists(directory.to_string_lossy().into_owned()));
        assert!(!directory_exists(file.to_string_lossy().into_owned()));
        assert!(!directory_exists(root.join("missing").to_string_lossy().into_owned()));

        fs::remove_dir_all(root).unwrap();
    }
}

/// The path-escape guard: is `candidate` contained within `base`? Both are
/// normalized (`..`/`.` collapsed) before a prefix check, so a candidate can never
/// resolve above the base directory. This is the single source of truth for the
/// "anti-vault / no parent escape" invariant — the BFS only ever descends into
/// children, but this prefix check is the structural second line of defence (and
/// the one that catches a symlink target pointing outside the base).
pub(crate) fn is_within_base(base: &Path, candidate: &Path) -> bool {
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
pub(crate) fn file_target_is_within_base(base: &Path, candidate: &Path, meta: &std::fs::Metadata) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;

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
    // These tests exercise `expand_home_with` directly, passing a known home
    // as a plain argument instead of mutating `$HOME` — `std::env::set_var`
    // is process-global, so even setting it to the *same* value across
    // parallel tests is shared mutable state a sibling test doesn't expect
    // (see `expand_home_with`'s doc comment for the concrete flake this
    // caused with a *differing* value). `expand_home` itself is covered
    // separately by `expand_home_leaves_relative_path_unchanged_via_the_public_fn`.

    fn tester_home() -> PathBuf {
        PathBuf::from("/home/tester")
    }

    #[test]
    fn expand_home_replaces_leading_tilde_slash() {
        assert_eq!(
            expand_home_with("~/notes/x.md", Some(tester_home())),
            PathBuf::from("/home/tester/notes/x.md")
        );
    }

    #[test]
    fn expand_home_bare_tilde_is_the_home_dir() {
        assert_eq!(expand_home_with("~", Some(tester_home())), PathBuf::from("/home/tester"));
    }

    #[test]
    fn expand_home_leaves_absolute_path_unchanged() {
        // No leading tilde → returned verbatim (only normalized).
        assert_eq!(expand_home_with("/abs/x.md", Some(tester_home())), PathBuf::from("/abs/x.md"));
    }

    #[test]
    fn expand_home_leaves_relative_path_unchanged() {
        // Relative paths carry no tilde → normalized but not anchored to home.
        assert_eq!(expand_home_with("sub/x.md", Some(tester_home())), PathBuf::from("sub/x.md"));
    }

    #[test]
    fn expand_home_does_not_expand_named_user_tilde() {
        // `~bob/…` is a *different* user's home, which we never resolve — left
        // verbatim so we don't over-expand a path we can't safely interpret.
        assert_eq!(expand_home_with("~bob/x.md", Some(tester_home())), PathBuf::from("~bob/x.md"));
    }

    #[test]
    fn expand_home_normalizes_after_expansion() {
        // `..` inside an expanded path is collapsed by normalize_path, so a
        // tilde path can't escape via `..` any more than a literal one can.
        assert_eq!(
            expand_home_with("~/notes/../x.md", Some(tester_home())),
            PathBuf::from("/home/tester/x.md")
        );
    }

    /// `expand_home` (the public, one-argument entry point every real caller
    /// uses) still behaves correctly end to end — this doesn't touch `$HOME`
    /// because a relative input is returned verbatim regardless of what the
    /// real environment's home resolves to.
    #[test]
    fn expand_home_leaves_relative_path_unchanged_via_the_public_fn() {
        assert_eq!(expand_home("sub/x.md"), PathBuf::from("sub/x.md"));
    }

    #[test]
    fn expand_home_falls_back_to_a_literal_relative_tilde_when_home_is_unresolvable() {
        // Pins the documented failure contract: no absolute value is ever
        // invented. Passing `None` directly (rather than removing $HOME —
        // see `expand_home_with`'s doc comment for why that raced other
        // tests) simulates the exact real-world condition that used to
        // trigger the Windows bug (home_dir() returning None).
        assert_eq!(expand_home_with("~", None), PathBuf::from("~"));
        assert!(
            !expand_home_with("~", None).is_absolute(),
            "an unresolvable home must never be promoted to an absolute path"
        );
    }

    // --- resolve_home_dir_unix / resolve_home_dir_windows (platform-neutral
    // home lookup rules) ---
    //
    // Both resolvers are pure functions of an env-lookup closure, so both
    // platforms' rules are exercised here regardless of which OS actually
    // runs `cargo test` — in particular the Windows rule is fully covered on
    // a macOS/Linux CI runner, which will never compile the `#[cfg(windows)]`
    // branch of `home_dir()` itself.

    fn env_map<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl for<'b> Fn(&'b str) -> Option<std::ffi::OsString> + 'a {
        move |key| pairs.iter().find(|(k, _)| *k == key).map(|(_, v)| std::ffi::OsString::from(v))
    }

    #[test]
    fn resolve_home_dir_unix_reads_home() {
        assert_eq!(
            resolve_home_dir_unix(env_map(&[("HOME", "/home/tester")])),
            Some(PathBuf::from("/home/tester"))
        );
    }

    #[test]
    fn resolve_home_dir_unix_is_none_without_home() {
        assert_eq!(resolve_home_dir_unix(env_map(&[])), None);
    }

    #[test]
    fn resolve_home_dir_windows_prefers_userprofile() {
        assert_eq!(
            resolve_home_dir_windows(env_map(&[
                ("USERPROFILE", r"C:\Users\tester"),
                ("HOMEDRIVE", "D:"),
                ("HOMEPATH", r"\Other"),
            ])),
            Some(PathBuf::from(r"C:\Users\tester"))
        );
    }

    #[test]
    fn resolve_home_dir_windows_falls_back_to_homedrive_and_homepath() {
        assert_eq!(
            resolve_home_dir_windows(env_map(&[("HOMEDRIVE", "C:"), ("HOMEPATH", r"\Users\tester")])),
            Some(PathBuf::from(r"C:\Users\tester"))
        );
    }

    #[test]
    fn resolve_home_dir_windows_ignores_home_and_empty_userprofile() {
        // `HOME` (a Unix-shell convention some Windows tools set to a
        // POSIX-style value) is never consulted; an empty `USERPROFILE`
        // falls through to HOMEDRIVE+HOMEPATH exactly like a missing one.
        assert_eq!(
            resolve_home_dir_windows(env_map(&[
                ("HOME", "/c/Users/tester"),
                ("USERPROFILE", ""),
                ("HOMEDRIVE", "C:"),
                ("HOMEPATH", r"\Users\tester"),
            ])),
            Some(PathBuf::from(r"C:\Users\tester"))
        );
    }

    #[test]
    fn resolve_home_dir_windows_is_none_without_any_source() {
        assert_eq!(resolve_home_dir_windows(env_map(&[])), None);
    }
}
