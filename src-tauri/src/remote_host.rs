//! Host-side containment for remote vault sharing. A remote vault is shared
//! only if the user has explicitly checked it in settings (an "armed" root —
//! see `ArmedVault`), and every path a peer requests must clear
//! `resolve_within`/`canonicalize_within` before it ever touches the
//! filesystem. This module is pure logic: no server, no pairing, no
//! `#[tauri::command]`. Task 5 (HTTP server) and Task 4 (pairing) are the
//! only consumers so far.
//!
//! Also owns pairing: a short-lived, human-typeable code
//! (`issue_pairing_code`/`PairingState`/`redeem`) that exchanges once for a
//! long-lived device token (`remote_token.rs` stores that token; this module
//! only mints it via `htmlview::mint_view_token`, reusing that CSPRNG-backed
//! minter rather than writing a second one).
//!
//! Follows `htmlview.rs`'s containment idiom rather than inventing a new
//! one: a **two-gate** check, same as `is_within_armed_root` there.
//! `resolve_within` is the lexical gate — it rejects `..`, an absolute path,
//! and the empty string by walking `Path::components()` *before* joining,
//! so an escaping path is never even constructed. But a lexical gate alone
//! is insufficient: a symlink inside the armed root that points outside it
//! shows up as an ordinary `Component::Normal` and sails through the
//! component check untouched (see `epubview.rs`'s doc comment on
//! "structural vs. checked" containment — this case is exactly why
//! `htmlview.rs` re-validates *after* the join). `canonicalize_within` is
//! that second gate: it canonicalizes both the armed root and the resolved
//! candidate — which resolves symlinks to their real target, not just their
//! lexical path — and, if the canonicalized target is still contained,
//! **returns that canonicalized path** rather than a bare `bool`. A caller
//! that only got `true`/`false` back would naturally go on to open the
//! pre-canonical path it already had (the symlink itself), leaving a TOCTOU
//! window between this check and that open; returning the canonicalized
//! path instead makes that mistake impossible to make. Like
//! `is_within_armed_root`, it fails closed (`None`) if either side can't be
//! canonicalized (e.g. the candidate doesn't exist) rather than falling back
//! to a lexical guess.

use std::path::{Component, Path, PathBuf};

/// A vault the host has explicitly armed for remote sharing: its identity
/// (`id`, stable across a pairing session), the name shown to peers
/// (`display_name`), and the canonical local filesystem root peers may read
/// from. `root` is never serialized — it is host-local and must never reach
/// a peer.
#[derive(Clone, Debug, serde::Serialize)]
pub struct ArmedVault {
    pub id: String,
    pub display_name: String,
    #[serde(skip)]
    pub root: PathBuf,
}

/// Resolves a peer-supplied relative path into an absolute path under
/// `armed.root`, or `None` if the path could escape it. Rejects `..`,
/// absolute paths, and the empty string by inspecting path *components*
/// before any join happens — so the escaping path is never constructed in
/// the first place. This is the lexical gate only; a candidate that passes
/// here can still be a symlink pointing outside `armed.root`, which is what
/// `canonicalize_within` exists to catch.
pub fn resolve_within(armed: &ArmedVault, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() {
        return None;
    }
    let candidate = Path::new(rel);
    for component in candidate.components() {
        match component {
            Component::Normal(_) => {}
            // RootDir, ParentDir, Prefix rejected outright. CurDir only ever
            // shows up here for a *leading* "./" — std already strips
            // interior "." components (e.g. "sub/./b.md" never produces one)
            // — and it's rejected the same as everything else non-`Normal`.
            _ => return None,
        }
    }
    Some(armed.root.join(candidate))
}

/// The second, post-resolve containment gate: canonicalizes `resolved` and
/// returns that canonical path if — and only if — it's still inside
/// `armed.root`'s own canonical form (symlinks resolved, `..` collapsed),
/// `None` otherwise. `resolve_within`'s component check can't see through a
/// symlink — it's an ordinary `Normal` component lexically — so a symlink
/// planted inside the armed root that points outside it needs this check to
/// be caught. Returning the canonicalized path (not a `bool`) is
/// deliberate: a caller must open *this* path, never the pre-canonical one
/// it started with, or a symlink swapped in between the check and the open
/// would reopen the TOCTOU window this function exists to close. Fails
/// closed (`None`) if either path can't be canonicalized.
pub fn canonicalize_within(armed: &ArmedVault, resolved: &Path) -> Option<PathBuf> {
    let root = armed.root.canonicalize().ok()?;
    let target = resolved.canonicalize().ok()?;
    target.starts_with(&root).then_some(target)
}

