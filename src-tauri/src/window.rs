//! Document-window spawning for explicit new-window opens (`open_path`); the
//! window chrome/size constants it uses still live in `lib.rs`.
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::{WebviewUrl, WebviewWindowBuilder};

use crate::fs::paths::normalize_path;

static WINDOW_SEQ: AtomicU32 = AtomicU32::new(1);

/// The (label, URL) pair for one explicit new-window open: a fresh `w{seq}`
/// webview loading `index.html?file=<urlencoded path>`. Under the approved
/// window-routing matrix this is the ONLY meaning `open_path` carries.
fn document_window_spec(seq: u32, path: &Path) -> (String, String) {
    let label = format!("w{seq}");
    let url = format!("index.html?file={}", urlencoding::encode(&path.to_string_lossy()));
    (label, url)
}

/// Open another file in a brand-new window (used by wikilink clicks).
pub(crate) fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let normalized = normalize_path(Path::new(&path));
    if !normalized.is_file() {
        return Err(format!("not a file: {}", normalized.display()));
    }
    let (label, url) = document_window_spec(WINDOW_SEQ.fetch_add(1, Ordering::Relaxed), &normalized);
    crate::with_document_chrome(
        WebviewWindowBuilder::new(&app, label, WebviewUrl::App(url.into()))
            .title("mermark")
            .inner_size(crate::DEFAULT_WINDOW.0, crate::DEFAULT_WINDOW.1)
            .min_inner_size(crate::MIN_WINDOW.0, crate::MIN_WINDOW.1),
    )
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod open_path_window_spec_tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn open_path_spawns_a_fresh_w_labelled_window_loading_the_encoded_file_query() {
        let (label, url) = document_window_spec(7, Path::new("/tmp/a b.md"));
        assert_eq!(label, "w7");
        assert_eq!(url, "index.html?file=%2Ftmp%2Fa%20b.md");
    }
}

#[cfg(test)]
mod tests {
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
}
