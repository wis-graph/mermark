//! Atomic import of images into permanent-vault storage
//! (single-window-opening Todo 5): the `#[tauri::command]`s the frontend
//! invokes for `image.attach`, and the dialog-free filesystem core they
//! delegate to.
//!
//! `attachments.rs` (Todo 4) owns the *shape* of this feature — deterministic
//! collision names, the basename-escape gate, file identity, and the wire
//! types. This module owns the *sequence*: pick a source file, copy it into a
//! sibling temp under `.attachments`, and install it under a name nobody else
//! is using via a no-replace primitive, cleaning up on every failure.
//!
//! ## Why `hard_link`, not `rename`, is the install primitive
//! POSIX `rename(2)` (and Windows' `MoveFileExW`) is *atomic but replacing*:
//! if the destination exists, it silently clobbers it. That is exactly the
//! one thing this feature must never do to a vault. `std::fs::hard_link`
//! (POSIX `link(2)` / `CreateHardLinkW`) is atomic and non-replacing: if the
//! destination exists, the kernel fails the call with `AlreadyExists` and
//! touches nothing. Two processes racing to link the same destination name
//! both wait on the same kernel-level guarantee — exactly one wins, the loser
//! observes `AlreadyExists` and retries the next candidate name — with no
//! locking of our own. See `_workspace/01_architect_wave2_design.md` §분기 2
//! for the full platform survey (macOS/Linux both support hard links on
//! their default filesystems; FAT/exFAT external vaults do not, and fail
//! closed into `ATTACH_COPY:` rather than silently succeeding unsafely).
//!
//! ## Dialog plugin: Rust-API-only, zero capability entries
//! `import_vault_attachment` calls `tauri_plugin_dialog`'s
//! `blocking_pick_file()` directly from Rust — the webview never invokes a
//! dialog command, so `capabilities/default.json` needs no new permission
//! entry (the orchestrator's ruling on this, including the main-thread
//! deadlock question addressed below, is recorded in
//! `_workspace/00_adjudication_wave2.md` and
//! `.omo/evidence/single-window-opening/task-5-backend.md`).
//!
//! ## No main-thread deadlock
//! `import_vault_attachment` is declared `async fn`, so Tauri runs its body
//! off the main/event-loop thread. `blocking_pick_file()`'s own
//! implementation (`tauri-plugin-dialog` v2.7.2, `src/desktop.rs`) dispatches
//! the actual native panel open to the main thread via
//! `AppHandle::run_on_main_thread` — a fire-and-forget post, not a blocking
//! call — then spawns a *separate* OS thread that awaits the dialog future
//! and reports the result back over a rendezvous channel; `blocking_pick_file`
//! itself just blocks *this* command's worker thread on that channel. The
//! main thread only ever runs a short, non-blocking closure to kick the
//! panel open and keeps pumping its event loop throughout — it is never the
//! thread that waits. See the evidence file for the full source trace.
use crate::attachments::{
    attachment_file_name, identity_matches, AttachmentImportOutcome, AttachmentReceipt,
    AttachmentReceipts, FileIdentity, ReceiptRecord,
};
use crate::attachments::validate_attachment_basename;
use crate::commands::is_image_ext;
use crate::qa_trace::qa_trace;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri_plugin_dialog::DialogExt;

/// Defensive upper bound on collision-suffix retries. Not expected to ever
/// bind in real use — it exists so a pathological `.attachments` directory
/// (thousands of numbered collisions for one basename) fails loudly instead
/// of looping forever.
const MAX_CANDIDATES: u64 = 10_000;

/// Extensions offered in the native picker's filter. Must stay identical to
/// `is_image_ext`'s match arms — pinned by the
/// `dialog_filter_list_matches_is_image_ext_gate` test below — because the
/// filter is a UX convenience only; `is_image_ext` on the actually-picked
/// file is the real gate (`import_attachment_from` re-checks it, since nothing
/// stops a user from typing a non-matching name into a native "all files"
/// fallback).
const IMAGE_DIALOG_FILTERS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"];

/// Process-unique counter for `.attachments`-sibling temp file names. Mirrors
/// `commands::TMP_SEQ`'s naming pattern but is deliberately a separate
/// counter/module — see that constant's sibling note in `lib.rs` for why the
/// pattern is copied, not the state.
static TMP_SEQ: AtomicU64 = AtomicU64::new(1);

/// Process-unique counter minting opaque receipt tokens. No randomness
/// needed: a guessed token can only ever name a file *this process* imported
/// and has not yet finalized — see `AttachmentReceipts`'s doc comment
/// (`attachments.rs`) for why that alone is the whole opacity guarantee.
static TOKEN_SEQ: AtomicU64 = AtomicU64::new(1);

/// RAII guard that deletes a sibling temp file on drop unless `defuse` was
/// called first. Defused only right after a successful `hard_link` install,
/// so every failure path — copy error, flush error, a non-`AlreadyExists`
/// install error, collision-loop exhaustion, even a panic unwinding through
/// this scope — cleans the temp file by construction, rather than by
/// enumerating each failing `return` by hand.
struct TempGuard {
    path: PathBuf,
    defused: bool,
}

