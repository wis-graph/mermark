//! Local control channel behind `mermark share on|off|status`.
//!
//! The `share` CLI process is a short-lived **client**; the running (primary)
//! mermark instance is the **server**. They talk over a Unix domain socket
//! (`<config_dir>/cli.sock`): one request line of JSON in, one response line
//! of JSON out. The single-instance plugin is deliberately not used — it is
//! one-way (the second process `exit(0)`s right after notifying) so no result
//! could come back to the terminal.
//!
//! Division of labour:
//! - `off` / `status` are answered by Rust alone (`dispatch`).
//! - `on` needs the vault registry, which only exists in the webview
//!   (`localStorage`), so the server parks an `Outstanding` request, emits
//!   `cli-share-request` to **one** ready window (`deliver_outstanding`), and
//!   waits for that window's `complete_cli_request`. The frontend reuses the
//!   ordinary `remote_share_start` command, so the settings panel and the CLI
//!   share one start path (and one "last selection" writer).
//!
//! Security posture: the socket lives in `~/Library/Application Support/
//! <identifier>/` (`~/Library` is 0700 for the user) and is itself chmod 0600,
//! so only the same local user can connect — which is why no peer-credential
//! check is done (`UnixStream::peer_cred` is not stable in std). The request
//! vocabulary is the three `ShareCommand` ops; nothing on this channel can
//! issue a pairing code, read a token, or revoke a device, and responses
//! never contain codes/tokens/device ids. The channel cannot arm an arbitrary
//! directory either: vault names/paths are resolved by the frontend against
//! already-registered vaults only.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use crate::cli::ShareCommand;
use crate::remote_share::{BindMode, RemoteShareState, ShareSelection, ShareStatus};

/// Wire protocol version; bumped when request/response shapes change so a
/// stale running instance answers "restart mermark" instead of misparsing.
pub const PROTOCOL_VERSION: u32 = 1;
/// Upper bound on one request line.
const MAX_REQUEST_BYTES: u64 = 64 * 1024;
/// A connection that sends nothing must not stall the (serial) server.
const SERVER_READ_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the server waits for the window to answer a parked `on`.
const WINDOW_REPLY_TIMEOUT: Duration = Duration::from_secs(45);
/// How long the client waits for the server's response (> window timeout).
const CLIENT_READ_TIMEOUT: Duration = Duration::from_secs(60);
/// `sun_path` limit on macOS (including the NUL).
const SUN_PATH_MAX: usize = 104;

// ---------------------------------------------------------------- paths --

/// The app config directory for `identifier` under `home` — the same rule as
/// tauri's `app_config_dir` on macOS (`remote_token` stores there too). Both
/// client and server compute the socket location from this one function; the
/// identifier is passed in (never hardcoded) so a QA build with a different
/// identifier cannot reach the user's real app.
pub fn mermark_config_dir(home: &Path, identifier: &str) -> PathBuf {
    home.join("Library").join("Application Support").join(identifier)
}

pub fn control_socket_path(config_dir: &Path) -> PathBuf {
    config_dir.join("cli.sock")
}

/// Whether `path` fits in a `sockaddr_un.sun_path`.
pub fn socket_path_fits(path: &Path) -> bool {
    path.as_os_str().len() < SUN_PATH_MAX
}

// ----------------------------------------------------------------- wire --

/// One request line: `{"v":1,"op":"share-on","names":[..]}`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct CliRequest {
    pub v: u32,
    #[serde(flatten)]
    pub cmd: ShareCommand,
}

/// One response line. The server formats everything; the client prints it
/// verbatim and exits with `code`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct CliResponse {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl CliResponse {
    fn ok(stdout: String) -> Self {
        Self { code: 0, stdout, stderr: String::new() }
    }
    fn fail(code: i32, message: &str) -> Self {
        Self { code, stdout: String::new(), stderr: format!("mermark: {message}\n") }
    }
}

/// What the webview reports back for a parked `share on`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CliShareOutcome {
    Started { warnings: Vec<String> },
    Failed { error: String },
}

/// Payload of the `cli-share-request` event (snake_case on the wire).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct CliShareRequestPayload {
    pub id: u64,
    pub names: Vec<String>,
    pub remembered: Option<ShareSelection>,
}

// ------------------------------------------------------------- queries --

/// True when `share on` has nothing to share: no names and no remembered
/// selection. Used by the server (before bothering the webview) and by the
/// client (before launching the app).
pub fn share_on_target_missing(names: &[String], last: Option<&ShareSelection>) -> bool {
    names.is_empty() && last.is_none()
}

const NO_TARGET_MESSAGE: &str =
    "공유할 볼트 이름을 넣으세요 (예: mermark share on 노트) — 기억된 마지막 선택이 없습니다";

pub fn bind_mode_label(mode: BindMode) -> &'static str {
    match mode {
        BindMode::Tailscale => "Tailscale",
        BindMode::LocalhostOnly => "로컬호스트만 (SSH 터널)",
    }
}

fn vault_names<'a>(names: impl Iterator<Item = &'a str>) -> String {
    names.collect::<Vec<_>>().join(", ")
}

