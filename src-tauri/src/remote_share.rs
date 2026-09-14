//! The host's control surface for remote vault sharing (Task 9a): the
//! `#[tauri::command]`s a settings UI calls to turn sharing on/off, arm a
//! set of local vaults, issue a pairing code, and list/revoke paired
//! devices. `remote_host.rs` owns the pure containment logic, the pairing
//! state machine, and the axum server itself; this module owns the *lifecycle*
//! around that server — starting it, stopping it, and the `RemoteShareState`
//! that remembers what's currently armed and running.
//!
//! Sharing is **off by default**: `RemoteShareState::new` never starts a
//! server on its own, only `remote_share_start` does, and only once a user
//! explicitly calls it with at least one vault. Nothing here can be reached
//! without the frontend calling one of these commands first.
//!
//! **The device token never crosses IPC.** Every command below returns only
//! non-secret projections (`ShareStatus`'s `DeviceInfo` has no `token`
//! field) — see `remote_token.rs`'s module doc for why the token itself
//! must stay entirely inside Rust.

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::remote_host::{self, ArmedVault, HostState, PairingState};
use crate::remote_token::PairedDevice;

/// How the host's HTTP server binds: the tailnet interface (reachable from
/// any device on the same Tailscale network) or `127.0.0.1` only (for a
/// user reaching the host through their own SSH tunnel). See
/// docs/design/remote-vault.md §5. `kebab-case` on the wire so the frontend
/// can send/receive `"tailscale"` / `"localhost-only"` directly.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BindMode {
    Tailscale,
    LocalhostOnly,
}

/// One vault the caller wants armed for sharing: `id`/`display_name` mirror
/// `remote_host::ArmedVault`'s wire-facing fields, `root` is the local
/// filesystem path to serve from. The backend keeps no registry of "known
/// vaults" of its own — that's `src/workspace/*`'s concern, entirely
/// frontend state — so `remote_share_start` takes the full triple per vault
/// rather than a bare id the backend would have nothing to resolve it
/// against.
#[derive(Clone, Debug, serde::Deserialize)]
pub struct VaultToArm {
    pub id: String,
    pub display_name: String,
    pub root: String,
}

/// A running server's teardown handle: the `shutdown` sender
/// `stop_running` fires to ask `remote_host::run`'s graceful shutdown to
/// begin, and the `handle` that same stop awaits so the port is verifiably
/// released (listener dropped) before returning — see `stop_running`'s doc
/// comment for why awaiting, not just sending, is load-bearing.
struct RunningServer {
    shutdown: tokio::sync::oneshot::Sender<()>,
    handle: tokio::task::JoinHandle<Result<(), String>>,
}

/// The bind mode/port a `remote_share_start` call configured — kept apart
/// from `HostState` (which the HTTP server itself reads) because neither
/// field means anything to a request handler; they only matter for
/// `remote_share_status` to echo back and for `remote_share_start` to decide
/// what to rebind to on a config change.
struct ShareConfig {
    bind_mode: BindMode,
    port: u16,
}

struct ShareInner {
    host: HostState,
    running: Option<RunningServer>,
    config: ShareConfig,
}

/// Managed Tauri state for the host's control surface: the live `HostState`
/// the HTTP server reads (armed vaults, paired devices, pairing session)
/// plus whatever server task is currently running, if any. One instance per
/// app, constructed in `lib.rs`'s `.setup` with the app's config
/// directory and whatever devices `remote_token::load` finds there —
/// loading at startup (rather than starting with an empty list) is what
/// makes a paired device survive an app restart at all.
pub struct RemoteShareState {
    inner: Mutex<ShareInner>,
}

impl RemoteShareState {
    pub fn new(config_dir: PathBuf, devices: Vec<PairedDevice>) -> Self {
        Self {
            inner: Mutex::new(ShareInner {
                host: HostState {
                    armed: Arc::new(Mutex::new(Vec::new())),
                    devices: Arc::new(Mutex::new(devices)),
                    pairing: Arc::new(Mutex::new(PairingState::unarmed())),
                    config_dir,
                },
                running: None,
                config: ShareConfig { bind_mode: BindMode::Tailscale, port: crate::remote_client::DEFAULT_PORT },
            }),
        }
    }
}

