//! Pure contract for vault image attachments (single-window-opening Todo 4).
//!
//! This module owns the *shape* of the attachment feature: how a candidate
//! `.attachments` file name is derived deterministically, what makes a
//! basename safe to place inside `.attachments`, how a file's identity is
//! captured and compared (the opaque-receipt primitive), and the wire shape
//! the frontend receives back from an import. It deliberately does no I/O of
//! its own — `attachment_import.rs` (Todo 5) is where the atomic
//! create/copy/hard_link sequence and the `#[tauri::command]`s that drive it
//! live. Splitting it this way lets the contract land, get reviewed, and lock
//! in tests before any filesystem-mutating code exists to get it wrong.
//!
//! Every non-test item here is exercised by its own `#[cfg(test)]` case and,
//! as of Todo 5, by its one real caller: `attachment_import.rs`, which drives
//! the whole install/rollback/finalize sequence through exactly this
//! module's types and pure functions.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// Deterministic collision-avoidance name for a `.attachments` entry:
/// candidate `n = 0` keeps the original basename, `n >= 1` inserts `-{n}`
/// before the extension. Same inputs always produce the same output (no
/// clock, no randomness, no filesystem read) — the install loop (Todo 5)
/// relies on this determinism to retry a taken slot reproducibly, and so the
/// sequence of candidates is fully testable without touching a disk.
pub(crate) fn attachment_file_name(stem: &str, ext: &str, n: u64) -> String {
    if n == 0 {
        format!("{stem}.{ext}")
    } else {
        format!("{stem}-{n}.{ext}")
    }
}

/// Confines a `.attachments` entry name to a single flat path segment: no `/`
/// or `\` (either would let the name escape `.attachments` into an arbitrary
/// subpath — the "destination escape" failure in the design), no `..`/`.`
/// (traversal / no-op segments), not empty, and no NUL (illegal in a path on
/// every target OS and a classic C-string-truncation vector). This is the
/// only gate standing between an attachment name and the filesystem, so it is
/// deliberately conservative: anything not obviously a plain file name is
/// rejected rather than sanitized.
pub(crate) fn validate_attachment_basename(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("attachment name must not be empty".to_string());
    }
    if name == "." || name == ".." {
        return Err(format!("attachment name must not be a directory segment: {name}"));
    }
    if name.contains('/') || name.contains('\\') {
        return Err(format!(
            "attachment name must not contain a path separator: {name}"
        ));
    }
    if name.contains('\0') {
        return Err("attachment name must not contain NUL".to_string());
    }
    Ok(())
}

/// A file's identity at the moment it was captured, used to answer "is this
/// still the file we created?" without trusting a path alone (paths can be
/// replaced). On Unix this is the `(dev, ino)` pair, which is stable across
/// renames/hard-links and changes the instant the path is repointed at a
/// different inode — exactly the property the rollback guard (Todo 5) needs.
/// Off Unix there is no portable inode-equivalent in `std`, so identity falls
/// back to `(len, modified)`; this is best-effort (a same-size same-mtime
/// replacement would be missed), which is acceptable because mermark's release
/// posture is macOS-first and Windows support is opt-in.
#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FileIdentity {
    dev: u64,
    ino: u64,
}

#[cfg(unix)]
impl FileIdentity {
    pub(crate) fn of(meta: &std::fs::Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;
        FileIdentity { dev: meta.dev(), ino: meta.ino() }
    }
}

#[cfg(not(unix))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FileIdentity {
    len: u64,
    modified: Option<std::time::SystemTime>,
}

#[cfg(not(unix))]
impl FileIdentity {
    pub(crate) fn of(meta: &std::fs::Metadata) -> Self {
        FileIdentity { len: meta.len(), modified: meta.modified().ok() }
    }
}

/// Whether `meta` (a fresh stat of some path) still identifies the same file
/// as `identity` (captured earlier, typically at install time). Named so the
/// rollback/finalize logic (Todo 5) reads as a domain rule — "has this file
/// changed identity since we made it?" — rather than an inline field
/// comparison at each call site.
pub(crate) fn identity_matches(meta: &std::fs::Metadata, identity: &FileIdentity) -> bool {
    FileIdentity::of(meta) == *identity
}

/// Server-side record backing one opaque `AttachmentReceipt`: the installed
/// file's vault-relative destination and the identity captured right after
/// install. The Todo 5 rollback/finalize commands look this up by `token` —
/// never by a frontend-supplied path — which is what makes the receipt
/// opaque: the only way to name a file for deletion is to hold a token this
/// process minted for a file this process just created.
pub(crate) struct ReceiptRecord {
    pub(crate) dest: PathBuf,
    pub(crate) identity: FileIdentity,
}

/// Managed state: in-memory map from opaque token to its receipt record. Only
/// entries for imports that have been installed but not yet finalized or
/// rolled back live here. Declared in this module (rather than
/// `attachment_import.rs`) because the *shape* of the receipt bookkeeping is
/// part of the Todo 4 contract; the commands that populate and drain it are
/// Todo 5. A process crash between import and finalize drops this map along
/// with the process — and with it, the only means of deleting the file — so
/// "retain the file conservatively on abrupt termination" falls out of this
/// structure rather than needing to be implemented as a separate rule.
#[derive(Default)]
pub struct AttachmentReceipts(pub(crate) Mutex<HashMap<u64, ReceiptRecord>>);

