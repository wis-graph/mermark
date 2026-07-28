//! Backend half of the HTML viewer's opt-in JS execution (setting, default off).
//! Design: `_workspace/01_architect_design_htmljs.md` (esp. §2 "why a custom
//! scheme", §10 "개정 1 — allow-same-origin + 토큰 오리진"), plan:
//! `_workspace/01_architect_plan_htmljs.md` (개정 1 section).
//!
//! The static (off) rendering path is untouched by this module — it lives
//! entirely in the frontend's `srcdoc` code and never crosses IPC. This module
//! exists solely for the *scripted* (on) path: a custom `htmlview://` protocol
//! that serves files from a caller-armed directory with its own frame-only CSP,
//! so a scripted `<iframe>` gets real JS execution without inheriting (or
//! weakening) the parent app's CSP — see `FRAME_CSP` below.
//!
//! **Revision 1 (per-open token origin, design §10).** The original judgment
//! was `sandbox="allow-scripts"` with `allow-same-origin` *never* granted, so
//! the frame stayed opaque-origin. A real `tauri build` bundle measurement
//! showed that WebKit treats a custom `WKURLSchemeHandler` scheme as a *local
//! scheme*: it applies a `SecurityOrigin::canDisplay` gate that only a
//! document whose own origin shares the resource's scheme may pass, and an
//! opaque origin never shares a scheme with anything — so every sibling
//! subresource (`<script src>`, `<img>`, `fetch`) failed outright, even
//! before any CORS check ran. `allow-same-origin` fixes that (the frame's
//! origin becomes `(htmlview, <token>)`, a real tuple that matches its own
//! resources' scheme), but a single shared `htmlview://localhost` origin
//! would let concurrently-open scripted documents reach each other's DOM and
//! storage through that shared origin. **Per-open random tokens** close that:
//! `arm_html_view_root` mints one token per open and the URL host *is* the
//! token, so origin = (scheme, token) — one unique origin per open, never
//! shared, and the protocol handler resolves the requested root *from* the
//! token rather than trusting a caller-supplied path at all.
//!
//! Security rests on three gates, all enforced *here*, never trusted from the
//! caller: (1) `arm_html_view_root` mints an unguessable token
//! (`mint_view_token`, OS CSPRNG) and binds it to a canonicalized root — the
//! token is the only key that resolves to a root at all; (2) every request's
//! `rel_path` is joined onto *that* root and the join result is re-verified
//! with `is_within_armed_root` (post-canonicalize, so `..`/symlinks/an
//! encoded-slash-smuggled absolute path can't lie); (3) the CORS answer this
//! handler gives (`cors_allow_origin`) only ever matches the *resource's own*
//! `(scheme, token)` origin — a fetch from a different origin (the app, or a
//! different token's document) gets no CORS grant and can't read the body,
//! even if it somehow knows/guesses another valid token.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::http::{header, HeaderValue, Method, Request, Response, StatusCode};
use tauri::Manager;

/// The single value both the preflight response and the real GET response
/// advertise for `Access-Control-Allow-Methods`. Named so the two call sites
/// can't silently drift (a preflight promising a method the real response
/// doesn't also grant would fail the browser's own consistency checks).
const CORS_ALLOWED_METHODS: &str = "GET";

/// The CSP handed to every `.html` document the `htmlview` protocol serves —
/// **not** the parent app's CSP (which is untouched save for one `frame-src`
/// addition in `tauri.conf.json`). This is what makes scripted execution
/// possible at all: a `srcdoc` document inherits the embedder's CSP (which
/// forbids inline scripts), but a document loaded from a *network-shaped*
/// custom scheme does not — its CSP is whatever this handler's response
/// header says. `script-src`/`style-src` allow inline (the whole point) plus
/// `https:` for CDN scripts a dashboard-style document might load; the
/// deliberately **absent** pieces carry the real weight: no `ipc:` / no
/// `http://ipc.localhost` (Tauri IPC unreachable from this frame), no
/// `asset:` / no `http://asset.localhost` (the wide-open asset-protocol scope
/// stays unreachable too), no `tauri:` (no init-script channel). `frame-src
/// 'none'` blocks nested iframes; `object-src`/`base-uri`/`form-action 'none'`
/// close the remaining classic escapes. Unaffected by the token-origin
/// revision — still the frame's only CSP, still per-`.html`-response. Cargo
/// tests below assert both the absences (the security-bearing half) and
/// presences.
pub(crate) const FRAME_CSP: &str = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' htmlview: https:; style-src 'unsafe-inline' htmlview: https:; img-src htmlview: data: blob: https:; media-src htmlview: data: blob: https:; font-src htmlview: data: https:; connect-src htmlview: https:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/// Number of random bytes in a minted view token — 128 bits, hex-encoded to
/// 32 characters. This is the entire access-control secret for a scripted
/// open: possessing the token *is* the authorization (design §10.3), so it
/// must be infeasible to guess or enumerate, not just "different each time".
const VIEW_TOKEN_BYTES: usize = 16;

