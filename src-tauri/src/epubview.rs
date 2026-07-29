//! Backend half of the EPUB viewer: an `epub://<token>/<zip-entry-path>`
//! custom scheme that serves a `.epub` file's zip entries directly, with no
//! temp-folder extraction step.
//!
//! Design: `_workspace/01_architect_design_epub.md` (esp. §1 "zip 직접
//! 서빙", §2 backend surface, §4 sandbox/CSP judgment), plan:
//! `_workspace/01_architect_plan_epub.md` (Stage B1/B2).
//!
//! **Sibling module, not a variant of `htmlview.rs`** (design §1 "형제 모듈 +
//! 별도 스킴, enum 주입 기각"). The two modules share only
//! `htmlview::mint_view_token` (promoted `pub(crate)` for this) — every other
//! helper here (token/path parsing, CORS, 403, CSP) is its own copy, on
//! purpose: capping the reuse at "duplicate twice, no shared abstraction yet"
//! keeps `htmlview.rs`'s already-shipped (v0.9.15) cargo-test surface
//! completely unchanged, and keeps the two CSPs' *very* different security
//! postures (htmlview's exists to let scripts run; this one exists to stop
//! them) from ever sharing a branch.
//!
//! **Containment is structural, not checked.** `htmlview.rs`'s
//! `is_within_armed_root` re-validates a joined filesystem path because a
//! directory root is served with `fs::join` + `fs::read`. This module never
//! joins a path onto a filesystem root at all — every request resolves
//! through `ZipArchive::by_name(<requested entry string>)`, an *exact-match*
//! lookup against the zip's own central directory. There is no join, so
//! there is nothing for `..`, a symlink, or a percent-decoded absolute path
//! to escape *through* — a request for an entry name the zip doesn't
//! contain simply isn't found, the same as any other typo. (A malicious zip
//! *can* contain an entry literally named e.g. `../evil` — but since we only
//! ever read that entry's bytes, never extract it to a filesystem path,
//! zip-slip does not apply either.)
//!
//! Security still rests on the same three-gate shape as `htmlview.rs`: (1) a
//! per-open unguessable token (`mint_view_token`) is the only key that
//! resolves to an armed `.epub` path at all; (2) every chapter (`text/html`)
//! response carries `epub_frame_csp`, whose `script-src` names *only* our own
//! `__mermark__/measure.js` — no book script, inline or `<script src>`, can
//! ever execute; (3) `cors_allow_origin` only ever grants a `fetch`/XHR read
//! back to the exact same token's own origin, so one open book's script (were
//! CSP somehow bypassed) still can't read another open book's or the app's
//! resources.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::http::{header, HeaderValue, Method, Request, Response, StatusCode};
use tauri::Manager;

use crate::htmlview::mint_view_token;

/// Mirrors `htmlview::CORS_ALLOWED_METHODS` — the one value both the
/// preflight and the real response advertise, named once so they can't drift
/// apart from each other.
const CORS_ALLOWED_METHODS: &str = "GET";

/// The reader-runtime asset (`_workspace/01_architect_design_epub.md` §3),
/// embedded into the binary so it ships with zero extra files and needs no
/// filesystem lookup at request time. This is the *only* script any chapter
/// document is ever allowed to execute — `epub_frame_csp`'s `script-src`
/// names exactly this asset's URL.
const MEASURE_JS: &str = include_str!("epub_reader/measure.js");

/// The reserved request path the protocol handler intercepts *before* trying
/// a zip lookup at all (design §2 "예약 경로"). A real book is exceedingly
/// unlikely to ship an entry with this exact name; if one somehow does, our
/// asset wins — documented, not silently arbitrated.
const READER_ASSET_PATH: &str = "__mermark__/measure.js";

/// Upper bound on any single zip entry this module will materialize in
/// memory, shared by **both** consumers: the `read_epub_entry` IPC channel
/// (design §2 — it exists only to hand the app's own DOMParser small XML
/// metadata) and `EpubViewRoots::resolve`, the choke point the `epub://`
/// scheme handler goes through for every chapter/image/font it serves.
///
/// **Audit fix (`_workspace/04_audit_report_epub.md` 🟡 #2, 2026-07-28):**
/// originally only the IPC channel enforced this cap — the scheme-serving
/// path called `read_to_end` with no bound at all, so a single zip-bomb
/// chapter entry (a small compressed size that decompresses to gigabytes)
/// could spike memory unbounded the moment the viewer lazily loaded it. Both
/// paths now route through `resolve`, which enforces this same constant via
/// `entry_within_cap` before either one ever sees the bytes — see
/// `read_at_most`'s doc for why the *enforcement* itself is a bounded read,
/// not just a post-hoc length check.
const MAX_EPUB_ENTRY_BYTES: usize = 8 * 1024 * 1024;

/// The four-byte local-file-header signature every zip archive (and
/// therefore every valid `.epub`, which *is* a zip) starts with. Checking
/// just these four bytes is cheap and turns "user picked a non-EPUB file"
/// into an immediate, human-classifiable rejection instead of a confusing
/// failure three steps later inside `ZipArchive::new`.
const ZIP_SIGNATURE: [u8; 4] = [0x50, 0x4b, 0x03, 0x04];

/// Per-open state: which armed `.epub` file (canonical path) a minted token
/// resolves to. Same accumulation policy as `htmlview::HtmlViewRoots` (no
/// disarm command, bounded by documents opened in the session) and the same
/// "arming the same file twice mints two distinct tokens" behavior — see
/// that module's doc for the shared rationale.
#[derive(Default)]
pub struct EpubViewRoots(Mutex<HashMap<String, PathBuf>>);

impl EpubViewRoots {
    /// Mint a token and bind `epub_path` (already canonicalized by the
    /// caller) to it.
    fn arm(&self, epub_path: PathBuf) -> String {
        let token = mint_view_token();
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(token.clone(), epub_path);
        token
    }

