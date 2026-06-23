pub mod cli;
mod commands;

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
                        cli::CliError::NotFound(p) => {
                            eprintln!("mermark: file not found: {}", p.display());
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
