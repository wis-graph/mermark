use std::path::PathBuf;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Read a file's UTF-8 contents. Used by the frontend at startup.
#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))
}

/// Open another file in a brand-new window (used by wikilink clicks).
#[tauri::command]
pub fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let label = format!("w{}", app.webview_windows().len() + 1);
    let url = WebviewUrl::App(format!("index.html?file={}", urlencoding::encode(&path)).into());
    WebviewWindowBuilder::new(&app, label, url)
        .title("mermark")
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}