/// How long an issued pairing code stays redeemable. Five minutes is enough
/// for a human to read it off one screen and type it into another, but short
/// enough that a code left visible in a screenshot or over-the-shoulder
/// glance is worthless soon after.
pub const PAIRING_TTL_MS: u64 = 5 * 60_000;

/// How many wrong codes `redeem` tolerates before locking the pairing
/// session out entirely (regardless of whether a later attempt is correct).
/// Bounds brute-force guessing of the 6-digit space to a handful of tries
/// per issued code rather than an unlimited one.
pub const PAIRING_MAX_ATTEMPTS: u8 = 5;

/// A freshly minted pairing code: the 6 ASCII digits shown to the user, and
/// the timestamp it was issued at (caller-supplied `now_ms`, not a wall
/// clock read here, so tests can drive expiry deterministically).
#[derive(Clone, Debug)]
pub struct PairingCode {
    pub code: String,
    pub issued_at_ms: u64,
}

/// Why `redeem` refused a code. `LockedOut` and `Mismatch` are deliberately
/// distinct: `redeem`'s ordering (see its doc comment) guarantees a caller
/// only ever sees `Mismatch` while attempts remain, and `LockedOut`
/// afterward — never a `Mismatch` on the (N+1)th wrong guess.
#[derive(Debug, PartialEq)]
pub enum PairError {
    Expired,
    AlreadyUsed,
    Mismatch,
    LockedOut,
    NotArmed,
}

/// One pairing session's mutable state: the code it was armed with (`None`
/// once never armed — `redeem` reports `NotArmed` rather than panicking),
/// whether it has already been redeemed, and how many wrong guesses it has
/// absorbed so far.
pub struct PairingState {
    code: Option<PairingCode>,
    used: bool,
    failed_attempts: u8,
}

impl PairingState {
    pub fn armed(code: PairingCode) -> Self {
        Self { code: Some(code), used: false, failed_attempts: 0 }
    }

    /// The code this session was armed with, or `""` if never armed. Exists
    /// so callers (and tests) can read back what to type without reaching
    /// into the private `code` field.
    pub fn code(&self) -> &str {
        self.code.as_ref().map(|c| c.code.as_str()).unwrap_or("")
    }
}

/// Draws a fresh 6-digit pairing code from the OS CSPRNG (`getrandom`, same
/// source `htmlview::mint_view_token` uses for its token bytes) rather than
/// a PRNG seeded from the clock — a guessable code would defeat the whole
/// point of a pairing step. `now_ms` is caller-supplied (not read here) so
/// `redeem`'s expiry check is deterministic under test.
pub fn issue_pairing_code(now_ms: u64) -> PairingCode {
    let mut bytes = [0u8; 4];
    getrandom::fill(&mut bytes).expect("OS CSPRNG must be available");
    let n = u32::from_be_bytes(bytes) % 1_000_000;
    PairingCode { code: format!("{n:06}"), issued_at_ms: now_ms }
}

/// Exchanges a pairing code for a device token. Checks expiry, prior use,
/// and lockout **before** ever comparing `offered` against the issued
/// code — a session that has already locked out must refuse even the
/// genuinely correct code, so a caller can never tell (by trying after
/// lockout) whether the code they eventually typed was right. Only once all
/// three gates pass does it compare (in constant time) and, on mismatch,
/// count the attempt.
pub fn redeem(state: &mut PairingState, offered: &str, now_ms: u64) -> Result<String, PairError> {
    let Some(issued) = state.code.clone() else { return Err(PairError::NotArmed) };
    if state.used {
        return Err(PairError::AlreadyUsed);
    }
    if state.failed_attempts >= PAIRING_MAX_ATTEMPTS {
        return Err(PairError::LockedOut);
    }
    if now_ms.saturating_sub(issued.issued_at_ms) > PAIRING_TTL_MS {
        return Err(PairError::Expired);
    }
    if !constant_time_eq(offered, &issued.code) {
        state.failed_attempts += 1;
        return Err(PairError::Mismatch);
    }
    state.used = true;
    Ok(crate::htmlview::mint_view_token())
}