    /// The `.epub` path a token was armed with, or `None` for an
    /// unminted/unknown token.
    fn epub_path(&self, token: &str) -> Option<PathBuf> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).get(token).cloned()
    }

    /// Read one zip entry's raw bytes for `token`'s armed `.epub` file, or
    /// `None` when the token is unknown, the entry doesn't exist in that
    /// archive, *or* the entry is over `MAX_EPUB_ENTRY_BYTES` (the
    /// zip-bomb gate — audit fix, `MAX_EPUB_ENTRY_BYTES`'s doc). This is the
    /// **single choke point** both the `epub://` scheme handler and
    /// `read_text_entry` go through, so the cap applies uniformly to every
    /// byte either path can ever see — there is no second copy of this
    /// comparison anywhere else in the module. Opens the archive fresh on
    /// every call — a deliberate v1 simplification (design §2): no cached
    /// `ZipArchive` session state to avoid re-introducing `hwp.rs`'s
    /// one-slot-mutex contention, and a central-directory read is a
    /// millisecond-scale cost in practice.
    fn resolve(&self, token: &str, entry: &str) -> Option<Vec<u8>> {
        let path = self.epub_path(token)?;
        let bytes = read_zip_entry(&path, entry)?;
        entry_within_cap(bytes.len(), MAX_EPUB_ENTRY_BYTES).ok()?;
        Some(bytes)
    }

    /// `read_epub_entry`'s core: resolve `entry` (via `resolve`, which
    /// already enforces the size cap — see its doc) and decode it as UTF-8
    /// text. Kept as an inherent method (not the `#[tauri::command]` itself)
    /// so it's callable directly in tests without a live `tauri::State`.
    fn read_text_entry(&self, token: &str, entry: &str) -> Result<String, String> {
        let bytes = self
            .resolve(token, entry)
            .ok_or_else(|| format!("entry not found or too large: {entry}"))?;
        String::from_utf8(bytes).map_err(|_| format!("entry is not valid utf-8: {entry}"))
    }
}

/// Open `epub_path` as a zip archive and read `entry`'s bytes, bounded to at
/// most `MAX_EPUB_ENTRY_BYTES + 1` bytes (`read_at_most`), or `None` if the
/// file can't be opened, isn't a valid zip, or has no such entry. No
/// filesystem join happens anywhere in this function — `entry` is only ever
/// used as a lookup key into the archive's own central directory (module
/// doc: "containment is structural, not checked").
///
/// The returned `Vec` may itself be over `MAX_EPUB_ENTRY_BYTES` long (up to
/// the `+ 1` bound) — this function's job is only to guarantee memory safety
/// during the read, never to reject; `EpubViewRoots::resolve` is what turns
/// an oversized result into a rejection, via the same named
/// `entry_within_cap` gate every other size decision in this module uses.
fn read_zip_entry(epub_path: &Path, entry: &str) -> Option<Vec<u8>> {
    let file = std::fs::File::open(epub_path).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;
    let mut zip_file = archive.by_name(entry).ok()?;
    // Advisory fast path only, NOT the security boundary: if the zip
    // header's own declared uncompressed size already exceeds the cap, skip
    // decompressing at all. A malicious archive can simply lie about this
    // field (understate it while the compressed stream actually inflates to
    // far more), so this check alone would NOT close the audit's zip-bomb
    // gap — `read_at_most` below is what actually bounds memory regardless
    // of what the header claims.
    if zip_file.size() > MAX_EPUB_ENTRY_BYTES as u64 {
        return None;
    }
    read_at_most(&mut zip_file, MAX_EPUB_ENTRY_BYTES).ok()
}

/// Read at most `cap + 1` bytes from `reader`. This is the actual
/// zip-bomb defense (`_workspace/04_audit_report_epub.md` 🟡 #2): a
/// `Read::take(cap + 1)` guarantees the number of bytes ever materialized in
/// memory cannot exceed the bound, *regardless* of how much more the
/// underlying stream would produce if drained in full — so it protects even
/// against a zip entry whose declared size lies (understates itself to slip
/// past `read_zip_entry`'s advisory pre-check, then decompresses to
/// gigabytes). The `+ 1` is deliberate: it lets the caller distinguish
/// "exactly at the cap" from "more was available" by comparing the returned
/// length against `cap` (via `entry_within_cap`) without needing to know the
/// entry's true total length up front. Proven against a literally infinite
/// reader by `read_at_most_never_exceeds_the_cap_against_an_infinite_reader`
/// below — the strongest test available for "this bound holds no matter
/// what the source claims about itself".
fn read_at_most(reader: &mut impl Read, cap: usize) -> std::io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    reader.take(cap as u64 + 1).read_to_end(&mut buf)?;
    Ok(buf)
}

/// Domain rule extracted to a name (per `mermark-backend`'s guidance): a byte
/// length is admissible only up to `cap`. The single named gate
/// `EpubViewRoots::resolve` calls — every size decision in this module
/// (scheme-serving path and IPC path alike, since both go through `resolve`)
/// routes through this one function rather than each call site running its
/// own inline `>` comparison.
fn entry_within_cap(byte_len: usize, cap: usize) -> Result<(), String> {
    if byte_len > cap {
        return Err(format!("entry too large: {byte_len} bytes (cap {cap} bytes)"));
    }
    Ok(())
}

/// True when `path`'s first four bytes are the zip local-file-header
/// signature. Fails closed (`false`) on any I/O error (missing file,
/// permission denied, file shorter than four bytes) — an unreadable path is
/// never treated as "looks like a zip".
fn looks_like_zip(path: &Path) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut sig = [0u8; 4];
    if file.read_exact(&mut sig).is_err() {
        return false;
    }
    sig == ZIP_SIGNATURE
}

/// `arm_epub_view`'s core: canonicalize `path` and classify it, separately
/// testable from the `#[tauri::command]` wrapper (same command/core split
/// `htmlview.rs` uses). Two distinct failure shapes: a bad/unreadable path
/// surfaces the raw I/O error (no `epubOpenErrorMessage` kind covers "file
/// doesn't exist"); a path that opens fine but isn't a zip returns the
/// classification string `"not-zip"`, which the frontend's
/// `epubOpenErrorMessage("not-zip")` turns into a human sentence (design
/// §2 — the backend returns a *kind*, never the prose itself).
fn armable_epub_path(path: &str) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path).map_err(|e| format!("arm {path}: {e}"))?;
    if !looks_like_zip(&canonical) {
        return Err("not-zip".to_string());
    }
    Ok(canonical)
}

/// Arm `path` (a `.epub` file) as a root the `epub` protocol may serve zip
/// entries from, returning the freshly minted token the frontend folds into
/// every `iframe.src`/`read_epub_entry` call for this open
/// (`epub://<token>/<entry>`).
#[tauri::command]
pub fn arm_epub_view(path: String, roots: tauri::State<'_, EpubViewRoots>) -> Result<String, String> {
    let canonical = armable_epub_path(&path)?;
    Ok(roots.arm(canonical))
}

/// The app's (parent-origin) sole channel to a book's small XML metadata —
/// container.xml/OPF/nav/NCX/encryption.xml. Chapter *bodies* never travel
/// this way (module doc, design §2): they're loaded by the chapter iframe
/// directly from the `epub://` scheme, keeping raw book HTML out of the
/// app's own DOM.
#[tauri::command]
pub fn read_epub_entry(
    token: String,
    entry: String,
    roots: tauri::State<'_, EpubViewRoots>,
) -> Result<String, String> {
    roots.read_text_entry(&token, &entry)
}