impl TempGuard {
    fn new(path: PathBuf) -> Self {
        TempGuard { path, defused: false }
    }

    fn defuse(&mut self) {
        self.defused = true;
    }
}

impl Drop for TempGuard {
    fn drop(&mut self) {
        if !self.defused {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Ensures `.attachments` exists as a real (non-symlink) directory directly
/// under `vault_root`, creating it if entirely absent. Uses `symlink_metadata`
/// (never `metadata`, which follows symlinks) so a `.attachments` that has
/// been replaced with a symlink is caught *before* anything is written
/// through it — a symlink's `file_type()` reports `is_dir() == false`
/// regardless of what it points at, so this one check rejects both "not a
/// directory" and "directory reached only via a symlink" in one gate.
fn ensure_real_attachments_dir(vault_root: &Path) -> Result<PathBuf, String> {
    let dir = vault_root.join(".attachments");
    match fs::symlink_metadata(&dir) {
        Ok(meta) if meta.is_dir() => Ok(dir),
        Ok(_) => Err(format!(
            "ATTACH_DIR_INVALID: {} exists but is not a regular directory",
            dir.display()
        )),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(&dir)
                .map_err(|e| format!("ATTACH_COPY: cannot create {}: {e}", dir.display()))?;
            Ok(dir)
        }
        Err(e) => Err(format!("ATTACH_COPY: cannot inspect {}: {e}", dir.display())),
    }
}

/// Splits an already-validated attachment source name into `(stem, ext)` for
/// `attachment_file_name`. Only called after the `is_image_ext`/basename
/// gates have accepted `file_name`, so `extension()` is guaranteed `Some`.
fn split_stem_ext(file_name: &str) -> (String, String) {
    let path = Path::new(file_name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(file_name).to_string();
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_string();
    (stem, ext)
}

/// The shared source-acceptability gate for attaching an image: `source` must
/// have a file name, that name's extension must be a recognized image
/// extension (`is_image_ext`), and `source` must be a regular file (not a
/// directory, a device node, etc.). Applied identically whether the source
/// ends up copied into `.attachments` (outside-vault, `import_attachment_from`
/// below) or referenced in place (`AlreadyInVault`, inside-vault,
/// `attach_outcome_from` below) — an already-in-vault non-image file must be
/// rejected exactly like an outside one (design §분기 4, row 2). Returns the
/// borrowed file name on success so callers don't re-derive it.
///
/// Deliberately does NOT run `validate_attachment_basename` (the
/// destination-escape gate): that only matters when a name is about to be
/// placed as a new `.attachments` entry, which never happens for an in-vault
/// source — `import_attachment_from` applies it itself, right after this gate,
/// only on the path that actually writes a destination name.
fn validate_attachable_source(source: &Path) -> Result<&str, String> {
    let file_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "ATTACH_INVALID_IMAGE: source has no file name".to_string())?;
    let ext_ok = Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(is_image_ext);
    if !ext_ok {
        return Err(format!("ATTACH_INVALID_IMAGE: {file_name} is not an image"));
    }
    // "Not a regular file" shares the same user-facing failure as "wrong
    // extension" (design §분기 4, row 3) — both mean "this isn't something we
    // can attach as an image" from the caller's point of view.
    let source_is_regular_file = source.metadata().map(|m| m.is_file()).unwrap_or(false);
    if !source_is_regular_file {
        return Err(format!("ATTACH_INVALID_IMAGE: {file_name} is not a regular file"));
    }
    Ok(file_name)
}

/// Whether the picked `source` file already lives inside the vault rooted at
/// `root_canon` (which the caller must already have canonicalized). Resolves
/// `source` via `fs::canonicalize` too — not a lexical comparison — so a
/// symlink that lexically sits under the vault but points *outside* it is
/// correctly judged "outside" and takes the ordinary copy-in path rather than
/// being referenced in place (the same canonicalize-then-compare argument as
/// `file_target_is_within_base` in `commands.rs`, applied here to the
/// picker's selection instead of a scan candidate — design §분기 4).
/// `fs::canonicalize` failing (source vanished, permission denied, a broken
/// symlink, …) is treated as "outside" too: a fail-through into the ordinary
/// import path, which will surface its own clear `ATTACH_*` error rather than
/// silently skipping the copy on an unresolvable path.
fn picked_source_is_inside_vault(root_canon: &Path, source: &Path) -> bool {
    match fs::canonicalize(source) {
        Ok(resolved) => resolved.starts_with(root_canon),
        Err(_) => false,
    }
}

/// The dialog-free, filesystem-mutating core of `import_vault_attachment`:
/// validate `source`, copy it into a sibling temp under
/// `vault_root/.attachments`, and install it under a deterministic
/// collision-free name via no-replace `hard_link`. No dialog, no
/// `AppHandle` — every temp-vault integration test in this module drives
/// this function directly; the command wrapper below is a thin
/// dialog-then-delegate shell around it (design §분기 2).
///
/// Must NOT: touch `source` beyond reading it (never moved, never deleted —
/// the only filesystem call against it is `metadata`/`File::open`),
/// overwrite an existing `.attachments` entry (`hard_link`'s `AlreadyExists`
/// is the *only* retried error), or leave a temp file behind on any failure
/// (enforced by `TempGuard`, not by enumerating failure branches).
pub(crate) fn import_attachment_from(
    source: &Path,
    vault_root: &Path,
    receipts: &AttachmentReceipts,
) -> Result<AttachmentReceipt, String> {
    let file_name = validate_attachable_source(source)?;
    validate_attachment_basename(file_name).map_err(|e| format!("ATTACH_ESCAPE: {e}"))?;

    let attachments_dir = ensure_real_attachments_dir(vault_root)?;
    let (stem, ext) = split_stem_ext(file_name);

    let temp_name = format!("{file_name}.mermark-tmp.{}", TMP_SEQ.fetch_add(1, Ordering::Relaxed));
    let temp_path = attachments_dir.join(&temp_name);
    let mut temp_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
        .map_err(|e| format!("ATTACH_COPY: cannot create temp {}: {e}", temp_path.display()))?;
    // From this point on, every early return must go through `guard` staying
    // armed so the temp file is removed on drop — only the success arm below
    // defuses it.
    let mut guard = TempGuard::new(temp_path.clone());

    let mut source_file =
        File::open(source).map_err(|e| format!("ATTACH_COPY: cannot open {file_name}: {e}"))?;
    io::copy(&mut source_file, &mut temp_file)
        .map_err(|e| format!("ATTACH_COPY: cannot copy {file_name}: {e}"))?;
    temp_file.sync_all().map_err(|e| format!("ATTACH_COPY: cannot flush {file_name}: {e}"))?;

    // Captured from the still-open fd, not a fresh stat-by-path: `hard_link`
    // guarantees the eventual destination shares this exact inode, so this
    // identity already *is* the destination's identity — no re-stat race
    // between "we just made this file" and "someone else touched the path".
    let identity = FileIdentity::of(
        &temp_file
            .metadata()
            .map_err(|e| format!("ATTACH_COPY: cannot stat temp {}: {e}", temp_path.display()))?,
    );
    drop(temp_file);

    for n in 0..MAX_CANDIDATES {
        let candidate_name = attachment_file_name(&stem, &ext, n);
        let dest = attachments_dir.join(&candidate_name);
        match fs::hard_link(&temp_path, &dest) {
            Ok(()) => {
                // Best-effort: dest already carries the bytes (same inode)
                // regardless of whether this cleanup succeeds.
                let _ = fs::remove_file(&temp_path);
                guard.defuse();
                let token = TOKEN_SEQ.fetch_add(1, Ordering::Relaxed);
                receipts
                    .0
                    .lock()
                    .unwrap()
                    .insert(token, ReceiptRecord { dest, identity });
                return Ok(AttachmentReceipt {
                    token,
                    rel_path: format!(".attachments/{candidate_name}"),
                    file_name: candidate_name,
                });
            }
            // The only retried error: the destination is already occupied.
            // Every other error (permissions, disk full, unsupported
            // operation on the underlying filesystem, …) fails the import
            // outright rather than looping.
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("ATTACH_COPY: cannot install {candidate_name}: {e}")),
        }
    }
    Err(format!("ATTACH_COPY: exhausted {MAX_CANDIDATES} collision candidates for {file_name}"))
}

/// The dialog-free core of `import_vault_attachment`'s outcome decision
/// (`vault:` scheme withdrawal, design §분기 4): after the shared
/// `validate_attachable_source` gate accepts the picked file, a source that
/// already lives inside the vault (`picked_source_is_inside_vault`) is
/// referenced in place — `AlreadyInVault`, no copy, no receipt minted, since
/// there is nothing to finalize or roll back — while a source outside the
/// vault goes through the unchanged `import_attachment_from` machinery. This
/// is the one place the "is it already in the vault?" judgment is made: the
/// native picker only exists on the backend, so this is the only place it
/// *can* be made. `root_canon` must already be canonicalized by the caller
/// (the command wrapper below does this once and reuses it for both this
/// check and the import call).
pub(crate) fn attach_outcome_from(
    source: &Path,
    root_canon: &Path,
    receipts: &AttachmentReceipts,
) -> Result<AttachmentImportOutcome, String> {
    let file_name = validate_attachable_source(source)?;
    if picked_source_is_inside_vault(root_canon, source) {
        return Ok(AttachmentImportOutcome::AlreadyInVault { file_name: file_name.to_string() });
    }
    let receipt = import_attachment_from(source, root_canon, receipts)?;
    Ok(AttachmentImportOutcome::Imported { receipt })
}

/// Deletes the file behind `token` only if it is still exactly the file this
/// process created: a no-follow (`symlink_metadata`) stat rules out a
/// destination that has since been swapped for a symlink (which would
/// otherwise redirect a follow-and-delete at an attacker-chosen target), and
/// `identity_matches` rules out an in-place same-name replacement. An
/// unknown token, a stat failure, or a changed identity all *refuse* rather
/// than guess — the only path that ever deletes anything is "we still
/// recognise exactly this file."
pub(crate) fn rollback_import(receipts: &AttachmentReceipts, token: u64) -> Result<(), String> {
    let mut map = receipts.0.lock().unwrap();
    let (dest, identity) = match map.get(&token) {
        Some(record) => (record.dest.clone(), record.identity),
        None => return Err(format!("ROLLBACK_UNKNOWN: no pending import for token {token}")),
    };

    let meta = match fs::symlink_metadata(&dest) {
        Ok(meta) => meta,
        Err(e) => return Err(format!("ROLLBACK_IO: cannot inspect {}: {e}", dest.display())),
    };
    if !meta.is_file() || !identity_matches(&meta, &identity) {
        // No longer the file we made — the record can't vouch for whatever
        // is at `dest` now, so it is dropped without deleting anything.
        map.remove(&token);
        return Err(format!("ROLLBACK_CHANGED: {} was modified since import", dest.display()));
    }
    match fs::remove_file(&dest) {
        Ok(()) => {
            map.remove(&token);
            Ok(())
        }
        // Deletion failed: keep the record so a later retry can still find
        // and remove exactly this file — conservative, matching the
        // "retain rather than risk deleting the wrong thing" posture
        // (design §분기 3).
        Err(e) => Err(format!("ROLLBACK_IO: cannot remove {}: {e}", dest.display())),
    }
}

/// Drops the bookkeeping for a successfully-inserted import, making the file
/// permanent — once its record is gone, no code path can delete it by token
/// again. Idempotent on an unknown/already-finalized token: finalizing twice,
/// or finalizing after a rollback already removed the record, both do
/// nothing rather than error, since "no record" and "already permanent" are
/// indistinguishable from here and neither is a mistake worth reporting.
fn finalize_import(receipts: &AttachmentReceipts, token: u64) {
    receipts.0.lock().unwrap().remove(&token);
}

/// Debug-only override for `import_vault_attachment`'s native file dialog
/// (single-window-opening Todo 6): the native picker is an OS modal with no
/// scripting seam, so a QA harness stands in for it via
/// `MERMARK_QA_PICK_FILE` — a path means "the user picked this file"
/// (`Source`), an empty string means "the user cancelled" (`Cancel`). This
/// enum only exists in debug builds, alongside the rest of the qa_trace seam.
#[cfg(debug_assertions)]
#[derive(Debug, PartialEq)]
pub(crate) enum PickOverride {
    Cancel,
    Source(PathBuf),
}

/// Pure mapping from `std::env::var("MERMARK_QA_PICK_FILE")`'s raw `Result`
/// to a `PickOverride`: unset (`Err`) means no override at all — the real
/// dialog runs — set-and-empty means "cancelled", set-and-non-empty is the
/// source path. Takes the `Result` as a parameter rather than reading the
/// env var itself specifically so this domain rule is a plain function a
/// unit test can lock down without mutating process env (which would
/// otherwise race across `cargo test`'s parallel threads).
#[cfg(debug_assertions)]
pub(crate) fn qa_pick_override(raw: Result<String, std::env::VarError>) -> Option<PickOverride> {
    match raw {
        Err(_) => None,
        Ok(s) if s.is_empty() => Some(PickOverride::Cancel),
        Ok(s) => Some(PickOverride::Source(PathBuf::from(s))),
    }
}

/// Opens the real native picker and resolves its result to a source path, or
/// `None` for "user cancelled". The one place `blocking_pick_file()` is
/// called from — both the debug QA-override path and the plain release path
/// route through this so there is exactly one dialog call site to reason
/// about.
fn pick_file_via_dialog(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    let picked = app.dialog().file().add_filter("Image", IMAGE_DIALOG_FILTERS).blocking_pick_file();
    match picked {
        None => Ok(None),
        Some(file_path) => file_path
            .into_path()
            .map(Some)
            .map_err(|e| format!("ATTACH_INVALID_IMAGE: cannot resolve picked file: {e}")),
    }
}

/// Resolves the source path `import_vault_attachment` should import, or
/// `None` for "cancelled" — from the Todo 6 QA override when
/// `MERMARK_QA_PICK_FILE` is set, else the real native dialog. The override
/// replaces exactly this one call; every step after it (validation, temp
/// copy, install, receipt) is the same real code either way (see this
/// module's doc comment on the picker plugin).
#[cfg(debug_assertions)]
fn resolve_import_source(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    match qa_pick_override(std::env::var("MERMARK_QA_PICK_FILE")) {
        Some(PickOverride::Cancel) => Ok(None),
        Some(PickOverride::Source(path)) => Ok(Some(path)),
        None => pick_file_via_dialog(app),
    }
}

/// Release build's twin of the function above: always the real dialog, no
/// QA override in scope at all — `MERMARK_QA_PICK_FILE` is read nowhere in
/// this compilation.
#[cfg(not(debug_assertions))]
fn resolve_import_source(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    pick_file_via_dialog(app)
}

/// Picks an image (via the native dialog, or the debug-only QA override
/// above) and imports it into the permanent vault at `vault_root`. Returns
/// `Cancelled` when the user closes the picker without choosing a file —
/// import never runs on a cancelled selection because the code to run it is
/// simply never reached, not because of a check the frontend must remember
/// to make.
///
/// `async fn` is load-bearing: see this module's doc comment for why that is
/// what makes `blocking_pick_file()` safe to call here (it must not run on
/// Tauri's main/event-loop thread).
#[tauri::command]
pub async fn import_vault_attachment(
    app: tauri::AppHandle,
    vault_root: String,
    receipts: tauri::State<'_, AttachmentReceipts>,
) -> Result<AttachmentImportOutcome, String> {
    let root = fs::canonicalize(&vault_root)
        .map_err(|e| format!("ATTACH_COPY: cannot resolve vault root {vault_root}: {e}"))?;
    if !root.is_dir() {
        return Err(format!("ATTACH_COPY: vault root is not a directory: {}", root.display()));
    }

    let source = match resolve_import_source(&app)? {
        None => {
            qa_trace!("attach-import", serde_json::json!({ "outcome": "cancelled" }));
            return Ok(AttachmentImportOutcome::Cancelled);
        }
        Some(path) => path,
    };

    match attach_outcome_from(&source, &root, &receipts) {
        Ok(outcome) => {
            match &outcome {
                AttachmentImportOutcome::Imported { receipt } => qa_trace!(
                    "attach-import",
                    serde_json::json!({
                        "outcome": "imported",
                        "token": receipt.token,
                        "rel_path": receipt.rel_path,
                    })
                ),
                AttachmentImportOutcome::AlreadyInVault { file_name } => qa_trace!(
                    "attach-import",
                    serde_json::json!({ "outcome": "alreadyInVault", "file_name": file_name })
                ),
                AttachmentImportOutcome::Cancelled => {} // unreachable here — early-returned above
            }
            Ok(outcome)
        }
        Err(e) => {
            qa_trace!("attach-import", serde_json::json!({ "outcome": "error", "error": e }));
            Err(e)
        }
    }
}

/// Makes a successful import permanent. Called only after the frontend's
/// synchronous editor insertion has already succeeded (design lifecycle
/// contract) — this command itself has no way to know that and doesn't try
/// to; it only ever removes bookkeeping, never a file.
#[tauri::command]
pub fn finalize_attachment_import(
    token: u64,
    receipts: tauri::State<'_, AttachmentReceipts>,
) -> Result<(), String> {
    finalize_import(&receipts, token);
    qa_trace!("attach-finalize", serde_json::json!({ "token": token }));
    Ok(())
}

/// Classifies a `rollback_import` result into the trace vocabulary the Todo
/// 6 harness asserts against (`removed`/`changed`/`io`/`unknown`), read off
/// the same `ROLLBACK_*` error prefixes the frontend already branches on.
/// Debug-only: its one call site is a `qa_trace!` argument, discarded
/// unevaluated in release (see `qa_trace` module doc), so gating the
/// function too avoids an "unused function" warning in that build.
#[cfg(debug_assertions)]
fn qa_rollback_result_label(result: &Result<(), String>) -> &'static str {
    match result {
        Ok(()) => "removed",
        Err(e) if e.starts_with("ROLLBACK_CHANGED:") => "changed",
        Err(e) if e.starts_with("ROLLBACK_IO:") => "io",
        Err(_) => "unknown",
    }
}