/// Two-line summary of a running share. Never includes codes, tokens or
/// device ids.
pub fn format_started(status: &ShareStatus) -> String {
    format!(
        "원격 공유 켜짐 — {} · 포트 {}\n  볼트: {}\n",
        bind_mode_label(status.bind_mode),
        status.port,
        vault_names(status.vaults.iter().map(|v| v.display_name.as_str()))
    )
}

pub fn format_status(status: &ShareStatus) -> String {
    if status.running {
        return format!("{}  페어링된 기기: {}대\n", format_started(status), status.devices.len());
    }
    let mut out = String::from("원격 공유: 꺼짐\n");
    if let Some(sel) = &status.last_selection {
        out.push_str(&format!(
            "  마지막 선택: {} ({}) — 'mermark share on'으로 다시 켭니다\n",
            vault_names(sel.vaults.iter().map(|v| v.display_name.as_str())),
            bind_mode_label(sel.bind_mode)
        ));
    }
    out
}

pub fn format_stopped(was_running: bool) -> String {
    if was_running { "원격 공유를 껐습니다\n".into() } else { "원격 공유: 이미 꺼져 있습니다\n".into() }
}

fn format_warnings(warnings: &[String]) -> String {
    warnings.iter().map(|w| format!("mermark: 경고: {w}\n")).collect()
}

const NOT_RUNNING_TEXT: &str = "원격 공유: 꺼짐 (mermark가 실행 중이 아닙니다)\n";

// ------------------------------------------------------------ dispatch --

/// Side effects `dispatch` needs from its shell, injected so the decision
/// logic is testable without a running app.
pub struct Effects<'a> {
    /// Park a `share on` request on the webview and wait for its outcome.
    pub deliver: &'a dyn Fn(Vec<String>, Option<ShareSelection>) -> CliShareOutcome,
    /// Tell the UI the share state changed.
    pub changed: &'a dyn Fn(),
}

/// Version gate + command routing for one parsed request.
pub fn handle_request(req: CliRequest, state: &RemoteShareState, fx: &Effects) -> CliResponse {
    if req.v != PROTOCOL_VERSION {
        return CliResponse::fail(1, "실행 중인 mermark와 버전이 맞지 않습니다 — mermark를 재시작하세요");
    }
    dispatch(req.cmd, state, fx)
}

/// Executes one command against the share state. Blocks the calling (std)
/// thread; never call from an async context.
pub fn dispatch(cmd: ShareCommand, state: &RemoteShareState, fx: &Effects) -> CliResponse {
    match cmd {
        ShareCommand::Status => {
            CliResponse::ok(format_status(&crate::remote_share::share_status(state)))
        }
        ShareCommand::Off => {
            let was_running = tauri::async_runtime::block_on(crate::remote_share::share_stop(state));
            if was_running {
                (fx.changed)();
            }
            CliResponse::ok(format_stopped(was_running))
        }
        ShareCommand::On { names } => {
            let last = crate::remote_share::share_status(state).last_selection;
            if share_on_target_missing(&names, last.as_ref()) {
                return CliResponse::fail(1, NO_TARGET_MESSAGE);
            }
            match (fx.deliver)(names, last) {
                CliShareOutcome::Started { warnings } => {
                    let status = crate::remote_share::share_status(state);
                    CliResponse {
                        code: 0,
                        stdout: format_started(&status),
                        stderr: format_warnings(&warnings),
                    }
                }
                CliShareOutcome::Failed { error } => CliResponse::fail(1, &error),
            }
        }
    }
}

// ------------------------------------------------- parked `on` requests --

struct Outstanding {
    id: u64,
    payload: CliShareRequestPayload,
    /// Window the event was emitted to; `None` until delivered.
    label: Option<String>,
    reply: mpsc::Sender<CliShareOutcome>,
}

/// Managed state of the control channel. The server handles connections one
/// at a time, so at most one request is ever parked.
#[derive(Default)]
pub struct CliControlState {
    next_id: Mutex<u64>,
    outstanding: Mutex<Option<Outstanding>>,
    bound_path: Mutex<Option<PathBuf>>,
}

impl CliControlState {
    /// Command: parks a request; returns its id and the reply receiver.
    fn post(
        &self,
        names: Vec<String>,
        remembered: Option<ShareSelection>,
    ) -> (u64, mpsc::Receiver<CliShareOutcome>) {
        let id = {
            let mut next = self.next_id.lock().unwrap();
            *next += 1;
            *next
        };
        let (tx, rx) = mpsc::channel();
        let payload = CliShareRequestPayload { id, names, remembered };
        *self.outstanding.lock().unwrap() = Some(Outstanding { id, payload, label: None, reply: tx });
        (id, rx)
    }

    /// Command: claims the undelivered parked request for `label` and
    /// returns its payload; `None` when nothing is waiting or it was already
    /// delivered (so two triggers can never double-deliver).
    fn claim_for_delivery(&self, label: &str) -> Option<CliShareRequestPayload> {
        let mut slot = self.outstanding.lock().unwrap();
        let o = slot.as_mut().filter(|o| o.label.is_none())?;
        o.label = Some(label.to_string());
        Some(o.payload.clone())
    }

