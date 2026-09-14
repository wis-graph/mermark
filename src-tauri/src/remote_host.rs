//! Host-side containment for remote vault sharing. A remote vault is shared
//! only if the user has explicitly checked it in settings (an "armed" root —
//! see `ArmedVault`), and every path a peer requests must clear
//! `resolve_within`/`canonicalize_within` before it ever touches the
//! filesystem. This module is pure logic: no server, no pairing, no
//! `#[tauri::command]`. Task 5 (HTTP server) and Task 4 (pairing) are the
//! only consumers so far.
//!
//! Also owns pairing: a short-lived, human-typeable code
//! (`issue_pairing_code`/`PairingState`/`redeem`) that exchanges once for a
//! long-lived device token (`remote_token.rs` stores that token; this module
//! only mints it via `htmlview::mint_view_token`, reusing that CSPRNG-backed
//! minter rather than writing a second one).
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

/// How long an issued pairing code stays redeemable. Five minutes is enough
/// for a human to read it off one screen and type it into another, but short
/// enough that a code left visible in a screenshot or over-the-shoulder
/// glance is worthless soon after.
pub const PAIRING_TTL_MS: u64 = 5 * 60_000;

/// How many wrong codes `redeem` tolerates before locking the pairing
/// session out entirely (regardless of whether a later attempt is correct).
/// Bounds brute-force guessing of the 6-digit space to a handful of tries
/// per issued code rather than an unlimited one.
pub const PAIRING_MAX_ATTEMPTS: u8 = 5;

/// A freshly minted pairing code: the 6 ASCII digits shown to the user, and
/// the timestamp it was issued at (caller-supplied `now_ms`, not a wall
/// clock read here, so tests can drive expiry deterministically).
#[derive(Clone, Debug)]
pub struct PairingCode {
    pub code: String,
    pub issued_at_ms: u64,
}

/// Why `redeem` refused a code. `LockedOut` and `Mismatch` are deliberately
/// distinct: `redeem`'s ordering (see its doc comment) guarantees a caller
/// only ever sees `Mismatch` while attempts remain, and `LockedOut`
/// afterward — never a `Mismatch` on the (N+1)th wrong guess.
#[derive(Debug, PartialEq)]
pub enum PairError {
    Expired,
    AlreadyUsed,
    Mismatch,
    LockedOut,
    NotArmed,
}

/// One pairing session's mutable state: the code it was armed with (`None`
/// once never armed — `redeem` reports `NotArmed` rather than panicking),
/// whether it has already been redeemed, and how many wrong guesses it has
/// absorbed so far.
pub struct PairingState {
    code: Option<PairingCode>,
    used: bool,
    failed_attempts: u8,
}

impl PairingState {
    pub fn armed(code: PairingCode) -> Self {
        Self { code: Some(code), used: false, failed_attempts: 0 }
    }

    /// The code this session was armed with, or `""` if never armed. Exists
    /// so callers (and tests) can read back what to type without reaching
    /// into the private `code` field.
    pub fn code(&self) -> &str {
        self.code.as_ref().map(|c| c.code.as_str()).unwrap_or("")
    }
}

/// Draws a fresh 6-digit pairing code from the OS CSPRNG (`getrandom`, same
/// source `htmlview::mint_view_token` uses for its token bytes) rather than
/// a PRNG seeded from the clock — a guessable code would defeat the whole
/// point of a pairing step. `now_ms` is caller-supplied (not read here) so
/// `redeem`'s expiry check is deterministic under test.
pub fn issue_pairing_code(now_ms: u64) -> PairingCode {
    let mut bytes = [0u8; 4];
    getrandom::fill(&mut bytes).expect("OS CSPRNG must be available");
    let n = u32::from_be_bytes(bytes) % 1_000_000;
    PairingCode { code: format!("{n:06}"), issued_at_ms: now_ms }
}

/// Exchanges a pairing code for a device token. Checks expiry, prior use,
/// and lockout **before** ever comparing `offered` against the issued
/// code — a session that has already locked out must refuse even the
/// genuinely correct code, so a caller can never tell (by trying after
/// lockout) whether the code they eventually typed was right. Only once all
/// three gates pass does it compare (in constant time) and, on mismatch,
/// count the attempt.
pub fn redeem(state: &mut PairingState, offered: &str, now_ms: u64) -> Result<String, PairError> {
    let Some(issued) = state.code.clone() else { return Err(PairError::NotArmed) };
    if state.used {
        return Err(PairError::AlreadyUsed);
    }
    if state.failed_attempts >= PAIRING_MAX_ATTEMPTS {
        return Err(PairError::LockedOut);
    }
    if now_ms.saturating_sub(issued.issued_at_ms) > PAIRING_TTL_MS {
        return Err(PairError::Expired);
    }
    if !constant_time_eq(offered, &issued.code) {
        state.failed_attempts += 1;
        return Err(PairError::Mismatch);
    }
    state.used = true;
    Ok(crate::htmlview::mint_view_token())
}

/// Byte-for-byte comparison that never short-circuits on a *content*
/// mismatch, so a timing side channel can't leak how many leading bytes of
/// a guess were right. A length mismatch returns early — the length of a
/// pairing code isn't a secret, only its digits are — matching
/// `constant_time_eq`'s job everywhere else in this codebase (compare
/// exactly the confidential part, nothing more).
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
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

    // --- pairing ---

    #[test]
    fn pairing_code_is_six_digits() {
        let c = issue_pairing_code(0);
        assert_eq!(c.code.len(), 6);
        assert!(c.code.chars().all(|ch| ch.is_ascii_digit()));
    }

    #[test]
    fn pairing_code_expires_after_five_minutes() {
        let mut st = PairingState::armed(issue_pairing_code(0));
        let code = st.code().to_string();
        assert!(matches!(redeem(&mut st, &code, 5 * 60_000 + 1), Err(PairError::Expired)));
    }

    #[test]
    fn pairing_code_is_single_use() {
        let mut st = PairingState::armed(issue_pairing_code(0));
        let code = st.code().to_string();
        assert!(redeem(&mut st, &code, 1_000).is_ok());
        assert!(matches!(redeem(&mut st, &code, 2_000), Err(PairError::AlreadyUsed)));
    }

    #[test]
    fn pairing_code_locks_out_after_five_wrong_attempts() {
        let mut st = PairingState::armed(issue_pairing_code(0));
        let code = st.code().to_string();
        for _ in 0..5 {
            assert!(matches!(redeem(&mut st, "000000", 1_000), Err(PairError::Mismatch)));
        }
        assert!(
            matches!(redeem(&mut st, &code, 1_000), Err(PairError::LockedOut)),
            "정답이어도 시도 초과 후에는 거부한다"
        );
    }

    #[test]
    fn redeeming_yields_a_128_bit_device_token() {
        let mut st = PairingState::armed(issue_pairing_code(0));
        let code = st.code().to_string();
        let token = redeem(&mut st, &code, 1_000).unwrap();
        assert_eq!(token.len(), 32, "16바이트 hex");
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn constant_time_eq_matches_normal_equality() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "ab"));
    }
}
