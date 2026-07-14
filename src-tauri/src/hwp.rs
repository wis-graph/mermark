//! HWP/HWPX viewer backend: three read-only commands (`hwp_open`,
//! `hwp_render_page`, `hwp_close`) built on the pinned `rhwp` crate.
//!
//! Threat model: we parse and render an untrusted binary in our own process
//! (no sandbox — see `_workspace/01_hwp_viewer.md` §1/§6 for the audit that
//! accepted this trade). Every path that touches parser output is therefore
//! wrapped so a malformed file degrades to an `Err`, never a process crash:
//! `catch_unwind` around parse/render, a timeout around both, and a file-size
//! cap before we ever read the bytes into memory.
use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use tauri::State;

use crate::commands::expand_home;

/// Upper bound on an HWP/HWPX file we'll attempt to parse. The crate's own
/// internal caps (256-512MB, aimed at "the library doesn't panic") are about
/// zip-bomb safety, not "this desktop app stays responsive" — this is ours.
const HWP_MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;

/// Wall-clock budget for parsing a whole document. A blown budget rejects the
/// open with `Err`; the `spawn_blocking` thread itself may keep running past
/// this (see module docs on the accepted thread-leak risk), which is why
/// `hwp_open` on timeout does not retain any session — a fresh `hwp_open`
/// can't stack a second leaked parse on top of it.
const PARSE_TIMEOUT: Duration = Duration::from_secs(30);

/// Wall-clock budget for rendering a single page. Deliberately much shorter
/// than `PARSE_TIMEOUT`: a single page should be visually instant once the
/// document is already parsed, so a page that blows this budget is treated
/// the same as a parse timeout — the session is dropped rather than restored,
/// which blocks further render requests until the user reopens the file.
const RENDER_TIMEOUT: Duration = Duration::from_secs(10);

/// One open HWP/HWPX document plus the path it came from. `doc` is the only
/// field that matters for rendering; `path` is kept for diagnostics/future
/// use (e.g. reporting which file a stray error belongs to).
struct HwpSession {
    #[allow(dead_code)]
    path: String,
    doc: rhwp::wasm_api::HwpDocument,
}

/// Single-slot session store, mirroring `watcher::WatchState`'s one-live-thing
/// pattern: the viewer shell never stacks more than one open HWP document, so
/// `hwp_open` always *replaces* whatever was here (dropping the old session).
#[derive(Default)]
pub struct HwpState(Mutex<Option<HwpSession>>);

/// `hwp_open`'s success shape: just the page count the frontend needs to
/// pre-create placeholder divs. Everything else is fetched lazily per page.
#[derive(serde::Serialize)]
pub struct HwpOpenInfo {
    pub pages: u32,
}

/// True when `path`'s extension is `hwp` or `hwpx` (case-insensitive, no
/// dot). Named so the extension rule is one fact instead of an inline `if` at
/// each of the two places it matters: the frontend's viewer-registry dispatch
/// (already validated there) and this backend re-check — we don't trust the
/// frontend's dispatch alone, since IPC commands are reachable directly.
fn is_hwp_ext(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("hwp") | Some("hwpx")
    )
}

/// Reject a file before we ever read it into memory, rather than after. The
/// crate's own internal size caps exist to keep *parsing* memory-safe; this
/// one exists to keep the *desktop app* responsive, so it runs first and at a
/// much tighter bound.
fn assert_hwp_file_within_cap(path: &str) -> Result<(), String> {
    let size = std::fs::metadata(path)
        .map_err(|e| format!("stat {path}: {e}"))?
        .len();
    if size > HWP_MAX_FILE_BYTES {
        Err(format!(
            "파일이 너무 큽니다: {size} bytes (상한 {HWP_MAX_FILE_BYTES} bytes)"
        ))
    } else {
        Ok(())
    }
}

/// The Hangul-capable font path rhwp should fall back to when a document
/// references a font the OS doesn't have installed. rhwp's own default is a
/// Linux path (`/usr/share/fonts/truetype/nanum/NanumGothic.ttf`) baked into
/// `document_core::mod` — fine on Linux, silently wrong everywhere else, so
/// every other desktop target gets an explicit override here.
fn platform_fallback_font() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "/System/Library/Fonts/AppleSDGothicNeo.ttc"
    }
    #[cfg(target_os = "windows")]
    {
        "C:\\Windows\\Fonts\\malgun.ttf"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "/usr/share/fonts/truetype/nanum/NanumGothic.ttf"
    }
}

