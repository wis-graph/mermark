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
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(RESPONSE_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
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

/// Sends `req` with `token` attached as the bearer header, then classifies
/// the outcome: a transport failure maps to `Unreachable` (via
/// `unreachable`), and a non-success HTTP status maps through `status_for`
/// into the matching `REMOTE:` error — the one place every command's
/// "did the call succeed" check lives, so a future route can't reimplement
/// (and drift from) this classification.
async fn send_authorized(req: reqwest::RequestBuilder, token: &str) -> Result<reqwest::Response, String> {
    let res = req.header("x-mermark-token", token).send().await.map_err(unreachable)?;
    if res.status().is_success() {
        Ok(res)
    } else {
        Err(format!("REMOTE:{:?}", status_for(res.status().as_u16())))
    }
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
        return Err(format!("REMOTE:{:?}", status_for(res.status().as_u16())));
    }
    let parsed: crate::remote_host::PairResponse = res.json().await.map_err(|e| e.to_string())?;
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
    res.json().await.map_err(|e| e.to_string())
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
    res.json().await.map_err(|e| e.to_string())
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
    res.json().await.map_err(|e| e.to_string())
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
    res.json().await.map_err(|e| e.to_string())
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
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = res.bytes().await.map_err(unreachable)?;
    Ok(data_url(&content_type, &bytes))
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
    res.json().await.map_err(|e| e.to_string())
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
    res.json().await.map_err(|e| e.to_string())
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
        // A connection to a closed local port fails fast without touching the
        // network — no real server needed for this to exercise the mapping.
        let res = reqwest::Client::new().get("http://127.0.0.1:1").send().await;
        let err = unreachable(res.unwrap_err());
        assert!(err.contains("REMOTE:Unreachable"), "got: {err}");
    }
}
