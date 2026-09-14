//! SSH tunnel fallback for users without Tailscale (docs/design/remote-vault.md
//! §5). **mermark never touches SSH keys.** It spawns `ssh -N -L
//! <port>:localhost:<port> user@host` as a child process and lets the user's
//! own `~/.ssh` configuration do the authentication — no key reading, no
//! passphrase prompting, no credential storage. Once the tunnel is up,
//! `remote_client::base_url` already maps any `ssh://user@host` input to
//! `http://127.0.0.1:<port>` (the local end of the forward), so every
//! existing `remote_*` command works unchanged against it.
//!
//! Only one tunnel is ever held at a time (`SshTunnels`'s single `Option`
//! slot): the local end binds a *fixed* port
//! (`remote_client::DEFAULT_PORT`), so a second concurrent tunnel to a
//! different host would either fail to bind or — worse — silently win the
//! bind and have every `remote_*` call for the *other* host read the wrong
//! machine's files under the right host's name. `connect_with`'s
//! `decide_connect` refuses that outright rather than leaving it to chance
//! which `ssh -L` wins.

use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

/// How long to wait for the local end of the tunnel to accept a connection
/// before giving up. `ssh -L` returns as soon as it forks off the connection
/// attempt — it does **not** wait for the handshake with the remote host to
/// finish — so "the process spawned successfully" is not "the tunnel works".
/// A wrong host, a rejected key, or a host that requires an interactive
/// passphrase (which mermark will never supply) all fail *after* the spawn
/// already succeeded; only polling the actual forward tells them apart from
/// "still connecting".
pub const READY_TIMEOUT: Duration = Duration::from_secs(8);
pub const READY_POLL_INTERVAL: Duration = Duration::from_millis(150);

/// `ssh://user@host` → the argv for `ssh -N -L <port>:localhost:<port>
/// user@host`. This is exec'd directly as an argument array (see
/// `spawn_tunnel`) and never passed through a shell, so classic shell
/// injection (`;`, `` ` ``, `$(...)`) is already structurally impossible —
/// but the target string is still validated conservatively here, because
/// `ssh` itself parses its trailing argument and a value starting with `-`
/// could be read as an option (e.g. smuggling `-oProxyCommand=...`) rather
/// than a hostname.
pub fn tunnel_args(host: &str, port: u16) -> Result<Vec<String>, String> {
    let target = host.strip_prefix("ssh://").ok_or("ssh:// 호스트가 아닙니다")?;
    if target.is_empty() || target.starts_with('-') {
        return Err("SSH 대상이 올바르지 않습니다".into());
    }
    let ok = target.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '.' | '-' | '_'));
    if !ok {
        return Err(format!("SSH 대상에 허용되지 않는 문자가 있습니다: {target}"));
    }
    Ok(vec!["-N".into(), "-L".into(), format!("{port}:localhost:{port}"), target.to_string()])
}

/// One live `ssh -L` child, tagged with the host it tunnels to.
struct ActiveTunnel {
    host: String,
    child: Child,
}

