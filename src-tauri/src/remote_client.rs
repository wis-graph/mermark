//! Client-side remote vault: the `remote_*` Tauri commands the frontend
//! calls to read a vault a Mac mini (or other host) is sharing over
//! Tailscale/SSH. Every call carries an explicit timeout — this is the whole
//! reason a mount-based (SMB) design was rejected: a hung network under a
//! mount blocks in the kernel with no timeout knob, freezing the UI. Here a
//! stuck host just returns `REMOTE:Unreachable` after `RESPONSE_TIMEOUT`.
//! See docs/design/remote-vault.md §2.
//!
//! **The device token never reaches the frontend.** No command below takes a
//! `token` parameter — each takes `host` (+ `vault`/`path`/...) and looks its
//! token up itself from `ClientTokens` (managed Tauri state, keyed by host),
//! attaching it as the `x-mermark-token` header. If TypeScript never holds
//! the token, it can never leak it into webview memory, `localStorage`, or a
//! devtools inspection. See `remote_token.rs`'s module doc for the other half
//! of that story (why the token lives in Rust at all).

use std::time::Duration;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
pub const RESPONSE_TIMEOUT: Duration = Duration::from_secs(10);
pub const DEFAULT_PORT: u16 = 8787;

/// The four connection states the frontend can distinguish and act on
/// separately (e.g. "re-pair" for `AuthExpired` vs. "check the network" for
/// `Unreachable`) — see `status_for`'s doc comment for why these are never
/// collapsed into a single generic failure.
#[derive(Debug, PartialEq, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteStatus {
    Connected,
    Unreachable,
    AuthExpired,
    SharingOff,
}

/// Turns a user-typed host string into the base URL every `remote_*` command
/// talks to. `ssh://...` doesn't name a host to dial directly — mermark's own
/// `ssh -L` tunnel (set up elsewhere) forwards `127.0.0.1:DEFAULT_PORT` to the
/// remote host's server, so that's the address this returns for any
/// `ssh://` input, regardless of what follows the scheme. A bare
/// `name[:port]` is otherwise assumed to be directly reachable (e.g. over
/// Tailscale) and becomes `http://name:port`, defaulting to `DEFAULT_PORT`
/// when no port is given. Anything carrying its own scheme or a path is
/// rejected outright — this function's job is "name a host", not "parse an
/// arbitrary URL a peer could smuggle a redirect through".
pub fn base_url(host: &str) -> Result<String, String> {
    if host.is_empty() {
        return Err("호스트가 비어 있습니다".into());
    }
    if host.strip_prefix("ssh://").is_some() {
        return Ok(format!("http://127.0.0.1:{DEFAULT_PORT}"));
    }
    if host.contains("://") || host.contains('/') {
        return Err(format!("호스트에는 이름과 포트만 적습니다: {host}"));
    }
    if host.contains(':') {
        Ok(format!("http://{host}"))
    } else {
        Ok(format!("http://{host}:{DEFAULT_PORT}"))
    }
}

/// Classifies a host response's HTTP status into one of the four surfaced
/// states. Deliberately never collapses failures into one generic
/// "disconnected" — `AuthExpired` (re-pair) and `SharingOff` (the vault was
/// unshared) call for different user action than `Unreachable` (network/host
/// down), and hiding that distinction behind one failure state would leave
/// the user guessing which fix to try.
pub fn status_for(http_status: u16) -> RemoteStatus {
    match http_status {
        200..=299 => RemoteStatus::Connected,
        401 | 403 => RemoteStatus::AuthExpired,
        404 => RemoteStatus::SharingOff,
        _ => RemoteStatus::Unreachable,
    }
}