/// Content-Type for a zip entry the `epub` protocol serves, keyed on
/// extension. EPUB-specific mappings are handled here (design §2 — `xhtml`/
/// `xht` deliberately serve as `text/html`, not `application/xhtml+xml`, so a
/// slightly-malformed book still parses as tag soup instead of hard-failing,
/// and so `inject_reader_runtime`'s trailing `<script>` append is valid);
/// everything else falls back to `htmlview::mime_for_path`; so the two
/// modules' commodity extension lists (png/jpg/css/js/json/…) don't drift
/// apart from each other.
pub(crate) fn epub_mime_for_path(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "xhtml" | "xht" => "text/html",
        "opf" | "ncx" => "application/xml",
        "otf" => "font/otf",
        "ttf" => "font/ttf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => crate::htmlview::mime_for_path(path),
    }
}

/// True when `entry` is the reserved reader-runtime path
/// (`READER_ASSET_PATH`) the protocol handler must serve from the embedded
/// `MEASURE_JS` asset instead of looking it up in the zip archive.
pub(crate) fn is_reader_asset_path(entry: &str) -> bool {
    entry == READER_ASSET_PATH
}

/// The two URL forms a chapter response's CSP/injected `<script>` tag need to
/// name, derived from the *actual request that arrived* rather than assumed
/// from one platform (`epub_origin_base`'s doc explains the derivation).
/// `script_src` is always an exact URL (CSP's default "no trailing `/`"
/// matching), since only one asset is ever granted; `scoped_src` is whatever
/// source expression admits every one of this token's own resources and
/// nothing from another token — a bare origin on the native form (which
/// already carries no other token's resources, since the token *is* the
/// host), or an explicit path-prefix source (trailing `/`) on the Windows/
/// WebView2 fallback form (module doc: every token there shares the *same*
/// fixed host, so without the path prefix this would silently widen to every
/// open book).
struct EpubOriginBase {
    script_src: String,
    scoped_src: String,
}

/// Derive `EpubOriginBase` from `request`'s own URI, mirroring exactly what
/// `token_and_entry_path` parsed off the same request (module doc, "Windows/
/// Android fallback"): the native macOS/Linux form, where `uri.host()` *is*
/// `token` itself, or the WebView2 fallback form, where the host is the fixed
/// `<scheme>.localhost` and the token instead travels as the first path
/// segment. Reading the shape back off the request (instead of hardcoding a
/// platform) is what keeps the CSP/injection tag honest on whichever
/// platform actually served this response — see `arch:win-origin` fix
/// (`_workspace/02_backend_changes_windows.md`): before this, both were
/// hardcoded to the native `epub://{token}` form unconditionally, which is a
/// scheme that simply doesn't exist on Windows, silently locking out every
/// sibling resource a chapter needs (measure.js, book CSS/images/fonts).
fn epub_origin_base(request: &Request<Vec<u8>>, token: &str) -> EpubOriginBase {
    let uri = request.uri();
    let scheme = uri.scheme_str().unwrap_or("epub");
    match uri.host() {
        Some(host) if host == token => EpubOriginBase {
            script_src: format!("{scheme}://{token}/{READER_ASSET_PATH}"),
            scoped_src: format!("{scheme}://{token}"),
        },
        Some(host) => EpubOriginBase {
            script_src: format!("{scheme}://{host}/{token}/{READER_ASSET_PATH}"),
            scoped_src: format!("{scheme}://{host}/{token}/"),
        },
        // No host at all never happens for a request `token_and_entry_path`
        // already accepted (it requires a non-empty host) — this arm exists
        // only so the function is total; it falls back to the native form.
        None => EpubOriginBase {
            script_src: format!("epub://{token}/{READER_ASSET_PATH}"),
            scoped_src: format!("epub://{token}"),
        },
    }
}

/// The per-token CSP attached to every chapter (`text/html`) response
/// (design §4). `script-src` names *exactly one* URL — this token's own
/// `__mermark__/measure.js` — so no book script, inline or external, can
/// ever run; the `https:`-free directive list also means the book can't
/// beacon to any remote origin (image/font/media all scoped to this token's
/// own resources + `data:` only). Unlike `htmlview::frame_csp` (whose grant
/// is coarse — the whole `htmlview:`/`http://htmlview.localhost` scheme, by
/// design, per that module's doc), this stays scoped to exactly one token's
/// own resources on *both* platform shapes (`EpubOriginBase::scoped_src`'s
/// doc) — this has to be a function of the request, not a fixed constant,
/// because the allowlisted URL(s) must name *this response's own* reachable
/// origin/path so a same-origin `allow-same-origin` frame's script gate
/// matches the frame it was actually served into.
pub(crate) fn epub_frame_csp(origin: &EpubOriginBase) -> String {
    let EpubOriginBase { script_src, scoped_src } = origin;
    format!(
        "default-src 'none'; script-src {script_src}; \
         style-src 'unsafe-inline' {scoped_src}; img-src {scoped_src} data:; \
         font-src {scoped_src} data:; media-src {scoped_src} data:; \
         connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    )
}


/// Append the reader-runtime `<script src>` tag to a chapter's raw HTML
/// bytes. Safe specifically because chapters are served as `text/html` (a
/// tag-soup parser hoists a trailing `<script>` tag into `<body>` and runs it
/// there) — the same reasoning that motivated serving `.xhtml` as `text/html`
/// in `epub_mime_for_path` rather than as strict XML. Takes the
/// already-derived `script_src` URL (`EpubOriginBase::script_src`) rather than
/// re-deriving it, so the tag and the CSP that allows it are always built from
/// the same single derivation, never two independent ones that could drift.
///
/// HISTORY (2026-07-29, do not re-add without measuring first): this function
/// briefly also injected a `VIEWPORT_HEIGHT_OVERRIDE_CSS` `<style>` that killed
/// the `height:100%` / `max-height:100%` authoring idiom, on the theory that it
/// caused the "chapter content clips at its boundary" bug. That diagnosis was
/// WRONG. The real cause was a missing `flex: none` on `.epub-viewer-chapter`
/// (styles.css) letting column-flex shrink every placeholder to its 60vh floor;
/// a WebKit harness against two real books (`_workspace/05_trace_epub_height.md`)
/// showed zero overflow with the flex fix and NO injected CSS, including on a
/// book that uses the idiom. The override was reverted because it fixed nothing
/// and silently overrode author intent (a full-bleed cover stopped filling the
/// view). If this idiom ever does look guilty again, measure before patching.
fn inject_reader_runtime(mut bytes: Vec<u8>, script_src: &str) -> Vec<u8> {
    let script_tag = format!("<script src=\"{script_src}\"></script>");
    bytes.extend_from_slice(script_tag.as_bytes());
    bytes
}

/// A bare 403 with no body — same uniform-refusal rationale as
/// `htmlview::forbidden_response`: undifferentiated across every gate
/// (unknown token, missing entry, non-GET/OPTIONS, cross-origin fetch) so a
/// probing script can't fingerprint *why* a request failed.
fn forbidden_response() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::FORBIDDEN)
        .body(Vec::new())
        .expect("a static 403 with no body always builds")
}