/// Parse raw file bytes into a document, with a panic converted to `Err`
/// instead of unwinding out of the `spawn_blocking` task. This is the single
/// point where a malformed HWP/HWPX file's worst *catchable* outcome (a
/// parser panic) becomes a normal command failure instead of a dead task.
/// Stack-overflow aborts are the one thing this can't catch — see module docs
/// / `_workspace/01_hwp_viewer.md` §6 for why that residual risk is accepted.
fn parse_hwp_guarded(bytes: Vec<u8>) -> Result<rhwp::wasm_api::HwpDocument, String> {
    std::panic::catch_unwind(AssertUnwindSafe(|| {
        rhwp::wasm_api::HwpDocument::from_bytes(&bytes)
    }))
    .map_err(|_| "HWP 파서가 패닉했습니다 (손상된 파일로 추정)".to_string())
    .and_then(|r| r.map_err(|e| format!("HWP 파일 파싱 오류: {e}")))
}

/// Render one page to an SVG string, panic-guarded the same way as
/// `parse_hwp_guarded`. Borrows the document rather than consuming it so the
/// caller keeps ownership regardless of success/failure/panic — the session
/// is only ever dropped by a *timeout*, never by a guarded render error.
fn render_page_guarded(doc: &rhwp::wasm_api::HwpDocument, page: u32) -> Result<String, String> {
    std::panic::catch_unwind(AssertUnwindSafe(|| doc.render_page_svg_native(page)))
        .map_err(|_| "HWP 렌더러가 패닉했습니다 (손상된 페이지 데이터로 추정)".to_string())
        .and_then(|r| r.map_err(|e| format!("페이지 렌더링 오류: {e}")))
}

fn take_session(state: &State<'_, HwpState>) -> Option<HwpSession> {
    state.0.lock().unwrap().take()
}

fn put_session(state: &State<'_, HwpState>, session: HwpSession) {
    *state.0.lock().unwrap() = Some(session);
}

/// Open an HWP/HWPX file: validate it, parse it once (guarded + timed out),
/// and store the parsed document as the single live session — replacing
/// whatever session was open before. Returns just the page count; page
/// content is fetched lazily via `hwp_render_page`.
#[tauri::command]
pub async fn hwp_open(path: String, state: State<'_, HwpState>) -> Result<HwpOpenInfo, String> {
    let normalized = expand_home(&path);
    if !is_hwp_ext(&normalized) {
        return Err(format!("지원하지 않는 확장자입니다: {}", normalized.display()));
    }
    let normalized_str = normalized.to_string_lossy().into_owned();
    if !normalized.is_file() {
        return Err(format!("파일을 찾을 수 없습니다: {normalized_str}"));
    }
    assert_hwp_file_within_cap(&normalized_str)?;
    let bytes = std::fs::read(&normalized_str).map_err(|e| format!("read {normalized_str}: {e}"))?;

    let parsed = tokio::time::timeout(
        PARSE_TIMEOUT,
        tauri::async_runtime::spawn_blocking(move || parse_hwp_guarded(bytes)),
    )
    .await;

    let mut doc = match parsed {
        Ok(Ok(Ok(doc))) => doc,
        Ok(Ok(Err(e))) => return Err(e),
        Ok(Err(join_err)) => return Err(format!("파싱 작업 실패: {join_err}")),
        Err(_) => return Err(format!(
            "파일 파싱 시간 초과 (>{}s)",
            PARSE_TIMEOUT.as_secs()
        )),
    };
    doc.set_fallback_font(platform_fallback_font());
    let pages = doc.page_count();

    put_session(
        &state,
        HwpSession { path: normalized_str, doc },
    );
    Ok(HwpOpenInfo { pages })
}

/// Render a single page of the currently open session to an SVG string.
/// Errors (no session, out-of-range page) are caught by named guards before
/// the parser/renderer is ever touched; a guarded render error restores the
/// session (the document itself is still fine), while a timeout drops it
/// (further renders fail until the viewer is reopened — see `RENDER_TIMEOUT`).
#[tauri::command]
pub async fn hwp_render_page(page: u32, state: State<'_, HwpState>) -> Result<String, String> {
    let session = take_session(&state)
        .ok_or_else(|| "HWP 세션이 없습니다: 먼저 파일을 여세요".to_string())?;

    let pages = session.doc.page_count();
    if page >= pages {
        put_session(&state, session);
        return Err(format!("페이지 범위 초과: {page} (전체 {pages}페이지)"));
    }

    let rendered = tokio::time::timeout(
        RENDER_TIMEOUT,
        tauri::async_runtime::spawn_blocking(move || {
            let result = render_page_guarded(&session.doc, page);
            (session, result)
        }),
    )
    .await;

    match rendered {
        Ok(Ok((session, Ok(svg)))) => {
            put_session(&state, session);
            Ok(svg)
        }
        Ok(Ok((session, Err(e)))) => {
            put_session(&state, session);
            Err(e)
        }
        Ok(Err(join_err)) => Err(format!("렌더링 작업 실패: {join_err}")),
        Err(_) => Err(format!(
            "페이지 렌더링 시간 초과 (>{}s) — 세션을 닫습니다",
            RENDER_TIMEOUT.as_secs()
        )),
    }
}

