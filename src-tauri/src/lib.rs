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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            commands::open_path,
            commands::path_exists
        ])
        .setup(|app| {
            let args: Vec<String> = std::env::args().skip(1).collect();
            let cwd = std::env::current_dir().unwrap_or_default();
            match cli::resolve_target(&args, &cwd) {
                Ok(path) => {
                    let url = tauri::WebviewUrl::App(
                        format!(
                            "index.html?file={}",
                            urlencoding::encode(&path.to_string_lossy())
                        )
                        .into(),
                    );
                    tauri::WebviewWindowBuilder::new(app, "main", url)
                        .title("mermark")
                        .inner_size(DEFAULT_WINDOW.0, DEFAULT_WINDOW.1)
                        .min_inner_size(MIN_WINDOW.0, MIN_WINDOW.1)
                        .build()?;
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
