//! Filesystem domain library behind the `#[tauri::command]` adapters in
//! `commands.rs` (and the remote host's HTTP handlers in `remote_host.rs`).
//! Signatures are still IPC-shaped (`String` args) on purpose — this module
//! was split out of `commands.rs` as a pure move (2026-09-25); the `&Path` /
//! `ListingPolicy` reshaping is a later step. Dependency direction:
//! paths ← file_io; paths ← listing ← link_targets ← image_resolve;
//! listing ← drives. Nothing here imports `crate::commands`.
pub(crate) mod drives;
pub(crate) mod file_io;
pub(crate) mod image_resolve;
pub(crate) mod link_targets;
pub(crate) mod listing;
pub(crate) mod paths;
#[cfg(test)]
pub(crate) mod test_support;