    fn has_undelivered(&self) -> bool {
        self.outstanding.lock().unwrap().as_ref().is_some_and(|o| o.label.is_none())
    }

    /// Command: accepts a window's reply. Only the window the event was
    /// delivered to, answering the current id, is accepted (once).
    pub fn complete(&self, label: &str, id: u64, outcome: CliShareOutcome) -> bool {
        let mut slot = self.outstanding.lock().unwrap();
        let accepted = slot.as_ref().is_some_and(|o| o.id == id && o.label.as_deref() == Some(label));
        if accepted {
            let o = slot.take().unwrap();
            let _ = o.reply.send(outcome);
        }
        accepted
    }

    fn discard(&self, id: u64) {
        let mut slot = self.outstanding.lock().unwrap();
        if slot.as_ref().is_some_and(|o| o.id == id) {
            *slot = None;
        }
    }

    /// Waits for the window's outcome; on timeout drops the parked request
    /// and reports failure.
    fn await_outcome(&self, id: u64, rx: mpsc::Receiver<CliShareOutcome>, timeout: Duration) -> CliShareOutcome {
        match rx.recv_timeout(timeout) {
            Ok(outcome) => outcome,
            Err(_) => {
                self.discard(id);
                CliShareOutcome::Failed { error: "mermark 창이 응답하지 않았습니다".into() }
            }
        }
    }
}

/// Window → backend reply for a `cli-share-request`. Accepts only the id and
/// window label the event was delivered to (cf. `acknowledge_open_request`).
#[tauri::command]
pub fn complete_cli_request(
    window: tauri::WebviewWindow,
    state: tauri::State<CliControlState>,
    id: u64,
    outcome: CliShareOutcome,
) {
    state.complete(window.label(), id, outcome);
}

/// Hands the parked `share on` request to one ready window, or arranges for
/// one to exist. Called when a request is parked and again each time a
/// window reports ready. Emits to a single window (a global emit would make
/// every window call `remote_share_start`) and never moves focus.
pub fn deliver_outstanding(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    let control = app.state::<CliControlState>();
    if !control.has_undelivered() {
        return;
    }
    let live: std::collections::HashSet<String> = app.webview_windows().keys().cloned().collect();
    let routing = app.state::<crate::single_instance::RoutingState>();
    let recipient = routing.0.lock().unwrap().ready_recipient(&live);
    match recipient {
        Some(label) => {
            if let Some(payload) = control.claim_for_delivery(&label) {
                if let Err(e) = app.emit_to(
                    tauri::EventTarget::WebviewWindow { label: label.clone() },
                    "cli-share-request",
                    payload,
                ) {
                    eprintln!("mermark: failed to deliver cli-share-request to {label}: {e}");
                }
            }
        }
        None => {
            // No ready window. If no document window exists at all, recreate
            // `main` (the SpawnMain gate prevents duplicates); otherwise a
            // window is still booting and `register_window_ready` re-enters.
            if !live.iter().any(|l| l == "main" || l.starts_with('w')) {
                let actions = routing.0.lock().unwrap().focus_only(&live);
                crate::single_instance::apply_actions(app.clone(), actions);
            }
        }
    }
}

// --------------------------------------------------------- server (unix) --

/// Reads one request line from `stream`, answers it via `respond`, closes.
/// Malformed/oversized requests get a code-2 answer; a silent peer is dropped
/// after `read_timeout`.
#[cfg(unix)]
pub fn serve_connection(
    mut stream: std::os::unix::net::UnixStream,
    read_timeout: Duration,
    respond: &dyn Fn(CliRequest) -> CliResponse,
) {
    use std::io::{BufRead, Read, Write};
    let _ = stream.set_read_timeout(Some(read_timeout));
    let mut line = String::new();
    let read = std::io::BufReader::new((&stream).take(MAX_REQUEST_BYTES + 1)).read_line(&mut line);
    let response = match read {
        Err(_) | Ok(0) => return,
        Ok(n) if n as u64 > MAX_REQUEST_BYTES => CliResponse::fail(2, "요청이 너무 큽니다"),
        Ok(_) => match serde_json::from_str::<CliRequest>(line.trim_end()) {
            Ok(req) => respond(req),
            Err(_) => CliResponse::fail(2, "잘못된 요청입니다 — mermark 버전을 확인하세요"),
        },
    };
    if let Ok(mut json) = serde_json::to_string(&response) {
        json.push('\n');
        let _ = stream.write_all(json.as_bytes());
    }
}

/// Accept loop: connections are served strictly one at a time.
#[cfg(unix)]
pub fn serve_loop(
    listener: std::os::unix::net::UnixListener,
    read_timeout: Duration,
    respond: impl Fn(CliRequest) -> CliResponse,
) {
    for conn in listener.incoming() {
        match conn {
            Ok(stream) => serve_connection(stream, read_timeout, &respond),
            Err(e) => eprintln!("mermark: control socket accept failed: {e}"),
        }
    }
}