/// Mint one fresh, unguessable view token: `VIEW_TOKEN_BYTES` bytes from the
/// OS CSPRNG (`getrandom`, never a seeded/deterministic PRNG — a predictable
/// token would let one open's document forge another's URL and reach a root
/// it was never armed for), hex-encoded. Two calls always differ in practice
/// (locked by `mint_view_token_is_not_repeated_across_calls`) precisely
/// because they're independent CSPRNG draws, not a counter.
pub(crate) fn mint_view_token() -> String {
    let mut bytes = [0u8; VIEW_TOKEN_BYTES];
    getrandom::fill(&mut bytes).expect("OS CSPRNG must be available to mint a view token");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Per-open state: which armed root a minted token resolves to. Managed
/// Tauri state (`app.manage(HtmlViewRoots::default())`); the protocol
/// handler reads it via `AppHandle::state`. A token is *never* removed once
/// minted (§9 of the design scopes a disarm command out — accumulation is
/// bounded by documents opened in the session, an acceptable cost), and two
/// opens of the very same directory each mint their *own* token — that's
/// deliberate, not an inefficiency: it's what makes every open its own
/// unshared origin (design §10.3, "형제 scripted 문서 접근" row).
#[derive(Default)]
pub struct HtmlViewRoots(Mutex<HashMap<String, PathBuf>>);

impl HtmlViewRoots {
    /// Mint a token, bind `root` (already canonicalized by the caller) to
    /// it, and return the token.
    fn arm(&self, root: PathBuf) -> String {
        let token = mint_view_token();
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(token.clone(), root);
        token
    }

    /// Resolve `(token, rel_path)` to a servable filesystem path, or `None`
    /// when either the token was never minted (an unknown/guessed token —
    /// design §10.5 R5) or the joined path escapes the token's own bound
    /// root (`..`, a symlink, or `rel_path` smuggling in an absolute path via
    /// an encoded slash — `is_within_armed_root` catches all three the same
    /// way, post-canonicalize). This is the single choke point both
    /// "unknown token" and "path escape" run through — a caller can never
    /// reach a file outside the root *their own* token is bound to, and two
    /// different tokens are never compared against each other (an
    /// already-armed token's root lookup can only ever resolve within that
    /// token's own root, structurally — there is no code path that lets
    /// token A's request resolve inside token B's root, so "교차 토큰"
    /// access is closed by construction, not by an extra check).
    fn resolve(&self, token: &str, rel_path: &Path) -> Option<PathBuf> {
        let root = self.0.lock().unwrap_or_else(|e| e.into_inner()).get(token).cloned()?;
        let candidate = root.join(rel_path);
        is_within_armed_root(&root, &candidate).then_some(candidate)
    }
}

/// The single containment rule this whole feature's file-access safety rests
/// on: is `candidate` inside `root`? Both sides are `canonicalize`d before the
/// prefix check, which is what makes this resistant to every escape route a
/// lexical check would miss — `canonicalize` both collapses `..` components
/// *and* resolves symlinks to their real target, so a symlink sitting inside
/// `root` but pointing outside it fails the `starts_with` check on its
/// resolved (not lexical) path. It also catches the case `HtmlViewRoots::resolve`
/// specifically needs it for: `PathBuf::join` silently *discards* `root` and
/// returns its argument verbatim when that argument is itself absolute — so a
/// `rel_path` that decodes to an absolute path (e.g. `%2Fetc%2Fpasswd` →
/// `/etc/passwd`) would otherwise escape with no `..` in sight; the
/// post-join containment re-check here rejects it exactly like any other
/// escape, because the joined-and-canonicalized result simply won't start
/// with `root`. A `candidate` that doesn't exist, or a `root` that can't be
/// resolved, fails closed (`false`) rather than falling back to a lexical
/// guess.
pub(crate) fn is_within_armed_root(root: &Path, candidate: &Path) -> bool {
    match (std::fs::canonicalize(root), std::fs::canonicalize(candidate)) {
        (Ok(real_root), Ok(real_candidate)) => real_candidate.starts_with(&real_root),
        _ => false,
    }
}

/// Arm `dir` (a document's parent folder) as a root the `htmlview` protocol
/// may serve files from, and return the freshly minted token the frontend
/// must fold into the `iframe.src` URL's *host* (`htmlview://<token>/<doc
/// file name>`) — see module doc for why the token has to be the host, not a
/// path segment, for the per-open-origin property to hold. Canonicalizes
/// `dir` before storing so every later containment check
/// (`is_within_armed_root`) compares resolved paths on both sides.
///
/// Return type changed from `Result<(), String>` to `Result<String, String>`
/// in the token-origin revision (design §10.7) — **every caller/mock must
/// read the token from the resolved value now**, not just await completion.
#[tauri::command]
pub fn arm_html_view_root(dir: String, roots: tauri::State<'_, HtmlViewRoots>) -> Result<String, String> {
    let canonical = std::fs::canonicalize(&dir).map_err(|e| format!("arm {dir}: {e}"))?;
    Ok(roots.arm(canonical))
}

/// Content-Type for a file the `htmlview` protocol serves, keyed on
/// extension. Deliberately narrow — this handler only ever serves a scripted
/// HTML document and its same-folder siblings (images/styles/scripts/data),
/// never arbitrary files — so anything outside this list falls back to
/// `application/octet-stream` rather than guessing.
pub(crate) fn mime_for_path(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "css" => "text/css",
        "js" | "mjs" => "application/javascript",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

/// Split an incoming `htmlview://<token>/<doc-relative-path>` request into
/// its token (the URL's own host/authority — macOS/Linux native custom-scheme
/// form) and percent-decoded relative path. `None` for a request with no
/// usable host at all.
///
/// Windows/Android surface a registered custom scheme as
/// `http://<scheme-name>.localhost/<path>` (fixed to the *scheme name*, not
/// per-open) — the per-token-origin property this revision relies on cannot
/// be reproduced through that fixed host, since Tauri doesn't expose a way to
/// vary it per navigation. As a fallback for that shape specifically (host is
/// exactly the registered scheme's `<name>.localhost`, so it carries no
/// token), the token is read as the **first path segment** instead
/// (`/<token>/<rest>`) — routing still works, but the per-open-origin
/// guarantee doesn't hold on that platform. mermark ships Windows opt-in
/// only (`windows-release-opt-in-only`), and this revision's real-app
/// verification (design §10.5 R1–R8) is WKWebView/macOS-only; the fallback
/// exists so Windows doesn't hard-fail, not as a verified-equal guarantee.
fn token_and_rel_path(request: &Request<Vec<u8>>) -> Option<(String, PathBuf)> {
    let uri = request.uri();
    let host = uri.host()?;
    if host.is_empty() {
        return None;
    }
    let raw_path = uri.path();
    if host == "htmlview.localhost" || host == "localhost" {
        // Windows/Android fallback shape: token travels as the first path
        // segment instead of the (fixed) host.
        let trimmed = raw_path.trim_start_matches('/');
        let mut parts = trimmed.splitn(2, '/');
        let token = parts.next()?;
        if token.is_empty() {
            return None;
        }
        let rest = parts.next().unwrap_or("");
        return Some((token.to_string(), decode_path_segment(rest)));
    }
    let rel = raw_path.trim_start_matches('/');
    Some((host.to_string(), decode_path_segment(rel)))
}

/// Percent-decode a URL path segment into a `PathBuf`. A single narrow
/// helper so both branches of `token_and_rel_path` decode identically —
/// deliberately *not* trusted to produce a relative path (a `%2F`-encoded
/// leading slash decodes back into a literal `/`, which would make the
/// result absolute): callers must still run the joined result through
/// `is_within_armed_root` before serving it, which is exactly what
/// `HtmlViewRoots::resolve` does.
fn decode_path_segment(raw: &str) -> PathBuf {
    let decoded = urlencoding::decode(raw)
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| raw.to_string());
    PathBuf::from(decoded)
}

/// A bare 403 with no body — the uniform refusal for every *content* gate
/// this handler enforces (unmapped token, path escape, unreadable file,
/// non-GET/OPTIONS method, cross-origin fetch attempt). Deliberately
/// undifferentiated: a 403 tells the caller "not servable" without leaking
/// *why*, which would otherwise let a probing script fingerprint token
/// validity or armed-root contents.
fn forbidden_response() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::FORBIDDEN)
        .body(Vec::new())
        .expect("a static 403 with no body always builds")
}