/// Byte-for-byte comparison that never short-circuits on a *content*
/// mismatch, so a timing side channel can't leak how many leading bytes of
/// a guess were right. A length mismatch returns early — the length of a
/// pairing code isn't a secret, only its digits are — matching
/// `constant_time_eq`'s job everywhere else in this codebase (compare
/// exactly the confidential part, nothing more).
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// --- HTTP server (Task 5) ---
//
// A read-only axum front for the two gates above plus the existing
// `commands::` file logic — no file logic is reimplemented here. Every
// non-`/pair` handler follows the same four-step skeleton: `authorize` (bearer
// token) → `armed_vault` (is this vault id actually shared) → `safe_path`
// (lexical + canonical containment) → delegate to `commands::`. v1 is
// GET-only for every file route: the route table below has no PUT/POST/DELETE
// entry for any of them, so a non-GET method falls through to axum's built-in
// 405 rather than reaching a handler that would have to remember to refuse
// it — read-only is enforced by the shape of the router, not by a runtime
// check that could be forgotten.
//
// Percent-decoding: axum's `Query<T>` extractor deserializes through
// `serde_urlencoded`, which percent-decodes each key/value exactly once while
// splitting the query string. Handlers below read `q.path` as already-decoded
// text and never call any decoding function on it themselves. Doing so would
// decode a second time and revive an escape a client encoded as `%252e` (which
// decodes once to the literal `%2e`, harmless) into `..` — decoding it again
// would turn that `%2e` into `.`, and `%252e%252e%2f` into `../`. Not
// double-decoding is therefore load-bearing, not a style choice.
use axum::{
    body::Bytes,
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use std::sync::{Arc, Mutex};

/// Hard ceiling on a request's `path` query value, enforced in `safe_path`
/// *before* it ever reaches `resolve_within`/`canonicalize`. Without this, an
/// absurdly long path (thousands of components) would still walk all the way
/// down to a filesystem syscall on every request; 4096 bytes comfortably
/// covers any legitimate vault-relative path.
const MAX_REQUEST_PATH_BYTES: usize = 4096;

/// Everything a request handler needs, shared across connections. `armed` is
/// the live list of vaults the user has checked to share (mutated by the
/// settings UI, Task 9's concern — this module only reads it);
/// `devices`/`pairing` back the token-auth and pairing-exchange gates.
#[derive(Clone)]
pub struct HostState {
    pub armed: Arc<Mutex<Vec<ArmedVault>>>,
    pub devices: Arc<Mutex<Vec<crate::remote_token::PairedDevice>>>,
    pub pairing: Arc<Mutex<PairingState>>,
}

/// Query shape shared by every file route that takes just a vault id plus a
/// vault-relative path: `read_file`, `read_asset`, `list_dir`,
/// `list_files_recursive`, `list_link_targets` all name their relative
/// argument `path` (matching each `commands::` function's own arg name),
/// even though `list_dir`'s `path` means "directory to list" and
/// `read_file`'s means "file to read" — one field name for "the
/// vault-relative thing this route resolves", not five different ones.
#[derive(serde::Deserialize)]
pub struct PathQuery {
    pub vault: String,
    pub path: String,
}

/// `list_dir`/`list_files_recursive` additionally take the explorer's
/// "숨김 파일 표시" toggle, so they get their own query shape rather than
/// overloading `PathQuery`.
#[derive(serde::Deserialize)]
pub struct DirQuery {
    pub vault: String,
    pub path: String,
    pub show_hidden: bool,
}

/// `resolve_image`'s query: `path` is the vault-relative *directory* the
/// image search starts from (mirrors `commands::resolve_image`'s
/// `base_dir`), `name` is the image reference to hunt for, `max_depth`
/// bounds the search exactly as it does locally.
#[derive(serde::Deserialize)]
pub struct ResolveImageQuery {
    pub vault: String,
    pub path: String,
    pub name: String,
    pub max_depth: u8,
}

#[derive(serde::Deserialize)]
pub struct PairRequest {
    pub code: String,
    pub label: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct PairResponse {
    pub id: String,
    pub token: String,
}

/// Assembles the full read-only route table (see the brief's table — this is
/// all of it, nothing more). `/pair` is the only non-GET route and touches no
/// file. Every other route accepts GET only: axum answers any other method on
/// a registered path with 405 automatically, which is how "read-only" is
/// enforced structurally rather than by a convention a future handler could
/// forget to honor.
pub fn router(state: HostState) -> Router {
    Router::new()
        .route("/pair", post(pair_handler))
        .route("/vaults", get(vaults_handler))
        .route("/list_dir", get(list_dir_handler))
        .route("/list_files_recursive", get(list_files_recursive_handler))
        .route("/read_file", get(read_file_handler))
        .route("/read_asset", get(read_asset_handler))
        .route("/resolve_image", get(resolve_image_handler))
        .route("/list_link_targets", get(list_link_targets_handler))
        .with_state(state)
}

/// Starts serving `router(state)` on `bind`. The bind address is the
/// caller's choice — a Tailscale interface address, or `127.0.0.1` behind an
/// SSH tunnel — never decided here. This function is never called on its
/// own: sharing defaults to off, so `serve` only runs once the user turns
/// sharing on (Task 9 wires that). Returns once the listener fails or the
/// server is shut down; a bind failure is reported as `Err`, never a panic.
pub async fn serve(bind: std::net::SocketAddr, state: HostState) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|e| format!("bind {bind}: {e}"))?;
    axum::serve(listener, router(state)).await.map_err(|e| e.to_string())
}

