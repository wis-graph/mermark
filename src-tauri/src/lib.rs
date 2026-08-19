use std::io::{IsTerminal, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

mod attachment_import;
pub mod attachments;
mod bundle;
pub mod cli;
mod commands;
mod epubview;
mod htmlview;
mod hwp;
mod qa_trace;
mod single_instance;
mod sqlite;
mod watcher;

use qa_trace::qa_trace;

#[cfg(target_os = "macos")]
fn setup_cli_path() -> std::io::Result<()> {
    let home = std::env::var("HOME").map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "HOME environment variable not found")
    })?;
    setup_cli_path_in(PathBuf::from(home))
}

#[cfg(target_os = "macos")]
fn setup_cli_path_in(home: PathBuf) -> std::io::Result<()> {
    use std::fs::OpenOptions;
    use std::io::Write;

    let zshrc_path = home.join(".zshrc");
    let content = if zshrc_path.exists() {
        std::fs::read_to_string(&zshrc_path)?
    } else {
        String::new()
    };

    if !content.contains("/Applications/mermark.app/Contents/MacOS") {
        let cli_line = "\n# mermark CLI path\nexport PATH=\"$PATH:/Applications/mermark.app/Contents/MacOS\"\n";
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&zshrc_path)?;
        file.write_all(cli_line.as_bytes())?;
    }
    Ok(())
}

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

/// mermark document window's chrome rule, shared by the startup `main` window
/// (below) and the wikilink-spawned window in `commands::open_path` — the same
/// two-path sharing pattern as `DEFAULT_WINDOW`/`MIN_WINDOW` above, so this lives
/// here rather than being duplicated per call site.
///
/// macOS keeps the native decorations but overlays them: the traffic lights stay
/// (so window controls remain native) while the title text is hidden and the
/// frontend's own title-bar strip draws underneath. `decorations` is deliberately
/// **never** touched on macOS — setting it `false` there would disable the
/// Overlay title bar entirely, silently losing the traffic lights (a known
/// Tauri/macOS footgun, not a hypothetical).
///
/// Every other OS instead turns decorations off outright (`decorations(false)`)
/// so the native title bar disappears and the frontend's custom minimize/
/// maximize/close buttons take its place.
///
/// `title_bar_style`/`hidden_title` exist on `WebviewWindowBuilder` **only**
/// under `#[cfg(target_os = "macos")]` (verified against the tauri 2.11.2
/// source) — off-macOS builds don't just skip the *behavior*, the methods are
/// absent from the type, so the platform split has to be a `cfg` branch, not a
/// runtime `if`.
pub(crate) fn with_document_chrome<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: tauri::WebviewWindowBuilder<'a, R, M>,
) -> tauri::WebviewWindowBuilder<'a, R, M> {
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);
    builder
}

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

/// True when the process argv selects the headless `bundle` subcommand: the
/// first positional token is exactly `"bundle"`. Named so `run` reads the
/// subcommand rule as one fact and the window arg parser (`cli::parse_args`)
/// stays unaware of `bundle` — keeping its tests regression-free. A file literally
/// named `bundle` is still openable as `mermark ./bundle.md` (first token isn't
/// `"bundle"`).
fn is_bundle_subcommand(argv: &[String]) -> bool {
    argv.first().is_some_and(|first| first == "bundle")
}

/// QA trace payload for the `launch-class` event (single-window-opening
/// Todo 6): which `LaunchClass` this process resolved to, plus (for
/// `Isolated`) the file path and `--right` flag the native harness asserts
/// against. This function's only call site is a `qa_trace!` argument, whose
/// release arm discards it unevaluated — cfg-gating the function itself too
/// means a release build never even sees it as an item, so there is no
/// "unused function" warning to suppress on top of that.
#[cfg(debug_assertions)]
fn qa_launch_class_fields(class: &cli::LaunchClass) -> serde_json::Value {
    match class {
        cli::LaunchClass::Headless(cli::Headless::Version) => {
            serde_json::json!({ "class": "headless-version" })
        }
        cli::LaunchClass::Headless(cli::Headless::Bundle) => {
            serde_json::json!({ "class": "headless-bundle" })
        }
        cli::LaunchClass::Isolated(cli::LaunchArgs { target, right }) => serde_json::json!({
            "class": "isolated",
            "file": match target {
                cli::Target::File(p) => Some(p.to_string_lossy().into_owned()),
                cli::Target::Stdin => None,
            },
            "right": right,
        }),
        cli::LaunchClass::SingletonRouted(path) => serde_json::json!({
            "class": "singleton-routed",
            "file": path.as_ref().map(|p| p.to_string_lossy().into_owned()),
        }),
    }
}