/// Drop the open session, if any. Idempotent — closing twice (or closing
/// with nothing open) is not an error, matching the shell's `close()`
/// teardown contract.
#[tauri::command]
pub fn hwp_close(state: State<'_, HwpState>) {
    *state.0.lock().unwrap() = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_send<T: Send>() {}

    /// The riskiest structural fact this module depends on: `HwpDocument`
    /// (and therefore `HwpSession`, which just wraps it) must be `Send` for
    /// `Mutex<Option<HwpSession>>` to be usable from the async command
    /// handlers, which move sessions across `spawn_blocking` task boundaries.
    /// `HwpDocument`'s internal `RefCell` caches make it `!Sync` but not
    /// `!Send` (rhwp's own `document_core` test asserts the same for
    /// `DocumentCore`) — this pins that fact for our module too, so a future
    /// rhwp bump that broke it would fail here at compile time, not at
    /// runtime deep in a spawn_blocking closure.
    #[test]
    fn hwp_document_and_session_are_send() {
        assert_send::<rhwp::wasm_api::HwpDocument>();
        assert_send::<HwpSession>();
    }

    // --- is_hwp_ext ---

    #[test]
    fn recognizes_hwp_and_hwpx_case_insensitively() {
        assert!(is_hwp_ext(Path::new("a.hwp")));
        assert!(is_hwp_ext(Path::new("a.HWP")));
        assert!(is_hwp_ext(Path::new("a.hwpx")));
        assert!(is_hwp_ext(Path::new("a.HwPx")));
    }

    #[test]
    fn rejects_other_extensions() {
        assert!(!is_hwp_ext(Path::new("a.md")));
        assert!(!is_hwp_ext(Path::new("a.doc")));
        assert!(!is_hwp_ext(Path::new("a")));
    }

    // --- assert_hwp_file_within_cap ---

    fn temp_path(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!("mermark_hwp_test_{}_{tag}", std::process::id()))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn small_file_passes_cap() {
        let p = temp_path("small_pass");
        std::fs::write(&p, b"tiny").unwrap();
        assert!(assert_hwp_file_within_cap(&p).is_ok());
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn oversized_file_is_rejected_before_read() {
        let p = temp_path("oversized");
        // Sparse file: seek past the cap and write one byte, so the test
        // doesn't actually allocate/write 100MB+ to disk.
        let f = std::fs::File::create(&p).unwrap();
        f.set_len(HWP_MAX_FILE_BYTES + 1).unwrap();
        let err = assert_hwp_file_within_cap(&p).unwrap_err();
        assert!(err.contains("파일이 너무 큽니다"), "got: {err}");
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn missing_file_is_a_stat_error_not_a_panic() {
        let p = temp_path("missing_never_created");
        let err = assert_hwp_file_within_cap(&p).unwrap_err();
        assert!(err.contains("stat"), "got: {err}");
    }

    // --- parse_hwp_guarded (negative — no real HWP fixture needed) ---

    #[test]
    fn garbage_bytes_are_a_parse_error_not_a_panic() {
        let result = parse_hwp_guarded(b"this is not an hwp file".to_vec());
        assert!(result.is_err(), "garbage bytes must fail as Err, not panic");
    }

    #[test]
    fn empty_bytes_are_a_parse_error_not_a_panic() {
        let result = parse_hwp_guarded(Vec::new());
        assert!(result.is_err());
    }

    // --- panic containment itself (the guard mechanism, independent of rhwp) ---

    #[test]
    fn catch_unwind_pattern_converts_panic_to_err() {
        // Exercises the exact catch_unwind + AssertUnwindSafe shape used by
        // parse_hwp_guarded/render_page_guarded, with a closure that always
        // panics, to prove the *mechanism* converts a panic to Err — not
        // relying on rhwp happening to panic on some input.
        let result: Result<(), String> =
            std::panic::catch_unwind(AssertUnwindSafe(|| -> () { panic!("boom") }))
                .map_err(|_| "guarded".to_string());
        assert_eq!(result, Err("guarded".to_string()));
    }
}