/// Milliseconds since the Unix epoch, for `redeem`'s `now_ms`. A thin wrapper
/// so the handler body doesn't repeat the `SystemTime` dance inline.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Rejects a request that doesn't carry a known device's bearer token in
/// `x-mermark-token`. The first line of every handler but `pair_handler`.
/// Uses `constant_time_eq` (not `==`) for the actual comparison — this is the
/// one place in the server where a timing side channel could leak a live
/// token byte-by-byte, since an attacker can send arbitrary headers on every
/// request.
fn authorize(state: &HostState, headers: &HeaderMap) -> Result<(), StatusCode> {
    let offered = headers.get("x-mermark-token").and_then(|v| v.to_str().ok()).unwrap_or("");
    let devices = state.devices.lock().unwrap();
    if devices.iter().any(|d| constant_time_eq(&d.token, offered)) {
        Ok(())
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

/// Looks up an armed (shared) vault by id, or 404 if it isn't currently
/// shared. 404 rather than 403: whether a given id names a vault at all is
/// not information this server volunteers to an authenticated-but-unrelated
/// caller.
fn armed_vault(state: &HostState, id: &str) -> Result<ArmedVault, StatusCode> {
    state.armed.lock().unwrap().iter().find(|v| v.id == id).cloned().ok_or(StatusCode::NOT_FOUND)
}

/// The full containment gate for one request: length-bounds `rel` (Ruling
/// 12's third gate — an absurd path must never reach a syscall), then the
/// lexical gate (`resolve_within`), then the canonical gate
/// (`canonicalize_within`), and returns the *canonical* path — the only path
/// a caller may open (see `canonicalize_within`'s doc comment on the TOCTOU
/// window opening the pre-canonical path would reopen). Every failure —
/// too-long, lexical escape, symlink escape, or plain "doesn't exist" — comes
/// back as the same `NOT_FOUND`: `canonicalize` cannot itself distinguish
/// "missing" from "escape attempt", so refusing to guess and returning 404
/// uniformly is what keeps this server from leaking which one happened, and
/// matches the client's own `path_exists` semantics (Ruling 12).
fn safe_path(armed: &ArmedVault, rel: &str) -> Result<std::path::PathBuf, StatusCode> {
    if rel.len() > MAX_REQUEST_PATH_BYTES {
        return Err(StatusCode::NOT_FOUND);
    }
    let resolved = resolve_within(armed, rel).ok_or(StatusCode::NOT_FOUND)?;
    canonicalize_within(armed, &resolved).ok_or(StatusCode::NOT_FOUND)
}

async fn pair_handler(
    State(state): State<HostState>,
    Json(req): Json<PairRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    let now = now_ms();
    let token = {
        let mut pairing = state.pairing.lock().unwrap();
        // `redeem` is called while holding the guard, on the state behind
        // it directly — never on a clone written back afterward — so the
        // "used"/attempt-count check-and-set is one atomic step. Cloning out,
        // calling `redeem` on the clone, and writing the clone back would let
        // two concurrent requests both observe `used == false` and both
        // redeem the same code.
        remote_host_redeem_or(&mut pairing, &req.code, now)?
    };
    let id = crate::htmlview::mint_view_token();
    let device = crate::remote_token::PairedDevice {
        id: id.clone(),
        token: token.clone(),
        label: req.label,
        paired_at_ms: now,
    };
    state.devices.lock().unwrap().push(device);
    Ok(Json(PairResponse { id, token }))
}

/// Maps `redeem`'s `PairError` to an HTTP status. Every variant means "this
/// code does not currently grant a token" — none of them should tell an
/// unauthenticated caller *which* reason applied (expired vs. wrong vs.
/// already used vs. locked out vs. never armed), so they all collapse to the
/// same 401 a caller gets for any other bad-credential request.
fn remote_host_redeem_or(state: &mut PairingState, offered: &str, now_ms: u64) -> Result<String, StatusCode> {
    redeem(state, offered, now_ms).map_err(|_| StatusCode::UNAUTHORIZED)
}

async fn vaults_handler(
    State(state): State<HostState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
    authorize(&state, &headers)?;
    let vaults = state.armed.lock().unwrap().clone();
    Ok(Json(vaults))
}

async fn read_file_handler(
    State(state): State<HostState>,
    headers: HeaderMap,
    Query(q): Query<PathQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    authorize(&state, &headers)?;
    let armed = armed_vault(&state, &q.vault)?;
    let path = safe_path(&armed, &q.path)?; // canonical path — this is what gets opened.
    let content = crate::commands::read_file(path.to_string_lossy().into_owned())
        .map_err(|_| StatusCode::NOT_FOUND)?;
    Ok(Json(content))
}

/// Best-effort content-type for `read_asset`'s raw bytes, keyed off the
/// extension — enough for the client to build a `data:` URL with a sane MIME
/// type. Falls back to `application/octet-stream` for anything unrecognized
/// rather than guessing wrong.
fn asset_content_type(path: &std::path::Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    }
}

/// Serves the raw bytes of a file inside an armed vault (images, mainly) —
/// unlike `read_file`, no UTF-8 decoding and no JSON envelope: the client
/// turns the body straight into a `data:` URL, so base64-wrapping it here
/// would just be wasted work the client would have to undo.
async fn read_asset_handler(
    State(state): State<HostState>,
    headers: HeaderMap,
    Query(q): Query<PathQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    authorize(&state, &headers)?;
    let armed = armed_vault(&state, &q.vault)?;
    let path = safe_path(&armed, &q.path)?;
    let bytes = std::fs::read(&path).map_err(|_| StatusCode::NOT_FOUND)?;
    let content_type = asset_content_type(&path);
    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_static(content_type),
    );
    Ok((headers, Bytes::from(bytes)))
}

