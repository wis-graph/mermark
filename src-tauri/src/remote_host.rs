//! Host-side containment for remote vault sharing. A remote vault is shared
//! only if the user has explicitly checked it in settings (an "armed" root —
//! see `ArmedVault`), and every path a peer requests must clear
//! `resolve_within`/`canonicalize_within` before it ever touches the
//! filesystem. This module owns the pure containment logic, the pairing
//! state machine, and the axum HTTP server — but no `#[tauri::command]`
//! itself. `remote_share.rs` (Task 9) is the module that turns this into a
//! host control surface: it owns `RemoteShareState`, starts/stops the
//! server via `bind`/`run` below, and is what the settings UI actually
//! talks to over IPC.
//!
//! Also owns pairing: a short-lived, human-typeable code
//! (`issue_pairing_code`/`PairingState`/`redeem`) that exchanges once for a
//! long-lived device token (`remote_token.rs` stores that token; this module
//! only mints it via `crypto_token::mint_view_token`, reusing that CSPRNG-backed
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

    /// The initial state before any pairing code has ever been issued —
    /// `redeem` reports `NotArmed` for it, same as it would for any other
    /// session whose `code` is `None`. This is what `RemoteShareState`
    /// constructs at startup. `remote_share_stop` does NOT itself call this
    /// (an earlier version of this comment claimed it did) — it only tears
    /// the server down; a still-armed pairing code left in the `Arc<Mutex<_>>`
    /// after a stop is inert, since no `/pair` handler is reachable to
    /// redeem it once the listener is gone, and `remote_share_start` re-arms
    /// with a fresh code the next time sharing turns back on regardless.
    pub fn unarmed() -> Self {
        Self { code: None, used: false, failed_attempts: 0 }
    }

    /// The code this session was armed with, or `""` if never armed. Exists
    /// so callers (and tests) can read back what to type without reaching
    /// into the private `code` field.
    pub fn code(&self) -> &str {
        self.code.as_ref().map(|c| c.code.as_str()).unwrap_or("")
    }
}

/// Draws a fresh 6-digit pairing code from the OS CSPRNG (`getrandom`, same
/// source `crypto_token::mint_view_token` uses for its token bytes) rather than
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
    Ok(crate::crypto_token::mint_view_token())
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
// `fs::` file logic — no file logic is reimplemented here. Every
// non-`/pair` handler follows the same four-step skeleton: `authorize` (bearer
// token) → `armed_vault` (is this vault id actually shared) → `safe_path`
// (lexical + canonical containment) → delegate to `fs::`. v1 is
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
use std::io::Read as _;
use std::sync::{Arc, Mutex};

/// Hard ceiling on a request's `path` query value, enforced in `safe_path`
/// *before* it ever reaches `resolve_within`/`canonicalize`. Without this, an
/// absurdly long path (thousands of components) would still walk all the way
/// down to a filesystem syscall on every request; 4096 bytes comfortably
/// covers any legitimate vault-relative path.
const MAX_REQUEST_PATH_BYTES: usize = 4096;

/// What `/list_dir` and `/list_files_recursive` pass to `fs::` in
/// place of the peer's own `show_hidden` query value — always `false`,
/// unconditionally. Decided deliberately, not left as an oversight:
/// `safe_path`'s hidden/artifact gate (see its doc comment) means the host
/// can never actually *serve* a path with a hidden component anyway — a peer
/// asking `show_hidden=true` for `.git/config` still 404s at `safe_path`
/// regardless of what this constant says. So the only thing a peer's
/// `show_hidden=true` could still do, if it were honored, is make a
/// listing's *entries* name hidden siblings the peer can never actually
/// open (`.git`, `.obsidian`, `.DS_Store`, ...) — at best a misleading
/// listing (dead entries that 404 the moment they're clicked), at worst a
/// gratuitous disclosure of the host's dotfile layout to an authenticated
/// peer who has no way to read what's named. Neither outcome is worth
/// honoring, so a remote listing always behaves as if `show_hidden=false`,
/// full stop — the field survives on `DirQuery` only because the wire shape
/// is shared with the local `list_dir`/`list_files_recursive` commands, not
/// because the host route reads it.
const IGNORE_PEER_SHOW_HIDDEN: bool = false;

/// Everything a request handler needs, shared across connections. `armed` is
/// the live list of vaults the user has checked to share (mutated by
/// `remote_share_start`, Task 9's host control surface — this module only
/// reads it here); `devices`/`pairing` back the token-auth and
/// pairing-exchange gates. `config_dir` is the app's config directory,
/// carried on `HostState` itself (not looked up separately by each handler)
/// so `pair_handler` and revocation can persist the device list via
/// `remote_token::save` without threading an extra parameter through every
/// call site — see `persist_new_device`'s doc comment for why persisting at
/// all is the point of this field's existence.
#[derive(Clone)]
pub struct HostState {
    pub armed: Arc<Mutex<Vec<ArmedVault>>>,
    pub devices: Arc<Mutex<Vec<crate::remote_token::PairedDevice>>>,
    pub pairing: Arc<Mutex<PairingState>>,
    pub config_dir: PathBuf,
}

/// Query shape shared by every file route that takes just a vault id plus a
/// vault-relative path: `read_file`, `read_asset`, `list_dir`,
/// `list_files_recursive`, `list_link_targets` all name their relative
/// argument `path` (matching each `fs::` function's own arg name),
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
/// overloading `PathQuery`. `show_hidden` is accepted on the wire (kept for
/// shape-parity with the local `list_dir`/`list_files_recursive` commands)
/// but never actually honored by the corresponding handlers — see
/// `IGNORE_PEER_SHOW_HIDDEN`. `Option<bool>` (not `bool`) so the field is
/// optional: axum's `Query` extractor (serde_urlencoded) already ignores any
/// *extra* key a client sends that isn't in this struct, so a required
/// `bool` bought no leniency there — it only made *omitting* the key a 400,
/// which is the opposite of what a field the handlers never read should
/// cost a client.
#[derive(serde::Deserialize)]
pub struct DirQuery {
    pub vault: String,
    pub path: String,
    // Deliberately unread by the handlers — see `IGNORE_PEER_SHOW_HIDDEN`.
    // Kept as a field (not dropped from the wire shape) so a client that
    // still sends it isn't rejected by strict query deserialization.
    #[allow(dead_code)]
    pub show_hidden: Option<bool>,
}

/// `resolve_image`'s query: `path` is the vault-relative *directory* the
/// image search starts from (mirrors `fs::image_resolve::resolve_image`'s
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
/// The GET file routes as a data table rather than a chain of `.route()`
/// calls — this is the *single* place that names them, and `router()` and
/// the `no_route_response_leaks_the_armed_root_absolute_path` test both
/// build off it. axum 0.7 has no public API to enumerate a `Router`'s
/// registered paths after the fact (only the boolean `has_routes()`), so
/// this table is what stands in for that: a test that wants "every file
/// route" iterates this instead of hand-copying the path list, so a route
/// added here is automatically covered there too.
fn get_routes() -> Vec<(&'static str, axum::routing::MethodRouter<HostState>)> {
    vec![
        ("/vaults", get(vaults_handler)),
        ("/list_dir", get(list_dir_handler)),
        ("/list_files_recursive", get(list_files_recursive_handler)),
        ("/read_file", get(read_file_handler)),
        ("/read_asset", get(read_asset_handler)),
        ("/resolve_image", get(resolve_image_handler)),
        ("/list_link_targets", get(list_link_targets_handler)),
    ]
}

pub fn router(state: HostState) -> Router {
    let mut router = Router::new().route("/pair", post(pair_handler));
    for (path, method_router) in get_routes() {
        router = router.route(path, method_router);
    }
    router.with_state(state)
}