/// Binds the control socket at `path`: removes a stale file, binds, chmod
/// 0600. The caller decides what to do with the listener.
#[cfg(unix)]
pub fn bind_control_socket(path: &Path) -> std::io::Result<std::os::unix::net::UnixListener> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let _ = std::fs::remove_file(path);
    let listener = std::os::unix::net::UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

/// Primary-instance entry point: binds `cli.sock` and serves it on a
/// dedicated thread. Call only from a process that owns the singleton (never
/// an `Isolated` one) and only after `RemoteShareState` is managed.
#[cfg(target_os = "macos")]
pub fn start_server(app: tauri::AppHandle) {
    use tauri::Manager;
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        eprintln!("mermark: HOME is not set; control socket disabled");
        return;
    };
    let path = control_socket_path(&mermark_config_dir(&home, &app.config().identifier));
    if !socket_path_fits(&path) {
        eprintln!("mermark: control socket path too long, `mermark share` disabled: {}", path.display());
        return;
    }
    let listener = match bind_control_socket(&path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("mermark: failed to bind {}: {e}", path.display());
            return;
        }
    };
    *app.state::<CliControlState>().bound_path.lock().unwrap() = Some(path);

    let spawn = std::thread::Builder::new().name("mermark-cli-control".into()).spawn(move || {
        serve_loop(listener, SERVER_READ_TIMEOUT, |req| {
            let state = app.state::<RemoteShareState>();
            let deliver = |names: Vec<String>, remembered: Option<ShareSelection>| {
                let control = app.state::<CliControlState>();
                let (id, rx) = control.post(names, remembered);
                deliver_outstanding(&app);
                control.await_outcome(id, rx, WINDOW_REPLY_TIMEOUT)
            };
            let changed = || crate::remote_share::notify_share_changed(&app);
            handle_request(req, &state, &Effects { deliver: &deliver, changed: &changed })
        });
    });
    if let Err(e) = spawn {
        eprintln!("mermark: failed to start control thread: {e}");
    }
}

#[cfg(not(target_os = "macos"))]
pub fn start_server(_app: tauri::AppHandle) {}

/// Removes the socket file this process bound (and only that one).
pub fn cleanup(app: &tauri::AppHandle) {
    use tauri::Manager;
    let control = app.state::<CliControlState>();
    let bound = control.bound_path.lock().unwrap().take();
    if let Some(path) = bound {
        let _ = std::fs::remove_file(path);
    }
}

// ------------------------------------------------------ client (macOS) --

/// What the client does when it cannot connect (the app is not running).
#[derive(Debug, PartialEq)]
pub enum OfflinePlan {
    /// `off` / `status`: report "not running"; never launch the app.
    PrintNotRunning,
    /// `on` with neither names nor a remembered selection: fail without
    /// launching the app.
    FailNoTarget,
    /// `on` with something to share: launch the app, then retry.
    SpawnAndRetry,
}

pub fn offline_plan(cmd: &ShareCommand, remembered: Option<&ShareSelection>) -> OfflinePlan {
    match cmd {
        ShareCommand::Off | ShareCommand::Status => OfflinePlan::PrintNotRunning,
        ShareCommand::On { names } if share_on_target_missing(names, remembered) => OfflinePlan::FailNoTarget,
        ShareCommand::On { .. } => OfflinePlan::SpawnAndRetry,
    }
}

/// Query: a vault argument containing `/` is a path (the escape hatch for
/// duplicate names), everything else is a name.
pub fn is_path_vault_arg(arg: &str) -> bool {
    arg.contains('/')
}

/// Turns path-form arguments into canonical absolute paths (relative ones
/// resolve against the shell's cwd, which only the client knows).
pub fn absolutize_path_args(names: &[String]) -> Result<Vec<String>, String> {
    names
        .iter()
        .map(|n| {
            if !is_path_vault_arg(n) {
                return Ok(n.clone());
            }
            std::fs::canonicalize(n)
                .map(|p| p.to_string_lossy().into_owned())
                .map_err(|_| format!("경로를 찾을 수 없습니다: {n}"))
        })
        .collect()
}

#[cfg(unix)]
fn app_is_offline(e: &std::io::Error) -> bool {
    matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused)
}

/// Sends `req` on `stream` and reads the single response line.
#[cfg(unix)]
pub fn exchange(
    stream: &mut std::os::unix::net::UnixStream,
    req: &CliRequest,
    read_timeout: Duration,
) -> Result<CliResponse, String> {
    use std::io::{BufRead, Write};
    let mut json = serde_json::to_string(req).map_err(|e| e.to_string())?;
    json.push('\n');
    stream.write_all(json.as_bytes()).map_err(|e| format!("요청 전송 실패: {e}"))?;
    stream.set_read_timeout(Some(read_timeout)).map_err(|e| e.to_string())?;
    let mut line = String::new();
    std::io::BufReader::new(&*stream)
        .read_line(&mut line)
        .map_err(|e| format!("응답을 받지 못했습니다: {e}"))?;
    serde_json::from_str(line.trim_end()).map_err(|_| "응답을 해석할 수 없습니다".to_string())
}