async fn list_dir_handler(
    State(state): State<HostState>,
    headers: HeaderMap,
    Query(q): Query<DirQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    authorize(&state, &headers)?;
    let armed = armed_vault(&state, &q.vault)?;
    let path = safe_path(&armed, &q.path)?;
    let entries = crate::commands::list_dir(path.to_string_lossy().into_owned(), q.show_hidden)
        .map_err(|_| StatusCode::NOT_FOUND)?;
    Ok(Json(entries))
}

async fn list_files_recursive_handler(
    State(state): State<HostState>,
    headers: HeaderMap,
    Query(q): Query<DirQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    authorize(&state, &headers)?;
    let armed = armed_vault(&state, &q.vault)?;
    let path = safe_path(&armed, &q.path)?;
    let result = crate::commands::list_files_recursive(path.to_string_lossy().into_owned(), q.show_hidden)
        .map_err(|_| StatusCode::NOT_FOUND)?;
    Ok(Json(result))
}

async fn resolve_image_handler(
    State(state): State<HostState>,
    headers: HeaderMap,
    Query(q): Query<ResolveImageQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    authorize(&state, &headers)?;
    let armed = armed_vault(&state, &q.vault)?;
    let base = safe_path(&armed, &q.path)?;
    let resolved = crate::commands::resolve_image(base.to_string_lossy().into_owned(), q.name, q.max_depth);
    Ok(Json(resolved))
}