/// Split an incoming `epub://<token>/<zip-entry-path>` request into its
/// token (URL host) and percent-decoded entry path. Windows/Android fallback
/// shape (`http://epub.localhost/<token>/<rest>`) mirrors
/// `htmlview::token_and_rel_path`'s documented limitation — token-as-
/// first-path-segment, no per-open-origin guarantee on that platform.
fn token_and_entry_path(request: &Request<Vec<u8>>) -> Option<(String, String)> {
    let uri = request.uri();
    let host = uri.host()?;
    if host.is_empty() {
        return None;
    }
    let raw_path = uri.path();
    if host == "epub.localhost" || host == "localhost" {
        let trimmed = raw_path.trim_start_matches('/');
        let mut parts = trimmed.splitn(2, '/');
        let token = parts.next()?;
        if token.is_empty() {
            return None;
        }
        let rest = parts.next().unwrap_or("");
        return Some((token.to_string(), decode_entry_path(rest)));
    }
    let rel = raw_path.trim_start_matches('/');
    Some((host.to_string(), decode_entry_path(rel)))
}

/// Percent-decode a URL path segment into the entry-path string
/// `token_and_entry_path` returns. Since entries are resolved purely by
/// string equality against the zip's own names (never joined onto a
/// filesystem path — module doc), there is no separate containment
/// re-check needed here the way `htmlview::decode_path_segment` requires
/// one downstream: a decoded `../x` or `/etc/hosts` simply won't match any
/// entry name a real archive has.
fn decode_entry_path(raw: &str) -> String {
    urlencoding::decode(raw).map(|c| c.into_owned()).unwrap_or_else(|_| raw.to_string())
}

/// The origin string a request to `request`'s own URL would carry if the
/// requesting document's own origin were that URL's `(scheme, host)` — same
/// definition as `htmlview::resource_origin`, own copy per this module's
/// duplication-over-shared-abstraction policy (module doc).
fn resource_origin(request: &Request<Vec<u8>>) -> Option<String> {
    let uri = request.uri();
    let scheme = uri.scheme_str()?;
    let host = uri.host()?;
    Some(format!("{scheme}://{host}"))
}

/// The `Access-Control-Allow-Origin` value to answer, or `None` to grant no
/// CORS access. Same matching rule as `htmlview::cors_allow_origin`: granted
/// only when the request's `Origin` header exactly matches the requested
/// resource's own `(epub, token)` origin — a different token's document, or
/// the app itself, gets no grant.
fn cors_allow_origin(request: &Request<Vec<u8>>) -> Option<HeaderValue> {
    let origin_header = request.headers().get(header::ORIGIN)?;
    let origin_str = origin_header.to_str().ok()?;
    let expected = resource_origin(request)?;
    (origin_str == expected).then(|| origin_header.clone())
}

/// Answer a CORS preflight (`OPTIONS`). Token-blind by construction — it
/// never touches the zip-resolution gate, only the `Origin` vs.
/// `resource_origin` comparison — same shape as
/// `htmlview::build_preflight_response`.
fn build_preflight_response(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let mut builder = Response::builder().status(StatusCode::NO_CONTENT);
    if let Some(origin) = cors_allow_origin(request) {
        builder = builder
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin)
            .header(header::ACCESS_CONTROL_ALLOW_METHODS, CORS_ALLOWED_METHODS);
    }
    builder
        .body(Vec::new())
        .expect("a static 204 preflight with no body always builds")
}

/// Build the 200 response for an entry that has already been resolved
/// (either a real zip entry's bytes, or the embedded reader-runtime asset).
/// `token` is the request's own token (already known to the caller via
/// `token_and_entry_path`); combined with `request` itself, `epub_origin_base`
/// derives the platform-correct URL(s) `epub_frame_csp`/`inject_reader_runtime`
/// need, since the CSP's `script-src` must name *this* response's own
/// actually-reachable origin/path, not an assumed one.
/// Pulled out from the handler, same reasoning as
/// `htmlview::build_ok_response`: testable without a live `AppHandle`.
fn build_ok_response(request: &Request<Vec<u8>>, token: &str, entry_path: &Path, bytes: Vec<u8>) -> Response<Vec<u8>> {
    let mime = epub_mime_for_path(entry_path);
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime);
    if let Some(origin) = cors_allow_origin(request) {
        builder = builder
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin)
            .header(header::ACCESS_CONTROL_ALLOW_METHODS, CORS_ALLOWED_METHODS);
    }
    let body = if mime == "text/html" {
        let origin = epub_origin_base(request, token);
        builder = builder.header("Content-Security-Policy", epub_frame_csp(&origin));
        inject_reader_runtime(bytes, &origin.script_src)
    } else {
        bytes
    };
    builder.body(body).unwrap_or_else(|_| forbidden_response())
}