/// Builds the `reqwest::Client` every command shares, pinned to the two
/// timeouts above. A separate client per call would also work, but building
/// one is cheap and this keeps the timeout policy in exactly one place.
/// `.redirect(Policy::none())`: reqwest's default follows up to 10 redirects
/// and only strips `Authorization`/`Cookie` on a cross-origin hop — our own
/// `x-mermark-token` header isn't one of those, so a redirecting (compromised
/// or misconfigured) host would otherwise have the client forward the bearer
/// token to wherever it points. This client has no legitimate reason to
/// follow a redirect at all — every route it calls is a fixed path on the
/// host named by `host` — so redirects are refused outright rather than
/// followed and merely re-authorized.
fn client() -> Result<reqwest::Client, String> {
    ensure_crypto_provider_installed();
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(RESPONSE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

/// `reqwest`'s rustls TLS backend (pulled in transitively — this build
/// links `rustls`/`ring` regardless of the `reqwest` feature flags we
/// request, because `tauri-plugin-updater` needs TLS for its own HTTPS
/// update checks) requires an explicit default `CryptoProvider` installed
/// exactly once per process before *any* `reqwest::Client` is built, or
/// `Client::builder().build()` panics with "No rustls crypto provider is
/// configured" — even though this module's client only ever speaks plain
/// `http://` and never negotiates TLS at all. Whatever else in the app might
/// install one first (e.g. the updater plugin building its own client) is
/// not something this module can rely on running before it does; `Once`
/// makes the install idempotent and safe regardless of call order or
/// concurrent first calls. `.install_default()`'s `Err` (a provider was
/// already installed by someone else) is intentionally ignored — either way,
/// a provider now exists.
static CRYPTO_PROVIDER_INSTALLED: std::sync::Once = std::sync::Once::new();

fn ensure_crypto_provider_installed() {
    CRYPTO_PROVIDER_INSTALLED.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// A transport-level failure (timeout, DNS failure, connection refused, TLS
/// error, ...) always classifies as `Unreachable` — the frontend has no more
/// specific state to offer for "never got an HTTP response at all". Kept as
/// a named function (not an inline `.map_err` closure repeated at every call
/// site) so that mapping rule reads as one fact, and every command that adds
/// the underlying `reqwest::Error` text keeps the exact `REMOTE:Unreachable`
/// substring the frontend matches on.
fn unreachable(e: reqwest::Error) -> String {
    format!("REMOTE:{:?}: {e}", RemoteStatus::Unreachable)
}

/// Looks up the caller's token for `host`, or classifies a missing one as
/// `REMOTE:AuthExpired` — the user must re-pair with that host. Named so this
/// domain rule ("no stored token behaves exactly like an expired one") isn't
/// left as a bare `.ok_or(...)` repeated at every command's top.
fn token_for_or_expired(store: &crate::remote_token::ClientTokens, host: &str) -> Result<String, String> {
    store.token_for(host).ok_or_else(|| format!("REMOTE:{:?}", RemoteStatus::AuthExpired))
}

/// Formats a non-success HTTP status as the `REMOTE:` error string the
/// frontend classifies on. The one place that formatting happens — both
/// `send_authorized` (every authorized route) and `remote_pair` (the one
/// route with no token to attach yet) go through this, rather than each
/// re-deriving `format!("REMOTE:{:?}", status_for(...))` on its own.
fn classify(http_status: u16) -> String {
    format!("REMOTE:{:?}", status_for(http_status))
}

/// Sends `req` with `token` attached as the bearer header, then classifies
/// the outcome: a transport failure maps to `Unreachable` (via
/// `unreachable`), and a non-success HTTP status maps through `classify`
/// into the matching `REMOTE:` error — the one place every command's
/// "did the call succeed" check lives, so a future route can't reimplement
/// (and drift from) this classification.
async fn send_authorized(req: reqwest::RequestBuilder, token: &str) -> Result<reqwest::Response, String> {
    let res = req.header("x-mermark-token", token).send().await.map_err(unreachable)?;
    if res.status().is_success() {
        Ok(res)
    } else {
        Err(classify(res.status().as_u16()))
    }
}

/// Decodes `res`'s JSON body into `T`, classifying a transport failure that
/// happens *during* the read (a response timeout, a connection dropped
/// mid-body, ...) the same way `unreachable` classifies one that happens
/// before any response arrives — `reqwest::Error` doesn't distinguish "never
/// connected" from "connection died while reading the body" by variant, only
/// by these predicate methods, and both must surface as `REMOTE:Unreachable`
/// so the frontend's classifier recognizes them. Only a genuine decode
/// failure (the host sent something that isn't valid JSON / doesn't match
/// `T`) falls through as plain text — that's a bug, not a connectivity
/// state, so it has no `REMOTE:` prefix for the frontend to key off of.
async fn decode_response<T: serde::de::DeserializeOwned>(res: reqwest::Response) -> Result<T, String> {
    res.json().await.map_err(|e| if is_transport_error(&e) { unreachable(e) } else { e.to_string() })
}

/// A `reqwest::Error` that means "the network/host misbehaved" rather than
/// "the host answered but the body was garbage". Extracted as its own
/// function (rather than left inline in `decode_response`) so the rule is
/// unit-testable against a real `reqwest::Error` without needing a body-read
/// failure specifically — any transport-level error exercises the same
/// predicate.
fn is_transport_error(e: &reqwest::Error) -> bool {
    e.is_timeout() || e.is_connect() || e.is_request()
}

/// One vault a host is currently sharing, as seen by a client: `id` (used to
/// address it in every other `remote_*` call) and the display name shown in
/// the vault picker. Mirrors `remote_host::ArmedVault`'s wire shape but isn't
/// the same type — the host's `ArmedVault` carries a host-local `root:
/// PathBuf` that only derives `Serialize` (never sent, `#[serde(skip)]`), so
/// it has no `Deserialize` impl for the client to decode a response into.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct RemoteVault {
    pub id: String,
    pub display_name: String,
}

/// Exchanges a human-typed pairing code for a device token and stores it —
/// the only place a token crosses the network *to* this device, and it never
/// goes any further than `ClientTokens::remember` (see this module's doc
/// comment). Returns nothing on success: the frontend only needs to know
/// pairing worked, not the token itself.
#[tauri::command]
pub async fn remote_pair(
    host: String,
    code: String,
    label: String,
    store: tauri::State<'_, crate::remote_token::ClientTokens>,
) -> Result<(), String> {
    let url = format!("{}/pair", base_url(&host)?);
    let res = client()?
        .post(&url)
        .json(&serde_json::json!({ "code": code, "label": label }))
        .send()
        .await
        .map_err(unreachable)?;
    if !res.status().is_success() {
        return Err(classify(res.status().as_u16()));
    }
    let parsed: crate::remote_host::PairResponse = decode_response(res).await?;
    store.remember(&host, &parsed.token)
}

#[tauri::command]
pub async fn remote_vaults(
    host: String,
    store: tauri::State<'_, crate::remote_token::ClientTokens>,
) -> Result<Vec<RemoteVault>, String> {
    let token = token_for_or_expired(&store, &host)?;
    let url = format!("{}/vaults", base_url(&host)?);
    let res = send_authorized(client()?.get(&url), &token).await?;
    decode_response(res).await
}

#[tauri::command]
pub async fn remote_list_dir(
    host: String,
    vault: String,
    path: String,
    show_hidden: bool,
    store: tauri::State<'_, crate::remote_token::ClientTokens>,
) -> Result<Vec<crate::commands::DirEntry>, String> {
    let token = token_for_or_expired(&store, &host)?;
    let url = format!("{}/list_dir", base_url(&host)?);
    let req = client()?.get(&url).query(&[
        ("vault", vault.as_str()),
        ("path", path.as_str()),
        ("show_hidden", if show_hidden { "true" } else { "false" }),
    ]);
    let res = send_authorized(req, &token).await?;
    decode_response(res).await
}

#[tauri::command]
pub async fn remote_list_files_recursive(
    host: String,
    vault: String,
    path: String,
    show_hidden: bool,
    store: tauri::State<'_, crate::remote_token::ClientTokens>,
) -> Result<crate::commands::ScanResult, String> {
    let token = token_for_or_expired(&store, &host)?;
    let url = format!("{}/list_files_recursive", base_url(&host)?);
    let req = client()?.get(&url).query(&[
        ("vault", vault.as_str()),
        ("path", path.as_str()),
        ("show_hidden", if show_hidden { "true" } else { "false" }),
    ]);
    let res = send_authorized(req, &token).await?;
    decode_response(res).await
}

#[tauri::command]
pub async fn remote_read_file(
    host: String,
    vault: String,
    path: String,
    store: tauri::State<'_, crate::remote_token::ClientTokens>,
) -> Result<crate::commands::FileContent, String> {
    let token = token_for_or_expired(&store, &host)?;
    let url = format!("{}/read_file", base_url(&host)?);
    let req = client()?.get(&url).query(&[("vault", vault.as_str()), ("path", path.as_str())]);
    let res = send_authorized(req, &token).await?;
    decode_response(res).await
}

/// Fetches an image's raw bytes from the host and returns them as a
/// `data:<mime>;base64,<...>` URL the frontend sets directly as an `img.src`.
/// This exists because `remote_resolve_image` only returns a vault-relative
/// *path*, and a remote path names nothing on this machine — `convertFileSrc`
/// can never turn it into something the webview can load. Base64-encoding
/// happens here, in Rust, rather than shipping the raw bytes and a separate
/// content-type field for the frontend to assemble — one self-contained
/// string is simpler for the caller than a byte array plus a MIME string it
/// has to combine correctly itself. The app's CSP already allows `data:` in
/// `img-src`, so this needs no CSP change.
#[tauri::command]
pub async fn remote_read_image(
    host: String,
    vault: String,
    path: String,
    store: tauri::State<'_, crate::remote_token::ClientTokens>,
) -> Result<String, String> {
    let token = token_for_or_expired(&store, &host)?;
    let url = format!("{}/read_asset", base_url(&host)?);
    let req = client()?.get(&url).query(&[("vault", vault.as_str()), ("path", path.as_str())]);
    let res = send_authorized(req, &token).await?;
    let content_type = as_image_mime(
        res.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or(""),
    );
    let bytes = res.bytes().await.map_err(unreachable)?;
    Ok(data_url(&content_type, &bytes))
}

/// Restricts a response's declared content type to `image/*` before it's
/// trusted for a `data:` URL, stripping any `; charset=...`-style parameter
/// first. Falls back to `application/octet-stream` for anything else. This
/// function is the only thing standing between whatever a host claims in its
/// `Content-Type` header and a value this module hands the frontend as fact
/// — the app's CSP and today's `img.src`-only usage happen to contain a
/// wrong MIME, but that's incidental to both, not enforced by this function
/// itself, so the restriction belongs here rather than being left implicit.
fn as_image_mime(content_type: &str) -> String {
    let base = content_type.split(';').next().unwrap_or("").trim();
    if base.starts_with("image/") {
        base.to_string()
    } else {
        "application/octet-stream".to_string()
    }
}

/// Assembles a `data:` URL from a MIME type and raw bytes. Pure and
/// unit-testable on its own — no network involved — so `remote_read_image`
/// itself doesn't need a live server to have this part of its behavior
/// pinned.
fn data_url(content_type: &str, bytes: &[u8]) -> String {
    use base64::Engine as _;
    format!(
        "data:{content_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

#[tauri::command]
pub async fn remote_resolve_image(
    host: String,
    vault: String,
    path: String,
    name: String,
    max_depth: u8,
    store: tauri::State<'_, crate::remote_token::ClientTokens>,
) -> Result<Option<String>, String> {
    let token = token_for_or_expired(&store, &host)?;
    let url = format!("{}/resolve_image", base_url(&host)?);
    let max_depth_str = max_depth.to_string();
    let req = client()?.get(&url).query(&[
        ("vault", vault.as_str()),
        ("path", path.as_str()),
        ("name", name.as_str()),
        ("max_depth", max_depth_str.as_str()),
    ]);
    let res = send_authorized(req, &token).await?;
    decode_response(res).await
}

#[tauri::command]
pub async fn remote_list_link_targets(
    host: String,
    vault: String,
    path: String,
    store: tauri::State<'_, crate::remote_token::ClientTokens>,
) -> Result<Vec<crate::commands::LinkTarget>, String> {
    let token = token_for_or_expired(&store, &host)?;
    let url = format!("{}/list_link_targets", base_url(&host)?);
    let req = client()?.get(&url).query(&[("vault", vault.as_str()), ("path", path.as_str())]);
    let res = send_authorized(req, &token).await?;
    decode_response(res).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_input_defaults_to_port_8787() {
        assert_eq!(base_url("wis-macmini").unwrap(), "http://wis-macmini:8787");
    }

    #[test]
    fn host_input_honors_an_explicit_port() {
        assert_eq!(base_url("wis-macmini:9000").unwrap(), "http://wis-macmini:9000");
    }

    #[test]
    fn ssh_host_targets_the_local_tunnel_end() {
        assert_eq!(base_url("ssh://wis@macmini").unwrap(), "http://127.0.0.1:8787");
    }

    #[test]
    fn rejects_a_host_with_a_path_or_scheme_we_do_not_support() {
        assert!(base_url("http://evil/x").is_err());
        assert!(base_url("").is_err());
    }

    #[test]
    fn http_status_maps_to_the_four_surfaced_states() {
        assert_eq!(status_for(401), RemoteStatus::AuthExpired);
        assert_eq!(status_for(404), RemoteStatus::SharingOff);
        assert_eq!(status_for(200), RemoteStatus::Connected);
        assert_eq!(status_for(500), RemoteStatus::Unreachable);
    }

    /// Pins the exact spelling a later task matches on — `REMOTE:AuthExpired`,
    /// not e.g. `remote:auth-expired` (the wire `kebab-case` form, which is
    /// for the *host's* JSON responses, not this client-side error string).
    #[test]
    fn missing_token_reports_auth_expired_with_the_exact_spelling() {
        let dir = std::env::temp_dir().join(format!(
            "mermark-remote-client-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let store = crate::remote_token::ClientTokens::load(&dir);
        let err = token_for_or_expired(&store, "wis-macmini").unwrap_err();
        assert_eq!(err, "REMOTE:AuthExpired");
    }

    #[test]
    fn data_url_embeds_mime_and_base64_bytes() {
        let url = data_url("image/png", b"\x89PNG");
        assert!(url.starts_with("data:image/png;base64,"));
        use base64::Engine as _;
        let encoded = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG");
        assert_eq!(url, format!("data:image/png;base64,{encoded}"));
    }

    /// A transport failure's error string must contain the exact
    /// `REMOTE:Unreachable` substring the frontend matches on, alongside the
    /// underlying `reqwest::Error` detail for human debugging.
    #[tokio::test]
    async fn unreachable_maps_a_transport_failure_to_the_exact_spelling() {
        ensure_crypto_provider_installed();
        // A connection to a closed local port fails fast without touching the
        // network — no real server needed for this to exercise the mapping.
        let res = reqwest::Client::new().get("http://127.0.0.1:1").send().await;
        let err = unreachable(res.unwrap_err());
        assert!(err.contains("REMOTE:Unreachable"), "got: {err}");
    }

    #[tokio::test]
    async fn a_connect_failure_is_a_transport_error() {
        ensure_crypto_provider_installed();
        let res = reqwest::Client::new().get("http://127.0.0.1:1").send().await;
        assert!(is_transport_error(&res.unwrap_err()));
    }

    /// Finding 2 (fix round 1): a failure that happens *while reading the
    /// response body* — not just one that happens before any response
    /// arrives — must still classify as `REMOTE:Unreachable`. Simulated with
    /// a real socket that sends headers promising a body it then never
    /// delivers, against a client whose own timeout is short enough to fire
    /// during that read; `decode_response`'s `.json()` call is what observes
    /// the resulting timeout.
    #[tokio::test]
    async fn decode_response_classifies_a_body_read_timeout_as_unreachable() {
        ensure_crypto_provider_installed();
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf); // drain the request so the client isn't stuck writing
                // Headers promise a body that never actually arrives.
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n",
                );
                std::thread::sleep(Duration::from_secs(5)); // outlives the test either way
            }
        });

        let short_timeout_client =
            reqwest::Client::builder().timeout(Duration::from_millis(200)).build().unwrap();
        let res = short_timeout_client.get(format!("http://{addr}/")).send().await.unwrap();

        #[derive(Debug, serde::Deserialize)]
        struct Anything {}
        let err = decode_response::<Anything>(res).await.unwrap_err();
        assert!(err.contains("REMOTE:Unreachable"), "got: {err}");
    }

    /// The other half of Finding 2: a response that arrives complete but
    /// isn't valid JSON is a genuine decode bug, not a connectivity failure
    /// — it must NOT carry the `REMOTE:` prefix, or the frontend would
    /// wrongly treat "the host sent garbage" as "try reconnecting".
    #[tokio::test]
    async fn decode_response_leaves_a_genuine_decode_failure_unprefixed() {
        ensure_crypto_provider_installed();
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 8\r\n\r\nnot json",
                );
            }
        });

        let res = reqwest::Client::new().get(format!("http://{addr}/")).send().await.unwrap();
        #[derive(Debug, serde::Deserialize)]
        struct Anything {}
        let err = decode_response::<Anything>(res).await.unwrap_err();
        assert!(!err.starts_with("REMOTE:"), "got: {err}");
    }

    #[test]
    fn image_mime_is_passed_through_and_stripped_of_parameters() {
        assert_eq!(as_image_mime("image/png"), "image/png");
        assert_eq!(as_image_mime("image/png; charset=binary"), "image/png");
        assert_eq!(as_image_mime("image/svg+xml"), "image/svg+xml");
    }

    #[test]
    fn non_image_mime_falls_back_to_octet_stream() {
        assert_eq!(as_image_mime("text/html"), "application/octet-stream");
        assert_eq!(as_image_mime("text/html; charset=utf-8"), "application/octet-stream");
        assert_eq!(as_image_mime(""), "application/octet-stream");
    }
}