/// The exact origin string a request to `request`'s own URL would carry if
/// the requesting document's own origin were that URL's `(scheme, host)` —
/// i.e. the origin a document loaded *from this very resource* would report
/// as `location.origin`. `None` when the request has no scheme or host to
/// build one from.
fn resource_origin(request: &Request<Vec<u8>>) -> Option<String> {
    let uri = request.uri();
    let scheme = uri.scheme_str()?;
    let host = uri.host()?;
    Some(format!("{scheme}://{host}"))
}

/// The value to answer in `Access-Control-Allow-Origin`, or `None` to grant
/// no CORS access at all. Revision-1 policy (design §10.3/§10.4 "형제
/// scripted 문서 접근" row): a scripted document's frame now has a **real**
/// `(htmlview, <token>)` origin (`allow-same-origin`, no longer opaque), so
/// its own same-folder `fetch("data.json")` is genuinely *same-origin* with
/// the resource it's fetching — same scheme, same token/host — and same-
/// origin requests don't need a CORS grant to be read at all. This function
/// exists for the one case that does need an explicit answer: a request that
/// *does* carry an `Origin` header. It's granted **only** when that `Origin`
/// exactly matches the requested resource's own origin
/// (`resource_origin`) — i.e. the token in the `Origin` header's host must be
/// the *same* token as the URL being fetched. A request whose `Origin` is a
/// **different** token (one scripted document trying to fetch another's
/// files) or the app's own origin gets **no** grant here, so the browser
/// refuses to let that caller's script read the response even if the bytes
/// were technically served — this is what keeps "각 토큰은 격리된 오리진"
/// true for `fetch`-based reads, not just for DOM/storage access. A request
/// with **no** `Origin` header at all (a plain `<img src>`/`<script src>` tag
/// load, which never sends one) also gets `None` — those loads aren't
/// CORS-checked by the browser in the first place, so no header is needed.
fn cors_allow_origin(request: &Request<Vec<u8>>) -> Option<HeaderValue> {
    let origin_header = request.headers().get(header::ORIGIN)?;
    let origin_str = origin_header.to_str().ok()?;
    let expected = resource_origin(request)?;
    (origin_str == expected).then(|| origin_header.clone())
}