/// Starts the app as an ordinary bare launch, detached from this terminal's
/// process group so closing the tab or Ctrl-C does not kill it.
#[cfg(target_os = "macos")]
fn spawn_app_detached() -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    Command::new(std::env::current_exe()?)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map(|_| ())
}

#[cfg(target_os = "macos")]
fn finish(response: CliResponse) -> ! {
    use std::io::Write;
    print!("{}", response.stdout);
    eprint!("{}", response.stderr);
    let _ = std::io::stdout().flush();
    std::process::exit(response.code);
}

#[cfg(target_os = "macos")]
fn die(code: i32, message: &str) -> ! {
    eprintln!("mermark: {message}");
    std::process::exit(code);
}

/// The whole `mermark share ...` process: talk to the running instance (or
/// start it for `on`), print its answer, exit with its code.
#[cfg(target_os = "macos")]
pub fn run_share_client(cmd: ShareCommand, identifier: &str) -> ! {
    use std::os::unix::net::UnixStream;

    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        die(1, "HOME 환경 변수가 없습니다");
    };
    let config_dir = mermark_config_dir(&home, identifier);
    let socket = control_socket_path(&config_dir);
    if !socket_path_fits(&socket) {
        die(1, "소켓 경로가 너무 깁니다");
    }
    let cmd = match cmd {
        ShareCommand::On { names } => match absolutize_path_args(&names) {
            Ok(names) => ShareCommand::On { names },
            Err(msg) => die(2, &msg),
        },
        other => other,
    };
    let req = CliRequest { v: PROTOCOL_VERSION, cmd: cmd.clone() };

    let mut stream = match UnixStream::connect(&socket) {
        Ok(s) => s,
        Err(e) if app_is_offline(&e) => {
            let remembered = crate::remote_share::load_selection(&config_dir);
            match offline_plan(&cmd, remembered.as_ref()) {
                OfflinePlan::PrintNotRunning => finish(CliResponse::ok(NOT_RUNNING_TEXT.into())),
                OfflinePlan::FailNoTarget => die(1, NO_TARGET_MESSAGE),
                OfflinePlan::SpawnAndRetry => {
                    if let Err(e) = spawn_app_detached() {
                        die(1, &format!("mermark를 시작하지 못했습니다: {e}"));
                    }
                    let deadline = std::time::Instant::now() + Duration::from_secs(20);
                    loop {
                        std::thread::sleep(Duration::from_millis(200));
                        match UnixStream::connect(&socket) {
                            Ok(s) => break s,
                            Err(e) if app_is_offline(&e) && std::time::Instant::now() < deadline => continue,
                            Err(_) => die(
                                1,
                                "mermark를 시작했지만 응답이 없습니다 (실행 중인 mermark가 이전 버전이면 재시작하세요)",
                            ),
                        }
                    }
                }
            }
        }
        Err(e) => die(1, &format!("mermark에 연결하지 못했습니다: {e}")),
    };
    match exchange(&mut stream, &req, CLIENT_READ_TIMEOUT) {
        Ok(response) => finish(response),
        Err(msg) => die(1, &msg),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn run_share_client(_cmd: ShareCommand, _identifier: &str) -> ! {
    eprintln!("mermark: mermark share는 macOS에서만 지원됩니다");
    std::process::exit(2);
}

// ---------------------------------------------------------------- tests --

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_share::{RememberedVault, VaultToArm};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn state_in(tag: &str) -> (RemoteShareState, PathBuf) {
        let dir = std::env::temp_dir().join(format!("mm-cc-{}-{tag}", std::process::id()));
        (RemoteShareState::new(dir.clone(), Vec::new(), None), dir)
    }

    fn sel(names: &[&str], mode: BindMode) -> ShareSelection {
        ShareSelection {
            bind_mode: mode,
            vaults: names
                .iter()
                .map(|n| RememberedVault { id: n.to_string(), display_name: n.to_string() })
                .collect(),
        }
    }

    fn no_fx_panics() -> (impl Fn(Vec<String>, Option<ShareSelection>) -> CliShareOutcome, impl Fn()) {
        (
            |_n: Vec<String>, _r: Option<ShareSelection>| -> CliShareOutcome { panic!("deliver must not be called") },
            || {},
        )
    }

    // --- paths ---

    #[test]
    fn config_dir_rule_uses_the_identifier_it_is_given() {
        let home = Path::new("/Users/u");
        assert_eq!(
            mermark_config_dir(home, "com.mermark.app"),
            PathBuf::from("/Users/u/Library/Application Support/com.mermark.app")
        );
        assert_eq!(
            mermark_config_dir(home, "com.mermark.qa"),
            PathBuf::from("/Users/u/Library/Application Support/com.mermark.qa")
        );
    }

    #[test]
    fn socket_path_is_cli_sock_in_config_dir_and_length_is_checked() {
        let dir = Path::new("/a/b");
        assert_eq!(control_socket_path(dir), PathBuf::from("/a/b/cli.sock"));
        let fits = PathBuf::from("x".repeat(103));
        let too_long = PathBuf::from("x".repeat(104));
        assert!(socket_path_fits(&fits));
        assert!(!socket_path_fits(&too_long));
    }

    // --- queries / wire ---

    #[test]
    fn target_missing_truth_table() {
        let some = sel(&["a"], BindMode::Tailscale);
        assert!(share_on_target_missing(&[], None));
        assert!(!share_on_target_missing(&[], Some(&some)));
        assert!(!share_on_target_missing(&["a".into()], None));
        assert!(!share_on_target_missing(&["a".into()], Some(&some)));
    }

    #[test]
    fn request_wire_has_version() {
        let req = CliRequest { v: 1, cmd: ShareCommand::Status };
        assert_eq!(serde_json::to_string(&req).unwrap(), r#"{"v":1,"op":"share-status"}"#);
        let on: CliRequest = serde_json::from_str(r#"{"v":1,"op":"share-on","names":["a"]}"#).unwrap();
        assert_eq!(on.cmd, ShareCommand::On { names: vec!["a".into()] });
    }

    #[test]
    fn outcome_wire_shape() {
        let s = CliShareOutcome::Started { warnings: vec!["w".into()] };
        assert_eq!(serde_json::to_string(&s).unwrap(), r#"{"kind":"started","warnings":["w"]}"#);
        let f: CliShareOutcome = serde_json::from_str(r#"{"kind":"failed","error":"x"}"#).unwrap();
        assert_eq!(f, CliShareOutcome::Failed { error: "x".into() });
    }

    #[test]
    fn payload_wire_is_snake_case_with_remembered() {
        let p = CliShareRequestPayload { id: 3, names: vec![], remembered: Some(sel(&["a"], BindMode::LocalhostOnly)) };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["remembered"]["bind_mode"], "localhost-only");
        assert_eq!(v["remembered"]["vaults"][0]["display_name"], "a");
        assert_eq!(v["id"], 3);
    }

    // --- formatters ---

    fn status_fixture(running: bool, last: Option<ShareSelection>) -> ShareStatus {
        use crate::remote_host::ArmedVault;
        ShareStatus {
            running,
            bind_mode: BindMode::Tailscale,
            port: 47878,
            vaults: if running {
                vec![
                    ArmedVault { id: "SECRET-ID".into(), display_name: "노트".into(), root: "/r1".into() },
                    ArmedVault { id: "i2".into(), display_name: "업무".into(), root: "/r2".into() },
                ]
            } else {
                Vec::new()
            },
            devices: Vec::new(),
            last_selection: last,
        }
    }

    #[test]
    fn started_text_names_mode_port_and_vaults_only() {
        let text = format_started(&status_fixture(true, None));
        assert_eq!(text, "원격 공유 켜짐 — Tailscale · 포트 47878\n  볼트: 노트, 업무\n");
        assert!(!text.contains("SECRET-ID") && !text.contains("/r1"));
    }

    #[test]
    fn status_text_covers_on_off_and_remembered() {
        let on = format_status(&status_fixture(true, None));
        assert!(on.contains("페어링된 기기: 0대"));
        assert_eq!(format_status(&status_fixture(false, None)), "원격 공유: 꺼짐\n");
        let off = format_status(&status_fixture(false, Some(sel(&["노트", "업무"], BindMode::Tailscale))));
        assert!(off.starts_with("원격 공유: 꺼짐\n"));
        assert!(off.contains("마지막 선택: 노트, 업무 (Tailscale)"));
    }

    #[test]
    fn stopped_text_and_labels() {
        assert_eq!(format_stopped(true), "원격 공유를 껐습니다\n");
        assert_eq!(format_stopped(false), "원격 공유: 이미 꺼져 있습니다\n");
        assert_eq!(bind_mode_label(BindMode::Tailscale), "Tailscale");
        assert_eq!(bind_mode_label(BindMode::LocalhostOnly), "로컬호스트만 (SSH 터널)");
    }

    // --- dispatch ---

    #[test]
    fn status_when_off_is_code_zero() {
        let (state, _d) = state_in("st-off");
        let (deliver, changed) = no_fx_panics();
        let r = dispatch(ShareCommand::Status, &state, &Effects { deliver: &deliver, changed: &changed });
        assert_eq!(r.code, 0);
        assert!(r.stdout.contains("꺼짐"));
    }

    #[test]
    fn off_stops_a_running_share_and_notifies() {
        let (state, dir) = state_in("off-run");
        let vaults = vec![VaultToArm {
            id: "v".into(),
            display_name: "노트".into(),
            root: std::env::temp_dir().to_string_lossy().into_owned(),
        }];
        tauri::async_runtime::block_on(crate::remote_share::share_start(
            BindMode::LocalhostOnly,
            0,
            vaults,
            &state,
        ))
        .unwrap();
        assert!(crate::remote_share::share_status(&state).running);

        let notified = AtomicUsize::new(0);
        let (deliver, _) = no_fx_panics();
        let changed = || {
            notified.fetch_add(1, Ordering::SeqCst);
        };
        let fx = Effects { deliver: &deliver, changed: &changed };
        let r = dispatch(ShareCommand::Off, &state, &fx);
        assert_eq!((r.code, r.stdout.as_str()), (0, "원격 공유를 껐습니다\n"));
        assert!(!crate::remote_share::share_status(&state).running);
        assert_eq!(notified.load(Ordering::SeqCst), 1);

        let again = dispatch(ShareCommand::Off, &state, &fx);
        assert_eq!(again.stdout, "원격 공유: 이미 꺼져 있습니다\n");
        assert_eq!(notified.load(Ordering::SeqCst), 1, "no change, no notification");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn on_without_names_or_memory_fails_without_asking_the_window() {
        let (state, _d) = state_in("on-nothing");
        let (deliver, changed) = no_fx_panics();
        let r = dispatch(ShareCommand::On { names: vec![] }, &state, &Effects { deliver: &deliver, changed: &changed });
        assert_eq!(r.code, 1);
        assert!(r.stderr.starts_with("mermark: ") && r.stderr.contains("볼트 이름"));
    }

    #[test]
    fn on_started_prints_summary_and_warnings() {
        let (state, _d) = state_in("on-ok");
        let deliver = |names: Vec<String>, _r: Option<ShareSelection>| {
            assert_eq!(names, vec!["a".to_string()]);
            CliShareOutcome::Started { warnings: vec!["w".into()] }
        };
        let changed = || {};
        let r = dispatch(
            ShareCommand::On { names: vec!["a".into()] },
            &state,
            &Effects { deliver: &deliver, changed: &changed },
        );
        assert_eq!(r.code, 0);
        assert!(r.stdout.starts_with("원격 공유"));
        assert_eq!(r.stderr, "mermark: 경고: w\n");
    }

    #[test]
    fn on_failed_prints_error_with_code_one() {
        let (state, _d) = state_in("on-fail");
        let deliver = |_n: Vec<String>, _r: Option<ShareSelection>| CliShareOutcome::Failed { error: "x".into() };
        let changed = || {};
        let r = dispatch(
            ShareCommand::On { names: vec!["a".into()] },
            &state,
            &Effects { deliver: &deliver, changed: &changed },
        );
        assert_eq!((r.code, r.stderr.as_str()), (1, "mermark: x\n"));
    }

    #[test]
    fn on_with_memory_passes_it_to_the_window_with_no_names() {
        let (state, dir) = state_in("on-mem");
        let state = {
            drop(state);
            RemoteShareState::new(dir, Vec::new(), Some(sel(&["a"], BindMode::LocalhostOnly)))
        };
        let deliver = |names: Vec<String>, remembered: Option<ShareSelection>| {
            assert!(names.is_empty());
            assert_eq!(remembered, Some(sel(&["a"], BindMode::LocalhostOnly)));
            CliShareOutcome::Started { warnings: vec![] }
        };
        let changed = || {};
        let r = dispatch(ShareCommand::On { names: vec![] }, &state, &Effects { deliver: &deliver, changed: &changed });
        assert_eq!(r.code, 0);
    }

    #[test]
    fn version_mismatch_is_code_one_with_restart_hint() {
        let (state, _d) = state_in("ver");
        let (deliver, changed) = no_fx_panics();
        let r = handle_request(
            CliRequest { v: 2, cmd: ShareCommand::Status },
            &state,
            &Effects { deliver: &deliver, changed: &changed },
        );
        assert_eq!(r.code, 1);
        assert!(r.stderr.contains("재시작"));
    }

    // --- parked requests ---

    #[test]
    fn complete_accepts_only_matching_id_and_delivered_label_once() {
        let c = CliControlState::default();
        let (id, rx) = c.post(vec!["a".into()], None);
        let done = CliShareOutcome::Started { warnings: vec![] };
        assert!(!c.complete("main", id, done.clone()), "not delivered yet");
        assert!(c.claim_for_delivery("main").is_some());
        assert!(c.claim_for_delivery("w2").is_none(), "no double delivery");
        assert!(!c.complete("main", id + 1, done.clone()), "wrong id");
        assert!(!c.complete("w2", id, done.clone()), "wrong window");
        assert!(c.complete("main", id, done.clone()));
        assert!(!c.complete("main", id, done.clone()), "only once");
        assert_eq!(rx.recv().unwrap(), done);
    }

    #[test]
    fn unanswered_request_times_out_and_is_discarded() {
        let c = CliControlState::default();
        let (id, rx) = c.post(vec![], None);
        c.claim_for_delivery("main");
        let out = c.await_outcome(id, rx, Duration::from_millis(30));
        assert!(matches!(&out, CliShareOutcome::Failed { error } if error.contains("응답하지 않았습니다")));
        assert!(!c.has_undelivered());
        assert!(!c.complete("main", id, CliShareOutcome::Started { warnings: vec![] }));
    }

    // --- offline client decisions ---

    #[test]
    fn offline_plan_truth_table() {
        let on = |n: &[&str]| ShareCommand::On { names: n.iter().map(|s| s.to_string()).collect() };
        let mem = sel(&["a"], BindMode::Tailscale);
        assert_eq!(offline_plan(&ShareCommand::Off, None), OfflinePlan::PrintNotRunning);
        assert_eq!(offline_plan(&ShareCommand::Status, Some(&mem)), OfflinePlan::PrintNotRunning);
        assert_eq!(offline_plan(&on(&[]), None), OfflinePlan::FailNoTarget);
        assert_eq!(offline_plan(&on(&[]), Some(&mem)), OfflinePlan::SpawnAndRetry);
        assert_eq!(offline_plan(&on(&["a"]), None), OfflinePlan::SpawnAndRetry);
    }

    #[test]
    fn path_args_are_canonicalized_and_names_pass_through() {
        let dir = std::env::temp_dir().join(format!("mm-cc-path-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let canon = std::fs::canonicalize(&dir).unwrap().to_string_lossy().into_owned();
        let got = absolutize_path_args(&["노트".into(), dir.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(got, vec!["노트".to_string(), canon]);
        assert!(is_path_vault_arg("./x") && !is_path_vault_arg("x"));
        let err = absolutize_path_args(&["/mermark/no/such/dir".into()]).unwrap_err();
        assert!(err.contains("경로를 찾을 수 없습니다"));
        std::fs::remove_dir_all(&dir).ok();
    }

    // --- socket round trip ---

    #[cfg(unix)]
    mod socket {
        use super::*;
        use std::io::Write;
        use std::os::unix::net::UnixStream;

        fn sock_path(tag: &str) -> PathBuf {
            let p = std::env::temp_dir().join(format!("mm{}-{tag}.sock", std::process::id()));
            assert!(socket_path_fits(&p), "{}", p.display());
            p
        }

        fn echo_server(path: &Path, timeout: Duration) {
            let listener = bind_control_socket(path).unwrap();
            std::thread::spawn(move || {
                serve_loop(listener, timeout, |req| match req.cmd {
                    ShareCommand::Status => CliResponse::ok("hi\n".into()),
                    _ => CliResponse::fail(1, "nope"),
                })
            });
        }

        #[test]
        fn round_trip_and_permissions() {
            use std::os::unix::fs::PermissionsExt;
            let path = sock_path("rt");
            echo_server(&path, Duration::from_secs(5));
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            let mut s = UnixStream::connect(&path).unwrap();
            let r = exchange(&mut s, &CliRequest { v: 1, cmd: ShareCommand::Status }, Duration::from_secs(5)).unwrap();
            assert_eq!(r, CliResponse::ok("hi\n".into()));
            std::fs::remove_file(&path).ok();
        }

        #[test]
        fn rebinding_replaces_a_stale_socket_file() {
            let path = sock_path("stale");
            drop(bind_control_socket(&path).unwrap()); // leaves the file behind
            assert!(path.exists());
            assert!(bind_control_socket(&path).is_ok());
            std::fs::remove_file(&path).ok();
        }

        #[test]
        fn oversized_request_is_rejected_and_server_keeps_serving() {
            let path = sock_path("big");
            echo_server(&path, Duration::from_secs(5));
            let mut big = UnixStream::connect(&path).unwrap();
            let junk = vec![b'a'; (MAX_REQUEST_BYTES as usize) + 10];
            let _ = big.write_all(&junk);
            let _ = big.write_all(b"\n");
            let mut line = String::new();
            use std::io::BufRead;
            std::io::BufReader::new(&big).read_line(&mut line).unwrap();
            let r: CliResponse = serde_json::from_str(line.trim_end()).unwrap();
            assert_eq!(r.code, 2);

            let mut ok = UnixStream::connect(&path).unwrap();
            let r = exchange(&mut ok, &CliRequest { v: 1, cmd: ShareCommand::Status }, Duration::from_secs(5)).unwrap();
            assert_eq!(r.code, 0);
            std::fs::remove_file(&path).ok();
        }

        #[test]
        fn silent_client_does_not_block_the_next_one() {
            let path = sock_path("silent");
            echo_server(&path, Duration::from_millis(150));
            let _silent = UnixStream::connect(&path).unwrap(); // never writes
            let mut ok = UnixStream::connect(&path).unwrap();
            let r = exchange(&mut ok, &CliRequest { v: 1, cmd: ShareCommand::Status }, Duration::from_secs(5)).unwrap();
            assert_eq!(r.code, 0);
            std::fs::remove_file(&path).ok();
        }

        #[test]
        fn garbage_request_gets_code_two() {
            let path = sock_path("garbage");
            echo_server(&path, Duration::from_secs(5));
            let mut s = UnixStream::connect(&path).unwrap();
            s.write_all(b"{\"op\":\"share-pair\"}\n").unwrap();
            let mut line = String::new();
            use std::io::BufRead;
            std::io::BufReader::new(&s).read_line(&mut line).unwrap();
            let r: CliResponse = serde_json::from_str(line.trim_end()).unwrap();
            assert_eq!(r.code, 2, "unknown ops are not part of the vocabulary");
            std::fs::remove_file(&path).ok();
        }

        #[test]
        fn connect_to_missing_socket_means_app_offline() {
            let e = UnixStream::connect(sock_path("missing")).unwrap_err();
            assert!(app_is_offline(&e));
        }
    }
}