/// The `epub` protocol handler registered on the Tauri builder in `lib.rs`.
/// `OPTIONS` is a token-blind CORS preflight; every other method must be
/// `GET` (no write surface). The reserved reader-asset path is intercepted
/// *before* any zip lookup (`is_reader_asset_path`); everything else goes
/// through `EpubViewRoots::resolve`, which folds "unknown token" and "no
/// such entry" into the same `None` → 403 (module doc: undifferentiated
/// refusal).
pub(crate) fn handle_epub_view_request(app: &tauri::AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() == Method::OPTIONS {
        return build_preflight_response(request);
    }
    if request.method() != Method::GET {
        return forbidden_response();
    }
    let Some((token, entry)) = token_and_entry_path(request) else {
        return forbidden_response();
    };
    if is_reader_asset_path(&entry) {
        return build_ok_response(request, &token, Path::new(READER_ASSET_PATH), MEASURE_JS.as_bytes().to_vec());
    }
    let roots = app.state::<EpubViewRoots>();
    let Some(bytes) = roots.resolve(&token, &entry) else {
        return forbidden_response();
    };
    build_ok_response(request, &token, Path::new(&entry), bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mermark_test_epubview_{}_{tag}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Build a minimal but realistic EPUB fixture zip: `mimetype`,
    /// `META-INF/container.xml`, `OEBPS/content.opf`, `OEBPS/ch1.xhtml`,
    /// `OEBPS/img/pic.png` (plan Stage B1 step 1's fixture shape).
    fn make_fixture_epub(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();
        zip.start_file("mimetype", opts).unwrap();
        zip.write_all(b"application/epub+zip").unwrap();
        zip.start_file("META-INF/container.xml", opts).unwrap();
        zip.write_all(
            br#"<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#,
        )
        .unwrap();
        zip.start_file("OEBPS/content.opf", opts).unwrap();
        zip.write_all(b"<package></package>").unwrap();
        zip.start_file("OEBPS/ch1.xhtml", opts).unwrap();
        zip.write_all(b"<html><body>Chapter 1</body></html>").unwrap();
        zip.start_file("OEBPS/img/pic.png", opts).unwrap();
        zip.write_all(b"fakepngbytes").unwrap();
        zip.finish().unwrap();
        path
    }

    fn make_non_zip_file(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, b"not a zip at all").unwrap();
        path
    }

    // --- armable_epub_path / looks_like_zip ---

    #[test]
    fn armable_epub_path_accepts_a_real_zip_signature() {
        let dir = scratch_dir("armable_ok");
        let epub = make_fixture_epub(&dir, "book.epub");
        assert!(armable_epub_path(epub.to_str().unwrap()).is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn armable_epub_path_rejects_a_non_zip_file() {
        let dir = scratch_dir("armable_not_zip");
        let bogus = make_non_zip_file(&dir, "book.epub");
        let err = armable_epub_path(bogus.to_str().unwrap()).unwrap_err();
        assert_eq!(err, "not-zip", "backend must return the classification kind, not prose");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn armable_epub_path_surfaces_io_error_for_a_missing_path() {
        let dir = scratch_dir("armable_missing");
        let missing = dir.join("nope.epub");
        assert!(armable_epub_path(missing.to_str().unwrap()).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    // --- EpubViewRoots: arm + resolve ---

    #[test]
    fn arming_mints_a_token_that_resolves_a_real_entry() {
        let dir = scratch_dir("arm_resolve");
        let epub = make_fixture_epub(&dir, "book.epub");
        let roots = EpubViewRoots::default();
        let canonical = armable_epub_path(epub.to_str().unwrap()).unwrap();
        let token = roots.arm(canonical);
        let bytes = roots.resolve(&token, "OEBPS/ch1.xhtml").expect("entry must resolve");
        assert_eq!(bytes, b"<html><body>Chapter 1</body></html>");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unminted_token_never_resolves() {
        let dir = scratch_dir("unminted");
        let _epub = make_fixture_epub(&dir, "book.epub");
        let roots = EpubViewRoots::default();
        assert!(roots.resolve("not-a-real-token", "OEBPS/ch1.xhtml").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn arming_the_same_epub_twice_mints_two_distinct_tokens() {
        let dir = scratch_dir("reopen");
        let epub = make_fixture_epub(&dir, "book.epub");
        let roots = EpubViewRoots::default();
        let a = roots.arm(armable_epub_path(epub.to_str().unwrap()).unwrap());
        let b = roots.arm(armable_epub_path(epub.to_str().unwrap()).unwrap());
        assert_ne!(a, b);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn one_token_never_resolves_a_different_epubs_entry() {
        let dir = scratch_dir("cross_token");
        let epub_a = make_fixture_epub(&dir, "a.epub");
        let epub_b = make_fixture_epub(&dir, "b.epub");
        let roots = EpubViewRoots::default();
        let token_a = roots.arm(armable_epub_path(epub_a.to_str().unwrap()).unwrap());
        let token_b = roots.arm(armable_epub_path(epub_b.to_str().unwrap()).unwrap());
        assert!(roots.resolve(&token_a, "OEBPS/ch1.xhtml").is_some());
        // Both fixtures share the same entry name, but token_a's resolve
        // must only ever read from a's own file — proven by containment:
        // this is trivially "some bytes" either way here, so the real
        // isolation guarantee is exercised by handle_epub_view_request's
        // per-token CSP/CORS tests below, not by content difference. What
        // this test locks is that token_b independently resolves too (both
        // opens are live at once, neither clobbers the other's binding).
        assert!(roots.resolve(&token_b, "OEBPS/ch1.xhtml").is_some());
        assert_ne!(token_a, token_b);
        std::fs::remove_dir_all(&dir).ok();
    }

    // --- traversal: no entry name in the fixture ever matches an escape attempt ---

    #[test]
    fn traversal_style_entry_names_never_resolve() {
        // Sibling file that genuinely exists next to the fixture, so a
        // resolve that somehow *did* escape onto the filesystem would find
        // real content — proving the rejection isn't just "path doesn't
        // exist" (mirrors htmlview's percent-encoded-traversal test doc).
        let dir = scratch_dir("traversal");
        let epub = make_fixture_epub(&dir, "book.epub");
        let sibling_secret = dir.parent().unwrap().join(format!(
            "mermark_test_epubview_{}_traversal_secret.txt",
            std::process::id()
        ));
        std::fs::write(&sibling_secret, "outside").unwrap();
        let roots = EpubViewRoots::default();
        let token = roots.arm(armable_epub_path(epub.to_str().unwrap()).unwrap());

        for attempt in [
            "../secret.txt",
            &format!("../{}", sibling_secret.file_name().unwrap().to_str().unwrap()),
            "/etc/hosts",
            "%2e%2e%2fsecret.txt",
        ] {
            assert!(
                roots.resolve(&token, attempt).is_none(),
                "traversal-shaped entry name {attempt:?} must never resolve"
            );
        }
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_file(&sibling_secret).ok();
    }

    #[test]
    fn token_and_entry_path_then_resolve_rejects_a_real_request_shaped_traversal() {
        // End-to-end through the same two steps handle_epub_view_request
        // composes: parse the request's (token, entry) off a real URI, then
        // resolve. The percent-encoded form is what a real fetch() sends;
        // the literal ".." form never reaches the handler (browsers
        // normalize it before dispatch), but both are asserted here for
        // defense-in-depth documentation, matching htmlview's precedent.
        let dir = scratch_dir("req_traversal");
        let epub = make_fixture_epub(&dir, "book.epub");
        let roots = EpubViewRoots::default();
        let token = roots.arm(armable_epub_path(epub.to_str().unwrap()).unwrap());

        let uri = format!("epub://{token}/%2e%2e%2fsecret.txt");
        let req = Request::builder().method(Method::GET).uri(uri).body(Vec::new()).unwrap();
        let (req_token, entry) = token_and_entry_path(&req).unwrap();
        assert_eq!(req_token, token);
        assert_eq!(entry, "../secret.txt");
        assert!(roots.resolve(&token, &entry).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    // --- zip-bomb gate: resolve() caps every entry, not just read_epub_entry ---
    // (audit fix, _workspace/04_audit_report_epub.md 🟡 #2)

    /// Build a fixture `.epub` whose single entry is `size` bytes of zero
    /// bytes — chosen because zeros compress to almost nothing, so writing
    /// even a multi-megabyte entry stays fast in a test despite the
    /// decompressed size being large.
    fn make_fixture_epub_with_one_entry(dir: &Path, name: &str, entry_name: &str, size: usize) -> PathBuf {
        let path = dir.join(name);
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();
        zip.start_file(entry_name, opts).unwrap();
        zip.write_all(&vec![0u8; size]).unwrap();
        zip.finish().unwrap();
        path
    }

    #[test]
    fn read_at_most_never_exceeds_the_cap_against_an_infinite_reader() {
        // std::io::repeat never terminates — this is the strongest possible
        // proof that the bound is enforced by the read itself, not by
        // trusting anything the source claims about its own length.
        let mut infinite = std::io::repeat(0u8);
        let cap = 100;
        let buf = read_at_most(&mut infinite, cap).unwrap();
        assert_eq!(buf.len(), cap + 1, "must stop at exactly cap+1 bytes even from a reader that never ends");
    }

    #[test]
    fn resolve_rejects_a_zip_entry_over_the_cap_via_the_scheme_serving_path() {
        // This is the exact gap the audit found: resolve() is what
        // handle_epub_view_request (the epub:// scheme handler) calls, and
        // prior to this fix it had no size gate at all — only
        // read_epub_entry (the IPC path) did.
        let dir = scratch_dir("zip_bomb_scheme_path");
        let epub = make_fixture_epub_with_one_entry(&dir, "big.epub", "OEBPS/huge.xhtml", MAX_EPUB_ENTRY_BYTES + 1);
        let roots = EpubViewRoots::default();
        let token = roots.arm(armable_epub_path(epub.to_str().unwrap()).unwrap());
        assert!(
            roots.resolve(&token, "OEBPS/huge.xhtml").is_none(),
            "an entry over MAX_EPUB_ENTRY_BYTES must be refused by the scheme-serving path, \
             not just the read_epub_entry IPC path"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_admits_a_zip_entry_exactly_at_the_cap() {
        // Boundary check: the fix must not be off-by-one in the strict
        // direction either — exactly-at-cap is still admissible.
        let dir = scratch_dir("zip_bomb_at_cap");
        let epub = make_fixture_epub_with_one_entry(&dir, "atcap.epub", "OEBPS/atcap.xhtml", MAX_EPUB_ENTRY_BYTES);
        let roots = EpubViewRoots::default();
        let token = roots.arm(armable_epub_path(epub.to_str().unwrap()).unwrap());
        let bytes = roots
            .resolve(&token, "OEBPS/atcap.xhtml")
            .expect("an entry exactly at the cap must still be admitted");
        assert_eq!(bytes.len(), MAX_EPUB_ENTRY_BYTES);
        std::fs::remove_dir_all(&dir).ok();
    }

    // --- read_text_entry / entry_within_cap ---

    #[test]
    fn read_text_entry_returns_utf8_text_for_a_real_entry() {
        let dir = scratch_dir("read_text_ok");
        let epub = make_fixture_epub(&dir, "book.epub");
        let roots = EpubViewRoots::default();
        let token = roots.arm(armable_epub_path(epub.to_str().unwrap()).unwrap());
        let text = roots.read_text_entry(&token, "OEBPS/content.opf").unwrap();
        assert_eq!(text, "<package></package>");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_text_entry_errs_for_a_missing_entry() {
        let dir = scratch_dir("read_text_missing");
        let epub = make_fixture_epub(&dir, "book.epub");
        let roots = EpubViewRoots::default();
        let token = roots.arm(armable_epub_path(epub.to_str().unwrap()).unwrap());
        assert!(roots.read_text_entry(&token, "META-INF/encryption.xml").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn entry_within_cap_boundary() {
        assert!(entry_within_cap(50, 50).is_ok(), "exactly at the cap is admissible");
        assert!(entry_within_cap(51, 50).is_err(), "one byte over the cap is refused");
        assert!(entry_within_cap(0, 50).is_ok());
    }

    // --- epub_mime_for_path ---

    #[test]
    fn epub_mime_for_path_covers_epub_specific_extensions() {
        assert_eq!(epub_mime_for_path(Path::new("ch1.xhtml")), "text/html");
        assert_eq!(epub_mime_for_path(Path::new("ch1.xht")), "text/html");
        assert_eq!(epub_mime_for_path(Path::new("content.opf")), "application/xml");
        assert_eq!(epub_mime_for_path(Path::new("toc.ncx")), "application/xml");
        assert_eq!(epub_mime_for_path(Path::new("font.woff2")), "font/woff2");
        assert_eq!(epub_mime_for_path(Path::new("font.woff")), "font/woff");
        assert_eq!(epub_mime_for_path(Path::new("font.ttf")), "font/ttf");
        assert_eq!(epub_mime_for_path(Path::new("font.otf")), "font/otf");
    }

    #[test]
    fn epub_mime_for_path_falls_back_to_htmlview_for_commodity_extensions() {
        assert_eq!(epub_mime_for_path(Path::new("pic.png")), "image/png");
        assert_eq!(epub_mime_for_path(Path::new("style.css")), "text/css");
        assert_eq!(
            epub_mime_for_path(Path::new(READER_ASSET_PATH)),
            "application/javascript"
        );
        assert_eq!(epub_mime_for_path(Path::new("a.bin")), "application/octet-stream");
    }

    // --- epub_origin_base / epub_frame_csp ---
    //
    // `native_origin`/`windows_origin` build the two request shapes a real
    // `epub://` request can actually arrive as (module doc, `token_and_entry_path`):
    // the native macOS/Linux custom-scheme form, and the Windows/WebView2
    // `http://epub.localhost/<token>/...` fallback form. Every test below runs
    // once per shape so a regression that only breaks one platform's CSP
    // still turns a test red.

    fn native_request(token: &str, entry: &str) -> Request<Vec<u8>> {
        Request::builder()
            .method(Method::GET)
            .uri(format!("epub://{token}/{entry}"))
            .body(Vec::new())
            .unwrap()
    }

    fn windows_request(token: &str, entry: &str) -> Request<Vec<u8>> {
        Request::builder()
            .method(Method::GET)
            .uri(format!("http://epub.localhost/{token}/{entry}"))
            .body(Vec::new())
            .unwrap()
    }

    fn native_origin(token: &str) -> EpubOriginBase {
        epub_origin_base(&native_request(token, "OEBPS/ch1.xhtml"), token)
    }

    fn windows_origin(token: &str) -> EpubOriginBase {
        epub_origin_base(&windows_request(token, "OEBPS/ch1.xhtml"), token)
    }

    #[test]
    fn epub_origin_base_native_form_is_the_bare_token_origin() {
        let origin = native_origin("tok123");
        assert_eq!(origin.script_src, "epub://tok123/__mermark__/measure.js");
        assert_eq!(origin.scoped_src, "epub://tok123");
    }

    #[test]
    fn epub_origin_base_windows_form_scopes_the_fixed_host_by_token_path() {
        // The Windows/WebView2 fallback: every token shares the same host
        // (`epub.localhost`), so the returned scoped_src must carry a
        // trailing-slash path prefix (`/tok123/`) — without it, CSP's
        // exact-path matching rule would either reject every real chapter
        // resource (no trailing slash = exact match only) or, worse, admit
        // every other open book's token too if the path were dropped
        // entirely.
        let origin = windows_origin("tok123");
        assert_eq!(origin.script_src, "http://epub.localhost/tok123/__mermark__/measure.js");
        assert_eq!(origin.scoped_src, "http://epub.localhost/tok123/");
    }

    #[test]
    fn epub_frame_csp_script_src_names_exactly_the_measure_js_url_on_both_platform_forms() {
        for (label, origin, expected) in [
            ("native", native_origin("tok123"), "script-src epub://tok123/__mermark__/measure.js;"),
            (
                "windows",
                windows_origin("tok123"),
                "script-src http://epub.localhost/tok123/__mermark__/measure.js;",
            ),
        ] {
            let csp = epub_frame_csp(&origin);
            assert!(csp.contains(expected), "{label}: got {csp}");
        }
    }

    #[test]
    fn epub_frame_csp_never_allows_unsafe_inline_script_or_unsafe_eval_on_either_form() {
        for origin in [native_origin("tok123"), windows_origin("tok123")] {
            let csp = epub_frame_csp(&origin);
            let script_directive = csp.split(';').find(|d| d.trim().starts_with("script-src")).unwrap();
            assert!(!script_directive.contains("unsafe-inline"), "got: {script_directive}");
            assert!(!script_directive.contains("unsafe-eval"), "got: {script_directive}");
        }
    }

    #[test]
    fn epub_frame_csp_style_src_allows_inline_but_not_script_src_on_either_form() {
        for origin in [native_origin("tok123"), windows_origin("tok123")] {
            let csp = epub_frame_csp(&origin);
            let style_directive = csp.split(';').find(|d| d.trim().starts_with("style-src")).unwrap();
            assert!(style_directive.contains("'unsafe-inline'"), "got: {style_directive}");
        }
    }

    #[test]
    fn epub_frame_csp_blocks_all_remote_https_origins_on_either_form() {
        for origin in [native_origin("tok123"), windows_origin("tok123")] {
            assert!(!epub_frame_csp(&origin).contains("https:"), "no remote-origin escape hatch");
        }
    }

    #[test]
    fn epub_frame_csp_never_reopens_ipc_or_asset_or_tauri_schemes_on_either_form() {
        for origin in [native_origin("tok123"), windows_origin("tok123")] {
            let csp = epub_frame_csp(&origin);
            assert!(!csp.contains("ipc"));
            assert!(!csp.contains("asset"));
            assert!(!csp.contains("tauri:"));
        }
    }

    #[test]
    fn epub_frame_csp_locks_the_classic_escape_directives_on_either_form() {
        for origin in [native_origin("tok123"), windows_origin("tok123")] {
            let csp = epub_frame_csp(&origin);
            assert!(csp.contains("object-src 'none'"));
            assert!(csp.contains("frame-src 'none'"));
            assert!(csp.contains("form-action 'none'"));
            assert!(csp.contains("base-uri 'none'"));
            assert!(csp.contains("connect-src 'none'"));
        }
    }

    #[test]
    fn epub_frame_csp_native_form_is_byte_for_byte_unchanged_from_the_shipped_v1_string() {
        // Locks the exact pre-Windows-fix output for the native macOS/Linux
        // form — the win-origin fix must not change one byte of what already
        // shipped and was real-app-verified there.
        let csp = epub_frame_csp(&native_origin("tok123"));
        assert_eq!(
            csp,
            "default-src 'none'; script-src epub://tok123/__mermark__/measure.js; \
             style-src 'unsafe-inline' epub://tok123; img-src epub://tok123 data:; \
             font-src epub://tok123 data:; media-src epub://tok123 data:; \
             connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
        );
    }

    #[test]
    fn epub_frame_csp_windows_form_scopes_every_directive_to_the_tokens_own_path_prefix() {
        let csp = epub_frame_csp(&windows_origin("tok123"));
        assert_eq!(
            csp,
            "default-src 'none'; script-src http://epub.localhost/tok123/__mermark__/measure.js; \
             style-src 'unsafe-inline' http://epub.localhost/tok123/; img-src http://epub.localhost/tok123/ data:; \
             font-src http://epub.localhost/tok123/ data:; media-src http://epub.localhost/tok123/ data:; \
             connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
        );
    }

    #[test]
    fn epub_frame_csp_windows_form_never_grants_a_different_tokens_path() {
        let csp = epub_frame_csp(&windows_origin("tok123"));
        assert!(!csp.contains("other-tok"), "got: {csp}");
        // The scoped source must be a path *prefix* under this token, not the
        // bare shared host alone (which would admit every token).
        assert!(
            !csp.contains("img-src http://epub.localhost data:"),
            "img-src must not grant the whole shared host, only this token's own path prefix: {csp}"
        );
    }

    // --- is_reader_asset_path ---

    #[test]
    fn is_reader_asset_path_matches_only_the_exact_reserved_name() {
        assert!(is_reader_asset_path("__mermark__/measure.js"));
        assert!(!is_reader_asset_path("OEBPS/ch1.xhtml"));
        assert!(!is_reader_asset_path("__mermark__/other.js"));
    }

    // --- inject_reader_runtime: reader-runtime script tag ---

    #[test]
    fn inject_reader_runtime_appends_only_the_measure_script_tag() {
        // The injection is deliberately MINIMAL: a chapter's own styling is the
        // book author's, and we add exactly one thing to it — the reader runtime.
        // A `<style>` override once lived here too; see this function's HISTORY
        // note for why it was reverted (wrong diagnosis, fixed nothing).
        let out = inject_reader_runtime(
            b"<html><body>x</body></html>".to_vec(),
            "epub://tok123/__mermark__/measure.js",
        );
        let body = String::from_utf8(out).unwrap();
        assert!(
            body.ends_with("<script src=\"epub://tok123/__mermark__/measure.js\"></script>"),
            "got: {body}"
        );
        assert!(!body.contains("<style"), "no style injection — got: {body}");
        assert!(body.starts_with("<html><body>x</body></html>"), "book bytes must be untouched — got: {body}");
    }

    // --- build_ok_response: CSP + injection attach to text/html only ---

    fn get_request(token: &str, entry: &str, origin: Option<&str>) -> Request<Vec<u8>> {
        let uri = format!("epub://{token}/{entry}");
        let mut builder = Request::builder().method(Method::GET).uri(uri);
        if let Some(o) = origin {
            builder = builder.header(header::ORIGIN, o);
        }
        builder.body(Vec::new()).unwrap()
    }

    #[test]
    fn html_response_carries_csp_and_the_injected_measure_script_tag() {
        let req = get_request("tok123", "OEBPS/ch1.xhtml", None);
        let resp = build_ok_response(&req, "tok123", Path::new("ch1.xhtml"), b"<html><body>hi</body></html>".to_vec());
        let csp = resp.headers().get("Content-Security-Policy").expect("html must carry CSP");
        assert_eq!(csp.to_str().unwrap(), epub_frame_csp(&native_origin("tok123")));
        let body = String::from_utf8(resp.body().clone()).unwrap();
        assert!(
            body.ends_with("<script src=\"epub://tok123/__mermark__/measure.js\"></script>"),
            "got: {body}"
        );
        assert_eq!(resp.headers().get(header::CONTENT_TYPE).unwrap(), "text/html");
    }

    #[test]
    fn html_response_on_the_windows_request_shape_carries_the_windows_csp_and_injection() {
        // End-to-end through build_ok_response with a *real* WebView2-shaped
        // request URI (not a hand-built EpubOriginBase) — this is the exact
        // path handle_epub_view_request drives in production on Windows.
        let req = windows_request("tok123", "OEBPS/ch1.xhtml");
        let resp = build_ok_response(&req, "tok123", Path::new("ch1.xhtml"), b"<html><body>hi</body></html>".to_vec());
        let csp = resp.headers().get("Content-Security-Policy").expect("html must carry CSP");
        assert_eq!(csp.to_str().unwrap(), epub_frame_csp(&windows_origin("tok123")));
        let body = String::from_utf8(resp.body().clone()).unwrap();
        assert!(
            body.ends_with("<script src=\"http://epub.localhost/tok123/__mermark__/measure.js\"></script>"),
            "got: {body}"
        );
        assert_eq!(resp.headers().get(header::CONTENT_TYPE).unwrap(), "text/html");
    }

    #[test]
    fn non_html_response_carries_no_csp_and_no_injection() {
        let req = get_request("tok123", "OEBPS/img/pic.png", None);
        let original = b"fakepngbytes".to_vec();
        let resp = build_ok_response(&req, "tok123", Path::new("pic.png"), original.clone());
        assert!(resp.headers().get("Content-Security-Policy").is_none());
        assert_eq!(resp.body(), &original, "non-html bytes must pass through unmodified");
        assert_eq!(resp.headers().get(header::CONTENT_TYPE).unwrap(), "image/png");
    }

    #[test]
    fn measure_js_asset_response_carries_no_csp_and_no_injection() {
        // The runtime script itself is not HTML — it must not get the CSP
        // header (which would be pointless on a script response) or a
        // recursive self-injection.
        let req = get_request("tok123", "__mermark__/measure.js", None);
        let resp = build_ok_response(&req, "tok123", Path::new(READER_ASSET_PATH), MEASURE_JS.as_bytes().to_vec());
        assert!(resp.headers().get("Content-Security-Policy").is_none());
        assert_eq!(resp.body(), MEASURE_JS.as_bytes());
    }

    // --- CORS: same-token grant, cross-token/app denial ---

    #[test]
    fn ok_response_grants_cors_for_a_same_token_fetch() {
        let req = get_request("tok123", "OEBPS/content.opf", Some("epub://tok123"));
        let resp = build_ok_response(&req, "tok123", Path::new("content.opf"), b"<package/>".to_vec());
        assert_eq!(resp.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(), "epub://tok123");
    }

    #[test]
    fn ok_response_grants_no_cors_for_a_cross_token_fetch() {
        let req = get_request("tok123", "OEBPS/content.opf", Some("epub://other-tok"));
        let resp = build_ok_response(&req, "tok123", Path::new("content.opf"), b"<package/>".to_vec());
        assert!(resp.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
    }

    #[test]
    fn ok_response_grants_no_cors_for_the_app_origin() {
        let req = get_request("tok123", "OEBPS/content.opf", Some("tauri://localhost"));
        let resp = build_ok_response(&req, "tok123", Path::new("content.opf"), b"<package/>".to_vec());
        assert!(resp.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
    }

    // --- token_and_entry_path ---

    #[test]
    fn token_and_entry_path_reads_the_host_as_token() {
        let req = get_request("abc123", "OEBPS/ch1.xhtml", None);
        let (token, entry) = token_and_entry_path(&req).unwrap();
        assert_eq!(token, "abc123");
        assert_eq!(entry, "OEBPS/ch1.xhtml");
    }

    #[test]
    fn token_and_entry_path_decodes_percent_encoded_segments() {
        let req = get_request("abc123", "OEBPS/my%20chapter.xhtml", None);
        let (_, entry) = token_and_entry_path(&req).unwrap();
        assert_eq!(entry, "OEBPS/my chapter.xhtml");
    }

    #[test]
    fn token_and_entry_path_falls_back_to_first_path_segment_on_windows_host_form() {
        let req = Request::builder()
            .method(Method::GET)
            .uri("http://epub.localhost/abc123/OEBPS/ch1.xhtml")
            .body(Vec::new())
            .unwrap();
        let (token, entry) = token_and_entry_path(&req).unwrap();
        assert_eq!(token, "abc123");
        assert_eq!(entry, "OEBPS/ch1.xhtml");
    }
}