/// Undoes a successful import after a synchronous editor-insertion failure.
/// `token` is the *only* input — see `AttachmentReceipts`'s doc comment for
/// why a frontend-supplied path is never accepted here.
#[tauri::command]
pub fn rollback_attachment_import(
    token: u64,
    receipts: tauri::State<'_, AttachmentReceipts>,
) -> Result<(), String> {
    let result = rollback_import(&receipts, token);
    qa_trace!(
        "attach-rollback",
        serde_json::json!({ "token": token, "result": qa_rollback_result_label(&result) })
    );
    result
}

#[cfg(test)]
mod attachment_import_tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    static TEST_SEQ: AtomicU64 = AtomicU64::new(1);

    fn temp_vault(tag: &str) -> PathBuf {
        let n = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir()
            .join(format!("mermark_attach_import_test_{}_{}_{tag}", std::process::id(), n));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_bytes(path: &Path, bytes: &[u8]) {
        fs::write(path, bytes).unwrap();
    }

    fn assert_err_prefixed(result: &Result<AttachmentReceipt, String>, prefix: &str) {
        match result {
            Err(e) if e.starts_with(prefix) => {}
            other => panic!("expected {prefix} prefix, got {other:?}"),
        }
    }

    #[test]
    fn import_creates_attachment_with_original_basename() {
        let vault = temp_vault("basename");
        let source = vault.join("pic.png");
        write_bytes(&source, b"pixels");
        let receipts = AttachmentReceipts::default();

        let receipt = import_attachment_from(&source, &vault, &receipts).unwrap();

        assert_eq!(receipt.file_name, "pic.png");
        assert_eq!(receipt.rel_path, ".attachments/pic.png");
        assert_eq!(fs::read(vault.join(".attachments/pic.png")).unwrap(), b"pixels");
        // Source is read, never moved.
        assert_eq!(fs::read(&source).unwrap(), b"pixels");

        fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn import_never_clobbers_and_takes_next_suffix() {
        let vault = temp_vault("suffix");
        let attachments = vault.join(".attachments");
        fs::create_dir_all(&attachments).unwrap();
        let existing = attachments.join("pic.png");
        write_bytes(&existing, b"ORIGINAL-BYTES");

        let source = vault.join("pic.png");
        write_bytes(&source, b"new-bytes");
        let receipts = AttachmentReceipts::default();

        let receipt = import_attachment_from(&source, &vault, &receipts).unwrap();

        assert_eq!(receipt.file_name, "pic-1.png");
        // The pre-existing occupant is byte-for-byte untouched.
        assert_eq!(fs::read(&existing).unwrap(), b"ORIGINAL-BYTES");
        assert_eq!(fs::read(attachments.join("pic-1.png")).unwrap(), b"new-bytes");

        fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn concurrent_same_basename_imports_get_distinct_targets() {
        let vault = temp_vault("concurrent");
        let dir_a = vault.join("srcA");
        let dir_b = vault.join("srcB");
        fs::create_dir_all(&dir_a).unwrap();
        fs::create_dir_all(&dir_b).unwrap();
        // Two different files that both happen to be named "pic.png" — the
        // race is on the *destination* basename, not on the source.
        let source_a = dir_a.join("pic.png");
        let source_b = dir_b.join("pic.png");
        write_bytes(&source_a, b"AAAA");
        write_bytes(&source_b, b"BBBB");

        let receipts = Arc::new(AttachmentReceipts::default());
        let (vault_a, vault_b) = (vault.clone(), vault.clone());
        let (receipts_a, receipts_b) = (Arc::clone(&receipts), Arc::clone(&receipts));

        let handle_a =
            std::thread::spawn(move || import_attachment_from(&source_a, &vault_a, &receipts_a));
        let handle_b =
            std::thread::spawn(move || import_attachment_from(&source_b, &vault_b, &receipts_b));

        let receipt_a = handle_a.join().unwrap().unwrap();
        let receipt_b = handle_b.join().unwrap().unwrap();

        let mut names = [receipt_a.file_name.clone(), receipt_b.file_name.clone()];
        names.sort();
        assert_eq!(names, ["pic-1.png".to_string(), "pic.png".to_string()]);

        let attachments = vault.join(".attachments");
        assert_eq!(fs::read(attachments.join(&receipt_a.file_name)).unwrap(), b"AAAA");
        assert_eq!(fs::read(attachments.join(&receipt_b.file_name)).unwrap(), b"BBBB");

        fs::remove_dir_all(&vault).ok();
    }

    #[cfg(unix)]
    #[test]
    fn failed_copy_leaves_no_temp_and_no_dest() {
        use std::os::unix::fs::PermissionsExt;
        let vault = temp_vault("copy_denied");
        let source = vault.join("locked.png");
        write_bytes(&source, b"secret-pixels");
        fs::set_permissions(&source, fs::Permissions::from_mode(0o000)).unwrap();
        let receipts = AttachmentReceipts::default();

        let result = import_attachment_from(&source, &vault, &receipts);
        // Restore perms immediately so cleanup below can't itself fail.
        fs::set_permissions(&source, fs::Permissions::from_mode(0o644)).unwrap();

        assert_err_prefixed(&result, "ATTACH_COPY:");
        let attachments = vault.join(".attachments");
        let leftover_temp = fs::read_dir(&attachments)
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .any(|e| e.file_name().to_string_lossy().contains(".mermark-tmp."))
            })
            .unwrap_or(false);
        assert!(!leftover_temp, "temp file leaked after copy failure");
        assert!(!attachments.join("locked.png").exists());

        fs::remove_dir_all(&vault).ok();
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_attachments_dir_is_rejected_untouched() {
        let vault = temp_vault("symlinked_dir");
        let real_target = vault.join("real-target");
        fs::create_dir_all(&real_target).unwrap();
        write_bytes(&real_target.join("keepme.txt"), b"unchanged");
        std::os::unix::fs::symlink(&real_target, vault.join(".attachments")).unwrap();

        let source = vault.join("pic.png");
        write_bytes(&source, b"pixels");
        let receipts = AttachmentReceipts::default();

        let result = import_attachment_from(&source, &vault, &receipts);

        assert_err_prefixed(&result, "ATTACH_DIR_INVALID:");
        // The symlink target's contents are exactly what they were before —
        // nothing was ever created or written through the symlink.
        let entries: Vec<_> = fs::read_dir(&real_target).unwrap().filter_map(|e| e.ok()).collect();
        assert_eq!(entries.len(), 1);
        assert_eq!(fs::read(real_target.join("keepme.txt")).unwrap(), b"unchanged");

        fs::remove_dir_all(&vault).ok();
    }

    #[cfg(unix)]
    #[test]
    fn invalid_basename_is_rejected_as_escape() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let vault = temp_vault("escape_basename");
        // Backslash is a legal Unix filename byte (not a path separator
        // there), so this constructs a *real* on-disk source whose name
        // still trips `validate_attachment_basename` — proving the core
        // reuses that exact gate rather than a weaker ad hoc check.
        let source = vault.join(OsStr::from_bytes(b"a\\b.png"));
        write_bytes(&source, b"pixels");
        let receipts = AttachmentReceipts::default();

        let result = import_attachment_from(&source, &vault, &receipts);

        assert_err_prefixed(&result, "ATTACH_ESCAPE:");
        assert!(!vault.join(".attachments").exists(), "must fail before touching .attachments");

        fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn non_image_source_is_rejected() {
        let vault = temp_vault("non_image");
        let source = vault.join("note.md");
        write_bytes(&source, b"# not an image");
        let receipts = AttachmentReceipts::default();

        let result = import_attachment_from(&source, &vault, &receipts);

        assert_err_prefixed(&result, "ATTACH_INVALID_IMAGE:");
        assert!(!vault.join(".attachments").exists());

        fs::remove_dir_all(&vault).ok();
    }

    // --- attach_outcome_from (vault: withdrawal — inside-vault vs outside-vault) ---

    #[test]
    fn inside_vault_source_returns_already_in_vault_without_copying() {
        let vault = temp_vault("inside_already");
        fs::create_dir_all(vault.join("sub")).unwrap();
        let source = vault.join("sub/pic.png");
        write_bytes(&source, b"pixels");
        let root = fs::canonicalize(&vault).unwrap();
        let receipts = AttachmentReceipts::default();

        let outcome = attach_outcome_from(&source, &root, &receipts).unwrap();

        match outcome {
            AttachmentImportOutcome::AlreadyInVault { file_name } => {
                assert_eq!(file_name, "pic.png")
            }
            other => panic!("expected AlreadyInVault, got {other:?}"),
        }
        assert!(!vault.join(".attachments").exists(), "an in-vault source must never be copied");
        assert!(
            receipts.0.lock().unwrap().is_empty(),
            "no receipt is minted for an in-vault reference — nothing to finalize/roll back"
        );

        fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn inside_vault_non_image_is_rejected() {
        // The image/regular-file gate applies inside the AlreadyInVault branch
        // too, not just on the copy-in path — a non-image can't be attached
        // just because it happens to already live in the vault.
        let vault = temp_vault("inside_non_image");
        let source = vault.join("note.md");
        write_bytes(&source, b"# not an image");
        let root = fs::canonicalize(&vault).unwrap();
        let receipts = AttachmentReceipts::default();

        let result = attach_outcome_from(&source, &root, &receipts);

        match &result {
            Err(e) if e.starts_with("ATTACH_INVALID_IMAGE:") => {}
            other => panic!("expected ATTACH_INVALID_IMAGE: prefix, got {other:?}"),
        }
        assert!(!vault.join(".attachments").exists());

        fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn outside_vault_source_still_imports() {
        // A source entirely outside the vault tree must still take the
        // ordinary copy-in path, byte-for-byte the same as
        // import_attachment_from's own direct behavior.
        let vault = temp_vault("outside_source_vault");
        let outside = temp_vault("outside_source_origin");
        let source = outside.join("pic.png");
        write_bytes(&source, b"pixels");
        let root = fs::canonicalize(&vault).unwrap();
        let receipts = AttachmentReceipts::default();

        let outcome = attach_outcome_from(&source, &root, &receipts).unwrap();

        match outcome {
            AttachmentImportOutcome::Imported { receipt } => {
                assert_eq!(receipt.file_name, "pic.png");
                assert_eq!(fs::read(vault.join(".attachments/pic.png")).unwrap(), b"pixels");
            }
            other => panic!("expected Imported, got {other:?}"),
        }
        // Source is read, never moved — the same guarantee as the direct path.
        assert_eq!(fs::read(&source).unwrap(), b"pixels");

        fs::remove_dir_all(&vault).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[cfg(unix)]
    #[test]
    fn symlink_inside_vault_pointing_outside_is_treated_as_outside() {
        // vault/link.png -> outside/real.png: lexically inside the vault, but
        // its resolved target is outside — canonicalize-then-compare must
        // judge this "outside" and take the copy-in path, not reference it in
        // place (a symlink masquerading as an in-vault file must not bypass
        // the import machinery).
        let vault = temp_vault("symlink_inside_points_outside");
        let outside = temp_vault("symlink_outside_target");
        let real = outside.join("real.png");
        write_bytes(&real, b"real-pixels");
        let source = vault.join("link.png");
        std::os::unix::fs::symlink(&real, &source).unwrap();
        let root = fs::canonicalize(&vault).unwrap();
        let receipts = AttachmentReceipts::default();

        let outcome = attach_outcome_from(&source, &root, &receipts).unwrap();

        match outcome {
            AttachmentImportOutcome::Imported { receipt } => {
                assert_eq!(receipt.file_name, "link.png");
                assert_eq!(fs::read(vault.join(".attachments/link.png")).unwrap(), b"real-pixels");
            }
            other => {
                panic!("expected Imported (symlink resolves outside the vault), got {other:?}")
            }
        }

        fs::remove_dir_all(&vault).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn rollback_removes_only_unchanged_receipt_target() {
        let vault = temp_vault("rollback_ok");
        let attachments = vault.join(".attachments");
        fs::create_dir_all(&attachments).unwrap();
        let untouched = attachments.join("keep.png");
        write_bytes(&untouched, b"KEEP");

        let source = vault.join("pic.png");
        write_bytes(&source, b"pixels");
        let receipts = AttachmentReceipts::default();
        let receipt = import_attachment_from(&source, &vault, &receipts).unwrap();
        let dest = attachments.join(&receipt.file_name);
        assert!(dest.exists());

        rollback_import(&receipts, receipt.token).unwrap();

        assert!(!dest.exists());
        assert_eq!(fs::read(&untouched).unwrap(), b"KEEP");

        fs::remove_dir_all(&vault).ok();
    }

    #[cfg(unix)]
    #[test]
    fn rollback_refuses_after_identity_change() {
        let vault = temp_vault("rollback_changed");
        let source = vault.join("pic.png");
        write_bytes(&source, b"pixels");
        let receipts = AttachmentReceipts::default();
        let receipt = import_attachment_from(&source, &vault, &receipts).unwrap();
        let dest = vault.join(".attachments").join(&receipt.file_name);

        // Swap the destination out from under the receipt: same path,
        // different inode.
        fs::remove_file(&dest).unwrap();
        write_bytes(&dest, b"REPLACED-CONTENT");

        let result = rollback_import(&receipts, receipt.token);

        match &result {
            Err(e) if e.starts_with("ROLLBACK_CHANGED:") => {}
            other => panic!("expected ROLLBACK_CHANGED: prefix, got {other:?}"),
        }
        assert!(dest.exists());
        assert_eq!(fs::read(&dest).unwrap(), b"REPLACED-CONTENT");

        fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn rollback_unknown_token_refuses() {
        let receipts = AttachmentReceipts::default();
        let result = rollback_import(&receipts, 999_999);
        match &result {
            Err(e) if e.starts_with("ROLLBACK_UNKNOWN:") => {}
            other => panic!("expected ROLLBACK_UNKNOWN: prefix, got {other:?}"),
        }
    }

    #[test]
    fn finalize_then_rollback_refuses() {
        let vault = temp_vault("finalize_then_rollback");
        let source = vault.join("pic.png");
        write_bytes(&source, b"pixels");
        let receipts = AttachmentReceipts::default();
        let receipt = import_attachment_from(&source, &vault, &receipts).unwrap();

        finalize_import(&receipts, receipt.token);
        let result = rollback_import(&receipts, receipt.token);

        match &result {
            Err(e) if e.starts_with("ROLLBACK_UNKNOWN:") => {}
            other => panic!("expected ROLLBACK_UNKNOWN: prefix, got {other:?}"),
        }
        let dest = vault.join(".attachments").join(&receipt.file_name);
        assert!(dest.exists(), "finalize must have made the file permanent");

        fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn dropped_state_retains_file_conservatively() {
        let vault = temp_vault("dropped_state");
        let source = vault.join("pic.png");
        write_bytes(&source, b"pixels");
        let dest;
        {
            let receipts = AttachmentReceipts::default();
            let receipt = import_attachment_from(&source, &vault, &receipts).unwrap();
            dest = vault.join(".attachments").join(&receipt.file_name);
            // `receipts` (and its token->record map) drops here, simulating
            // a process crash between import and finalize. Nothing in this
            // scope ever calls rollback.
        }
        assert!(dest.exists(), "file must survive state loss between import and finalize");

        fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn qa_pick_override_maps_env_shapes() {
        // Unset env (VarError) -> no override, real dialog runs.
        assert_eq!(qa_pick_override(Err(std::env::VarError::NotPresent)), None);
        // Set-and-empty -> cancel simulation.
        assert_eq!(qa_pick_override(Ok(String::new())), Some(PickOverride::Cancel));
        // Set-and-non-empty -> the source path to use instead of the dialog.
        assert_eq!(
            qa_pick_override(Ok("/p/x.png".to_string())),
            Some(PickOverride::Source(PathBuf::from("/p/x.png")))
        );
    }

    #[test]
    fn dialog_filter_list_matches_is_image_ext_gate() {
        // The picker's advertised filter and the actual acceptance gate
        // must agree — otherwise a user could pick a file the dialog
        // implied was valid and have the import reject it as
        // ATTACH_INVALID_IMAGE.
        for ext in IMAGE_DIALOG_FILTERS {
            assert!(is_image_ext(ext), "{ext} is offered but rejected by is_image_ext");
        }
        assert!(!is_image_ext("md"));
    }
}