impl Drop for ActiveTunnel {
    /// The tunnel process must never outlive the value that owns it — a
    /// leaked `ssh -N` holds the local port forever, and the next connect
    /// attempt (a reconnect this session, or the next app launch racing a
    /// lingering process from a killed-but-not-cleaned-up prior one) then
    /// either fails to bind or silently rides someone else's stale forward.
    /// Firing here (rather than only in an explicit disconnect command) is
    /// what makes *both* cleanup paths free: `disconnect` drops the
    /// `ActiveTunnel` by replacing the slot with `None`, and app exit drops
    /// it by dropping `SshTunnels` itself (managed Tauri state, torn down
    /// with the rest of the app). `wait()` after `kill()` reaps the process
    /// so it doesn't linger as a zombie.
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Managed Tauri state: at most one SSH tunnel at a time. See this module's
/// doc comment for why a second concurrent tunnel is refused rather than
/// silently allowed to race the first for the port.
#[derive(Default)]
pub struct SshTunnels {
    active: Mutex<Option<ActiveTunnel>>,
}

/// What a connect request should do, given the host (if any) currently
/// tunneled. Pulled out as its own named rule — rather than left as an
/// inline `if`/`match` inside `connect_with` — because this *is* the
/// port-collision guard the module doc promises, and a rule with
/// consequences like these deserves a name and a test of its own, not just
/// a branch buried in the spawn logic.
#[derive(Debug, PartialEq)]
enum ConnectDecision {
    /// Already tunneled to this exact host — reuse it, don't spawn a second.
    AlreadyConnected,
    /// Tunneled to a *different* host right now — refuse rather than risk
    /// two processes racing for the same local port.
    Busy(String),
    /// Nothing active — safe to spawn.
    ShouldSpawn,
}

fn decide_connect(active_host: Option<&str>, requested_host: &str) -> ConnectDecision {
    match active_host {
        Some(h) if h == requested_host => ConnectDecision::AlreadyConnected,
        Some(h) => ConnectDecision::Busy(h.to_string()),
        None => ConnectDecision::ShouldSpawn,
    }
}

/// Non-blocking "has this child already exited on its own" check — a wrong
/// host or a rejected key kills `ssh` moments after spawn, well before
/// `READY_TIMEOUT` would otherwise fire, and a tunnel that died *silently*
/// later (host went to sleep, network dropped) leaves a stale entry in
/// `SshTunnels` that must not block a fresh connect attempt.
fn has_exited(child: &mut Child) -> bool {
    matches!(child.try_wait(), Ok(Some(_)))
}

/// Spawns `program` with `args`, piping stdin (closed — mermark never
/// answers an interactive prompt) and stderr (drained on a background
/// thread, see `drain`'s doc comment). stdout is discarded: `ssh -N` prints
/// nothing to stdout by design.
fn spawn_tunnel(program: &str, args: &[String]) -> Result<Child, String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{program} 실행 실패: {e}"))?;
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || drain(stderr));
    }
    Ok(child)
}

/// Reads `r` to EOF and discards it. `ssh` can write to stderr (host-key
/// prompts, "Warning: Permanently added ...", banner text, ...); with
/// stdin closed there is nothing mermark can answer an interactive prompt
/// with, but the pipe still has a finite OS buffer — if nobody reads it, a
/// chatty `ssh` blocks on the write and the tunnel never comes up. This
/// thread only exists to keep that pipe from filling; it doesn't parse or
/// surface what `ssh` said (there is no channel back to the user for it in
/// v1 — a plain reachability failure is what surfaces instead).
fn drain(mut r: impl Read) {
    let mut buf = [0u8; 256];
    loop {
        match r.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
}

/// Polls until the local end of the tunnel accepts a TCP connection, the
/// child exits on its own (a definite failure — no point waiting out the
/// rest of the timeout), or `timeout` elapses. Every failure here maps to
/// `REMOTE:Unreachable` — from the client's point of view, "the tunnel
/// never came up" and "the host is unreachable" are the same actionable
/// state (reuses the four states `remote_client::RemoteStatus` already
/// defines rather than inventing a fifth one this module would own alone).
async fn wait_until_ready(child: &mut Child, port: u16, timeout: Duration, poll: Duration) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if has_exited(child) {
            return Err(format!(
                "REMOTE:{:?}: SSH 터널이 시작 직후 종료되었습니다 (호스트 또는 SSH 인증을 확인하세요)",
                crate::remote_client::RemoteStatus::Unreachable
            ));
        }
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "REMOTE:{:?}: SSH 터널이 {}초 내에 준비되지 않았습니다",
                crate::remote_client::RemoteStatus::Unreachable,
                timeout.as_secs()
            ));
        }
        tokio::time::sleep(poll).await;
    }
}

/// `remote_ssh_connect`'s actual logic, parameterized over the program name
/// and timings so tests can substitute a harmless local process for `ssh`
/// and short timings for the constants above — see this module's tests.
async fn connect_with(
    program: &str,
    host: &str,
    port: u16,
    timeout: Duration,
    poll: Duration,
    state: &SshTunnels,
) -> Result<(), String> {
    // Reap a slot whose process already exited on its own — a tunnel that
    // died silently must not block reconnecting, to the same host or a
    // different one.
    {
        let mut guard = state.active.lock().unwrap();
        if let Some(t) = guard.as_mut() {
            if has_exited(&mut t.child) {
                *guard = None;
            }
        }
    }

    let decision = {
        let guard = state.active.lock().unwrap();
        decide_connect(guard.as_ref().map(|t| t.host.as_str()), host)
    };
    match decision {
        ConnectDecision::AlreadyConnected => return Ok(()),
        ConnectDecision::Busy(other) => {
            return Err(format!(
                "SSH_TUNNEL_BUSY: 이미 다른 호스트({other})로 SSH 터널이 연결되어 있습니다. 먼저 연결을 해제하세요."
            ));
        }
        ConnectDecision::ShouldSpawn => {}
    }

    let args = tunnel_args(host, port)?;
    let mut child = spawn_tunnel(program, &args)?;
    if let Err(e) = wait_until_ready(&mut child, port, timeout, poll).await {
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    }

    *state.active.lock().unwrap() = Some(ActiveTunnel { host: host.to_string(), child });
    Ok(())
}

