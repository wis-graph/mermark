//! Host-side containment for remote vault sharing. A remote vault is shared
//! only if the user has explicitly checked it in settings (an "armed" root —
//! see `ArmedVault`), and every path a peer requests must clear
//! `resolve_within`/`is_canonically_within` before it ever touches the
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
//! `htmlview.rs` re-validates *after* the join). `is_canonically_within` is
//! that second gate: it canonicalizes both the armed root and the resolved
//! candidate — which resolves symlinks to their real target, not just their
//! lexical path — and checks containment on the resolved result. Like
//! `is_within_armed_root`, it fails closed (`false`) if either side can't be
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
/// `is_canonically_within` exists to catch.
pub fn resolve_within(armed: &ArmedVault, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() {
        return None;
    }
    let candidate = Path::new(rel);
    for component in candidate.components() {
        match component {
            Component::Normal(_) => {}
            _ => return None, // RootDir, ParentDir, CurDir, Prefix all rejected
        }
    }
    Some(armed.root.join(candidate))
}

/// The second, post-resolve containment gate: is `resolved` still inside
/// `armed.root` once both sides are canonicalized (symlinks resolved, `..`
/// collapsed)? `resolve_within`'s component check can't see through a
/// symlink — it's an ordinary `Normal` component lexically — so a symlink
/// planted inside the armed root that points outside it needs this check to
/// be caught. Fails closed (`false`) if either path can't be canonicalized.
pub fn is_canonically_within(armed: &ArmedVault, resolved: &Path) -> bool {
    match (armed.root.canonicalize(), resolved.canonicalize()) {
        (Ok(root), Ok(target)) => target.starts_with(&root),
        _ => false,
    }
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

    /// A symlink inside the armed root pointing at a file outside it: the
    /// attack `is_canonically_within` exists for. `resolve_within` alone
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
        let is_contained = resolved
            .as_ref()
            .map(|candidate| is_canonically_within(&armed, candidate));

        std::fs::remove_dir_all(&tmp).ok();

        assert_eq!(resolved, Some(root.join("link.md")), "component check should pass");
        assert_eq!(is_contained, Some(false), "symlink escape must be rejected");
    }
}