/// QA trace payload for the `stdin-scratch` event: the scratch file's path
/// plus its byte length, so the native harness can diff the on-disk bytes
/// against what it piped in. Debug-only for the same reason as
/// `qa_launch_class_fields` above.
#[cfg(debug_assertions)]
fn qa_stdin_scratch_fields(path: &Path) -> serde_json::Value {
    let bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    serde_json::json!({ "path": path.to_string_lossy(), "bytes": bytes })
}

/// QA trace payload for the `isolated-geometry` event: the monitor's logical
/// size and the resolved `--right` window geometry, so the native harness
/// can assert `right_half_geometry`'s contract end-to-end (`x == width ==
/// monitor.logical_width/2 && height == monitor.logical_height`) against a
/// real monitor instead of just the pure function in isolation. Debug-only
/// for the same reason as `qa_launch_class_fields` above.
#[cfg(debug_assertions)]
fn qa_isolated_geometry_fields(
    right: bool,
    logical_width: f64,
    logical_height: f64,
    geometry: (f64, f64, f64),
) -> serde_json::Value {
    let (width, height, x) = geometry;
    serde_json::json!({
        "right": right,
        "monitor": { "logical_width": logical_width, "logical_height": logical_height },
        "window": { "x": x, "y": 0.0, "width": width, "height": height },
    })
}

/// Pure core of the `bundle` subcommand: turn the tokens *after* `bundle` plus a
/// cwd into the bundle string, with no process exit so it is unit-testable.
/// The first remaining token is the file path, resolved to an absolute path
/// against `cwd` (cli.rs convention) before handing to the shared bundle core.
/// `mermark bundle` with no path is a usage error.
fn bundle_argv_to_output(rest: &[String], cwd: &Path) -> Result<String, String> {
    let raw = rest
        .first()
        .ok_or_else(|| "usage: mermark bundle <file.md>".to_string())?;
    let p = Path::new(raw);
    let abs = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
    bundle::bundle_to_string(&abs.to_string_lossy())
}

