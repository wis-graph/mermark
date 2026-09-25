//! Test-only fixture helpers shared by the `fs/` test modules and
//! `commands.rs`'s own tests. Draws names from `file_io::TMP_SEQ` exactly as
//! the pre-split `commands::tests` helpers did.
use std::path::PathBuf;
use std::sync::atomic::Ordering;

use super::file_io::TMP_SEQ;

pub(crate) fn temp_path(tag: &str) -> String {
    let n = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir()
        .join(format!("mermark_test_{}_{}_{tag}.md", std::process::id(), n))
        .to_string_lossy()
        .into_owned()
}

/// A fresh, isolated directory for picker tests, PID- and tag-keyed so
/// concurrent test binaries don't collide.
pub(crate) fn temp_dir(tag: &str) -> PathBuf {
    let n = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir()
        .join(format!("mermark_links_{}_{}_{tag}", std::process::id(), n));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