/// Answer a CORS preflight (`OPTIONS`) request. Preflight never reaches the
/// token/file gates below (a preflight's whole purpose is the browser asking
/// "would a real request be allowed" *before* sending one, and answering it
/// must not reveal token validity or armed-root contents) — it is answered
/// purely from the `Origin` vs. `resource_origin` comparison
/// (`cors_allow_origin`). A same-token request gets the grant headers on a
/// bare `204`; a cross-origin request (different token, or the app itself)
/// gets a bare `204` with **no** CORS headers, which makes the browser refuse
/// to send the real request at all.
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

/// Build the 200 response for a file that has already passed the token/root
/// gates and been read successfully. Pulled out from `handle_html_view_request`
/// so its header logic — the CSP attaching **only** to `.html` responses, and
/// the CORS grant only ever matching the resource's own origin — is testable
/// without a live `AppHandle`/managed-state context.
fn build_ok_response(request: &Request<Vec<u8>>, fs_path: &Path, bytes: Vec<u8>) -> Response<Vec<u8>> {
    let mime = mime_for_path(fs_path);
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime);
    // Same-token `fetch()`/`XHR` (a dashboard reading its own sibling
    // data.json) is same-origin already and doesn't need this header to be
    // *read*, but WKWebView's canDisplay gate — the actual §10.2 root cause —
    // is independent of CORS, so this grant is defense-in-depth for the read
    // step, not the display step. A cross-origin caller gets no header here
    // (`cors_allow_origin` doc explains the exact matching rule) —
    // `FRAME_CSP`'s `connect-src` is the directive that gates *whether* a
    // fetch is attempted at all; this header only governs whether a
    // same-token script may read a result the armed-root gate already let
    // through.
    if let Some(origin) = cors_allow_origin(request) {
        builder = builder
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin)
            .header(header::ACCESS_CONTROL_ALLOW_METHODS, CORS_ALLOWED_METHODS);
    }
    if mime == "text/html" {
        builder = builder.header("Content-Security-Policy", FRAME_CSP);
    }
    builder
        .body(bytes)
        .unwrap_or_else(|_| forbidden_response())
}