/// Binds `addr`, mapping any failure (port already in use, or — for a
/// Tailscale bind mode — the interface not being up) to a human-readable
/// `Err` rather than a panic. Split out from `run` so `remote_share_start`
/// (the host control surface, `remote_share.rs`) can `.await` this alone and
/// observe a bind failure synchronously, *before* ever spawning the task
/// that runs the server loop — a failure that only surfaced inside a
/// detached background task would have nowhere to report back to.
pub async fn bind(addr: std::net::SocketAddr) -> Result<tokio::net::TcpListener, String> {
    tokio::net::TcpListener::bind(addr).await.map_err(|e| format!("bind {addr}: {e}"))
}

/// Runs `router(state)` on an already-bound `listener` until `shutdown`
/// fires. `with_graceful_shutdown` is what makes `remote_share_stop` able to
/// actually free the port: axum stops accepting new connections and this
/// future resolves (dropping `listener`, closing the fd) as soon as
/// `shutdown` resolves, instead of running forever with no way to ask it to
/// quit. A bind failure can't happen here — `listener` is already bound by
/// the caller (`bind`, above) — so the only `Err` this returns is a genuine
/// server-loop I/O failure.
pub async fn run(
    listener: tokio::net::TcpListener,
    state: HostState,
    shutdown: tokio::sync::oneshot::Receiver<()>,
) -> Result<(), String> {
    axum::serve(listener, router(state))
        .with_graceful_shutdown(async {
            let _ = shutdown.await;
        })
        .await
        .map_err(|e| e.to_string())
}

/// Convenience "serve forever" wrapper (`bind` then `run` with a shutdown
/// signal that never fires) for a caller with no need to ever stop the
/// server — currently only this module's own tests. The host control
/// surface (`remote_share.rs`) does not use this: it needs `bind`+`run`
/// split so `remote_share_stop` can actually shut the server down, which
/// this convenience form has no way to do.
#[allow(dead_code)]
pub async fn serve(bind_addr: std::net::SocketAddr, state: HostState) -> Result<(), String> {
    let listener = bind(bind_addr).await?;
    let (never_send, shutdown) = tokio::sync::oneshot::channel();
    // Leaked deliberately: dropping the sender resolves `shutdown`
    // immediately (a closed sender is itself observed as "fire" by the
    // receiver), which would make this "serve forever" wrapper return right
    // after binding instead of actually running until an external stop.
    std::mem::forget(never_send);
    run(listener, state, shutdown).await
}