/// The non-secret projection of `PairedDevice` a UI may see: `id` (what
/// `remote_revoke_device` takes), `label`, and when pairing happened — never
/// `token`. Deliberately its own type rather than `#[serde(skip)]` on
/// `PairedDevice.token`: that field must stay serializable so
/// `remote_token::save` can persist it to disk, so the redaction has to
/// happen at the IPC boundary instead, in `redact` below.
#[derive(Clone, Debug, serde::Serialize)]
pub struct DeviceInfo {
    pub id: String,
    pub label: String,
    pub paired_at_ms: u64,
}

fn redact(d: &PairedDevice) -> DeviceInfo {
    DeviceInfo { id: d.id.clone(), label: d.label.clone(), paired_at_ms: d.paired_at_ms }
}

/// The settings panel's full picture of sharing: whether the server is
/// running, its last-configured bind mode/port (kept even while stopped, so
/// a UI can pre-fill the form from the previous session), the vaults
/// currently armed (`ArmedVault`'s `root` is `#[serde(skip)]`, so this can
/// never leak a local filesystem path), and the paired devices (redacted,
/// never carrying a token).
#[derive(serde::Serialize)]
pub struct ShareStatus {
    pub running: bool,
    pub bind_mode: BindMode,
    pub port: u16,
    pub vaults: Vec<ArmedVault>,
    pub devices: Vec<DeviceInfo>,
}

#[tauri::command]
pub fn remote_share_status(state: tauri::State<'_, RemoteShareState>) -> ShareStatus {
    share_status(&state)
}

/// `remote_share_status`'s actual logic, taking a plain `&RemoteShareState`
/// rather than `tauri::State` — `tauri::State`'s constructor is crate-private
/// upstream, so a unit test has no way to build one outside a running app.
/// Every command below follows this split (a thin `#[tauri::command]`
/// wrapper plus a same-named-minus-`remote_`-prefix function) purely so its
/// logic stays testable; `tauri::State<T>` derefs to `&T`, so the wrapper's
/// `&state` argument satisfies this signature for free.
fn share_status(state: &RemoteShareState) -> ShareStatus {
    let inner = state.inner.lock().unwrap();
    let status = ShareStatus {
        running: inner.running.is_some(),
        bind_mode: inner.config.bind_mode,
        port: inner.config.port,
        vaults: inner.host.armed.lock().unwrap().clone(),
        devices: inner.host.devices.lock().unwrap().iter().map(redact).collect(),
    };
    status
}

/// Resolves a `BindMode` to the concrete address to bind. `LocalhostOnly` is
/// a constant; `Tailscale` shells out to `tailscale ip -4` (run off the
/// async executor via `spawn_blocking` — `Command::output` blocks the
/// calling thread) since detecting a tailnet address has no pure-Rust
/// answer without a new dependency, which this feature is not permitted to
/// add. A missing/not-running Tailscale surfaces as a clear `Err`, not a
/// silent fallback to some other interface.
async fn resolve_bind_ip(mode: BindMode) -> Result<IpAddr, String> {
    match mode {
        BindMode::LocalhostOnly => Ok(IpAddr::from([127, 0, 0, 1])),
        BindMode::Tailscale => tokio::task::spawn_blocking(tailscale_ipv4)
            .await
            .map_err(|e| format!("tailscale ip 조회 실패: {e}"))?
            .ok_or_else(|| {
                "Tailscale IPv4 주소를 찾을 수 없습니다. Tailscale이 실행 중인지 확인하세요.".to_string()
            }),
    }
}

