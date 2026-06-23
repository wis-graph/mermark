use std::io::{IsTerminal, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub mod cli;
mod commands;

/// Process-unique counter for scratch-file names. Kept separate from
/// `commands::TMP_SEQ` (which names autosave temp files) so the two concerns
/// don't share state across module boundaries; the naming *pattern* is copied,
/// the counter is not. Starts at 1 — `mermark -` reads stdin at most once per
/// process, so in practice this stays 1, but the counter keeps scratch names
/// unique under any repeated call without relying on a clock.
static STDIN_SEQ: AtomicU64 = AtomicU64::new(1);

/// True when this process's stdin is a real pipe/redirect rather than an
/// interactive terminal. `mermark -` on a TTY would block forever in `read`
/// waiting for Ctrl-D, so the `Target::Stdin` path checks this *before* reading.
/// Kept thin (just the terminal query, no logic) because it touches the real
/// stdin handle and so isn't unit-testable — the testable work lives in
/// `write_stdin_to_scratch`.
fn stdin_is_piped() -> bool {
    !std::io::stdin().is_terminal()
}

/// Read all of `reader` into a fresh scratch `.md` file under `dir` and return
/// its path. The name is `mermark-stdin-{pid}-{seq}.md`: pid avoids collisions
/// between concurrent mermark processes, `seq` (from `STDIN_SEQ`) avoids them
/// within one process — both without a clock. The `.md` extension matters so the
/// live preview treats the scratch as markdown and autosave writes a real md
/// file. `reader` is injected (`impl Read`) so tests drive it with a fake reader
/// instead of real stdin; an empty reader yields an empty (but valid) scratch.
/// This is a command (it creates a file) that returns the created file's handle
/// so the launch flow can open it.
fn write_stdin_to_scratch(mut reader: impl Read, dir: &Path) -> std::io::Result<PathBuf> {
    let mut buf = String::new();
    reader.read_to_string(&mut buf)?;
    let seq = STDIN_SEQ.fetch_add(1, Ordering::Relaxed);
    let path = dir.join(format!("mermark-stdin-{}-{seq}.md", std::process::id()));
    std::fs::write(&path, buf)?;
    Ok(path)
}

/// Default inner size (width, height) for a document window. mermark opens the
/// same kind of window down two paths — the startup `main` window and the
/// wikilink-spawned window in `open_path` — so the size lives here once and both
/// reference it, keeping the two windows consistent and the numbers un-scattered.
pub const DEFAULT_WINDOW: (f64, f64) = (1200.0, 860.0);

/// Lower bound on a document window's inner size. Below this the reading column,
/// status bar, and gutter start to break, so the user can shrink the window but
/// not into a degenerate state.
pub const MIN_WINDOW: (f64, f64) = (640.0, 480.0);

/// Logical `(width, height, x)` for a window that fills the right half of a
/// monitor: half the monitor's logical width, full logical height, offset right
/// by that same half-width. The builder takes logical pixels, so the caller
/// converts the monitor's physical size by its scale factor before handing the
/// numbers here. Named so the "right half" rule reads as one fact, not three
/// inline divisions in the setup closure.
fn right_half_geometry(logical_width: f64, logical_height: f64) -> (f64, f64, f64) {
    let half = logical_width / 2.0;
    (half, logical_height, half)
}

/// Ensure a `Target::File` path is openable before launch: when it doesn't exist
/// yet, create it (vim's `:e newfile.md` convention — a missing path is intent to
/// *create*, not an error); when it already exists, no-op. An existing path is
/// never written over, so user content is safe even if a directory somehow
/// reaches here (rejecting a directory target is `resolve_target`'s job upstream,
/// via `CliError::IsDirectory`). Reuses the IPC command's pure helper directly
/// (no `invoke` round-trip) so the on-disk shape — recursive parent dirs and a
/// `# {stem}\n` header — stays identical to wikilink-created files. Named so the
/// "missing target file is born on launch" rule lives behind one verb instead of
/// an inline `if !exists` in the setup closure.
fn ensure_file_target(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    commands::create_markdown_file(path.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            commands::open_path,
            commands::path_exists,
            commands::create_markdown_file
        ])
        .setup(|app| {
            let args: Vec<String> = std::env::args().skip(1).collect();
            let cwd = std::env::current_dir().unwrap_or_default();
            match cli::parse_args(&args, &cwd) {
                Ok(cli::LaunchArgs { target, right }) => {
                    // Resolve the parse-time intent into a concrete file path to
                    // open. `File` already carries one; `Stdin` performs the
                    // effect (read piped stdin into a scratch .md) the pure
                    // parser deferred. Both converge here so the url/geometry/
                    // builder code below runs once for either source.
                    let target = match target {
                        cli::Target::File(path) => {
                            // Create the file if it doesn't exist yet (vim-style)
                            // before opening; an existing file is opened as-is.
                            // A creation failure (e.g. unwritable parent dir) is a
                            // launch error: report it and exit gracefully with the
                            // same code/style as the other CLI failures below
                            // rather than panicking out of `setup`.
                            if let Err(e) = ensure_file_target(&path) {
                                eprintln!("mermark: cannot open {}: {e}", path.display());
                                std::process::exit(2);
                            }
                            path
                        }
                        cli::Target::Stdin => {
                            if !stdin_is_piped() {
                                eprintln!(
                                    "mermark: '-' reads piped stdin; nothing was piped.\nusage: cat file.md | mermark -"
                                );
                                std::process::exit(2);
                            }
                            write_stdin_to_scratch(
                                std::io::stdin().lock(),
                                &std::env::temp_dir(),
                            )
                            .map_err(|e| format!("mermark: failed to buffer stdin: {e}"))?
                        }
                    };
                    let url = tauri::WebviewUrl::App(
                        format!(
                            "index.html?file={}",
                            urlencoding::encode(&target.to_string_lossy())
                        )
                        .into(),
                    );
                    // `--right` docks the window to the right half of the
                    // primary monitor; without a readable monitor (None/Err) we
                    // fall back to the centered default rather than abort launch.
                    let right_half = if right {
                        app.primary_monitor()
                            .ok()
                            .flatten()
                            .map(|monitor| {
                                let scale = monitor.scale_factor();
                                let size = monitor.size();
                                let logical_width = size.width as f64 / scale;
                                let logical_height = size.height as f64 / scale;
                                right_half_geometry(logical_width, logical_height)
                            })
                    } else {
                        None
                    };

                    let mut builder = tauri::WebviewWindowBuilder::new(app, "main", url)
                        .title("mermark")
                        .min_inner_size(MIN_WINDOW.0, MIN_WINDOW.1);
                    builder = match right_half {
                        Some((width, height, x)) => {
                            builder.inner_size(width, height).position(x, 0.0)
                        }
                        None => builder.inner_size(DEFAULT_WINDOW.0, DEFAULT_WINDOW.1),
                    };
                    builder.build()?;
                }
                Err(e) => {
                    match &e {
                        cli::CliError::Missing => {
                            eprintln!("mermark: no file given.\nusage: mermark <file.md>");
                        }
                        cli::CliError::IsDirectory(p) => {
                            eprintln!(
                                "mermark: {} is a directory, not a file.\nusage: mermark <file.md>",
                                p.display()
                            );
                        }
                    }
                    std::process::exit(2);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Isolated scratch dir per test, PID- and tag-keyed like the cli.rs
    /// fixtures, so concurrent test binaries don't clobber each other.
    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("mermark_stdin_{}_{tag}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scratch_has_stdin_contents() {
        let dir = scratch_dir("contents");
        let path = write_stdin_to_scratch(&b"# piped\nbody"[..], &dir).unwrap();
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("md"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "# piped\nbody");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_stdin_makes_empty_scratch() {
        // An empty pipe (immediate EOF) is a valid intent: a blank document.
        let dir = scratch_dir("empty");
        let path = write_stdin_to_scratch(&b""[..], &dir).unwrap();
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("md"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scratch_names_are_unique() {
        // Two calls in the same dir must not collide (seq, no clock).
        let dir = scratch_dir("unique");
        let a = write_stdin_to_scratch(&b"a"[..], &dir).unwrap();
        let b = write_stdin_to_scratch(&b"b"[..], &dir).unwrap();
        assert_ne!(a, b);
        assert_eq!(fs::read_to_string(&a).unwrap(), "a");
        assert_eq!(fs::read_to_string(&b).unwrap(), "b");
        fs::remove_dir_all(&dir).ok();
    }

    // --- ensure_file_target (vim-style create-on-launch) ---

    #[test]
    fn ensure_creates_missing_target_with_header() {
        // A missing path is created with the same `# {stem}\n` shape as
        // wikilink-spawned files, including any missing parent directories.
        let dir = scratch_dir("ensure_missing");
        let path = dir.join("sub").join("fresh.md");
        assert!(!path.exists());
        ensure_file_target(&path).unwrap();
        assert!(path.is_file());
        assert_eq!(fs::read_to_string(&path).unwrap(), "# fresh\n");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ensure_leaves_existing_file_untouched() {
        // The data-safety invariant: an existing file is never overwritten —
        // ensure_file_target no-ops and the user's content survives verbatim.
        let dir = scratch_dir("ensure_existing");
        let path = dir.join("keep.md");
        fs::write(&path, "# my notes\nkeep me").unwrap();
        ensure_file_target(&path).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "# my notes\nkeep me");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ensure_noops_on_existing_directory_without_clobber() {
        // ensure_file_target treats an *existing* path (file or dir) as nothing to
        // do, so a directory survives untouched — it never creates a file over it.
        // Rejecting a directory as a target is resolve_target's job (IsDirectory),
        // upstream of here; this test just documents that ensure never clobbers.
        let dir = scratch_dir("ensure_dir");
        let child = dir.join("inside.md");
        fs::write(&child, "x").unwrap();
        ensure_file_target(&dir).unwrap(); // no-op: the dir already exists
        assert!(dir.is_dir());
        assert!(child.is_file(), "the directory's contents must survive");
        fs::remove_dir_all(&dir).ok();
    }
}