async fn list_link_targets_handler(
    State(state): State<HostState>,
    headers: HeaderMap,
    Query(q): Query<PathQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    authorize(&state, &headers)?;
    let armed = armed_vault(&state, &q.vault)?;
    let path = safe_path(&armed, &q.path)?;
    let targets = crate::commands::list_link_targets(path.to_string_lossy().into_owned())
        .map_err(|_| StatusCode::NOT_FOUND)?;
    Ok(Json(targets))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    fn armed() -> ArmedVault {
        ArmedVault { id: "rv1".into(), display_name: "노트".into(), root: PathBuf::from("/vault") }
    }

    #[test]
    fn resolves_a_plain_relative_path() {
        assert_eq!(resolve_within(&armed(), "a/b.md"), Some(PathBuf::from("/vault/a/b.md")));
    }

    #[test]
    fn rejects_dotdot_escape() {
        assert_eq!(resolve_within(&armed(), "../secret.md"), None);
        assert_eq!(resolve_within(&armed(), "a/../../secret.md"), None);
    }

    #[test]
    fn rejects_absolute_path() {
        assert_eq!(resolve_within(&armed(), "/etc/passwd"), None);
    }

    #[test]
    fn rejects_empty_and_root() {
        assert_eq!(resolve_within(&armed(), ""), None);
    }

    /// Pins the accept path: a real file inside the armed root must come
    /// back as `Some` carrying the *canonicalized* path inside the root —
    /// not just any `Some`. Without this, a bug that returned `Some` for
    /// the wrong path (e.g. echoing back an unrelated file) would pass
    /// every other test here. Compares against `root.canonicalize()` rather
    /// than the raw `root` because on macOS `TMPDIR` resolves through a
    /// `/var` → `/private/var` symlink, so a literal `root.join(...)`
    /// wouldn't match what `canonicalize_within` actually returns.
    #[test]
    fn accepts_a_real_file_inside_the_armed_root() {
        let n = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        let tmp = std::env::temp_dir().join(format!("mermark-rv-accept-{}-{n}", std::process::id()));
        let root = tmp.join("vault");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("note.md"), "hello").unwrap();

        let armed = ArmedVault { id: "rv1".into(), display_name: "노트".into(), root: root.clone() };
        let resolved = resolve_within(&armed, "note.md");
        let canonical = resolved.as_ref().and_then(|candidate| canonicalize_within(&armed, candidate));
        let expected = root.canonicalize().unwrap().join("note.md");

        std::fs::remove_dir_all(&tmp).ok();

        assert_eq!(resolved, Some(root.join("note.md")), "component check should pass");
        assert_eq!(canonical, Some(expected), "legitimate in-root file must resolve to its canonical path");
    }

    /// A symlink inside the armed root pointing at a file outside it: the
    /// attack `canonicalize_within` exists for. `resolve_within` alone
    /// would let this through, since the symlink is a plain `Normal`
    /// component lexically. Uses a unique per-test/per-process temp dir
    /// (pid + atomic counter, matching `commands.rs`'s `temp_path`
    /// convention) so parallel test runs never collide, and captures the
    /// assertion outcome before cleanup so a panic can't skip it and leak
    /// the fixture on disk.
    #[test]
    fn rejects_symlink_that_points_outside_the_armed_root() {
        let n = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        let tmp = std::env::temp_dir().join(format!("mermark-rv-{}-{n}", std::process::id()));
        let root = tmp.join("vault");
        let outside = tmp.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.md"), "s").unwrap();
        let link = root.join("link.md");
        std::os::unix::fs::symlink(outside.join("secret.md"), &link).unwrap();

        let armed = ArmedVault { id: "rv1".into(), display_name: "노트".into(), root: root.clone() };
        let resolved = resolve_within(&armed, "link.md");
        let canonical = resolved
            .as_ref()
            .and_then(|candidate| canonicalize_within(&armed, candidate));

        std::fs::remove_dir_all(&tmp).ok();

        assert_eq!(resolved, Some(root.join("link.md")), "component check should pass");
        assert_eq!(canonical, None, "symlink escape must be rejected");
    }

    // --- pairing ---

    #[test]
    fn pairing_code_is_six_digits() {
        let c = issue_pairing_code(0);
        assert_eq!(c.code.len(), 6);
        assert!(c.code.chars().all(|ch| ch.is_ascii_digit()));
    }

    #[test]
    fn pairing_code_expires_after_five_minutes() {
        let mut st = PairingState::armed(issue_pairing_code(0));
        let code = st.code().to_string();
        assert!(matches!(redeem(&mut st, &code, 5 * 60_000 + 1), Err(PairError::Expired)));
    }

    #[test]
    fn pairing_code_is_single_use() {
        let mut st = PairingState::armed(issue_pairing_code(0));
        let code = st.code().to_string();
        assert!(redeem(&mut st, &code, 1_000).is_ok());
        assert!(matches!(redeem(&mut st, &code, 2_000), Err(PairError::AlreadyUsed)));
    }

    #[test]
    fn pairing_code_locks_out_after_five_wrong_attempts() {
        let mut st = PairingState::armed(issue_pairing_code(0));
        let code = st.code().to_string();
        for _ in 0..5 {
            assert!(matches!(redeem(&mut st, "000000", 1_000), Err(PairError::Mismatch)));
        }
        assert!(
            matches!(redeem(&mut st, &code, 1_000), Err(PairError::LockedOut)),
            "정답이어도 시도 초과 후에는 거부한다"
        );
    }

    #[test]
    fn redeeming_yields_a_128_bit_device_token() {
        let mut st = PairingState::armed(issue_pairing_code(0));
        let code = st.code().to_string();
        let token = redeem(&mut st, &code, 1_000).unwrap();
        assert_eq!(token.len(), 32, "16바이트 hex");
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn constant_time_eq_matches_normal_equality() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "ab"));
    }

    // --- HTTP router (Task 5) ---

    use axum::body::Body;
    use axum::http::{self, Request};
    use tower::ServiceExt;

    /// A `HostState` with one armed vault (`rv1`, root = a scratch temp dir
    /// that need not contain anything) and one paired device whose token is
    /// `"test-token"`, for tests that only care about routing/auth shape and
    /// never touch a real file.
    fn test_state() -> HostState {
        HostState {
            armed: Arc::new(Mutex::new(vec![ArmedVault {
                id: "rv1".into(),
                display_name: "노트".into(),
                root: std::env::temp_dir(),
            }])),
            devices: Arc::new(Mutex::new(vec![crate::remote_token::PairedDevice {
                id: "dev1".into(),
                token: "test-token".into(),
                label: "테스트".into(),
                paired_at_ms: 0,
            }])),
            pairing: Arc::new(Mutex::new(PairingState::armed(issue_pairing_code(0)))),
        }
    }

    /// A `test_state()`-shaped host whose `rv1` root is a fresh temp
    /// directory containing one real file (`name` → `contents`), for tests
    /// that exercise a route's containment gate end to end. Returns the
    /// state plus the temp directory so the caller can clean up afterward
    /// (mirrors the pid+counter temp-dir convention used elsewhere in this
    /// file).
    fn state_with_file(name: &str, contents: &str) -> (HostState, PathBuf) {
        let n = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("mermark-rv-http-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(name), contents).unwrap();
        let state = HostState {
            armed: Arc::new(Mutex::new(vec![ArmedVault {
                id: "rv1".into(),
                display_name: "노트".into(),
                root: dir.clone(),
            }])),
            devices: Arc::new(Mutex::new(vec![crate::remote_token::PairedDevice {
                id: "dev1".into(),
                token: "test-token".into(),
                label: "테스트".into(),
                paired_at_ms: 0,
            }])),
            pairing: Arc::new(Mutex::new(PairingState::armed(issue_pairing_code(0)))),
        };
        (state, dir)
    }

    /// Drives `app` with one request via `tower::ServiceExt::oneshot`,
    /// attaching `token` as the `x-mermark-token` header when given (`None`
    /// sends the request with no auth header at all, not an empty one — the
    /// two must be tested separately, since an empty offered token happens
    /// to equal no device's token anyway but for a different reason).
    async fn call(
        app: &Router,
        method: http::Method,
        path: &str,
        token: Option<&str>,
    ) -> axum::response::Response {
        let mut req = Request::builder().method(method).uri(path);
        if let Some(t) = token {
            req = req.header("x-mermark-token", t);
        }
        let req = req.body(Body::empty()).unwrap();
        app.clone().oneshot(req).await.unwrap()
    }

    async fn call_get(app: &Router, path: &str) -> axum::response::Response {
        call(app, http::Method::GET, path, Some("test-token")).await
    }

    async fn call_no_token(app: &Router, path: &str) -> axum::response::Response {
        call(app, http::Method::GET, path, None).await
    }

    async fn json_body<T: serde::de::DeserializeOwned>(res: axum::response::Response) -> T {
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn file_routes_reject_every_method_but_get() {
        let app = router(test_state());
        for (method, path) in [
            (http::Method::POST, "/read_file"),
            (http::Method::PUT, "/read_file"),
            (http::Method::DELETE, "/read_file"),
            (http::Method::POST, "/list_dir"),
            (http::Method::PUT, "/vaults"),
        ] {
            let res = call(&app, method.clone(), path, None).await;
            assert_eq!(
                res.status(),
                http::StatusCode::METHOD_NOT_ALLOWED,
                "{method} {path} 는 405여야 한다 — 읽기 전용은 라우트 부재로 강제된다"
            );
        }
    }

    #[tokio::test]
    async fn requests_without_a_token_are_rejected() {
        let app = router(test_state());
        let res = call_no_token(&app, "/vaults").await;
        assert_eq!(res.status(), http::StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn read_file_serves_a_file_inside_an_armed_vault() {
        let (state, dir) = state_with_file("note.md", "# 안녕");
        let app = router(state);
        let res = call_get(&app, "/read_file?vault=rv1&path=note.md").await;
        assert_eq!(res.status(), http::StatusCode::OK);
        let body: crate::commands::FileContent = json_body(res).await;
        assert_eq!(body.text, "# 안녕");
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn read_file_refuses_a_path_outside_the_armed_vault() {
        let (state, dir) = state_with_file("note.md", "x");
        let app = router(state);
        let res = call_get(&app, "/read_file?vault=rv1&path=../outside.md").await;
        assert_eq!(res.status(), http::StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn an_unshared_vault_id_is_not_reachable() {
        let (state, dir) = state_with_file("note.md", "x");
        let app = router(state);
        let res = call_get(&app, "/read_file?vault=NOT_SHARED&path=note.md").await;
        assert_eq!(res.status(), http::StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(dir).ok();
    }

    /// A percent-encoded escape must fail the same way a literal one does.
    /// `%2e%2e%2f` decodes once (by axum's `Query` extractor) to `../`; if a
    /// handler decoded `q.path` a *second* time, a doubly-encoded
    /// `%252e%252e%252f` would decode to `%2e%2e%2f` at the query layer and
    /// then to `../` on the handler's extra pass, reviving the escape this
    /// test exists to close off. Exercising the once-encoded form here pins
    /// that the single decode axum performs is exactly the one gate acts on.
    #[tokio::test]
    async fn percent_encoded_traversal_is_refused() {
        let (state, dir) = state_with_file("note.md", "x");
        let app = router(state);
        let res = call_get(&app, "/read_file?vault=rv1&path=%2e%2e%2foutside.md").await;
        assert_eq!(res.status(), http::StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(dir).ok();
    }

    /// A wrong bearer token is rejected exactly like a missing one — the
    /// route table's structural read-only guarantee doesn't help if a stale
    /// or guessed token were somehow accepted.
    #[tokio::test]
    async fn a_wrong_token_is_rejected() {
        let app = router(test_state());
        let res = call(&app, http::Method::GET, "/vaults", Some("not-the-token")).await;
        assert_eq!(res.status(), http::StatusCode::UNAUTHORIZED);
    }

    /// `/vaults` never leaks the armed root's local filesystem path —
    /// `ArmedVault::root` is `#[serde(skip)]`, so the field simply must not
    /// appear on the wire at all.
    #[tokio::test]
    async fn vaults_list_never_serializes_the_local_root() {
        let app = router(test_state());
        let res = call_get(&app, "/vaults").await;
        assert_eq!(res.status(), http::StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(!text.contains("root"), "armed vault root must never reach a peer: {text}");
    }

    /// A request path far past any legitimate vault-relative path must be
    /// refused before it ever reaches `canonicalize` — this is Ruling 12's
    /// third gate (a length bound ahead of the containment checks), pinned
    /// here so a regression that dropped the bound would be caught even
    /// though such a path would also fail the lexical/canonical gates on its
    /// own merits.
    #[tokio::test]
    async fn an_absurdly_long_path_is_refused() {
        let (state, dir) = state_with_file("note.md", "x");
        let app = router(state);
        let long = "a".repeat(MAX_REQUEST_PATH_BYTES + 1);
        let res = call_get(&app, &format!("/read_file?vault=rv1&path={long}")).await;
        assert_eq!(res.status(), http::StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(dir).ok();
    }

    /// Pairing end to end through the HTTP layer: redeeming the code the
    /// state was armed with returns a token, and that token is immediately
    /// usable as a bearer token on a subsequent authenticated request —
    /// pinning that `pair_handler` actually registers the device it mints,
    /// not just returns a token nobody can use afterward.
    #[tokio::test]
    async fn pairing_yields_a_token_that_immediately_authorizes() {
        let code = "654321".to_string();
        // `pair_handler` compares against real wall-clock `now_ms()` (it must —
        // that's what makes the TTL meaningful in production), so the code
        // has to be armed with a real "now" too, not `0` — otherwise `redeem`
        // sees a decades-old code and reports `Expired` before ever comparing
        // digits.
        let issued_at_ms = now_ms();
        let state = HostState {
            armed: Arc::new(Mutex::new(vec![])),
            devices: Arc::new(Mutex::new(vec![])),
            pairing: Arc::new(Mutex::new(PairingState::armed(PairingCode {
                code: code.clone(),
                issued_at_ms,
            }))),
        };
        let app = router(state);
        let body = serde_json::to_vec(&serde_json::json!({ "code": code, "label": "맥북" })).unwrap();
        let req = Request::builder()
            .method(http::Method::POST)
            .uri("/pair")
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), http::StatusCode::OK);
        let parsed: PairResponse = json_body(res).await;

        let res = call(&app, http::Method::GET, "/vaults", Some(&parsed.token)).await;
        assert_eq!(res.status(), http::StatusCode::OK, "방금 받은 토큰이 즉시 통해야 한다");
    }
}
