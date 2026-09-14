//! Host-side containment for remote vault sharing. A remote vault is shared
//! only if the user has explicitly checked it in settings (an "armed" root —
//! see `ArmedVault`), and every path a peer requests must clear
//! `resolve_within`/`canonicalize_within` before it ever touches the
//! filesystem. This module is pure logic: no server, no pairing, no
//! `#[tauri::command]`. Task 5 (HTTP server) and Task 4 (pairing) are the
//! only consumers so far.
//!
//! Follows `htmlview.rs`'s containment idiom rather than inventing a new
//! one: a **two-gate** check, same as `is_within_armed_root` there.
//! `resolve_within` is the lexical gate — it rejects `..`, an absolute path,
//! and the empty string by walking `Path::components()` *before* joining,
//! so an escaping path is never even constructed. But a lexical gate alone
//! is insufficient: a symlink inside the armed root that points outside it
//! shows up as an ordinary `Component::Normal` and sails through the
//! component check untouched (see `epubview.rs`'s doc comment on
//! "structural vs. checked" containment — this case is exactly why
//! `htmlview.rs` re-validates *after* the join). `canonicalize_within` is
//! that second gate: it canonicalizes both the armed root and the resolved
//! candidate — which resolves symlinks to their real target, not just their
//! lexical path — and, if the canonicalized target is still contained,
//! **returns that canonicalized path** rather than a bare `bool`. A caller
//! that only got `true`/`false` back would naturally go on to open the
//! pre-canonical path it already had (the symlink itself), leaving a TOCTOU
//! window between this check and that open; returning the canonicalized
//! path instead makes that mistake impossible to make. Like
//! `is_within_armed_root`, it fails closed (`None`) if either side can't be
//! canonicalized (e.g. the candidate doesn't exist) rather than falling back
//! to a lexical guess.

use std::path::{Component, Path, PathBuf};

/// A vault the host has explicitly armed for remote sharing: its identity
/// (`id`, stable across a pairing session), the name shown to peers
/// (`display_name`), and the canonical local filesystem root peers may read
/// from. `root` is never serialized — it is host-local and must never reach
/// a peer.
#[derive(Clone, Debug, serde::Serialize)]
pub struct ArmedVault {
    pub id: String,
    pub display_name: String,
    #[serde(skip)]
    pub root: PathBuf,
}

/// Resolves a peer-supplied relative path into an absolute path under
/// `armed.root`, or `None` if the path could escape it. Rejects `..`,
/// absolute paths, and the empty string by inspecting path *components*
/// before any join happens — so the escaping path is never constructed in
/// the first place. This is the lexical gate only; a candidate that passes
/// here can still be a symlink pointing outside `armed.root`, which is what
/// `canonicalize_within` exists to catch.
pub fn resolve_within(armed: &ArmedVault, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() {
        return None;
    }
    let candidate = Path::new(rel);
    for component in candidate.components() {
        match component {
            Component::Normal(_) => {}
            // RootDir, ParentDir, Prefix rejected outright. CurDir only ever
            // shows up here for a *leading* "./" — std already strips
            // interior "." components (e.g. "sub/./b.md" never produces one)
            // — and it's rejected the same as everything else non-`Normal`.
            _ => return None,
        }
    }
    Some(armed.root.join(candidate))
}