/// Runs `tailscale ip -4` and parses its first line as an address. `None`
/// covers every failure mode uniformly (binary not on `PATH`, not logged
/// in, not running) — none of those are distinguishable in a way a caller
/// could act on differently, so they all collapse to "no Tailscale address
/// available" for `resolve_bind_ip` to report.
fn tailscale_ipv4() -> Option<IpAddr> {
    let output = std::process::Command::new("tailscale").args(["ip", "-4"]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    parse_tailscale_ip_output(&String::from_utf8_lossy(&output.stdout))
}

/// Parses `tailscale ip -4`'s stdout (one IPv4 address, first line) into the
/// address to bind. Pulled out from `tailscale_ipv4` so the parsing rule is
/// unit-testable without an actual `tailscale` binary on the machine running
/// the tests.
fn parse_tailscale_ip_output(stdout: &str) -> Option<IpAddr> {
    stdout.lines().next()?.trim().parse().ok()
}

/// Stops whatever server is currently running, if any — the shared teardown
/// path both `remote_share_stop` and `remote_share_start` (for its restart)
/// use. Sends the shutdown signal and then **awaits** the task to
/// completion before returning: `with_graceful_shutdown` only drops the
/// listener (closing the port) once that future resolves, so returning
/// right after `send` would race a subsequent `bind` on the same port
/// against this task's own teardown — occasionally producing a spurious
/// "address already in use" on a rapid stop-then-start. Awaiting here makes
/// port release synchronous from the caller's point of view. Takes the
/// `running` slot out of `inner` before ever `.await`ing, so no
/// `std::sync::MutexGuard` (which is `!Send`) is ever held across an await
/// point.
async fn stop_running(state: &RemoteShareState) {
    let running = {
        let mut inner = state.inner.lock().unwrap();
        inner.running.take()
    };
    if let Some(r) = running {
        let _ = r.shutdown.send(());
        let _ = r.handle.await;
    }
}

/// Starts the server. Requires at least one vault — arming zero vaults
/// would start a server that serves nothing but still occupies the port and
/// (once Tailscale-bound) is reachable on the tailnet for no reason, so
/// this refuses rather than silently no-opping or binding anyway. Changing
/// the armed vault set, bind mode, or port always goes through a full
/// stop-then-restart (never a live mutation of a running server) — simplest
/// correct behavior, and cheap: the whole handshake is local and sub-second,
/// so a UI-driven "apply" has no perceptible cost from tearing the old
/// listener down first.
///
/// The bind happens here, in this command's own async body, *before*
/// spawning the task that runs the server loop — so a bind failure (port in
/// use, interface not up) is observed synchronously and returned as a plain
/// `Err` the caller can show, never left to disappear inside a detached
/// background task or to panic.
#[tauri::command]
pub async fn remote_share_start(
    bind_mode: BindMode,
    port: u16,
    vaults: Vec<VaultToArm>,
    state: tauri::State<'_, RemoteShareState>,
) -> Result<(), String> {
    share_start(bind_mode, port, vaults, &state).await
}

async fn share_start(
    bind_mode: BindMode,
    port: u16,
    vaults: Vec<VaultToArm>,
    state: &RemoteShareState,
) -> Result<(), String> {
    if vaults.is_empty() {
        return Err("공유할 볼트를 하나 이상 선택하세요".into());
    }

    stop_running(state).await;

    let ip = resolve_bind_ip(bind_mode).await?;
    let addr = SocketAddr::new(ip, port);
    let listener = remote_host::bind(addr).await?;

    let armed: Vec<ArmedVault> = vaults
        .into_iter()
        .map(|v| ArmedVault { id: v.id, display_name: v.display_name, root: PathBuf::from(v.root) })
        .collect();

    let mut inner = state.inner.lock().unwrap();
    *inner.host.armed.lock().unwrap() = armed;
    // A fresh sharing session starts with no live pairing code — any code
    // issued in a previous run is meaningless once the server (and thus the
    // only thing that could ever redeem it) has been torn down and rebuilt.
    *inner.host.pairing.lock().unwrap() = PairingState::unarmed();
    inner.config = ShareConfig { bind_mode, port };

    let host_for_task = inner.host.clone();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let handle = tokio::spawn(remote_host::run(listener, host_for_task, shutdown_rx));
    inner.running = Some(RunningServer { shutdown: shutdown_tx, handle });
    Ok(())
}

/// Stops the server if running; a no-op (not an error) if it wasn't — the
/// settings UI's "off" toggle should never fail just because sharing was
/// already off.
#[tauri::command]
pub async fn remote_share_stop(state: tauri::State<'_, RemoteShareState>) -> Result<(), String> {
    stop_running(&state).await;
    Ok(())
}
// `remote_share_stop` has no separate `share_stop` split — `stop_running`
// already takes a plain `&RemoteShareState` and *is* the whole logic, so
// there's nothing left for a wrapper-vs-logic split to separate.

/// The freshly minted pairing code plus when it was issued, so the UI can
/// render its own countdown against `remote_host::PAIRING_TTL_MS` without a
/// second round trip.
#[derive(serde::Serialize)]
pub struct IssuedCode {
    pub code: String,
    pub issued_at_ms: u64,
}

/// Issues a new 6-digit pairing code, replacing any still-live one from
/// this session. Refuses while sharing is off: a code that names no
/// reachable server (there is nothing listening for the `POST /pair` it
/// would need to be redeemed against) would just be a dead end for whoever
/// tries to use it, so this reports that plainly instead of minting a code
/// that can never work.
#[tauri::command]
pub fn remote_issue_code(state: tauri::State<'_, RemoteShareState>) -> Result<IssuedCode, String> {
    issue_code(&state)
}

fn issue_code(state: &RemoteShareState) -> Result<IssuedCode, String> {
    let inner = state.inner.lock().unwrap();
    if inner.running.is_none() {
        return Err("원격 공유가 꺼져 있어 페어링 코드를 발급할 수 없습니다".into());
    }
    let code = remote_host::issue_pairing_code(remote_host::now_ms());
    *inner.host.pairing.lock().unwrap() = PairingState::armed(code.clone());
    Ok(IssuedCode { code: code.code, issued_at_ms: code.issued_at_ms })
}

/// Revokes a paired device by its non-secret `id` — never by token, which
/// must never cross IPC in the first place (see this module's doc comment).
/// Returns whether a device was actually removed, so the UI can tell "gone"
/// apart from "already wasn't there" (e.g. a stale list after two revoke
/// clicks in a row).
#[tauri::command]
pub fn remote_revoke_device(id: String, state: tauri::State<'_, RemoteShareState>) -> Result<bool, String> {
    revoke_device(&id, &state)
}

fn revoke_device(id: &str, state: &RemoteShareState) -> Result<bool, String> {
    let inner = state.inner.lock().unwrap();
    remote_host::revoke_and_persist(&inner.host, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_config_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "mermark-share-{}-{:?}-{tag}",
            std::process::id(),
            std::thread::current().id()
        ))
    }

    #[test]
    fn tailscale_output_parses_the_first_line_as_an_address() {
        assert_eq!(parse_tailscale_ip_output("100.64.1.2\n"), Some("100.64.1.2".parse().unwrap()));
        assert_eq!(parse_tailscale_ip_output("100.64.1.2\n100.64.1.3\n"), Some("100.64.1.2".parse().unwrap()));
    }

    #[test]
    fn tailscale_output_is_none_when_empty_or_garbage() {
        assert_eq!(parse_tailscale_ip_output(""), None);
        assert_eq!(parse_tailscale_ip_output("not an ip\n"), None);
    }

    #[tokio::test]
    async fn localhost_only_resolves_without_touching_tailscale() {
        assert_eq!(resolve_bind_ip(BindMode::LocalhostOnly).await.unwrap(), IpAddr::from([127, 0, 0, 1]));
    }

    #[test]
    fn sharing_is_off_by_default() {
        let state = RemoteShareState::new(tmp_config_dir("default"), Vec::new());
        let status = share_status(&state);
        assert!(!status.running);
        assert!(status.vaults.is_empty());
    }

    /// Restores devices loaded at construction time — the whole point of
    /// `RemoteShareState::new` taking a `devices` argument instead of
    /// always starting empty.
    #[test]
    fn constructed_with_previously_paired_devices_reports_them() {
        let devices = vec![PairedDevice { id: "d1".into(), token: "t".into(), label: "맥북".into(), paired_at_ms: 5 }];
        let state = RemoteShareState::new(tmp_config_dir("loaded"), devices);
        let status = share_status(&state);
        assert_eq!(status.devices.len(), 1);
        assert_eq!(status.devices[0].id, "d1");
        assert_eq!(status.devices[0].label, "맥북");
    }

    #[tokio::test]
    async fn starting_with_no_vaults_is_refused() {
        let dir = tmp_config_dir("no-vaults");
        let state = RemoteShareState::new(dir.clone(), Vec::new());
        let result = share_start(BindMode::LocalhostOnly, 0, Vec::new(), &state).await;
        assert!(result.is_err());
        assert!(!share_status(&state).running);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn issuing_a_code_before_sharing_is_on_is_refused() {
        let dir = tmp_config_dir("no-code-when-off");
        let state = RemoteShareState::new(dir.clone(), Vec::new());
        assert!(issue_code(&state).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// End-to-end lifecycle through the same functions the commands
    /// delegate to: start on an OS-assigned port, confirm status reflects
    /// it, stop, then start again — the concrete guarantee
    /// `remote_share_stop` exists to provide (the fixed-port case is
    /// covered directly in `remote_host.rs`'s
    /// `stop_then_start_on_the_same_port_succeeds`).
    #[tokio::test]
    async fn start_stop_start_succeeds() {
        let dir = tmp_config_dir("lifecycle");
        let state = RemoteShareState::new(dir.clone(), Vec::new());
        let vaults = vec![VaultToArm {
            id: "v1".into(),
            display_name: "노트".into(),
            root: std::env::temp_dir().to_string_lossy().into_owned(),
        }];

        share_start(BindMode::LocalhostOnly, 0, vaults.clone(), &state).await.unwrap();
        let status = share_status(&state);
        assert!(status.running);
        assert_eq!(status.vaults.len(), 1);

        stop_running(&state).await;
        assert!(!share_status(&state).running);

        share_start(BindMode::LocalhostOnly, 0, vaults, &state).await.unwrap();
        assert!(share_status(&state).running);
        stop_running(&state).await;
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Calling start twice without an intervening stop must not leak the
    /// first server's task or leave two listeners bound — `stop_running`'s
    /// call at the top of `share_start` is what guarantees this.
    #[tokio::test]
    async fn starting_twice_replaces_rather_than_leaking_the_first_server() {
        let dir = tmp_config_dir("double-start");
        let state = RemoteShareState::new(dir.clone(), Vec::new());
        let vaults = vec![VaultToArm {
            id: "v1".into(),
            display_name: "노트".into(),
            root: std::env::temp_dir().to_string_lossy().into_owned(),
        }];

        share_start(BindMode::LocalhostOnly, 0, vaults.clone(), &state).await.unwrap();
        share_start(BindMode::LocalhostOnly, 0, vaults, &state).await.unwrap();
        assert!(share_status(&state).running, "두 번째 시작도 성공해야 한다");

        stop_running(&state).await;
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn revoking_an_unknown_device_reports_false_not_an_error() {
        let dir = tmp_config_dir("revoke-unknown");
        let state = RemoteShareState::new(dir.clone(), Vec::new());
        let removed = revoke_device("nope", &state).unwrap();
        assert!(!removed);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn revoking_a_known_device_removes_it_and_persists() {
        let dir = tmp_config_dir("revoke-known");
        let devices = vec![PairedDevice { id: "d1".into(), token: "t".into(), label: "맥북".into(), paired_at_ms: 1 }];
        let state = RemoteShareState::new(dir.clone(), devices);

        let removed = revoke_device("d1", &state).unwrap();
        assert!(removed);
        assert!(share_status(&state).devices.is_empty());

        let on_disk = crate::remote_token::load(&dir).unwrap();
        assert!(on_disk.is_empty(), "철회는 디스크에도 반영돼야 한다");
        std::fs::remove_dir_all(&dir).ok();
    }
}