/// Headless dispatch for `mermark bundle <file.md>`: print the bundle to stdout
/// and exit, never touching the webview/invoke_handler/setup path. Runs *before*
/// `tauri::Builder` so the LLM pipe gets an immediate answer with no window.
/// Exit codes match the other CLI failures (`2`).
fn dispatch_bundle(rest: &[String]) -> ! {
    let cwd = std::env::current_dir().unwrap_or_default();
    match bundle_argv_to_output(rest, &cwd) {
        Ok(output) => {
            println!("{output}");
            std::process::exit(0);
        }
        Err(e) => {
            eprintln!("mermark: {e}");
            std::process::exit(2);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let cwd = std::env::current_dir().unwrap_or_default();

    // Pre-builder launch classification (single-window-opening Todo 2): the
    // launch class is decided once, here, before `tauri::Builder` even
    // exists — everything downstream (whether the single-instance plugin
    // gets installed, what `.setup` does) branches on this one answer
    // instead of re-deriving it. This ordering is load-bearing for
    // `Isolated` launches — see `cli::LaunchClass`'s doc comment and
    // `single_instance.rs`'s module doc for why. It also means a rejected
    // target (`IsDirectory` / `NotFound`, below) is reported and this
    // process exits *before* the single-instance plugin installs — so even
    // when another mermark window is already running, the process holding
    // the terminal gets immediate feedback instead of silently forwarding a
    // bad path to the running instance.
    let class = match cli::classify_launch(&argv, &cwd) {
        Ok(class) => class,
        Err(cli::CliError::IsDirectory(p)) => {
            eprintln!(
                "mermark: {} is a directory, not a file.\nusage: mermark <file>",
                p.display()
            );
            std::process::exit(2);
        }
        Err(cli::CliError::NotFound(p)) => {
            // mermark's primary surface is the viewer, not a file-creation
            // tool: a path that doesn't exist is an error, not "create it"
            // (see `cli::resolve_target`'s doc comment for why the old vim
            // `:e newfile.md` convention was dropped). Applies regardless
            // of extension — markdown included.
            eprintln!("mermark: {} does not exist.\nusage: mermark <file>", p.display());
            std::process::exit(2);
        }
        // classify_launch absorbs a missing argument into
        // `SingletonRouted(None)` ("join the singleton, no document")
        // rather than propagating `Missing` as an error.
        Err(cli::CliError::Missing) => unreachable!("classify_launch never returns Missing"),
    };
    qa_trace!("launch-class", qa_launch_class_fields(&class));

    // Headless dispatch: `--version`/`bundle` print to stdout and exit
    // before any window or webview exists — same shape as before, just
    // routed through the classifier instead of two separate ad hoc checks.
    // The version string comes from `CARGO_PKG_VERSION` (Cargo.toml, bumped
    // by release.sh) — the single source of truth, never a hand-written
    // constant. Console output only reaches a terminal on macOS/Linux; a
    // Windows release build is `windows_subsystem = "windows"` (no attached
    // console), the same pre-existing limitation `bundle` already has — the
    // CLI surface itself is a macOS-first concept.
    match &class {
        cli::LaunchClass::Headless(cli::Headless::Version) => {
            println!("mermark {}", env!("CARGO_PKG_VERSION"));
            std::process::exit(0);
        }
        cli::LaunchClass::Headless(cli::Headless::Bundle) => {
            dispatch_bundle(&argv[1..]); // never returns (always exits)
        }
        _ => {}
    }

    let mut builder = tauri::Builder::default();
    if class.joins_singleton() {
        // README:60 — the single-instance plugin must be the *first*
        // plugin registered (plugin setup runs in registration order, and
        // this plugin's own setup is what notifies the primary process and
        // exits a second one). Installed *only* for `SingletonRouted`
        // launches: an `Isolated` process never installs it, so it can
        // never be intercepted — installation itself is the interception
        // gate.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            single_instance::route_secondary_invocation(app, &argv, &cwd);
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Native file picker for vault image attachment import
        // (single-window-opening Todo 5). Only `attachment_import.rs`'s
        // `import_vault_attachment` command calls into this plugin's Rust
        // API (`DialogExt::dialog().file().blocking_pick_file()`) — the
        // webview never invokes a dialog command directly, so this adds
        // zero entries to capabilities/default.json. See that module's doc
        // comment and `_workspace/00_adjudication_wave2.md` for the
        // orchestrator's ruling on why "minimum capability permission" is 0
        // here, and the main-thread-deadlock check this required.
        .plugin(tauri_plugin_dialog::init())
        // The single-file fs watcher's slot + self-write mute baseline. Managed
        // state so `write_file` can record its own mtime and `watch_file` /
        // `unwatch_file` can swap the one live watcher.
        .manage(watcher::WatchState::default())
        .manage(hwp::HwpState::default())
        // The set of directories `arm_html_view_root` has admitted; the
        // `htmlview` protocol handler below reads it via `AppHandle::state`.
        // See `htmlview.rs` module doc for the full design.
        .manage(htmlview::HtmlViewRoots::default())
        // Opaque token -> in-flight import receipt map for vault attachment
        // import/finalize/rollback (single-window-opening Todo 5). See
        // `attachments::AttachmentReceipts`'s doc comment for why dropping
        // this state (process exit) is exactly what makes "retain the file
        // conservatively on abrupt termination" fall out structurally.
        .manage(attachments::AttachmentReceipts::default())
        // Frame-only CSP delivery for the HTML viewer's opt-in scripted mode
        // (`_workspace/01_architect_design_htmljs.md` §2). Serves only files
        // that resolve inside an armed root (`htmlview::handle_html_view_request`);
        // every other request gets a bare 403. The parent app's own CSP is
        // untouched — this scheme gets its *own* CSP via the response header
        // (`htmlview::FRAME_CSP`), which is the whole mechanism that lets a
        // scripted document execute inline JS without weakening the app.
        .register_uri_scheme_protocol("htmlview", |ctx, request| {
            htmlview::handle_html_view_request(ctx.app_handle(), &request)
        })
        // The set of `.epub` files `arm_epub_view` has admitted; the `epub`
        // protocol handler below reads it via `AppHandle::state`. Sibling of
        // `htmlview::HtmlViewRoots` by design, not a shared/enum-unified
        // state — see `epubview.rs` module doc.
        .manage(epubview::EpubViewRoots::default())
        // Zip-entry server for the EPUB viewer (`_workspace/01_architect_design_epub.md`).
        // Never extracts to a temp folder — every request reads one entry
        // straight out of the armed `.epub`'s own zip central directory
        // (`epubview::handle_epub_view_request`). Chapter (`text/html`)
        // responses carry their own per-token CSP (`epubview::epub_frame_csp`)
        // that allows exactly one script URL (our embedded measure.js) and no
        // remote origins — book scripts never execute.
        .register_uri_scheme_protocol("epub", |ctx, request| {
            epubview::handle_epub_view_request(ctx.app_handle(), &request)
        })
        // The single-window-opening routing broker's managed state
        // (recency/readiness/queues) plus the window-lifecycle hook that
        // feeds it — see `single_instance.rs` module doc.
        .manage(single_instance::RoutingState::default())
        .on_window_event(single_instance::track_window_event)
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            commands::open_path,
            commands::path_exists,
            commands::directory_exists,
            commands::canonicalize_path,
            commands::create_markdown_file,
            commands::bundle_doc,
            commands::list_link_targets,
            commands::list_dir,
            commands::list_files_recursive,
            commands::resolve_image,
            commands::watch_file,
            commands::unwatch_file,
            commands::copy_to_clipboard,
            attachment_import::import_vault_attachment,
            attachment_import::finalize_attachment_import,
            attachment_import::rollback_attachment_import,
            htmlview::arm_html_view_root,
            epubview::arm_epub_view,
            epubview::read_epub_entry,
            hwp::hwp_open,
            hwp::hwp_render_page,
            hwp::hwp_close,
            sqlite::sqlite_tables,
            sqlite::sqlite_table_info,
            sqlite::sqlite_rows,
            single_instance::register_window_ready,
            single_instance::acknowledge_open_request
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            if let Err(e) = setup_cli_path() {
                eprintln!("mermark: failed to setup CLI path: {e}");
            }

            // `class` was fully decided pre-builder (above); `Headless`
            // already exited before `tauri::Builder` was even constructed,
            // so only `Isolated`/`SingletonRouted` ever reach here.
            // `.setup` performs the one effect the classifier deferred —
            // reading piped stdin into a scratch `.md` file — and then
            // builds the window; file targets were already created
            // pre-builder, so both file-carrying arms just pass the path
            // through.
            let (target_path, right) = match &class {
                cli::LaunchClass::Isolated(cli::LaunchArgs {
                    target: cli::Target::File(path),
                    right,
                }) => (Some(path.clone()), *right),
                cli::LaunchClass::Isolated(cli::LaunchArgs { target: cli::Target::Stdin, right }) => {
                    if !stdin_is_piped() {
                        eprintln!(
                            "mermark: '-' reads piped stdin; nothing was piped.\nusage: cat file.md | mermark -"
                        );
                        std::process::exit(2);
                    }
                    let path = write_stdin_to_scratch(
                        std::io::stdin().lock(),
                        &std::env::temp_dir(),
                    )
                    .map_err(|e| format!("mermark: failed to buffer stdin: {e}"))?;
                    qa_trace!("stdin-scratch", qa_stdin_scratch_fields(&path));
                    (Some(path), *right)
                }
                cli::LaunchClass::SingletonRouted(path) => (path.clone(), false),
                cli::LaunchClass::Headless(_) => {
                    unreachable!("headless classes exit before .setup runs")
                }
            };
            let url = match target_path {
                Some(path) => tauri::WebviewUrl::App(
                    format!(
                        "index.html?file={}",
                        urlencoding::encode(&path.to_string_lossy())
                    )
                    .into(),
                ),
                None => tauri::WebviewUrl::App("index.html".into()),
            };

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
                        let geometry = right_half_geometry(logical_width, logical_height);
                        qa_trace!(
                            "isolated-geometry",
                            qa_isolated_geometry_fields(right, logical_width, logical_height, geometry)
                        );
                        geometry
                    })
            } else {
                None
            };

            let mut builder = with_document_chrome(
                tauri::WebviewWindowBuilder::new(app, "main", url)
                    .title("mermark")
                    .min_inner_size(MIN_WINDOW.0, MIN_WINDOW.1),
            );
            builder = match right_half {
                Some((width, height, x)) => {
                    builder.inner_size(width, height).position(x, 0.0)
                }
                None => builder.inner_size(DEFAULT_WINDOW.0, DEFAULT_WINDOW.1),
            };
            builder.build()?;
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

    // Note: the old `ensure_file_target` (vim-style create-on-launch) and its
    // tests were removed — mermark's primary surface is the viewer, not a
    // file-creation tool, so `cli::resolve_target` now rejects a missing
    // launch target as `CliError::NotFound` before a window ever opens (see
    // `run()`'s `CliError::NotFound` arm and `resolve_target`'s doc
    // comment). The invariant `ensure_leaves_existing_file_untouched` used
    // to check — "an existing file is never overwritten" — is now trivially
    // true: launch classification never writes to the target at all, since
    // there is no create-on-launch step left to write with. Coverage for
    // "an existing file resolves to itself, unmodified" now lives in
    // `cli.rs`'s `existing_file_resolves` and "a missing file is rejected"
    // in `cli.rs`'s `nonexistent_file_is_not_found` /
    // `classify_missing_file_is_not_found`.

    // --- bundle subcommand dispatch (testable core; dispatch_bundle exits) ---

    #[test]
    fn is_bundle_subcommand_matches_only_the_bundle_token() {
        assert!(is_bundle_subcommand(&["bundle".into(), "f.md".into()]));
        assert!(!is_bundle_subcommand(&["./bundle.md".into()]));
        assert!(!is_bundle_subcommand(&[]));
        assert!(!is_bundle_subcommand(&["f.md".into()]));
    }

    #[test]
    fn bundle_argv_resolves_relative_path_and_wraps() {
        // `mermark bundle a.md` from a cwd → reads a.md under that cwd and
        // returns the envelope (relative path resolved against cwd).
        let dir = scratch_dir("bundle_rel");
        fs::write(dir.join("a.md"), "# hi\nbody").unwrap();
        let out = bundle_argv_to_output(&["a.md".into()], &dir).unwrap();
        assert!(out.starts_with("<documents>"), "got: {out}");
        assert!(out.contains("path=\"a.md\""), "relative root path:\n{out}");
        assert!(out.contains("body"), "got: {out}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bundle_argv_without_path_is_a_usage_error() {
        // `mermark bundle` with no file → usage error (dispatch exits 2).
        let cwd = std::env::temp_dir();
        let err = bundle_argv_to_output(&[], &cwd).unwrap_err();
        assert!(err.contains("usage"), "got: {err}");
    }

    #[test]
    fn bundle_argv_absolute_path_is_used_as_is() {
        let dir = scratch_dir("bundle_abs");
        let f = dir.join("doc.md");
        fs::write(&f, "absolute body").unwrap();
        let out = bundle_argv_to_output(
            &[f.to_string_lossy().into_owned()],
            &std::env::temp_dir(), // cwd irrelevant for an absolute path
        )
        .unwrap();
        assert!(out.contains("absolute body"), "got: {out}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn test_setup_cli_path() {
        // Case 1: .zshrc exists but doesn't have the path
        let dir1 = scratch_dir("setup_cli_exists");
        let zshrc1 = dir1.join(".zshrc");
        fs::write(&zshrc1, "# initial zshrc\n").unwrap();
        setup_cli_path_in(dir1.clone()).unwrap();
        let content1 = fs::read_to_string(&zshrc1).unwrap();
        assert!(content1.contains("/Applications/mermark.app/Contents/MacOS"));
        
        // Case 2: second run doesn't append duplicate
        setup_cli_path_in(dir1.clone()).unwrap();
        let content2 = fs::read_to_string(&zshrc1).unwrap();
        assert_eq!(content1, content2);
        fs::remove_dir_all(&dir1).ok();

        // Case 3: .zshrc does not exist
        let dir2 = scratch_dir("setup_cli_missing");
        let zshrc2 = dir2.join(".zshrc");
        assert!(!zshrc2.exists());
        setup_cli_path_in(dir2.clone()).unwrap();
        assert!(zshrc2.exists());
        let content3 = fs::read_to_string(&zshrc2).unwrap();
        assert!(content3.contains("/Applications/mermark.app/Contents/MacOS"));
        fs::remove_dir_all(&dir2).ok();

        // Case 4: duplication check checks path itself, not comment
        let dir3 = scratch_dir("setup_cli_path_only");
        let zshrc3 = dir3.join(".zshrc");
        fs::write(&zshrc3, "export PATH=\"$PATH:/Applications/mermark.app/Contents/MacOS\"\n").unwrap();
        setup_cli_path_in(dir3.clone()).unwrap();
        let content4 = fs::read_to_string(&zshrc3).unwrap();
        assert_eq!(content4, "export PATH=\"$PATH:/Applications/mermark.app/Contents/MacOS\"\n");
        fs::remove_dir_all(&dir3).ok();
    }
}