/// The `htmlview` protocol handler registered on the Tauri builder in
/// `lib.rs`. `OPTIONS` is answered as a CORS preflight
/// (`build_preflight_response`, token-blind by construction). Every other
/// method must be `GET` — this protocol has no write surface — and then
/// passes the token/root gate: `token_and_rel_path` must parse a token from
/// the request, and `HtmlViewRoots::resolve` must map that token to a root
/// *and* confirm the joined path still resolves inside it (unknown token,
/// path escape, and cross-token access are all refused the same way — see
/// `HtmlViewRoots::resolve`'s doc). Only past that does the file need to
/// actually be readable, and only then does `build_ok_response` attach the
/// CSP/CORS headers and return the bytes.
pub(crate) fn handle_html_view_request(
    app: &tauri::AppHandle,
    request: &Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    if request.method() == Method::OPTIONS {
        return build_preflight_response(request);
    }
    if request.method() != Method::GET {
        return forbidden_response();
    }
    let Some((token, rel_path)) = token_and_rel_path(request) else {
        return forbidden_response();
    };
    let roots = app.state::<HtmlViewRoots>();
    let Some(fs_path) = roots.resolve(&token, &rel_path) else {
        return forbidden_response();
    };
    match std::fs::read(&fs_path) {
        Ok(bytes) => build_ok_response(request, &fs_path, bytes),
        Err(_) => forbidden_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mermark_test_htmlview_{}_{tag}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    // --- mint_view_token ---

    #[test]
    fn mint_view_token_is_32_hex_chars() {
        let token = mint_view_token();
        assert_eq!(token.len(), VIEW_TOKEN_BYTES * 2);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()), "got: {token}");
    }

    #[test]
    fn mint_view_token_is_not_repeated_across_calls() {
        let a = mint_view_token();
        let b = mint_view_token();
        assert_ne!(a, b, "two independent CSPRNG draws must not collide");
    }

    // --- is_within_armed_root ---

    #[test]
    fn armed_root_admits_a_file_directly_inside_it() {
        let root = scratch_dir("root_self");
        let file = root.join("doc.html");
        fs::write(&file, "<html></html>").unwrap();
        assert!(is_within_armed_root(&root, &file));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn armed_root_admits_a_file_in_a_subdirectory() {
        let root = scratch_dir("root_sub");
        let sub = root.join("assets");
        fs::create_dir_all(&sub).unwrap();
        let file = sub.join("pic.png");
        fs::write(&file, b"fake png").unwrap();
        assert!(is_within_armed_root(&root, &file));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn armed_root_rejects_a_dot_dot_escape() {
        let root = scratch_dir("root_dotdot");
        let sibling = root.parent().unwrap().join(format!(
            "mermark_test_htmlview_{}_root_dotdot_sibling.txt",
            std::process::id()
        ));
        fs::write(&sibling, "outside").unwrap();
        let escaping = root.join("..").join(sibling.file_name().unwrap());
        assert!(
            !is_within_armed_root(&root, &escaping),
            "a `..`-escaping candidate must never resolve inside root"
        );
        fs::remove_dir_all(&root).ok();
        fs::remove_file(&sibling).ok();
    }

    #[test]
    fn unarmed_root_rejects_a_path_that_lives_elsewhere() {
        let root = scratch_dir("root_unrelated_a");
        let elsewhere = scratch_dir("root_unrelated_b");
        let file = elsewhere.join("doc.html");
        fs::write(&file, "<html></html>").unwrap();
        assert!(!is_within_armed_root(&root, &file));
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&elsewhere).ok();
    }

    #[cfg(unix)]
    #[test]
    fn armed_root_rejects_a_symlink_pointing_outside_it() {
        use std::os::unix::fs::symlink;
        let root = scratch_dir("root_symlink");
        let outside = scratch_dir("root_symlink_outside");
        let secret = outside.join("secret.html");
        fs::write(&secret, "<html>secret</html>").unwrap();
        let link = root.join("escape.html");
        symlink(&secret, &link).unwrap();
        assert!(
            !is_within_armed_root(&root, &link),
            "a symlink inside root pointing outside it must be rejected"
        );
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    // --- HtmlViewRoots (mint + bind + resolve) ---

    #[test]
    fn unmapped_token_is_refused() {
        let root = scratch_dir("state_unmapped");
        fs::write(root.join("doc.html"), "<html></html>").unwrap();
        let roots = HtmlViewRoots::default();
        assert!(
            roots.resolve("not-a-real-token", Path::new("doc.html")).is_none(),
            "a request with a token that was never minted must be refused"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn arming_mints_a_token_that_resolves_files_inside_its_root() {
        let root = scratch_dir("state_armed");
        fs::write(root.join("doc.html"), "<html></html>").unwrap();
        let roots = HtmlViewRoots::default();
        let token = roots.arm(std::fs::canonicalize(&root).unwrap());
        let resolved = roots.resolve(&token, Path::new("doc.html"));
        assert_eq!(resolved, Some(std::fs::canonicalize(&root).unwrap().join("doc.html")));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn resolve_rejects_a_dot_dot_escape_through_the_token() {
        let root = scratch_dir("state_dotdot");
        let sibling_secret = root.parent().unwrap().join(format!(
            "mermark_test_htmlview_{}_state_dotdot_secret.txt",
            std::process::id()
        ));
        fs::write(&sibling_secret, "outside").unwrap();
        let roots = HtmlViewRoots::default();
        let token = roots.arm(std::fs::canonicalize(&root).unwrap());
        let escaping_rel = Path::new("..").join(sibling_secret.file_name().unwrap());
        assert!(roots.resolve(&token, &escaping_rel).is_none());
        fs::remove_dir_all(&root).ok();
        fs::remove_file(&sibling_secret).ok();
    }

    #[test]
    fn resolve_rejects_a_rel_path_that_decodes_to_an_absolute_path() {
        // PathBuf::join silently discards the base when the argument is
        // itself absolute — the exact escape decode_path_segment's doc warns
        // about (a %2F-encoded leading slash). resolve() must still catch it
        // via the post-join containment re-check.
        let root = scratch_dir("state_absolute_smuggle");
        fs::write(root.join("doc.html"), "<html></html>").unwrap();
        let roots = HtmlViewRoots::default();
        let token = roots.arm(std::fs::canonicalize(&root).unwrap());
        assert!(roots.resolve(&token, Path::new("/etc/hosts")).is_none());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn one_token_never_resolves_inside_a_different_tokens_root() {
        // "교차 토큰" (design §10.5 R5): token A's requests can only ever
        // resolve within root A, even when asked for a file name that
        // genuinely exists — under a *different* token's root.
        let root_a = scratch_dir("cross_root_a");
        let root_b = scratch_dir("cross_root_b");
        fs::write(root_a.join("mine.html"), "<html>a</html>").unwrap();
        fs::write(root_b.join("secret.html"), "<html>b-secret</html>").unwrap();
        let roots = HtmlViewRoots::default();
        let token_a = roots.arm(std::fs::canonicalize(&root_a).unwrap());
        let token_b = roots.arm(std::fs::canonicalize(&root_b).unwrap());
        assert_ne!(token_a, token_b);
        // token A can read its own file...
        assert!(roots.resolve(&token_a, Path::new("mine.html")).is_some());
        // ...but never root B's file, even by exact relative name.
        assert!(roots.resolve(&token_a, Path::new("secret.html")).is_none());
        // and the reverse: token B never sees root A's file either.
        assert!(roots.resolve(&token_b, Path::new("mine.html")).is_none());
        fs::remove_dir_all(&root_a).ok();
        fs::remove_dir_all(&root_b).ok();
    }

    #[test]
    fn arming_the_same_directory_twice_mints_two_distinct_tokens() {
        // Deliberate, not an inefficiency (module doc): each open is its own
        // unshared origin, even for the identical folder.
        let root = scratch_dir("state_reopen");
        let roots = HtmlViewRoots::default();
        let a = roots.arm(std::fs::canonicalize(&root).unwrap());
        let b = roots.arm(std::fs::canonicalize(&root).unwrap());
        assert_ne!(a, b);
        fs::remove_dir_all(&root).ok();
    }

    // --- mime_for_path ---

    #[test]
    fn mime_for_path_covers_the_documented_extensions() {
        assert_eq!(mime_for_path(Path::new("a.html")), "text/html");
        assert_eq!(mime_for_path(Path::new("a.htm")), "text/html");
        assert_eq!(mime_for_path(Path::new("a.png")), "image/png");
        assert_eq!(mime_for_path(Path::new("a.jpg")), "image/jpeg");
        assert_eq!(mime_for_path(Path::new("a.jpeg")), "image/jpeg");
        assert_eq!(mime_for_path(Path::new("a.svg")), "image/svg+xml");
        assert_eq!(mime_for_path(Path::new("a.css")), "text/css");
        assert_eq!(mime_for_path(Path::new("a.js")), "application/javascript");
        assert_eq!(mime_for_path(Path::new("a.json")), "application/json");
        assert_eq!(mime_for_path(Path::new("a.bin")), "application/octet-stream");
        assert_eq!(mime_for_path(Path::new("a.HTML")), "text/html", "case-insensitive");
    }

    // --- FRAME_CSP: absences carry the security weight, presences the policy ---

    #[test]
    fn frame_csp_never_reopens_ipc_or_asset_or_tauri_schemes() {
        assert!(!FRAME_CSP.contains("ipc"), "IPC must stay unreachable from the frame");
        assert!(!FRAME_CSP.contains("asset"), "the wide-open asset scope must stay unreachable");
        assert!(!FRAME_CSP.contains("tauri:"), "no tauri: scheme access from the frame");
    }

    #[test]
    fn frame_csp_locks_the_classic_escape_directives() {
        assert!(FRAME_CSP.contains("object-src 'none'"));
        assert!(FRAME_CSP.contains("frame-src 'none'"));
        assert!(FRAME_CSP.contains("form-action 'none'"));
        assert!(FRAME_CSP.contains("base-uri 'none'"));
    }

    // --- test request builders ---

    /// A `GET` request to `htmlview://<token>/<rel>`, optionally carrying an
    /// `Origin` header. `origin=None` mirrors a plain tag load
    /// (`<img src>`/`<script src>`), which never sends one.
    fn get_request(token: &str, rel: &str, origin: Option<&str>) -> Request<Vec<u8>> {
        let uri = format!("htmlview://{token}/{rel}");
        let mut builder = Request::builder().method(Method::GET).uri(uri);
        if let Some(o) = origin {
            builder = builder.header(header::ORIGIN, o);
        }
        builder.body(Vec::new()).unwrap()
    }

    fn options_request(token: &str, rel: &str, origin: &str) -> Request<Vec<u8>> {
        let uri = format!("htmlview://{token}/{rel}");
        Request::builder()
            .method(Method::OPTIONS)
            .uri(uri)
            .header(header::ORIGIN, origin)
            .body(Vec::new())
            .unwrap()
    }

    // --- build_ok_response: CSP header attaches to .html only; CORS matches origin only ---

    #[test]
    fn html_response_carries_the_frame_csp_header() {
        let req = get_request("tok123", "doc.html", None);
        let resp = build_ok_response(&req, Path::new("doc.html"), b"<html></html>".to_vec());
        let csp = resp
            .headers()
            .get("Content-Security-Policy")
            .expect("an .html response must carry the CSP header");
        assert_eq!(csp.to_str().unwrap(), FRAME_CSP);
        assert_eq!(resp.headers().get(header::CONTENT_TYPE).unwrap(), "text/html");
    }

    #[test]
    fn non_html_response_carries_no_csp_header() {
        // A sibling image doesn't need (and shouldn't get) the document CSP —
        // it's not a navigable document, just a subresource.
        let req = get_request("tok123", "sibling.png", None);
        let resp = build_ok_response(&req, Path::new("sibling.png"), b"fake png".to_vec());
        assert!(resp.headers().get("Content-Security-Policy").is_none());
        assert_eq!(resp.headers().get(header::CONTENT_TYPE).unwrap(), "image/png");
    }

    #[test]
    fn ok_response_grants_cors_for_a_same_token_fetch() {
        // The real gap this closes for the fetch-read step: a scripted
        // document at htmlview://tok123/doc.html fetching its own sibling
        // note.md — Origin is genuinely "htmlview://tok123", matching the
        // resource's own origin exactly.
        let req = get_request("tok123", "note.md", Some("htmlview://tok123"));
        let resp = build_ok_response(&req, Path::new("note.md"), b"# note".to_vec());
        assert_eq!(
            resp.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
            "htmlview://tok123"
        );
        assert_eq!(resp.headers().get(header::ACCESS_CONTROL_ALLOW_METHODS).unwrap(), "GET");
    }

    #[test]
    fn ok_response_grants_no_cors_for_a_cross_token_fetch() {
        // A different scripted document (token "other-tok") somehow fetching
        // tok123's resource: no grant, so its script can't read the body —
        // this is the isolation property per-open tokens exist for.
        let req = get_request("tok123", "note.md", Some("htmlview://other-tok"));
        let resp = build_ok_response(&req, Path::new("note.md"), b"# note".to_vec());
        assert!(resp.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
    }

    #[test]
    fn ok_response_grants_no_cors_for_the_app_origin() {
        let req = get_request("tok123", "note.md", Some("tauri://localhost"));
        let resp = build_ok_response(&req, Path::new("note.md"), b"# note".to_vec());
        assert!(resp.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
    }

    #[test]
    fn ok_response_carries_no_cors_header_when_request_has_none() {
        // A plain <img src="…">/<script src="…"> tag load never sends an
        // Origin header — not CORS-checked, so no header is needed.
        let req = get_request("tok123", "pic.png", None);
        let resp = build_ok_response(&req, Path::new("pic.png"), b"fake png".to_vec());
        assert!(resp.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
    }

    // --- preflight (OPTIONS) ---

    #[test]
    fn options_preflight_grants_cors_headers_for_a_same_token_origin() {
        let req = options_request("tok123", "note.md", "htmlview://tok123");
        let resp = build_preflight_response(&req);
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        assert!(resp.body().is_empty());
        assert_eq!(
            resp.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
            "htmlview://tok123"
        );
        assert_eq!(resp.headers().get(header::ACCESS_CONTROL_ALLOW_METHODS).unwrap(), "GET");
    }

    #[test]
    fn options_preflight_denies_a_cross_token_origin() {
        let req = options_request("tok123", "note.md", "htmlview://other-tok");
        let resp = build_preflight_response(&req);
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        assert!(
            resp.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none(),
            "a cross-token preflight must not be granted CORS headers"
        );
    }

    // --- token_and_rel_path ---

    #[test]
    fn token_and_rel_path_reads_the_host_as_token_on_the_native_scheme_form() {
        let req = get_request("abc123", "sub/doc.html", None);
        let (token, rel) = token_and_rel_path(&req).unwrap();
        assert_eq!(token, "abc123");
        assert_eq!(rel, PathBuf::from("sub/doc.html"));
    }

    #[test]
    fn token_and_rel_path_decodes_percent_encoded_segments() {
        let req = get_request("abc123", "my%20docs/doc.html", None);
        let (_, rel) = token_and_rel_path(&req).unwrap();
        assert_eq!(rel, PathBuf::from("my docs/doc.html"));
    }

    #[test]
    fn token_and_rel_path_falls_back_to_the_first_path_segment_on_windows_host_form() {
        let req = Request::builder()
            .method(Method::GET)
            .uri("http://htmlview.localhost/abc123/doc.html")
            .body(Vec::new())
            .unwrap();
        let (token, rel) = token_and_rel_path(&req).unwrap();
        assert_eq!(token, "abc123");
        assert_eq!(rel, PathBuf::from("doc.html"));
    }

    // --- token_and_rel_path -> resolve combined: percent-encoded traversal ---
    //
    // The existing traversal tests each lock one half of the defense in
    // isolation: `resolve_rejects_a_dot_dot_escape_through_the_token` hands a
    // *literal* `..` `PathBuf` straight to `resolve`, skipping the decode
    // step entirely, and `token_and_rel_path_decodes_percent_encoded_segments`
    // only checks the decode, never runs the result through `resolve`. A real
    // request never arrives as a literal `..` PathBuf — it arrives as bytes on
    // an incoming URI, and a real-app probe (`fetch("../note.md")`) showed the
    // browser's own URL parser collapses a *literal* `../` before the request
    // is even made, so that vector never reaches the handler at all. The vector
    // that *does* reach the handler is a `%2e%2e%2f`-style encoded traversal,
    // which survives URL normalization as an opaque path segment and only
    // becomes `..` after `decode_path_segment` runs inside the handler. These
    // tests close that gap: they drive a `get_request` with an encoded rel
    // path through `token_and_rel_path` *and then* `resolve`, exactly as
    // `handle_html_view_request` does, and assert the combination still
    // rejects. A sibling file that genuinely exists outside the armed root is
    // required for this to mean anything — a nonexistent target would return
    // `None` from `resolve` merely because `canonicalize` fails on a missing
    // path, which would pass even with the containment check deleted and so
    // would prove nothing about the defense actually being exercised.

    #[test]
    fn token_and_rel_path_then_resolve_rejects_percent_encoded_dot_dot_traversal() {
        let root = scratch_dir("state_encoded_dotdot");
        let sibling_secret = root.parent().unwrap().join(format!(
            "mermark_test_htmlview_{}_state_encoded_dotdot_secret.txt",
            std::process::id()
        ));
        fs::write(&sibling_secret, "outside").unwrap();
        let roots = HtmlViewRoots::default();
        let token = roots.arm(std::fs::canonicalize(&root).unwrap());

        let sibling_name = sibling_secret.file_name().unwrap().to_str().unwrap();
        let req = get_request(&token, &format!("%2e%2e%2f{sibling_name}"), None);
        let (req_token, rel) = token_and_rel_path(&req).expect("host carries the token");
        assert_eq!(req_token, token);
        assert_eq!(
            rel,
            PathBuf::from("..").join(sibling_name),
            "decode_path_segment must turn %2e%2e%2f into a literal .. component"
        );
        assert!(
            roots.resolve(&token, &rel).is_none(),
            "the decode -> join -> containment-check combination must still reject an \
             encoded traversal that resolves to a real file outside the armed root"
        );

        fs::remove_dir_all(&root).ok();
        fs::remove_file(&sibling_secret).ok();
    }

    #[test]
    fn token_and_rel_path_then_resolve_rejects_uppercase_and_mixed_case_encoded_traversal() {
        // Case shouldn't matter: whatever `urlencoding::decode` does with
        // `%2E`/`%2e`, the decoded result must still be caught by the same
        // containment check. Locks `%2E%2E%2F` (fully uppercase) and
        // `..%2f` (mixed literal-dot + encoded-slash) as two variants of the
        // same escape.
        let root = scratch_dir("state_encoded_dotdot_case");
        let sibling_secret = root.parent().unwrap().join(format!(
            "mermark_test_htmlview_{}_state_encoded_dotdot_case_secret.txt",
            std::process::id()
        ));
        fs::write(&sibling_secret, "outside").unwrap();
        let roots = HtmlViewRoots::default();
        let token = roots.arm(std::fs::canonicalize(&root).unwrap());
        let sibling_name = sibling_secret.file_name().unwrap().to_str().unwrap();

        for encoded_prefix in ["%2E%2E%2F", "..%2f"] {
            let req = get_request(&token, &format!("{encoded_prefix}{sibling_name}"), None);
            let (_, rel) = token_and_rel_path(&req).expect("host carries the token");
            assert!(
                roots.resolve(&token, &rel).is_none(),
                "encoded traversal variant {encoded_prefix:?} must be rejected regardless \
                 of the encoded segment's letter case"
            );
        }

        fs::remove_dir_all(&root).ok();
        fs::remove_file(&sibling_secret).ok();
    }

    // --- handle_html_view_request (end-to-end gates, without a live AppHandle) ---
    //
    // The full handler takes `&tauri::AppHandle`, which needs a running app to
    // construct — out of reach for a headless unit test. The gates it composes
    // (method check, `token_and_rel_path`, `HtmlViewRoots::resolve`,
    // `build_ok_response`'s CSP/CORS attachment, `forbidden_response`'s 403)
    // are each covered directly above; this is intentional: a thin command
    // wrapper over already-tested pure logic, mirroring the
    // `write_file`/`write_file_with_state` split in `commands.rs`.
}