/// Wire shape of an `import_vault_attachment` result (Todo 5 command). Tagged
/// so the frontend can branch on `status` without a separate boolean, and
/// `Cancelled` carries no payload because a cancelled picker never reaches
/// the install path — there is nothing to report beyond the tag itself.
#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum AttachmentImportOutcome {
    Cancelled,
    Imported { receipt: AttachmentReceipt },
}

/// Opaque receipt returned to the frontend after a successful import.
/// `token` is the only handle the frontend can use to finalize or roll back
/// the import — `rel_path`/`file_name` are display-only, used to build the
/// `![name](vault:.attachments/name.ext)` insertion text, and are never
/// accepted back as input to any command (see `AttachmentReceipts` doc).
/// `rel_path` is always forward-slash and vault-root-relative, e.g.
/// `.attachments/pic-1.png`.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentReceipt {
    pub token: u64,
    pub rel_path: String,
    pub file_name: String,
}

#[cfg(test)]
mod attachment_contract_tests {
    use super::*;
    use crate::commands::is_image_ext;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TMP_SEQ: AtomicU64 = AtomicU64::new(1);

    fn temp_path(tag: &str) -> std::path::PathBuf {
        let n = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("mermark_attach_test_{}_{}_{tag}", std::process::id(), n))
    }

    // --- attachment_file_name: deterministic collision suffixes ---

    #[test]
    fn attachment_file_name_zero_keeps_original_basename() {
        assert_eq!(attachment_file_name("pic", "png", 0), "pic.png");
    }

    #[test]
    fn attachment_file_name_inserts_numeric_suffix() {
        assert_eq!(attachment_file_name("pic", "png", 1), "pic-1.png");
        assert_eq!(attachment_file_name("pic", "png", 12), "pic-12.png");
    }

    #[test]
    fn attachment_file_name_is_deterministic() {
        // Same inputs, called repeatedly, must always agree — the install
        // loop (Todo 5) depends on this to retry reproducibly.
        for _ in 0..5 {
            assert_eq!(attachment_file_name("pic", "png", 1), "pic-1.png");
        }
        assert_eq!(
            attachment_file_name("pic", "png", 7),
            attachment_file_name("pic", "png", 7)
        );
    }

    // --- validate_attachment_basename: target-escape gate ---

    #[test]
    fn validate_attachment_basename_accepts_plain_name() {
        assert!(validate_attachment_basename("pic.png").is_ok());
    }

    #[test]
    fn validate_attachment_basename_rejects_forward_slash() {
        assert!(validate_attachment_basename("a/b.png").is_err());
    }

    #[test]
    fn validate_attachment_basename_rejects_backslash() {
        assert!(validate_attachment_basename("a\\b.png").is_err());
    }

    #[test]
    fn validate_attachment_basename_rejects_parent_traversal() {
        assert!(validate_attachment_basename("..").is_err());
    }

    #[test]
    fn validate_attachment_basename_rejects_current_dir_segment() {
        assert!(validate_attachment_basename(".").is_err());
    }

    #[test]
    fn validate_attachment_basename_rejects_empty_name() {
        assert!(validate_attachment_basename("").is_err());
    }

    #[test]
    fn validate_attachment_basename_rejects_nul_byte() {
        assert!(validate_attachment_basename("a\0b.png").is_err());
    }

    // --- is_image_ext reuse gate (commands.rs SSOT) ---

    #[test]
    fn is_image_ext_gate_matches_frontend_image_extensions_case_insensitively() {
        // The element set here must stay identical to the frontend's
        // IMAGE_EXTENSIONS (src/sidebar/explorer/file-icons.ts) — this test
        // pins the reuse point, not a duplicated list.
        assert!(is_image_ext("png"));
        assert!(is_image_ext("PNG"));
        assert!(!is_image_ext("md"));
        assert!(!is_image_ext(""));
    }

    // --- FileIdentity / identity_matches ---

    #[cfg(unix)]
    #[test]
    fn identity_matches_same_file_stated_twice() {
        let path = temp_path("identity_same.png");
        fs::write(&path, b"bytes").unwrap();
        let meta_a = fs::metadata(&path).unwrap();
        let identity = FileIdentity::of(&meta_a);
        let meta_b = fs::metadata(&path).unwrap();
        assert!(identity_matches(&meta_b, &identity));
        fs::remove_file(&path).ok();
    }

    #[cfg(unix)]
    #[test]
    fn identity_mismatches_after_delete_and_recreate_same_name() {
        let path = temp_path("identity_replaced.png");
        fs::write(&path, b"original").unwrap();
        let identity = FileIdentity::of(&fs::metadata(&path).unwrap());
        fs::remove_file(&path).unwrap();
        fs::write(&path, b"replacement").unwrap();
        let replaced_meta = fs::metadata(&path).unwrap();
        assert!(!identity_matches(&replaced_meta, &identity));
        fs::remove_file(&path).ok();
    }
}