/// Milliseconds since the Unix epoch, for `redeem`'s `now_ms`. A thin wrapper
/// so the handler body doesn't repeat the `SystemTime` dance inline.
/// `pub(crate)` so `remote_share.rs`'s `remote_issue_code` command can stamp
/// a freshly issued code with the same clock `pair_handler` checks it
/// against, rather than reading `SystemTime` a second, independent way.
pub(crate) fn now_ms() -> u64 {
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
/// (`canonicalize_within`), then the hidden/artifact gate
/// (`has_a_hidden_or_artifact_component`) — checked against the *canonical*
/// resolved path's vault-relative form, not the raw `rel` a client sent, so a
/// non-hidden-looking symlink that resolves inside a hidden directory (or a
/// hidden artifact) is caught the same as a request that names the hidden
/// segment directly. Returns the *canonical* path — the only path a caller
/// may open (see `canonicalize_within`'s doc comment on the TOCTOU window
/// opening the pre-canonical path would reopen).
///
/// This is the single chokepoint every file route goes through — a prior
/// round wired the hidden/artifact check into `/read_asset` only, which left
/// every other route (`/read_file` among them) able to serve
/// `.git/config` — routinely credential-bearing — just by asking for it
/// directly. Putting the check here instead means a future route can't
/// forget it: it comes for free the moment a handler calls `safe_path`,
/// exactly like the escape gates already did. See
/// `every_get_route_with_a_path_param_refuses_a_hidden_path_component` for
/// the regression test that walks `get_routes()` so a fifth route added
/// without thought fails loudly rather than silently reintroducing the gap.
///
/// Every failure — too-long, lexical escape, symlink escape, hidden/artifact,
/// or plain "doesn't exist" — comes back as the same `NOT_FOUND`:
/// `canonicalize` cannot itself distinguish "missing" from "escape attempt",
/// so refusing to guess and returning 404 uniformly is what keeps this server
/// from leaking which one happened, and matches the client's own
/// `path_exists` semantics (Ruling 12).
///
/// An empty `rel` means "the vault root itself" — a freshly paired client's
/// very first `/list_dir` has nothing to name yet but the top level, so the
/// root has to be an addressable target. `resolve_within` itself still
/// rejects `""` unconditionally (that rejection is load-bearing elsewhere:
/// relaxing it there would also have to touch the same code path `..` and
/// absolute paths go through), so the root case is handled here, before
/// `resolve_within` ever sees it, by canonicalizing `armed.root` directly.
/// The vault root itself is never itself a hidden/artifact path, so the
/// hidden-gate check on the empty-`rel` branch is a cheap no-op, not a
/// special case.
fn safe_path(armed: &ArmedVault, rel: &str) -> Result<std::path::PathBuf, StatusCode> {
    if rel.len() > MAX_REQUEST_PATH_BYTES {
        return Err(StatusCode::NOT_FOUND);
    }
    let root = armed_root_canonical(armed)?;
    let resolved = if rel.is_empty() {
        root.clone()
    } else {
        let candidate = resolve_within(armed, rel).ok_or(StatusCode::NOT_FOUND)?;
        canonicalize_within(armed, &candidate).ok_or(StatusCode::NOT_FOUND)?
    };
    if has_a_hidden_or_artifact_component(&vault_relative(&root, &resolved.to_string_lossy())) {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok(resolved)
}

/// The armed vault's own root, canonicalized. Every path field a response
/// body carries is expressed relative to *this* (via `vault_relative`),
/// never as an absolute filesystem path: an absolute path would both leak
/// the host's local layout — the exact leak `ArmedVault.root`'s
/// `#[serde(skip)]` and `vaults_list_never_serializes_the_local_root` exist
/// to prevent, just via a different route — and be useless to the client,
/// since feeding an absolute path back into a query hits `resolve_within`'s
/// `RootDir` rejection and 404s. Fails the same way `safe_path` does (404)
/// if the root itself can't be canonicalized.
fn armed_root_canonical(armed: &ArmedVault) -> Result<std::path::PathBuf, StatusCode> {
    armed.root.canonicalize().map_err(|_| StatusCode::NOT_FOUND)
}

/// Rewrites an absolute filesystem path known to live under `root` into the
/// vault-relative form every response must carry instead — forward-slash
/// joined so the shape is consistent regardless of the host's OS. The root
/// itself maps to `""`, matching `safe_path`'s "empty means root" convention
/// so a client can round-trip a returned path straight back into another
/// request's `path` query param. Falls back to just the file name if `abs`
/// doesn't actually start with `root` (shouldn't happen — every path this is
/// called on comes from a walk rooted at `root` — but a fallback that can't
/// itself leak the host root is safer than passing an absolute path through
/// unguarded).
fn vault_relative(root: &Path, abs: &str) -> String {
    let abs_path = Path::new(abs);
    match abs_path.strip_prefix(root) {
        Ok(rel) => rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/"),
        Err(_) => abs_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
    }
}

/// Ceiling on `/pair`'s `label` field. Unlike every other request field,
/// `label` is never validated against a fixed vocabulary — it's a
/// human-chosen device name ("맥북", "iPad") — but with no bound at all, a
/// caller who has redeemed a valid pairing code (a real, if narrow,
/// capability) could still hand the host a multi-megabyte string that gets
/// persisted to disk via `persist_new_device` and rendered verbatim in the
/// host's own paired-devices settings UI on every future load. 256 bytes
/// comfortably covers any real device name (`docs/design/remote-vault.md`'s
/// own examples are a handful of characters) while ruling out that abuse.
const MAX_PAIR_LABEL_BYTES: usize = 256;

async fn pair_handler(
    State(state): State<HostState>,
    Json(req): Json<PairRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    if req.label.len() > MAX_PAIR_LABEL_BYTES {
        return Err(StatusCode::BAD_REQUEST);
    }
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
    let id = crate::crypto_token::mint_view_token();
    let device = crate::remote_token::PairedDevice {
        id: id.clone(),
        token: token.clone(),
        label: req.label,
        paired_at_ms: now,
    };
    // Must be durable before this handler answers 200: if the process is
    // killed or crashes right after, the client has already persisted the
    // token (`ClientTokens::remember`) and will offer it on every future
    // request. Without this the host would have no memory of the device at
    // all after a restart, and every one of that client's requests would
    // 401 forever — the exact bug this task exists to fix (see module doc).
    persist_new_device(&state, device)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(PairResponse { id, token }))
}

/// Disk-first device registration: builds the post-insert device list,
/// persists *that* via `remote_token::save`, and only pushes into the live
/// `devices` list once the write to disk has actually succeeded. Mirrors
/// `ClientTokens::remember`'s ordering (see that doc comment) for the same
/// reason: memory must never run ahead of what's durable, or a failed write
/// (full disk, read-only volume, permissions) would leave this process
/// believing a device is paired that a restart would silently forget.
/// Holds a **single** lock acquisition across clone → save → write-back —
/// this is load-bearing, not stylistic. An earlier version of both
/// `persist_new_device` and `revoke_and_persist` took the lock twice (once
/// to clone, again to write back), which let a `/pair` and an IPC revoke
/// interleave: a revoke's write-back could land, then a `/pair` already
/// holding a clone taken *before* the revoke would overwrite it, silently
/// resurrecting the just-revoked device with a token that once again
/// authorizes reads. Revocation is the one operation a user performs
/// specifically to cut off access, so a lost update there is worse than
/// either operation simply blocking on the other — which is exactly what
/// holding the guard for the whole sequence guarantees: the second caller's
/// `state.devices.lock()` doesn't even return until the first has finished
/// writing both disk and memory, so it always clones the post-first-write
/// state. `mutate` runs under that single guard and reports whether it
/// actually changed `candidate` (`bool`, not the `Option` an earlier version
/// of this comment claimed — there is no "new contents" to hand back,
/// `mutate` edits `candidate` in place): `true` persists the mutated list to
/// disk and swaps it into `*devices`; `false` ("nothing changed" — the
/// no-op-revoke case) skips both, since there is nothing to make durable.
/// `persist_new_device` and `revoke_and_persist` are both thin callers of
/// this function now — see their doc comments — rather than each
/// re-implementing the same clone/save/write-back sequence, which is what
/// let them drift apart (one single-lock, one still double-locking) in the
/// first place.
fn persist_devices_atomically(
    state: &HostState,
    mutate: impl FnOnce(&mut Vec<crate::remote_token::PairedDevice>) -> bool,
) -> Result<bool, String> {
    let mut devices = state.devices.lock().unwrap();
    let mut candidate = devices.clone();
    if !mutate(&mut candidate) {
        return Ok(false);
    }
    crate::remote_token::save(&state.config_dir, &candidate)?;
    *devices = candidate;
    Ok(true)
}

/// Disk-first device registration: builds the post-insert device list,
/// persists *that* via `remote_token::save`, and only replaces the live
/// `devices` list once the write to disk has actually succeeded — mirrors
/// `ClientTokens::remember`'s ordering (see that doc comment) for the same
/// reason: memory must never run ahead of what's durable, or a failed write
/// (full disk, read-only volume, permissions) would leave this process
/// believing a device is paired that a restart would silently forget. See
/// `persist_devices_atomically`'s doc comment for why the whole
/// clone/save/write-back sequence runs under one lock acquisition, not two.
/// A fresh pairing always changes the list (a push can never be a no-op), so
/// the `mutate` closure here always reports `true`.
pub(crate) fn persist_new_device(
    state: &HostState,
    device: crate::remote_token::PairedDevice,
) -> Result<(), String> {
    persist_devices_atomically(state, |candidate| {
        candidate.push(device);
        true
    })
    .map(|_| ())
}

/// Disk-first device revocation, the mirror image of `persist_new_device` —
/// and, since this fix, a direct caller of `persist_devices_atomically`
/// rather than a hand-duplicated copy of its body (the duplication is what
/// let this function keep the two-lock-acquisition shape after
/// `persist_new_device` was fixed to hold one — the exact drift the shared
/// helper now makes structurally impossible). Returns whether a device was
/// actually removed, same as `remote_token::revoke`, so a caller revoking an
/// already-gone id can tell the two cases apart; `remote_token::revoke`'s own
/// return value is exactly the `bool` `persist_devices_atomically` expects
/// back from `mutate`, so "did anything change" and "should this persist"
/// are the same question here. When the id doesn't match anything there is
/// nothing to persist, so this is a pure no-op rather than a needless disk
/// write — checked *inside* the same locked section
/// `persist_devices_atomically` holds, not before it, so a concurrent pair
/// can't sneak the id back in between the check and the lock.
pub(crate) fn revoke_and_persist(state: &HostState, id: &str) -> Result<bool, String> {
    persist_devices_atomically(state, |candidate| crate::remote_token::revoke(candidate, id))
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

/// Ceiling on `/read_file`'s response body, mirroring `read_asset_handler`'s
/// `MAX_ASSET_BYTES` precedent for the same reason: without a cap, a request
/// for a multi-gigabyte file inside the vault would be read wholesale into
/// RAM — and, since this route has no concurrency limit of its own, eight
/// simultaneous requests for one such file would allocate eight times that
/// before `read_file_bounded`'s UTF-8 check even had a chance to reject it.
/// 20 MiB matches `MAX_ASSET_BYTES` — no real markdown note approaches this,
/// while a deliberately or accidentally huge file is refused before most of
/// it is ever read.
const MAX_READ_FILE_BYTES: u64 = 20 * 1024 * 1024;

async fn read_file_handler(
    State(state): State<HostState>,
    headers: HeaderMap,
    Query(q): Query<PathQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    authorize(&state, &headers)?;
    let armed = armed_vault(&state, &q.vault)?;
    let path = safe_path(&armed, &q.path)?; // canonical path — this is what gets opened.
    // `read_file_bounded` does synchronous filesystem I/O (open + metadata +
    // read) — run on a blocking thread rather than inline in this async
    // handler, or a slow/huge read would stall Tokio's shared worker
    // threads, and with them every other in-flight request on this host —
    // including the host's OWN editor, which runs its local Tauri commands
    // on the same runtime. `read_asset_handler`'s own synchronous read is a
    // pre-existing instance of this same shape, already bounded by
    // `MAX_ASSET_BYTES`; this handler is the one the reviewer flagged
    // because, before this fix, it had no bound at all (see
    // `MAX_READ_FILE_BYTES`'s doc comment).
    let content = tokio::task::spawn_blocking(move || read_file_bounded(&path))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)? // the blocking task itself panicked
        .map_err(|_| StatusCode::NOT_FOUND)?;
    Ok(Json(content))
}

/// The actual read behind `read_file_handler`, split out so it can run
/// inside `spawn_blocking` as a plain synchronous function. Deliberately
/// does not call `fs::file_io::read_file` (which has no size bound at all —
/// see this task's finding): opens the file once, checks its metadata length
/// against `MAX_READ_FILE_BYTES` *before* reading any of it (same ordering
/// `read_asset_handler` uses for `MAX_ASSET_BYTES`), then reads through that
/// same handle so the size check and the bytes read can never refer to two
/// different underlying files. Reuses `fs::file_io::mtime_ms` for the mtime
/// field rather than re-deriving it, so this and the local `read_file`
/// command agree on exactly what "the file's mtime" means. A single opaque
/// `()` error is enough here — `read_file_handler` maps every failure to the
/// same `NOT_FOUND` `safe_path` already uses for "this request does not
/// resolve to servable content", so the specific reason (missing, too big,
/// not UTF-8, a directory) is not something the caller needs distinguished.
fn read_file_bounded(path: &std::path::Path) -> Result<crate::fs::file_io::FileContent, ()> {
    let mut file = std::fs::File::open(path).map_err(|_| ())?;
    let meta = file.metadata().map_err(|_| ())?;
    if meta.is_dir() || meta.len() > MAX_READ_FILE_BYTES {
        return Err(());
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.by_ref().take(MAX_READ_FILE_BYTES).read_to_end(&mut bytes).map_err(|_| ())?;
    let text = String::from_utf8(bytes).map_err(|_| ())?;
    let mtime = crate::fs::file_io::mtime_ms(&path.to_string_lossy());
    Ok(crate::fs::file_io::FileContent { text, mtime })
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

/// Ceiling on `/read_asset`'s response body. This route has no chunked or
/// range support, so the whole file is buffered into memory (`std::fs::read`)
/// once per request regardless of size — without a cap, a multi-gigabyte
/// file inside the vault would be read wholesale into RAM on every request a
/// client (or an attacker with a valid token) cares to send. 20 MiB is well
/// above any legitimate vault attachment (photos, screenshots) but far below
/// "read a video/archive into memory"; mirrors the network-facing size-gate
/// precedent `epubview.rs`'s `MAX_EPUB_ENTRY_BYTES` (8 MiB) sets for zip-bomb
/// defense, sized up because photos routinely run larger than a zip entry.
const MAX_ASSET_BYTES: u64 = 20 * 1024 * 1024;

/// Whether any component of a vault-relative path (not just the final file
/// name) is a hidden dotfile/dir or a mermark scratch artifact. The final
/// component alone is not enough: `.git/config`'s last component is
/// `"config"` (not hidden), but the file is inside a hidden `.git`
/// directory and must be excluded just the same — `.git/config` routinely
/// carries credential-bearing remote URLs, which must never leave the host.
/// Reuses `fs::listing::is_hidden_entry`/`is_mermark_artifact` (the SSOT
/// `list_dir` itself applies) rather than re-deriving the rule, just applied
/// to every path segment instead of one. This is `safe_path`'s hidden/
/// artifact gate — see its doc comment for why every file route goes
/// through it there rather than each route re-checking on its own.
fn has_a_hidden_or_artifact_component(vault_relative_path: &str) -> bool {
    Path::new(vault_relative_path).components().any(|c| {
        let name = c.as_os_str().to_string_lossy();
        crate::fs::listing::is_hidden_entry(&name) || crate::fs::listing::is_mermark_artifact(&name)
    })
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
    // `safe_path` itself now rejects a hidden/artifact path — the previous
    // per-route re-check that used to live here (and only here) is gone;
    // see `safe_path`'s doc comment for why the chokepoint moved.
    let path = safe_path(&armed, &q.path)?;
    // Single open handle for the metadata check and the read below — two
    // separate syscalls against the *path* (`fs::metadata` then `fs::read`)
    // would leave a window where a host-local write between them could
    // still land more than `MAX_ASSET_BYTES` on the wire, or swap the
    // target entirely. Opening once and asking that same handle for its
    // metadata makes the size check and the bytes read refer to the exact
    // same file, no matter what happens to the path afterward.
    let mut file = std::fs::File::open(&path).map_err(|_| StatusCode::NOT_FOUND)?;
    let meta = file.metadata().map_err(|_| StatusCode::NOT_FOUND)?;
    if meta.is_dir() {
        return Err(StatusCode::NOT_FOUND);
    }
    if meta.len() > MAX_ASSET_BYTES {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    // `.take(MAX_ASSET_BYTES)` is belt-and-suspenders on top of the metadata
    // check just above (same handle, so it can't have grown since): it
    // guarantees the buffer can never exceed the ceiling even if a future
    // edit removed that check.
    file.by_ref().take(MAX_ASSET_BYTES).read_to_end(&mut bytes).map_err(|_| StatusCode::NOT_FOUND)?;
    let content_type = asset_content_type(&path);
    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_static(content_type),
    );
    // The body is untrusted user file content; without this, a browser-based
    // client could be tricked into sniffing e.g. an ".svg" that starts with
    // `<script>`-looking bytes as HTML instead of the declared image type.
    headers.insert(axum::http::header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
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
    let root = armed_root_canonical(&armed)?;
    // `q.show_hidden` is deliberately never forwarded to `fs::listing::list_dir`
    // — see `IGNORE_PEER_SHOW_HIDDEN`'s doc comment for why a peer's request
    // to see hidden entries is refused rather than honored.
    let mut entries = crate::fs::listing::list_dir(path.to_string_lossy().into_owned(), IGNORE_PEER_SHOW_HIDDEN)
        .map_err(|_| StatusCode::NOT_FOUND)?;
    // `fs::listing::list_dir` returns the host's absolute filesystem paths —
    // correct for the local explorer, but here they'd both leak the armed
    // root and be unusable by the client (an absolute path fed back into a
    // query 404s at `resolve_within`'s `RootDir` rejection). Rewrite every
    // entry to the vault-relative form before it ever reaches `Json`.
    for entry in &mut entries {
        entry.path = vault_relative(&root, &entry.path);
    }
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
    let root = armed_root_canonical(&armed)?;
    // Same reasoning as `list_dir_handler`: `q.show_hidden` is never honored
    // here either — see `IGNORE_PEER_SHOW_HIDDEN`.
    let mut result =
        crate::fs::listing::list_files_recursive(path.to_string_lossy().into_owned(), IGNORE_PEER_SHOW_HIDDEN)
            .map_err(|_| StatusCode::NOT_FOUND)?;
    // Same rewrite as `list_dir_handler`, same reason: `FileHit.path` comes
    // back absolute from `fs::listing::list_files_recursive`.
    for hit in &mut result.files {
        hit.path = vault_relative(&root, &hit.path);
    }
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
    let root = armed_root_canonical(&armed)?;
    let resolved = crate::fs::image_resolve::resolve_image(base.to_string_lossy().into_owned(), q.name, q.max_depth)
        .map(|abs| vault_relative(&root, &abs));
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
    let targets = crate::fs::link_targets::list_link_targets(path.to_string_lossy().into_owned())
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
    /// A fresh scratch directory for a `HostState.config_dir` in tests that
    /// don't care about its contents (most routing/auth tests never write
    /// to it) — pid+counter-unique, matching this file's existing temp-dir
    /// convention, so parallel test runs never collide even if a future
    /// test does start writing device persistence into it.
    fn scratch_config_dir() -> PathBuf {
        let n = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("mermark-rv-config-{}-{n}", std::process::id()))
    }

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
            config_dir: scratch_config_dir(),
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
            config_dir: scratch_config_dir(),
        };
        (state, dir)
    }

    /// Like `state_with_file`, but for tests that must prove an escape path
    /// is *actually* blocked, not merely 404 because nothing happens to sit
    /// there. `root` (`tmp/vault`) holds `in_vault` and `tmp` itself (the
    /// armed root's *parent* — exactly where a `../`-relative escape lands)
    /// holds `outside`. Without a real file at the escape target, a test
    /// asserting 404 for `path=../outside.md` can't tell "the containment
    /// gate correctly rejected this" apart from "there was never anything to
    /// find" — both look identical from the response alone, so a broken gate
    /// and a working one would pass the same assertion. Planting a real,
    /// distinctively-named file at the escape target closes that gap: if a
    /// future regression let the escape through, the response would carry
    /// `outside`'s content instead of 404.
    fn state_with_escape_target(
        in_vault: (&str, &str),
        outside: (&str, &str),
    ) -> (HostState, PathBuf) {
        let n = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        let tmp = std::env::temp_dir().join(format!("mermark-rv-escape-{}-{n}", std::process::id()));
        let root = tmp.join("vault");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(in_vault.0), in_vault.1).unwrap();
        std::fs::write(tmp.join(outside.0), outside.1).unwrap();
        let state = HostState {
            armed: Arc::new(Mutex::new(vec![ArmedVault {
                id: "rv1".into(),
                display_name: "노트".into(),
                root: root.clone(),
            }])),
            devices: Arc::new(Mutex::new(vec![crate::remote_token::PairedDevice {
                id: "dev1".into(),
                token: "test-token".into(),
                label: "테스트".into(),
                paired_at_ms: 0,
            }])),
            pairing: Arc::new(Mutex::new(PairingState::armed(issue_pairing_code(0)))),
            config_dir: scratch_config_dir(),
        };
        (state, tmp)
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

    /// Iterates `get_routes()` — the same SSOT table `router()` builds from
    /// — rather than a hand-picked subset, so a route added there without a
    /// case here is covered automatically instead of silently going
    /// unchecked. A previous version of this test named only 3 of the then-7
    /// GET routes (`/read_file`, `/list_dir`, `/vaults`); the other 4
    /// (`/read_asset`, `/list_files_recursive`, `/resolve_image`,
    /// `/list_link_targets`) had never actually been exercised against a
    /// non-GET method at all.
    #[tokio::test]
    async fn file_routes_reject_every_method_but_get() {
        let app = router(test_state());
        for (path, _) in get_routes() {
            for method in [http::Method::POST, http::Method::PUT, http::Method::DELETE] {
                let res = call(&app, method.clone(), path, None).await;
                assert_eq!(
                    res.status(),
                    http::StatusCode::METHOD_NOT_ALLOWED,
                    "{method} {path} 는 405여야 한다 — 읽기 전용은 라우트 부재로 강제된다"
                );
            }
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
        let body: crate::fs::file_io::FileContent = json_body(res).await;
        assert_eq!(body.text, "# 안녕");
        std::fs::remove_dir_all(dir).ok();
    }

    /// A real, distinctively-named file sits at the escape target — see
    /// `state_with_escape_target`'s doc comment for why a merely-nonexistent
    /// target would leave this test unable to tell a working gate apart from
    /// a broken one.
    #[tokio::test]
    async fn read_file_refuses_a_path_outside_the_armed_vault() {
        let (state, tmp) = state_with_escape_target(("note.md", "x"), ("outside.md", "SECRET"));
        let app = router(state);
        let res = call_get(&app, "/read_file?vault=rv1&path=../outside.md").await;
        assert_eq!(res.status(), http::StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(tmp).ok();
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
        let (state, tmp) = state_with_escape_target(("note.md", "x"), ("outside.md", "SECRET"));
        let app = router(state);
        let res = call_get(&app, "/read_file?vault=rv1&path=%2e%2e%2foutside.md").await;
        assert_eq!(res.status(), http::StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(tmp).ok();
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
        let config_dir = scratch_config_dir();
        let state = HostState {
            armed: Arc::new(Mutex::new(vec![])),
            devices: Arc::new(Mutex::new(vec![])),
            pairing: Arc::new(Mutex::new(PairingState::armed(PairingCode {
                code: code.clone(),
                issued_at_ms,
            }))),
            config_dir: config_dir.clone(),
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
        std::fs::remove_dir_all(&config_dir).ok();
    }

    /// The bug this task exists to fix, pinned directly: pairing must
    /// persist the new device to disk, not just push it into the in-memory
    /// list — a fresh `remote_token::load` of the same `config_dir` after
    /// pairing must see it too, exactly as a restarted host process would.
    #[tokio::test]
    async fn pair_persists_the_new_device_to_disk() {
        let code = "111222".to_string();
        let issued_at_ms = now_ms();
        let config_dir = scratch_config_dir();
        let state = HostState {
            armed: Arc::new(Mutex::new(vec![])),
            devices: Arc::new(Mutex::new(vec![])),
            pairing: Arc::new(Mutex::new(PairingState::armed(PairingCode {
                code: code.clone(),
                issued_at_ms,
            }))),
            config_dir: config_dir.clone(),
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

        let on_disk = crate::remote_token::load(&config_dir).unwrap();
        assert_eq!(on_disk.len(), 1, "페어링된 기기가 디스크에 저장돼야 한다");
        assert_eq!(on_disk[0].id, parsed.id);
        assert_eq!(on_disk[0].token, parsed.token);
        assert_eq!(on_disk[0].label, "맥북");
        std::fs::remove_dir_all(&config_dir).ok();
    }

    /// A caller who has redeemed a genuinely valid pairing code (a real, if
    /// narrow, capability) must still be refused an oversized `label` — see
    /// `MAX_PAIR_LABEL_BYTES`'s doc comment for the abuse this closes
    /// (persisted to disk, rendered verbatim in the host's settings UI).
    /// Refused *before* `redeem` is ever called, so an oversized label can't
    /// burn one of the pairing code's limited attempts either.
    #[tokio::test]
    async fn pair_refuses_an_oversized_label() {
        let code = "333444".to_string();
        let issued_at_ms = now_ms();
        let config_dir = scratch_config_dir();
        let state = HostState {
            armed: Arc::new(Mutex::new(vec![])),
            devices: Arc::new(Mutex::new(vec![])),
            pairing: Arc::new(Mutex::new(PairingState::armed(PairingCode { code: code.clone(), issued_at_ms }))),
            config_dir: config_dir.clone(),
        };
        let app = router(state);
        let oversized_label = "a".repeat(MAX_PAIR_LABEL_BYTES + 1);
        let body = serde_json::to_vec(&serde_json::json!({ "code": code, "label": oversized_label })).unwrap();
        let req = Request::builder()
            .method(http::Method::POST)
            .uri("/pair")
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), http::StatusCode::BAD_REQUEST);
        assert!(
            crate::remote_token::load(&config_dir).unwrap().is_empty(),
            "거부된 페어링은 기기를 등록하면 안 된다"
        );
        std::fs::remove_dir_all(&config_dir).ok();
    }

    /// Pins `persist_new_device`'s disk-first ordering directly: when the
    /// write to `config_dir` fails, the in-memory device list must be left
    /// exactly as it was, not silently ahead of what's durable — mirrors
    /// `remote_token.rs`'s `remember_leaves_memory_untouched_when_persist_fails`.
    #[cfg(unix)]
    #[test]
    fn persist_new_device_leaves_memory_untouched_when_persist_fails() {
        use std::os::unix::fs::PermissionsExt;
        let config_dir = scratch_config_dir();
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::set_permissions(&config_dir, std::fs::Permissions::from_mode(0o500)).unwrap();

        let state = HostState {
            armed: Arc::new(Mutex::new(vec![])),
            devices: Arc::new(Mutex::new(vec![])),
            pairing: Arc::new(Mutex::new(PairingState::unarmed())),
            config_dir: config_dir.clone(),
        };
        let device = crate::remote_token::PairedDevice {
            id: "dev1".into(),
            token: "tok".into(),
            label: "맥북".into(),
            paired_at_ms: 0,
        };
        let result = persist_new_device(&state, device);

        std::fs::set_permissions(&config_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err(), "쓰기 실패는 Err로 보고돼야 한다");
        assert!(state.devices.lock().unwrap().is_empty(), "디스크 쓰기가 실패하면 메모리도 갱신되지 않아야 한다");
        std::fs::remove_dir_all(&config_dir).ok();
    }

    /// `revoke_and_persist`'s happy path: an existing device is removed from
    /// memory and the removal survives a fresh `remote_token::load`.
    #[test]
    fn revoke_and_persist_removes_the_device_and_persists_it() {
        let config_dir = scratch_config_dir();
        let devices = vec![
            crate::remote_token::PairedDevice { id: "dev1".into(), token: "aa".into(), label: "맥북".into(), paired_at_ms: 1 },
            crate::remote_token::PairedDevice { id: "dev2".into(), token: "bb".into(), label: "폰".into(), paired_at_ms: 2 },
        ];
        crate::remote_token::save(&config_dir, &devices).unwrap();
        let state = HostState {
            armed: Arc::new(Mutex::new(vec![])),
            devices: Arc::new(Mutex::new(devices)),
            pairing: Arc::new(Mutex::new(PairingState::unarmed())),
            config_dir: config_dir.clone(),
        };

        let removed = revoke_and_persist(&state, "dev1").unwrap();
        assert!(removed);
        assert_eq!(state.devices.lock().unwrap().len(), 1);

        let on_disk = crate::remote_token::load(&config_dir).unwrap();
        assert_eq!(on_disk.len(), 1, "철회가 디스크에도 반영돼야 한다");
        assert_eq!(on_disk[0].id, "dev2");
        std::fs::remove_dir_all(&config_dir).ok();
    }

    /// Revoking an id that doesn't exist is a no-op, not an error — and
    /// must not touch the disk (nothing changed, nothing to persist).
    #[test]
    fn revoke_and_persist_is_a_noop_for_an_unknown_id() {
        let config_dir = scratch_config_dir();
        let state = HostState {
            armed: Arc::new(Mutex::new(vec![])),
            devices: Arc::new(Mutex::new(vec![crate::remote_token::PairedDevice {
                id: "dev1".into(),
                token: "aa".into(),
                label: "맥북".into(),
                paired_at_ms: 1,
            }])),
            pairing: Arc::new(Mutex::new(PairingState::unarmed())),
            config_dir: config_dir.clone(),
        };
        let removed = revoke_and_persist(&state, "zz").unwrap();
        assert!(!removed);
        assert_eq!(state.devices.lock().unwrap().len(), 1);
        assert!(!crate::remote_token::store_path(&config_dir).exists(), "변경이 없으면 디스크에 쓰지 않는다");
    }

    /// Fix round 1, Finding 1: a revoke followed by a pair must never
    /// resurrect the revoked device. Before `persist_devices_atomically`,
    /// each function acquired the `devices` lock twice (once to clone, once
    /// to write back) — sequentially calling `revoke_and_persist` then
    /// `persist_new_device` still exercises that exact clone→save→write-back
    /// shape end to end, so a regression back to the two-acquisition version
    /// would still corrupt this (a stale-enough in-process cache from a
    /// wider refactor could reintroduce the window even without literal
    /// concurrency). The stronger, genuinely concurrent version of this
    /// guarantee is `concurrent_revoke_and_pair_never_resurrects_the_revoked_device`
    /// below.
    #[test]
    fn revoke_then_pair_does_not_resurrect_the_revoked_device() {
        let config_dir = scratch_config_dir();
        let devices = vec![crate::remote_token::PairedDevice {
            id: "dev1".into(),
            token: "aa".into(),
            label: "맥북".into(),
            paired_at_ms: 1,
        }];
        crate::remote_token::save(&config_dir, &devices).unwrap();
        let state = HostState {
            armed: Arc::new(Mutex::new(vec![])),
            devices: Arc::new(Mutex::new(devices)),
            pairing: Arc::new(Mutex::new(PairingState::unarmed())),
            config_dir: config_dir.clone(),
        };

        assert!(revoke_and_persist(&state, "dev1").unwrap());
        persist_new_device(
            &state,
            crate::remote_token::PairedDevice {
                id: "dev2".into(),
                token: "bb".into(),
                label: "폰".into(),
                paired_at_ms: 2,
            },
        )
        .unwrap();

        let on_disk = crate::remote_token::load(&config_dir).unwrap();
        assert_eq!(on_disk.len(), 1, "revoke된 dev1이 되살아나면 안 된다: {on_disk:?}");
        assert_eq!(on_disk[0].id, "dev2");
        std::fs::remove_dir_all(&config_dir).ok();
    }

    /// The real concurrency version: a revoke and a fresh pair racing on
    /// real OS threads must never let the revoked device reappear, and
    /// memory/disk must agree once both finish. This is the scenario the
    /// two-lock-acquisition bug (fixed by `persist_devices_atomically`)
    /// could actually produce — whichever thread's `.lock()` call lands
    /// second must observe the first's completed write, not a stale clone
    /// taken before it.
    #[test]
    fn concurrent_revoke_and_pair_never_resurrects_the_revoked_device() {
        let config_dir = scratch_config_dir();
        let initial = vec![crate::remote_token::PairedDevice {
            id: "dev1".into(),
            token: "aa".into(),
            label: "맥북".into(),
            paired_at_ms: 1,
        }];
        crate::remote_token::save(&config_dir, &initial).unwrap();
        let state = HostState {
            armed: Arc::new(Mutex::new(vec![])),
            devices: Arc::new(Mutex::new(initial)),
            pairing: Arc::new(Mutex::new(PairingState::unarmed())),
            config_dir: config_dir.clone(),
        };

        let revoker_state = state.clone();
        let revoker = std::thread::spawn(move || revoke_and_persist(&revoker_state, "dev1"));
        let pairer_state = state.clone();
        let pairer = std::thread::spawn(move || {
            persist_new_device(
                &pairer_state,
                crate::remote_token::PairedDevice {
                    id: "dev2".into(),
                    token: "bb".into(),
                    label: "폰".into(),
                    paired_at_ms: 2,
                },
            )
        });
        revoker.join().unwrap().unwrap();
        pairer.join().unwrap().unwrap();

        let on_disk = crate::remote_token::load(&config_dir).unwrap();
        let in_memory = state.devices.lock().unwrap().clone();
        assert_eq!(on_disk, in_memory, "디스크와 메모리는 항상 일치해야 한다");
        assert!(
            !on_disk.iter().any(|d| d.id == "dev1"),
            "레이스와 무관하게 철회된 기기가 되살아나면 안 된다: {on_disk:?}"
        );
        assert!(on_disk.iter().any(|d| d.id == "dev2"), "새로 페어링된 기기는 남아 있어야 한다: {on_disk:?}");
        std::fs::remove_dir_all(&config_dir).ok();
    }

    // --- server lifecycle (bind/run) ---

    /// `bind` then `run`, stopped via the shutdown channel, then `bind` again
    /// on the exact same port: this is the start→stop→start guarantee
    /// `remote_share_stop`/`remote_share_start` depend on — the port must be
    /// fully released by the time the first `run` future resolves, not just
    /// eventually.
    #[tokio::test]
    async fn stop_then_start_on_the_same_port_succeeds() {
        let addr: std::net::SocketAddr = "127.0.0.1:0".parse().unwrap();
        let listener = bind(addr).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = test_state();

        let (tx, rx) = tokio::sync::oneshot::channel();
        let handle = tokio::spawn(run(listener, state.clone(), rx));
        tx.send(()).unwrap();
        handle.await.unwrap().unwrap();

        let addr2: std::net::SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
        let listener2 = bind(addr2).await;
        assert!(listener2.is_ok(), "정지 후 같은 포트로 재시작이 성공해야 한다: {listener2:?}");
        std::fs::remove_dir_all(&state.config_dir).ok();
    }

    /// A bind on a port already held by another listener must come back as
    /// `Err`, never panic — the caller (`remote_share_start`) surfaces this
    /// straight to the UI.
    #[tokio::test]
    async fn bind_to_an_occupied_port_is_an_err_not_a_panic() {
        let addr: std::net::SocketAddr = "127.0.0.1:0".parse().unwrap();
        let first = bind(addr).await.unwrap();
        let port = first.local_addr().unwrap().port();
        let addr2: std::net::SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
        let result = bind(addr2).await;
        assert!(result.is_err());
    }

    // --- fix round 1: vault-root addressability, path relativization,
    //     read_asset bounds ---

    /// A freshly paired client's very first request has nothing to name but
    /// the top level — an empty `path` must resolve to the vault root, not
    /// 404. Without this, sharing a vault would be unusable: there would be
    /// no way to ever see what's in it.
    #[tokio::test]
    async fn vault_root_is_addressable_via_an_empty_path() {
        let (state, dir) = state_with_file("note.md", "x");
        let app = router(state);
        let res = call_get(&app, "/list_dir?vault=rv1&path=&show_hidden=false").await;
        assert_eq!(res.status(), http::StatusCode::OK);
        let entries: Vec<crate::fs::listing::DirEntry> = json_body(res).await;
        assert!(entries.iter().any(|e| e.name == "note.md"), "{:?}", entries.iter().map(|e| &e.name).collect::<Vec<_>>());
        std::fs::remove_dir_all(dir).ok();
    }

    /// The empty-path root carve-out in `safe_path` must not have loosened
    /// the escape gates it sits next to — `..` and an absolute path must
    /// still 404 on every route, not just `read_file`.
    #[tokio::test]
    async fn list_dir_still_refuses_dotdot_and_absolute_paths() {
        // `..` from the armed root lands in `tmp` — planting a real,
        // distinctively-named file there (see `state_with_escape_target`'s
        // doc comment) means a broken gate would show up as a 200 listing
        // `outside.md`, not just a 404 that happens to also occur when
        // nothing's there.
        let (state, tmp) = state_with_escape_target(("note.md", "x"), ("outside.md", "SECRET"));
        let app = router(state);
        let res = call_get(&app, "/list_dir?vault=rv1&path=..&show_hidden=false").await;
        assert_eq!(res.status(), http::StatusCode::NOT_FOUND, "dotdot escape");
        let res = call_get(&app, "/list_dir?vault=rv1&path=%2Fetc&show_hidden=false").await;
        assert_eq!(res.status(), http::StatusCode::NOT_FOUND, "absolute path escape");
        std::fs::remove_dir_all(tmp).ok();
    }

    /// General regression guard, not scoped to one route: no response body
    /// from any GET route may contain the armed vault's absolute host
    /// filesystem path. This is the same protection
    /// `vaults_list_never_serializes_the_local_root` pins for `/vaults`,
    /// widened to every route that returns a path-bearing shape.
    ///
    /// The route list under test is `get_routes()` itself — the same table
    /// `router()` builds from — rather than a hand-copied array: axum 0.7
    /// has no public API to enumerate a `Router`'s registered paths after
    /// construction (only the boolean `has_routes()`), so reading the
    /// pre-registration table is the closest available substitute for
    /// "derive the list from `router()`". A route added to that table is
    /// picked up here automatically; a path this test has no query fixture
    /// for panics loudly (see the `other =>` arm below) instead of silently
    /// running zero iterations for it, so a genuinely new route can't slip
    /// through unnoticed either.
    ///
    /// Each call also asserts 200 with a non-empty body *before* checking
    /// for the leaked string — a route that regressed to 404 or `null`
    /// would otherwise pass this test vacuously (an empty/absent body
    /// trivially "doesn't contain" anything).
    #[tokio::test]
    async fn no_route_response_leaks_the_armed_root_absolute_path() {
        let (state, dir) = state_with_file("note.md", "# hi");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("pic.png"), b"\x89PNG").unwrap();
        let root_str = dir.canonicalize().unwrap().to_string_lossy().into_owned();
        let app = router(state);

        for (path, _) in get_routes() {
            let query = match path {
                "/vaults" => String::new(),
                "/list_dir" | "/list_files_recursive" => "?vault=rv1&path=&show_hidden=false".into(),
                "/resolve_image" => "?vault=rv1&path=sub&name=pic.png&max_depth=1".into(),
                "/read_file" | "/read_asset" => "?vault=rv1&path=note.md".into(),
                "/list_link_targets" => "?vault=rv1&path=".into(),
                other => panic!(
                    "새 라우트 {other}가 get_routes()에 추가됐다 — \
                     no_route_response_leaks_the_armed_root_absolute_path에 쿼리 케이스를 추가하라"
                ),
            };
            let res = call_get(&app, &format!("{path}{query}")).await;
            assert_eq!(res.status(), http::StatusCode::OK, "{path} 는 200이어야 유효한 검증이 된다 (404/빈 바디는 통과가 아님)");
            let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
            assert!(!bytes.is_empty(), "{path} 응답 바디가 비어 있음 — 확인할 실제 내용이 없다");
            let text = String::from_utf8_lossy(&bytes);
            assert!(!text.contains(&root_str), "{path} 응답이 armed root 절대경로를 노출함: {text}");
        }
        std::fs::remove_dir_all(dir).ok();
    }

    /// `list_dir`'s entries must additionally be *usable* — a client that
    /// feeds a returned `path` straight into another request's `path` query
    /// param must get the same file back, which only works if the value is
    /// vault-relative (an absolute path 404s at `resolve_within`'s `RootDir`
    /// rejection).
    #[tokio::test]
    async fn list_dir_entries_are_vault_relative_and_round_trip() {
        let (state, dir) = state_with_file("note.md", "# 안녕");
        let app = router(state);
        let res = call_get(&app, "/list_dir?vault=rv1&path=&show_hidden=false").await;
        let entries: Vec<crate::fs::listing::DirEntry> = json_body(res).await;
        let note = entries.iter().find(|e| e.name == "note.md").unwrap();
        assert_eq!(note.path, "note.md");

        let res = call_get(&app, &format!("/read_file?vault=rv1&path={}", note.path)).await;
        assert_eq!(res.status(), http::StatusCode::OK, "list_dir가 돌려준 path는 read_file에 그대로 되먹여도 통해야 한다");
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn read_asset_serves_image_bytes_with_nosniff() {
        let (state, dir) = state_with_file("note.md", "x");
        std::fs::write(dir.join("pic.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        let app = router(state);
        let res = call_get(&app, "/read_asset?vault=rv1&path=pic.png").await;
        assert_eq!(res.status(), http::StatusCode::OK);
        assert_eq!(res.headers().get("content-type").unwrap(), "image/png");
        assert_eq!(
            res.headers().get("x-content-type-options").unwrap(),
            "nosniff",
            "바이너리 응답에는 MIME 스니핑 방지 헤더가 있어야 한다"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    /// `/read_asset` must apply the same hidden-file exclusion `list_dir`
    /// does — the containment gate alone has no opinion on `.git/config` or
    /// `.obsidian/*` since they're lexically and canonically inside the
    /// armed root.
    #[tokio::test]
    async fn read_asset_refuses_a_hidden_file() {
        let (state, dir) = state_with_file("note.md", "x");
        std::fs::write(dir.join(".secret.png"), b"x").unwrap();
        let app = router(state);
        let res = call_get(&app, "/read_asset?vault=rv1&path=.secret.png").await;
        assert_eq!(res.status(), http::StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(dir).ok();
    }

    /// A file directly under a hidden directory must be refused even though
    /// its own file name isn't hidden — `.git/config`'s last path component
    /// is `"config"`, not `".git"`. This is the fix-round-2 regression: the
    /// gate must inspect every component of the vault-relative path, not
    /// just the final one, or `.git/config` (which routinely carries
    /// credential-bearing remote URLs) would be servable.
    #[tokio::test]
    async fn read_asset_refuses_a_file_under_a_hidden_directory() {
        let (state, dir) = state_with_file("note.md", "x");
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".git").join("config"), b"[remote \"origin\"]").unwrap();
        let app = router(state);
        let res = call_get(&app, "/read_asset?vault=rv1&path=.git/config").await;
        assert_eq!(res.status(), http::StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(dir).ok();
    }

    /// Same as above, nested two levels deeper — pins that the check walks
    /// *every* component, not just the first hidden ancestor found.
    #[tokio::test]
    async fn read_asset_refuses_a_file_nested_under_a_hidden_directory() {
        let (state, dir) = state_with_file("note.md", "x");
        std::fs::create_dir_all(dir.join(".obsidian").join("plugins").join("x")).unwrap();
        std::fs::write(dir.join(".obsidian").join("plugins").join("x").join("data.json"), b"{}").unwrap();
        let app = router(state);
        let res = call_get(&app, "/read_asset?vault=rv1&path=.obsidian/plugins/x/data.json").await;
        assert_eq!(res.status(), http::StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(dir).ok();
    }

    /// A file over `MAX_ASSET_BYTES` must be refused by a metadata check,
    /// not read into memory and then rejected — refusing after buffering the
    /// whole thing would defeat the point of the ceiling.
    #[tokio::test]
    async fn read_asset_refuses_a_file_over_the_size_ceiling() {
        let (state, dir) = state_with_file("note.md", "x");
        let big = vec![0u8; (MAX_ASSET_BYTES + 1) as usize];
        std::fs::write(dir.join("big.bin"), &big).unwrap();
        let app = router(state);
        let res = call_get(&app, "/read_asset?vault=rv1&path=big.bin").await;
        assert_eq!(res.status(), http::StatusCode::PAYLOAD_TOO_LARGE);
        std::fs::remove_dir_all(dir).ok();
    }

    // --- fix round 3: the safe_path hidden/artifact chokepoint, the
    // read_file size cap, and the cross-host ssh tunnel guard's TS-visible
    // shape --------------------------------------------------------------

    /// The concrete exploit the report opens with: `.git/config` served
    /// through `/read_file`, which — before this fix — had no hidden-file
    /// check at all (only `/read_asset` did). Now that the check lives in
    /// `safe_path` itself, every route gets it for free.
    #[tokio::test]
    async fn read_file_refuses_a_hidden_component_path() {
        let (state, dir) = state_with_file("note.md", "x");
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".git").join("config"), b"[remote \"origin\"]\n\turl = https://user:pass@example.com/repo.git\n").unwrap();
        let app = router(state);
        let res = call_get(&app, "/read_file?vault=rv1&path=.git/config").await;
        assert_eq!(res.status(), http::StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(dir).ok();
    }

    /// The other half of the report's exploit: `show_hidden=true` on
    /// `/list_dir` must never actually reveal a hidden entry — see
    /// `IGNORE_PEER_SHOW_HIDDEN`'s doc comment for why the flag is accepted
    /// on the wire but never honored by the handler.
    #[tokio::test]
    async fn list_dir_never_reveals_hidden_entries_even_when_show_hidden_is_requested() {
        let (state, dir) = state_with_file("note.md", "x");
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        let app = router(state);
        let res = call_get(&app, "/list_dir?vault=rv1&path=&show_hidden=true").await;
        assert_eq!(res.status(), http::StatusCode::OK);
        let entries: Vec<crate::fs::listing::DirEntry> = json_body(res).await;
        assert!(
            !entries.iter().any(|e| e.name == ".git"),
            "숨김 표시를 요청해도 .git이 노출되면 안 된다: {:?}",
            entries.iter().map(|e| &e.name).collect::<Vec<_>>()
        );
        std::fs::remove_dir_all(dir).ok();
    }

    /// Walks `get_routes()` — the same SSOT table `router()` and
    /// `no_route_response_leaks_the_armed_root_absolute_path` already build
    /// off — rather than a hand-picked subset of routes, so a fifth
    /// path-taking route added later without threading it through
    /// `safe_path` fails this test immediately instead of silently
    /// reopening the gap a prior round left (`/read_asset` only). A path
    /// this test has no query fixture for panics loudly (the `other =>`
    /// arm) rather than running zero iterations for it.
    #[tokio::test]
    async fn every_get_route_with_a_path_param_refuses_a_hidden_path_component() {
        let (state, dir) = state_with_file("note.md", "x");
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".git").join("config"), b"[remote \"origin\"]").unwrap();
        let app = router(state);

        for (path, _) in get_routes() {
            let query: String = match path {
                "/vaults" => continue, // takes no vault-relative path param
                "/list_dir" | "/list_files_recursive" => "?vault=rv1&path=.git&show_hidden=true".into(),
                "/resolve_image" => "?vault=rv1&path=.git&name=config&max_depth=1".into(),
                "/read_file" | "/read_asset" => "?vault=rv1&path=.git/config".into(),
                // Unlike /read_file and /read_asset, .git/config is a file
                // that 404s on its own (list_link_targets expects a path it
                // can read and parse as markdown) with or without the
                // hidden-component gate — a vacuous pass. .git is a
                // directory instead, so the gate itself is what has to
                // reject it here, the same way /list_dir's arm above does.
                "/list_link_targets" => "?vault=rv1&path=.git".into(),
                other => panic!(
                    "새 라우트 {other}가 get_routes()에 추가됐다 — \
                     every_get_route_with_a_path_param_refuses_a_hidden_path_component에 쿼리 케이스를 추가하라"
                ),
            };
            let res = call_get(&app, &format!("{path}{query}")).await;
            assert_eq!(
                res.status(),
                http::StatusCode::NOT_FOUND,
                "{path}은 숨김 경로 구성요소를 거부해야 한다"
            );
        }
        std::fs::remove_dir_all(dir).ok();
    }

    /// `MAX_READ_FILE_BYTES` refuses an oversized file via a metadata check
    /// before ever reading it into memory — same ordering
    /// `read_asset_refuses_a_file_over_the_size_ceiling` pins for
    /// `MAX_ASSET_BYTES`.
    #[tokio::test]
    async fn read_file_refuses_a_file_over_the_size_ceiling() {
        let (state, dir) = state_with_file("note.md", "x");
        let big = "a".repeat((MAX_READ_FILE_BYTES + 1) as usize);
        std::fs::write(dir.join("big.md"), &big).unwrap();
        let app = router(state);
        let res = call_get(&app, "/read_file?vault=rv1&path=big.md").await;
        assert_eq!(res.status(), http::StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(dir).ok();
    }

    /// A file at or under the ceiling is unaffected — the cap must not
    /// reject legitimate reads.
    #[tokio::test]
    async fn read_file_serves_a_file_right_at_the_size_ceiling() {
        let (state, dir) = state_with_file("note.md", "x");
        let exactly_at_cap = "a".repeat(MAX_READ_FILE_BYTES as usize);
        std::fs::write(dir.join("at_cap.md"), &exactly_at_cap).unwrap();
        let app = router(state);
        let res = call_get(&app, "/read_file?vault=rv1&path=at_cap.md").await;
        assert_eq!(res.status(), http::StatusCode::OK);
        std::fs::remove_dir_all(dir).ok();
    }
}