/// The second, post-resolve containment gate: canonicalizes `resolved` and
/// returns that canonical path if — and only if — it's still inside
/// `armed.root`'s own canonical form (symlinks resolved, `..` collapsed),
/// `None` otherwise. `resolve_within`'s component check can't see through a
/// symlink — it's an ordinary `Normal` component lexically — so a symlink
/// planted inside the armed root that points outside it needs this check to
/// be caught. Returning the canonicalized path (not a `bool`) is
/// deliberate: a caller must open *this* path, never the pre-canonical one
/// it started with, or a symlink swapped in between the check and the open
/// would reopen the TOCTOU window this function exists to close. Fails
/// closed (`None`) if either path can't be canonicalized.
pub fn canonicalize_within(armed: &ArmedVault, resolved: &Path) -> Option<PathBuf> {
    let root = armed.root.canonicalize().ok()?;
    let target = resolved.canonicalize().ok()?;
    target.starts_with(&root).then_some(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    fn armed() -> ArmedVault {
        ArmedVault { id: "rv1".into(), display_name: "노트".into(), root: PathBuf::from("/vault") }
    }

    #[test]
    fn resolves_a_plain_relative_path() {
        assert_eq!(resolve_within(&armed(), "a/b.md"), Some(PathBuf::from("/vault/a/b.md")));
    }

    #[test]
    fn rejects_dotdot_escape() {
        assert_eq!(resolve_within(&armed(), "../secret.md"), None);
        assert_eq!(resolve_within(&armed(), "a/../../secret.md"), None);
    }

    #[test]
    fn rejects_absolute_path() {
        assert_eq!(resolve_within(&armed(), "/etc/passwd"), None);
    }

    #[test]
    fn rejects_empty_and_root() {
        assert_eq!(resolve_within(&armed(), ""), None);
    }

    /// Pins the accept path: a real file inside the armed root must come
    /// back as `Some` carrying the *canonicalized* path inside the root —
    /// not just any `Some`. Without this, a bug that returned `Some` for
    /// the wrong path (e.g. echoing back an unrelated file) would pass
    /// every other test here. Compares against `root.canonicalize()` rather
    /// than the raw `root` because on macOS `TMPDIR` resolves through a
    /// `/var` → `/private/var` symlink, so a literal `root.join(...)`
    /// wouldn't match what `canonicalize_within` actually returns.
    #[test]
    fn accepts_a_real_file_inside_the_armed_root() {
        let n = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        let tmp = std::env::temp_dir().join(format!("mermark-rv-accept-{}-{n}", std::process::id()));
        let root = tmp.join("vault");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("note.md"), "hello").unwrap();

        let armed = ArmedVault { id: "rv1".into(), display_name: "노트".into(), root: root.clone() };
        let resolved = resolve_within(&armed, "note.md");
        let canonical = resolved.as_ref().and_then(|candidate| canonicalize_within(&armed, candidate));
        let expected = root.canonicalize().unwrap().join("note.md");

        std::fs::remove_dir_all(&tmp).ok();

        assert_eq!(resolved, Some(root.join("note.md")), "component check should pass");
        assert_eq!(canonical, Some(expected), "legitimate in-root file must resolve to its canonical path");
    }

    /// A symlink inside the armed root pointing at a file outside it: the
    /// attack `canonicalize_within` exists for. `resolve_within` alone
    /// would let this through, since the symlink is a plain `Normal`
    /// component lexically. Uses a unique per-test/per-process temp dir
    /// (pid + atomic counter, matching `commands.rs`'s `temp_path`
    /// convention) so parallel test runs never collide, and captures the
    /// assertion outcome before cleanup so a panic can't skip it and leak
    /// the fixture on disk.
    #[test]
    fn rejects_symlink_that_points_outside_the_armed_root() {
        let n = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        let tmp = std::env::temp_dir().join(format!("mermark-rv-{}-{n}", std::process::id()));
        let root = tmp.join("vault");
        let outside = tmp.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.md"), "s").unwrap();
        let link = root.join("link.md");
        std::os::unix::fs::symlink(outside.join("secret.md"), &link).unwrap();

        let armed = ArmedVault { id: "rv1".into(), display_name: "노트".into(), root: root.clone() };
        let resolved = resolve_within(&armed, "link.md");
        let canonical = resolved
            .as_ref()
            .and_then(|candidate| canonicalize_within(&armed, candidate));

        std::fs::remove_dir_all(&tmp).ok();

        assert_eq!(resolved, Some(root.join("link.md")), "component check should pass");
        assert_eq!(canonical, None, "symlink escape must be rejected");
    }
}