/// Kills and drops the active tunnel if (and only if) it's the one for
/// `host` — a disconnect for a host that isn't the active one is a no-op,
/// same "the off toggle never fails just because it's already off" idiom
/// `remote_share_stop` uses.
async fn disconnect(host: &str, state: &SshTunnels) {
    let mut guard = state.active.lock().unwrap();
    if guard.as_ref().is_some_and(|t| t.host == host) {
        *guard = None; // ActiveTunnel::drop kills + reaps the child
    }
}

/// Establishes (or reuses) an SSH tunnel to `host` so `remote_client`'s
/// `ssh://`-mapped commands have a live `127.0.0.1:DEFAULT_PORT` to talk to.
/// Idempotent for the same host; refuses a different host while one is
/// active (see `decide_connect`).
#[tauri::command]
pub async fn remote_ssh_connect(host: String, state: tauri::State<'_, SshTunnels>) -> Result<(), String> {
    connect_with("ssh", &host, crate::remote_client::DEFAULT_PORT, READY_TIMEOUT, READY_POLL_INTERVAL, &state).await
}

/// Tears the tunnel for `host` down (vault removed, or the user explicitly
/// disconnects). A no-op if `host` isn't the currently tunneled one.
#[tauri::command]
pub async fn remote_ssh_disconnect(host: String, state: tauri::State<'_, SshTunnels>) -> Result<(), String> {
    disconnect(&host, &state).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- tunnel_args (task-12 brief's own contract) -------------------------

    #[test]
    fn builds_a_local_forward_command_without_touching_keys() {
        let args = tunnel_args("ssh://wis@macmini", 8787).unwrap();
        assert_eq!(args, vec!["-N", "-L", "8787:localhost:8787", "wis@macmini"]);
    }

    #[test]
    fn rejects_a_host_that_is_not_ssh_scheme() {
        assert!(tunnel_args("wis-macmini", 8787).is_err());
    }

    #[test]
    fn rejects_shell_metacharacters_in_the_ssh_target() {
        assert!(tunnel_args("ssh://wis@macmini; rm -rf /", 8787).is_err());
        assert!(tunnel_args("ssh://wis@macmini$(whoami)", 8787).is_err());
    }

    #[test]
    fn rejects_a_target_that_could_be_read_as_an_ssh_option() {
        // A leading `-` in the (post-`ssh://`) target could otherwise smuggle
        // an ssh option (e.g. `-oProxyCommand=...`) past this function's own
        // validation and into `ssh`'s argv.
        assert!(tunnel_args("ssh://-oProxyCommand=evil", 8787).is_err());
    }

    // --- decide_connect: the port-collision guard, in isolation -------------

    #[test]
    fn decide_connect_reuses_an_existing_tunnel_to_the_same_host() {
        assert_eq!(decide_connect(Some("ssh://a@h"), "ssh://a@h"), ConnectDecision::AlreadyConnected);
    }

    #[test]
    fn decide_connect_refuses_a_second_host_while_one_is_active() {
        match decide_connect(Some("ssh://a@h1"), "ssh://a@h2") {
            ConnectDecision::Busy(other) => assert_eq!(other, "ssh://a@h1"),
            other => panic!("expected Busy, got {other:?}"),
        }
    }

    #[test]
    fn decide_connect_spawns_when_nothing_is_active() {
        assert_eq!(decide_connect(None, "ssh://a@h"), ConnectDecision::ShouldSpawn);
    }

    // --- wait_until_ready: readiness / failure detection ---------------------

    fn spawn_sleep(secs: u64) -> Child {
        Command::new("sleep")
            .arg(secs.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    }

    #[tokio::test]
    async fn wait_until_ready_succeeds_once_the_local_port_accepts_connections() {
        // The readiness probe only cares whether *something* is listening on
        // the local end of the forward — it never inspects the child process
        // itself — so binding our own listener here stands in for a real
        // `ssh -L` having finished its handshake, with no network or ssh
        // binary involved.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            let _ = listener.accept().await;
        });

        let mut child = spawn_sleep(5);
        let res = wait_until_ready(&mut child, port, Duration::from_secs(2), Duration::from_millis(30)).await;
        assert!(res.is_ok(), "{res:?}");
        let _ = child.kill();
        let _ = child.wait();
    }

    #[tokio::test]
    async fn wait_until_ready_fails_fast_when_the_child_exits_immediately() {
        let mut child = Command::new("sh")
            .args(["-c", "exit 1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        // Give the shell a moment to actually exit before polling — this
        // pins "exited before the port ever came up", not a race against the
        // process table.
        tokio::time::sleep(Duration::from_millis(150)).await;
        let err = wait_until_ready(&mut child, 1, Duration::from_secs(2), Duration::from_millis(30))
            .await
            .unwrap_err();
        assert!(err.contains("REMOTE:Unreachable"), "got: {err}");
    }

    #[tokio::test]
    async fn wait_until_ready_times_out_when_nothing_ever_listens() {
        let mut child = spawn_sleep(5);
        let err = wait_until_ready(&mut child, 1, Duration::from_millis(150), Duration::from_millis(30))
            .await
            .unwrap_err();
        assert!(err.contains("REMOTE:Unreachable"), "got: {err}");
        let _ = child.kill();
        let _ = child.wait();
    }

    // --- connect_with / disconnect: the full lifecycle, with a harmless
    // local stand-in for `ssh` (never the real binary, never a real host) ----

    #[cfg(unix)]
    fn fake_ssh_script(dir: &std::path::Path) -> String {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join("fake_ssh.sh");
        // Ignores whatever argv it's given (the real ssh's `-N -L ... user@host`
        // included) and just sits there — the test's own TcpListener (bound
        // *before* this spawns) is what makes the readiness probe succeed, not
        // anything this script does.
        std::fs::write(&script, "#!/bin/sh\nsleep 5\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script.to_string_lossy().into_owned()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn connect_reuses_the_same_host_and_refuses_a_second_one() {
        let dir = std::env::temp_dir().join(format!(
            "mermark_ssh_test_{}_{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let program = fake_ssh_script(&dir);

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            loop {
                if listener.accept().await.is_err() {
                    break;
                }
            }
        });

        let state = SshTunnels::default();
        let timeout = Duration::from_secs(2);
        let poll = Duration::from_millis(30);

        connect_with(&program, "ssh://wis@macmini", port, timeout, poll, &state).await.unwrap();
        assert_eq!(state.active.lock().unwrap().as_ref().unwrap().host, "ssh://wis@macmini");

        // Reconnecting to the same host reuses the tunnel (no second spawn —
        // if it *did* spawn again, this would still pass, but the busy-guard
        // test right after would then fail because a second process is bound
        // to nothing new anyway; the real assurance here is functional:
        // reconnecting never errors).
        connect_with(&program, "ssh://wis@macmini", port, timeout, poll, &state).await.unwrap();

        // A different host is refused while this one is active — the
        // port-collision guard.
        let err = connect_with(&program, "ssh://other@host", port, timeout, poll, &state)
            .await
            .unwrap_err();
        assert!(err.starts_with("SSH_TUNNEL_BUSY"), "got: {err}");

        disconnect("ssh://wis@macmini", &state).await;
        assert!(state.active.lock().unwrap().is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn disconnect_is_a_noop_when_nothing_is_connected() {
        let state = SshTunnels::default();
        disconnect("ssh://nobody@nowhere", &state).await; // must not panic
        assert!(state.active.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn disconnect_ignores_a_host_that_is_not_the_active_one() {
        let mut child = spawn_sleep(5);
        assert!(!has_exited(&mut child));
        let state = SshTunnels::default();
        *state.active.lock().unwrap() = Some(ActiveTunnel { host: "ssh://a@h".into(), child });

        disconnect("ssh://different@host", &state).await;
        assert!(state.active.lock().unwrap().is_some(), "disconnect for the wrong host must be a no-op");

        disconnect("ssh://a@h", &state).await;
        assert!(state.active.lock().unwrap().is_none());
    }

    #[test]
    fn has_exited_distinguishes_a_running_child_from_a_finished_one() {
        let mut running = spawn_sleep(5);
        assert!(!has_exited(&mut running));
        let _ = running.kill();
        let _ = running.wait();

        let mut finished = Command::new("sh").args(["-c", "exit 0"]).spawn().unwrap();
        // try_wait can race a just-spawned process; wait() blocks until it's
        // actually done, which is exactly what this case needs to assert.
        let _ = finished.wait();
        assert!(has_exited(&mut finished));
    }
}
