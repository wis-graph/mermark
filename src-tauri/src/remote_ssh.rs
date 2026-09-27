//! SSH tunnel fallback for users without Tailscale (docs/design/remote-vault.md
//! §5). **mermark never touches SSH keys.** It spawns `ssh -N -L
//! <SSH_TUNNEL_LOCAL_PORT>:localhost:<share port> user@host` as a child
//! process and lets the user's own `~/.ssh` configuration do the
//! authentication — no key reading, no passphrase prompting, no credential
//! storage. The share port is the *remote* host's own (`?share-port=N` on
//! the `ssh://` host string, or `DEFAULT_PORT` when absent — see
//! `parse_ssh_host`); the local end is always the fixed
//! `SSH_TUNNEL_LOCAL_PORT`, deliberately different from `DEFAULT_PORT` (see
//! that constant's doc comment). Once the tunnel is up, `remote_client::
//! base_url` already maps any `ssh://user@host` input to
//! `http://127.0.0.1:SSH_TUNNEL_LOCAL_PORT` (the local end of the forward),
//! so every existing `remote_*` command works unchanged against it.
//!
//! Only one tunnel is ever held at a time (`SshTunnels`'s single `TunnelSlot`):
//! the local end binds a *fixed* port (`remote_client::SSH_TUNNEL_LOCAL_PORT`),
//! so a second concurrent tunnel to a different host would either fail to bind or
//! — worse — silently win the bind and have every `remote_*` call for the
//! *other* host read the wrong machine's files under the right host's name.
//! `connect_with`'s `decide_connect` refuses that outright rather than
//! leaving it to chance which `ssh -L` wins, and the same slot also carries a
//! `Connecting` marker so two overlapping `remote_ssh_connect` calls can't
//! both spawn (fix round 1, Important 4).
//!
//! **A pre-existing listener on the local port is a distinct danger from a
//! second *mermark* tunnel** (fix round 1, Critical 1): an orphaned `ssh -N`
//! left over from a killed prior run, a tunnel the user started by hand, or
//! (worst case) this same Mac's own `remote_share` running in
//! `LocalhostOnly` mode would all make the readiness probe below succeed
//! against *their* listener, not ours — silently reading a stranger's (or
//! the user's own) vault under this vault's name. Two defenses:
//! `port_is_free` refuses to even spawn when something is *already*
//! listening, which is what actually closes the realistic case (a
//! long-lived orphan or rival that predates this connect attempt); `-o
//! ExitOnForwardFailure=yes` (in `tunnel_args`) makes `ssh` itself exit if
//! it loses a bind race instead of warning and staying up forever, and
//! `wait_until_ready`'s per-iteration child-exited check will notice that
//! exit whenever it happens over the full `READY_TIMEOUT` window.
//!
//! **What that second defense does NOT do** (corrected fix round 2 — an
//! earlier version of this comment claimed the poll loop's sleep gave `ssh`
//! "time to die before the TCP probe could run": wrong. OpenSSH sets up a
//! `-L` forward only *after* authentication finishes, seconds later, not
//! within one `READY_POLL_INTERVAL`): if a rival binds the port in the
//! narrow window between `port_is_free`'s check and `ssh`'s own eventual
//! bind attempt, the TCP probe can still connect to that rival and report
//! success before `ssh` ever tries. That residual window's *duration* is
//! roughly however long `ssh` takes to authenticate, not milliseconds — but
//! it only matters if a rival happens to start listening in that exact
//! gap, which `port_is_free` has already ruled out for anything already
//! there. Narrow, accepted for v1.

use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
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

/// How many bytes of `ssh`'s stderr to keep (most-recent-wins) for a
/// connect-failure message. Just enough for the one or two lines that
/// actually matter (`Permission denied`, `Host key verification failed`,
/// `Connection refused`, `bind: Address already in use`) without letting a
/// chatty host balloon an error string.
const STDERR_LOG_CAP: usize = 2000;

/// A parsed `ssh://<target>[?share-port=<N>]` host string: the ssh target
/// unchanged, and the mermark share port the remote host is listening on
/// (parsed from `?share-port=N`, or `DEFAULT_PORT` when the suffix is
/// absent). `target` is *not* validated for character shape here — see
/// `parse_ssh_suffix` vs. `parse_ssh_host`'s doc comments for why that split
/// exists.
#[derive(Debug)]
pub struct SshHost {
    pub target: String,
    pub share_port: u16,
}

/// The human-readable guidance for every rule ② rejection (missing/unknown
/// query key, non-digit or `+`-prefixed input, out-of-range value) — named so
/// its three call sites below quote identical text rather than drifting
/// copies. Rule ③'s `:`-port rejection (a *different* mistake — writing the
/// SSH port where mermark's share port belongs) has its own, separate
/// message just below `parse_ssh_suffix`'s suffix-parsing `match`.
fn ssh_share_port_guidance() -> String {
    "SSH 호스트의 공유 포트는 ?share-port=1024~65535 형식입니다 — SSH 포트는 ~/.ssh/config에서 지정하세요".into()
}

/// Rules ①②③⑤ of the `ssh://` host grammar (design §1.2) — the target string
/// is split off and returned as-is, its *characters* deliberately
/// unvalidated (rule ④ lives in `parse_ssh_host` alone). This is the
/// narrower check `base_url` needs: is the string's *shape* well-formed
/// (right scheme, a recognized-or-absent suffix, no `:port` confusion on the
/// target) — not "is this actually safe to hand to `ssh`'s argv", which is a
/// stronger question only `tunnel_args` (via `parse_ssh_host`) needs to ask.
/// Splitting the two is what lets `base_url` keep accepting `ssh://맥미니` (a
/// non-ASCII target it has always tolerated, since it never actually dials
/// that string — the real dial target is the fixed local tunnel address)
/// while `tunnel_args` — which DOES pass the target into a real `ssh` argv —
/// still refuses it.
pub fn parse_ssh_suffix(host: &str) -> Result<SshHost, String> {
    let rest = host.strip_prefix("ssh://").ok_or("ssh:// 호스트가 아닙니다")?;
    let mut parts = rest.splitn(2, '?');
    let target = parts.next().unwrap_or("").to_string();
    let share_port = match parts.next() {
        None => crate::remote_client::DEFAULT_PORT,
        Some(suffix) => {
            let digits = suffix.strip_prefix("share-port=").ok_or_else(ssh_share_port_guidance)?;
            // Digits only, checked *before* parsing (audit 🟡-2): `u32::parse`
            // itself accepts a leading `+` (`"+47900"` → `Ok(47900)`), which
            // the TS side's `^share-port=(\d+)$` regex does not — ruling it
            // out here is what keeps "same input, same verdict" true across
            // the 3-boundary fixture.
            if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return Err(ssh_share_port_guidance());
            }
            let port: u32 = digits.parse().map_err(|_| ssh_share_port_guidance())?;
            let port: u16 = u16::try_from(port).map_err(|_| ssh_share_port_guidance())?;
            // Single Rust source for the 1024-65535 range (audit 🟡-2): reuse
            // `validate_share_port` instead of re-deriving the boundary here
            // — a future change to the valid range now can't drift between
            // the host-port and SSH-suffix paths.
            crate::remote_share::validate_share_port(port).map_err(|_| ssh_share_port_guidance())?;
            port
        }
    };
    if target.contains(':') {
        return Err(
            "SSH 대상에 ':포트'를 쓸 수 없습니다 — mermark 공유 포트는 ?share-port=N, SSH 포트는 ~/.ssh/config에서 지정하세요".into(),
        );
    }
    Ok(SshHost { target, share_port })
}

/// The full `ssh://<target>[?share-port=<N>]` grammar, rules ①–⑤ —
/// `parse_ssh_suffix` plus the target character allowlist `tunnel_args` has
/// always enforced (rule ④: non-empty, doesn't start with `-`, only
/// alphanumeric/`@`/`.`/`-`/`_` — unchanged from the pre-`?share-port=`
/// `tunnel_args` rule, just moved here so `tunnel_args` itself can shrink to
/// "parse, then build the argv"). See `parse_ssh_suffix`'s doc comment for
/// why the two are split rather than one function doing both jobs.
pub fn parse_ssh_host(host: &str) -> Result<SshHost, String> {
    let parsed = parse_ssh_suffix(host)?;
    if parsed.target.is_empty() || parsed.target.starts_with('-') {
        return Err("SSH 대상이 올바르지 않습니다".into());
    }
    let ok = parsed.target.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '.' | '-' | '_'));
    if !ok {
        return Err(format!("SSH 대상에 허용되지 않는 문자가 있습니다: {}", parsed.target));
    }
    Ok(parsed)
}

/// `ssh://user@host[?share-port=N]` → the argv for `ssh -o
/// ExitOnForwardFailure=yes -N -L <SSH_TUNNEL_LOCAL_PORT>:localhost:<share
/// port> user@host`. This is exec'd directly as an argument array (see
/// `spawn_tunnel`) and never passed through a shell, so classic shell
/// injection (`;`, `` ` ``, `$(...)`) is already structurally impossible —
/// `parse_ssh_host` (rule ④) is what still refuses a target that could be
/// misread as an `ssh` *option* (a leading `-`, e.g. smuggling
/// `-oProxyCommand=...`), since `ssh` parses its own trailing argument.
///
/// The local end is always the fixed `SSH_TUNNEL_LOCAL_PORT` (never the
/// caller's `?share-port=N`, which names the *remote* host's port only) —
/// deliberately different from `DEFAULT_PORT` so this Mac sharing a vault of
/// its own while also tunneling elsewhere can never self-collide on one
/// loopback port (see `SSH_TUNNEL_LOCAL_PORT`'s doc comment).
///
/// `ExitOnForwardFailure=yes` (fix round 1, Critical 1) is not optional:
/// without it, `ssh -N -L` that loses a bind race (something else already
/// listening on the local port) just logs a warning and keeps running
/// forever, doing nothing — `wait_until_ready`'s "did the child exit" check
/// would never fire, and its TCP probe would happily report success by
/// connecting to whatever *that other* listener is.
pub fn tunnel_args(host: &str) -> Result<Vec<String>, String> {
    let parsed = parse_ssh_host(host)?;
    Ok(vec![
        "-o".into(),
        "ExitOnForwardFailure=yes".into(),
        // Without this, a host that requires an interactive password (no
        // key auth configured) makes `ssh` block on a prompt written to
        // `/dev/tty` — invisible to mermark, which piped stdin closed
        // specifically so it would never have to answer one (see this
        // module's doc comment). That prompt then just sits there for the
        // whole `READY_TIMEOUT` window with nothing useful happening;
        // `BatchMode=yes` makes `ssh` itself refuse to prompt and exit
        // immediately instead, so `has_exited` in `wait_until_ready` reports
        // the real failure right away.
        "-o".into(),
        "BatchMode=yes".into(),
        "-N".into(),
        "-L".into(),
        format!("{}:localhost:{}", crate::remote_client::SSH_TUNNEL_LOCAL_PORT, parsed.share_port),
        parsed.target,
    ])
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
    /// either fails to bind or silently rides someone else's stale forward
    /// (exactly the Critical 1 scenario this module's doc comment
    /// describes — an orphan from *this* process is how that orphan gets
    /// created in the first place). `wait()` after `kill()` reaps the
    /// process so it doesn't linger as a zombie.
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The one thing `SshTunnels` can be holding at any moment. A plain
/// `Option<ActiveTunnel>` (the original shape) had a gap: `connect_with`
/// read the slot, decided to spawn, and only wrote the slot back *after*
/// `ssh` had spawned and become ready — during that whole window the slot
/// still read `Empty`/`None`, so a second overlapping `remote_ssh_connect`
/// call for a different host would see the same "nothing active" answer and
/// spawn its own tunnel too (fix round 1, Important 4: two `ssh` processes
/// racing for the same local port, with whichever `ActiveTunnel` gets
/// written last silently killing the other in `Drop`). `Connecting` closes
/// that gap: the slot is claimed *before* the spawn happens, under the same
/// lock acquisition that made the decision, so nothing else can observe
/// "empty" while a connect is in flight.
enum TunnelSlot {
    Empty,
    Connecting(String),
    Active(ActiveTunnel),
}

impl Default for TunnelSlot {
    fn default() -> Self {
        TunnelSlot::Empty
    }
}

/// Managed Tauri state: at most one SSH tunnel (or in-flight connect
/// attempt) at a time. See this module's doc comment for why.
#[derive(Default)]
pub struct SshTunnels {
    active: Mutex<TunnelSlot>,
}

/// What a connect request should do, given the slot's current contents.
/// Pulled out as its own named rule — rather than left as an inline
/// `if`/`match` inside `connect_with` — because this *is* the port-collision
/// (and connect-race) guard the module doc promises, and a rule with
/// consequences like these deserves a name and a test of its own, not just
/// a branch buried in the spawn logic.
#[derive(Debug, PartialEq)]
enum ConnectDecision {
    /// Already tunneled to this exact host — reuse it, don't spawn a second.
    AlreadyConnected,
    /// Already *connecting* to this exact host (another `remote_ssh_connect`
    /// call is in flight) — refuse rather than race it with a second spawn.
    AlreadyConnecting,
    /// Tunneled (or connecting) to a *different* host right now — refuse
    /// rather than risk two processes racing for the same local port.
    Busy(String),
    /// Nothing active — safe to claim the slot and spawn.
    ShouldSpawn,
}

fn decide_connect(slot: &TunnelSlot, requested_host: &str) -> ConnectDecision {
    match slot {
        TunnelSlot::Active(t) if t.host == requested_host => ConnectDecision::AlreadyConnected,
        TunnelSlot::Active(t) => ConnectDecision::Busy(t.host.clone()),
        TunnelSlot::Connecting(h) if h == requested_host => ConnectDecision::AlreadyConnecting,
        TunnelSlot::Connecting(h) => ConnectDecision::Busy(h.clone()),
        TunnelSlot::Empty => ConnectDecision::ShouldSpawn,
    }
}

/// Non-blocking "has this child already exited on its own" check — a wrong
/// host, a rejected key, or (with `ExitOnForwardFailure=yes`) a lost bind
/// race kills `ssh` moments after spawn, well before `READY_TIMEOUT` would
/// otherwise fire, and a tunnel that died *silently* later (host went to
/// sleep, network dropped) leaves a stale entry in `SshTunnels` that must
/// not block a fresh connect attempt.
fn has_exited(child: &mut Child) -> bool {
    matches!(child.try_wait(), Ok(Some(_)))
}

/// Whether the local end of the forward is currently unclaimed. Checked
/// *before* spawning `ssh` at all (fix round 1, Critical 1) — a bind
/// attempt is the only way to tell "nothing is listening here" from
/// "something already is" without parsing `ssh`'s own stderr, and doing it
/// up front turns a long-lived orphan/rival listener into an immediate,
/// specific refusal instead of an 8-second wait that then (without this
/// check) could have silently "succeeded" against the rival.
fn port_is_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

type StderrLog = Arc<Mutex<String>>;

/// Spawns `program` with `args`, piping stdin (closed — mermark never
/// answers an interactive prompt) and stderr (drained on a background
/// thread into the returned log — see `drain_into`'s doc comment). stdout is
/// discarded: `ssh -N` prints nothing to stdout by design.
fn spawn_tunnel(program: &str, args: &[String]) -> Result<(Child, StderrLog), String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{program} 실행 실패: {e}"))?;
    let log: StderrLog = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let log_for_thread = log.clone();
        std::thread::spawn(move || drain_into(stderr, log_for_thread));
    }
    Ok((child, log))
}

/// Reads `r` to EOF, appending everything into `log` (capped at
/// `STDERR_LOG_CAP` bytes, keeping the most recent output). `ssh` can write
/// to stderr (host-key prompts, "Permission denied", "bind: Address already
/// in use", banner text, ...); with stdin closed there is nothing mermark
/// can answer an interactive prompt with, but the pipe still has a finite OS
/// buffer — if nobody reads it, a chatty `ssh` blocks on the write and the
/// tunnel never comes up. This thread keeps that pipe from filling *and*
/// (fix round 1, Important 3) retains what `ssh` actually said, so a connect
/// failure can quote the real reason instead of forcing the user to guess
/// whether "host down" or "wrong password" is why `REMOTE:Unreachable` came
/// back.
fn drain_into(mut r: impl Read, log: StderrLog) {
    let mut buf = [0u8; 256];
    loop {
        match r.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if let Ok(mut s) = log.lock() {
                    s.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if s.len() > STDERR_LOG_CAP {
                        let excess = s.len() - STDERR_LOG_CAP;
                        s.replace_range(0..excess, "");
                    }
                }
            }
        }
    }
}

/// The trailing `" — <ssh's stderr, sanitized>"` suffix for a connect-failure
/// message, or `""` if `ssh` said nothing useful. Sanitizes control
/// characters (ANSI escapes, carriage returns from a progress banner) out of
/// what is otherwise untrusted-ish process output before it lands in an
/// error string the frontend displays verbatim.
fn stderr_suffix(log: &StderrLog) -> String {
    let raw = log.lock().map(|s| s.clone()).unwrap_or_default();
    let cleaned: String = raw.chars().filter(|c| !c.is_control() || *c == '\n').collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        String::new()
    } else {
        format!(" — {trimmed}")
    }
}

/// Polls until the local end of the tunnel accepts a TCP connection, the
/// child exits on its own (a definite failure — no point waiting out the
/// rest of the timeout), or `timeout` elapses. Every failure here maps to
/// `REMOTE:Unreachable` — from the client's point of view, "the tunnel
/// never came up" and "the host is unreachable" are the same actionable
/// state (reuses the four states `remote_client::RemoteStatus` already
/// defines rather than inventing a fifth one this module would own alone) —
/// but the message now (fix round 1, Important 3) carries `ssh`'s own
/// stderr tail so "wrong password" and "host is down" no longer look
/// identical to the person reading the error.
///
/// Sleeps *before* the first check rather than checking immediately — a
/// cheap way to avoid a guaranteed-wasted iteration at t=0 (nothing can be
/// listening yet a moment after spawn). It is NOT what protects against a
/// lost bind race (corrected fix round 2, see this module's doc comment for
/// why): OpenSSH only attempts the `-L` bind *after* authentication
/// completes, well past one `poll` interval, so `has_exited` catches that
/// failure whenever it actually happens over the full `timeout` window —
/// the sleep changes when the loop starts polling, not how fast a lost race
/// is detected.
async fn wait_until_ready(
    child: &mut Child,
    port: u16,
    timeout: Duration,
    poll: Duration,
    log: &StderrLog,
) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        tokio::time::sleep(poll).await;
        if has_exited(child) {
            return Err(format!(
                "REMOTE:{:?}: SSH 터널이 시작 직후 종료되었습니다 (호스트 또는 SSH 인증을 확인하세요){}",
                crate::remote_client::RemoteStatus::Unreachable,
                stderr_suffix(log)
            ));
        }
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "REMOTE:{:?}: SSH 터널이 {}초 내에 준비되지 않았습니다{}",
                crate::remote_client::RemoteStatus::Unreachable,
                timeout.as_secs(),
                stderr_suffix(log)
            ));
        }
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
    // Reap + decide + claim all happen under ONE lock acquisition (fix round
    // 1, Important 4) — splitting "decide" and "claim" into separate
    // lock()s left a gap where two overlapping calls could both observe
    // `ShouldSpawn` and both spawn. Reaping first (a slot whose process
    // already exited on its own) means a tunnel that died silently never
    // blocks reconnecting, to the same host or a different one.
    let decision = {
        let mut guard = state.active.lock().unwrap();
        if let TunnelSlot::Active(t) = &mut *guard {
            if has_exited(&mut t.child) {
                *guard = TunnelSlot::Empty;
            }
        }
        let decision = decide_connect(&guard, host);
        if decision == ConnectDecision::ShouldSpawn {
            *guard = TunnelSlot::Connecting(host.to_string());
        }
        decision
    };
    match decision {
        ConnectDecision::AlreadyConnected => return Ok(()),
        ConnectDecision::AlreadyConnecting => {
            return Err(format!("SSH_TUNNEL_CONNECTING: {host}에 이미 연결을 시도하는 중입니다."));
        }
        ConnectDecision::Busy(other) => {
            return Err(format!(
                "SSH_TUNNEL_BUSY: 이미 다른 호스트({other})로 SSH 터널이 연결되어 있습니다. 먼저 연결을 해제하세요."
            ));
        }
        ConnectDecision::ShouldSpawn => {}
    }

    // From here on this call owns the `Connecting(host)` claim; any error
    // path below must release it (reset to `Empty`) before returning.
    let release_claim = |state: &SshTunnels| {
        *state.active.lock().unwrap() = TunnelSlot::Empty;
    };

    if !port_is_free(port) {
        release_claim(state);
        return Err(format!(
            "SSH_TUNNEL_PORT_IN_USE: 이 기기의 127.0.0.1:{port}를 다른 프로그램이 쓰고 있습니다 (이전 mermark의 ssh가 남아 있을 수 있습니다 — 종료 후 다시 시도)."
        ));
    }

    let args = match tunnel_args(host) {
        Ok(args) => args,
        Err(e) => {
            release_claim(state);
            return Err(e);
        }
    };
    let (mut child, log) = match spawn_tunnel(program, &args) {
        Ok(v) => v,
        Err(e) => {
            release_claim(state);
            return Err(e);
        }
    };
    if let Err(e) = wait_until_ready(&mut child, port, timeout, poll, &log).await {
        let _ = child.kill();
        let _ = child.wait();
        release_claim(state);
        return Err(e);
    }

    *state.active.lock().unwrap() = TunnelSlot::Active(ActiveTunnel { host: host.to_string(), child });
    Ok(())
}

/// Kills and drops the active tunnel if (and only if) it's the one for
/// `host` — a disconnect for a host that isn't the active one (including a
/// `Connecting` claim, or `Empty`) is a no-op, same "the off toggle never
/// fails just because it's already off" idiom `remote_share_stop` uses. A
/// concurrent `Connecting(host)` is deliberately left alone rather than
/// interrupted — a rare enough race in v1 that it isn't worth the extra
/// state to cancel cleanly.
async fn disconnect(host: &str, state: &SshTunnels) {
    let mut guard = state.active.lock().unwrap();
    if let TunnelSlot::Active(t) = &*guard {
        if t.host == host {
            *guard = TunnelSlot::Empty; // ActiveTunnel::drop kills + reaps the child
        }
    }
}

/// Kills whatever tunnel is currently active (if any) unconditionally — the
/// app-exit cleanup path (fix round 1, Critical 2), as opposed to
/// `disconnect`'s host-scoped, user-initiated teardown. A `Connecting` claim
/// with no child yet has nothing to kill and is simply cleared.
pub fn shutdown_all(state: &SshTunnels) {
    *state.active.lock().unwrap() = TunnelSlot::Empty;
}

/// Establishes (or reuses) an SSH tunnel to `host` so `remote_client`'s
/// `ssh://`-mapped commands have a live `127.0.0.1:SSH_TUNNEL_LOCAL_PORT` to
/// talk to. Idempotent for the same host; refuses a different host (or a
/// second in-flight connect) while one is active — see `decide_connect`.
#[tauri::command]
pub async fn remote_ssh_connect(host: String, state: tauri::State<'_, SshTunnels>) -> Result<(), String> {
    connect_with("ssh", &host, crate::remote_client::SSH_TUNNEL_LOCAL_PORT, READY_TIMEOUT, READY_POLL_INTERVAL, &state).await
}

/// Tears the tunnel for `host` down (vault removed, or the user explicitly
/// disconnects). A no-op if `host` isn't the currently tunneled one.
#[tauri::command]
pub async fn remote_ssh_disconnect(host: String, state: tauri::State<'_, SshTunnels>) -> Result<(), String> {
    disconnect(&host, &state).await;
    Ok(())
}

/// Whether the tunnel currently active in `state` — if any — is the one that
/// would actually serve `host`. `remote_client.rs`'s ssh-routed commands
/// check this immediately before sending, closing a hole `base_url` opens by
/// design: `base_url` maps *every* `ssh://...` host to the same fixed local
/// address (`127.0.0.1:SSH_TUNNEL_LOCAL_PORT`, the one shared tunnel slot this module
/// enforces — see this module's doc comment), discarding which host that
/// address currently forwards to. Concretely: a tunnel to host A is Active;
/// A reboots, so the `ssh` child exits on its own; the user opens a vault on
/// host B, and `connect_with`'s dead-tunnel reaping (see its doc comment)
/// lets B's `remote_ssh_connect` claim the same slot and spawn B's tunnel on
/// the same local port; the user then switches back to the still-registered
/// A vault. Without this guard, `remote_list_dir(host=A)` would resolve to
/// `127.0.0.1:SSH_TUNNEL_LOCAL_PORT` exactly as before — which is now B's tunnel —
/// and hand A's 128-bit device token to B's machine. Named so it reads as
/// the promise it makes ("this tunnel currently serves this host"), not
/// merely "is something active" — `decide_connect`'s `AlreadyConnected` asks
/// a related but distinct question (should a *new* connect reuse the slot),
/// and conflating the two here would have let this guard rubber-stamp a
/// tunnel to the wrong host just because *some* tunnel happens to be up.
pub fn tunnel_serves(state: &SshTunnels, host: &str) -> bool {
    matches!(&*state.active.lock().unwrap(), TunnelSlot::Active(t) if t.host == host)
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- tunnel_args (task-12 brief's own contract, now with the fix round
    // 1 ExitOnForwardFailure option prepended) --------------------------------

    #[test]
    fn builds_a_local_forward_command_without_touching_keys() {
        let args = tunnel_args("ssh://wis@macmini").unwrap();
        assert_eq!(
            args,
            vec![
                "-o", "ExitOnForwardFailure=yes",
                "-o", "BatchMode=yes",
                "-N", "-L", "47879:localhost:47878", "wis@macmini",
            ]
        );
    }

    #[test]
    fn tunnel_args_honors_an_explicit_share_port() {
        let args = tunnel_args("ssh://wis@mac-mini?share-port=47900").unwrap();
        assert_eq!(
            args,
            vec![
                "-o", "ExitOnForwardFailure=yes",
                "-o", "BatchMode=yes",
                "-N", "-L", "47879:localhost:47900", "wis@mac-mini",
            ]
        );
    }

    #[test]
    fn rejects_a_host_that_is_not_ssh_scheme() {
        assert!(tunnel_args("wis-macmini").is_err());
    }

    #[test]
    fn rejects_shell_metacharacters_in_the_ssh_target() {
        assert!(tunnel_args("ssh://wis@macmini; rm -rf /").is_err());
        assert!(tunnel_args("ssh://wis@macmini$(whoami)").is_err());
    }

    #[test]
    fn rejects_a_target_that_could_be_read_as_an_ssh_option() {
        // A leading `-` in the (post-`ssh://`) target could otherwise smuggle
        // an ssh option (e.g. `-oProxyCommand=...`) past this function's own
        // validation and into `ssh`'s argv.
        assert!(tunnel_args("ssh://-oProxyCommand=evil").is_err());
    }

    // --- parse_ssh_host / parse_ssh_suffix (the `?share-port=N` grammar,
    // design §1.2 rules ①–⑤) ---------------------------------------------------

    #[test]
    fn parse_ssh_host_defaults_share_port_when_absent() {
        let parsed = parse_ssh_host("ssh://wis@macmini").unwrap();
        assert_eq!(parsed.target, "wis@macmini");
        assert_eq!(parsed.share_port, crate::remote_client::DEFAULT_PORT);
    }

    #[test]
    fn parse_ssh_host_accepts_an_explicit_share_port() {
        let parsed = parse_ssh_host("ssh://wis@mac-mini?share-port=47900").unwrap();
        assert_eq!(parsed.target, "wis@mac-mini");
        assert_eq!(parsed.share_port, 47900);
    }

    #[test]
    fn parse_ssh_host_rejects_a_share_port_below_1024() {
        assert!(parse_ssh_host("ssh://wis@mac-mini?share-port=80").is_err());
    }

    #[test]
    fn parse_ssh_host_rejects_a_non_numeric_share_port() {
        assert!(parse_ssh_host("ssh://wis@mac-mini?share-port=abc").is_err());
    }

    /// Audit 🟡-2: `u32::parse` itself accepts a leading `+` (`"+47900"`
    /// parses to `47900`), but the TS side's `^share-port=(\d+)$` regex does
    /// not — a 3-boundary drift the shared fixture is supposed to catch.
    /// Digits-only, checked *before* parsing, closes it on the Rust side.
    #[test]
    fn parse_ssh_host_rejects_a_share_port_with_a_leading_plus_sign() {
        assert!(parse_ssh_host("ssh://wis@mac-mini?share-port=+47900").is_err());
    }

    #[test]
    fn parse_ssh_host_rejects_an_unknown_query_key() {
        // `?port=N` is refused, not silently treated as `?share-port=N` —
        // the two are easy to confuse (SSH's own port vs. mermark's share
        // port), so only the one exact key name is accepted.
        let err = parse_ssh_host("ssh://wis@mac-mini?port=47900").unwrap_err();
        assert!(err.contains("share-port"), "got: {err}");
    }

    #[test]
    fn parse_ssh_host_rejects_a_colon_port_on_the_target_with_guidance() {
        // `ssh://host:N` reads as the SSH port in OpenSSH's own URI syntax —
        // refusing it (rather than silently reinterpreting it as the share
        // port) is what stops that exact confusion.
        let err = parse_ssh_host("ssh://wis@mac-mini:47900").unwrap_err();
        assert!(err.contains("share-port"), "got: {err}");
        assert!(err.contains(".ssh/config"), "got: {err}");
    }

    #[test]
    fn parse_ssh_host_rejects_shell_metacharacters_in_the_target() {
        assert!(parse_ssh_host("ssh://wis@macmini; rm -rf /").is_err());
    }

    #[test]
    fn parse_ssh_host_rejects_a_target_starting_with_a_dash() {
        assert!(parse_ssh_host("ssh://-oProxyCommand=evil").is_err());
    }

    #[test]
    fn parse_ssh_host_rejects_a_non_ssh_scheme() {
        assert!(parse_ssh_host("wis-macmini").is_err());
    }

    /// `parse_ssh_suffix` is the narrower rule `base_url` uses (rules ②③⑤
    /// only, no rule ④ target character check) — it must keep accepting a
    /// non-ASCII target `base_url`'s ssh branch has always tolerated, since
    /// `base_url` never actually dials that string itself.
    #[test]
    fn parse_ssh_suffix_accepts_a_non_ascii_target_that_parse_ssh_host_would_reject() {
        assert!(parse_ssh_suffix("ssh://맥미니").is_ok());
        assert!(parse_ssh_host("ssh://맥미니").is_err());
    }

    #[test]
    fn parse_ssh_suffix_still_rejects_the_colon_port_confusion() {
        assert!(parse_ssh_suffix("ssh://wis@mac-mini:47900").is_err());
    }

    // --- decide_connect: the port-collision / connect-race guard, in
    // isolation ----------------------------------------------------------------

    #[test]
    fn decide_connect_reuses_an_existing_tunnel_to_the_same_host() {
        let child = spawn_sleep(5);
        let active = TunnelSlot::Active(ActiveTunnel { host: "ssh://a@h".into(), child });
        assert_eq!(decide_connect(&active, "ssh://a@h"), ConnectDecision::AlreadyConnected);
        // active's ActiveTunnel drops here, killing + reaping the child.
    }

    #[test]
    fn decide_connect_refuses_a_second_host_while_one_is_active() {
        let child = spawn_sleep(5);
        let active = TunnelSlot::Active(ActiveTunnel { host: "ssh://a@h1".into(), child });
        match decide_connect(&active, "ssh://a@h2") {
            ConnectDecision::Busy(other) => assert_eq!(other, "ssh://a@h1"),
            other => panic!("expected Busy, got {other:?}"),
        }
    }

    #[test]
    fn decide_connect_spawns_when_nothing_is_active() {
        assert_eq!(decide_connect(&TunnelSlot::Empty, "ssh://a@h"), ConnectDecision::ShouldSpawn);
    }

    #[test]
    fn decide_connect_refuses_a_second_concurrent_connect_to_a_different_host() {
        let connecting = TunnelSlot::Connecting("ssh://a@h1".into());
        match decide_connect(&connecting, "ssh://a@h2") {
            ConnectDecision::Busy(other) => assert_eq!(other, "ssh://a@h1"),
            other => panic!("expected Busy, got {other:?}"),
        }
    }

    #[test]
    fn decide_connect_treats_a_duplicate_connect_to_the_same_host_as_already_connecting() {
        let connecting = TunnelSlot::Connecting("ssh://a@h".into());
        assert_eq!(decide_connect(&connecting, "ssh://a@h"), ConnectDecision::AlreadyConnecting);
    }

    // --- wait_until_ready: readiness / failure detection, including the
    // stderr capture ------------------------------------------------------------

    fn spawn_sleep(secs: u64) -> Child {
        Command::new("sleep")
            .arg(secs.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    }

    fn empty_log() -> StderrLog {
        Arc::new(Mutex::new(String::new()))
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
        let res = wait_until_ready(&mut child, port, Duration::from_secs(2), Duration::from_millis(30), &empty_log()).await;
        assert!(res.is_ok(), "{res:?}");
        let _ = child.kill();
        let _ = child.wait();
    }

    #[tokio::test]
    async fn wait_until_ready_fails_fast_when_the_child_exits_immediately() {
        let mut child = Command::new("sh")
            .args(["-c", "echo 'Permission denied (publickey)' 1>&2; exit 1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let log: StderrLog = Arc::new(Mutex::new(String::new()));
        if let Some(stderr) = child.stderr.take() {
            let log2 = log.clone();
            std::thread::spawn(move || drain_into(stderr, log2));
        }
        // Give the shell (and the drain thread) a moment to actually finish
        // before polling — this pins "exited before the port ever came up",
        // not a race against the process table or the pipe.
        tokio::time::sleep(Duration::from_millis(150)).await;
        let err = wait_until_ready(&mut child, 1, Duration::from_secs(2), Duration::from_millis(30), &log)
            .await
            .unwrap_err();
        assert!(err.contains("REMOTE:Unreachable"), "got: {err}");
        assert!(err.contains("Permission denied"), "stderr must be surfaced, got: {err}");
    }

    #[tokio::test]
    async fn wait_until_ready_times_out_when_nothing_ever_listens() {
        let mut child = spawn_sleep(5);
        let err = wait_until_ready(&mut child, 1, Duration::from_millis(150), Duration::from_millis(30), &empty_log())
            .await
            .unwrap_err();
        assert!(err.contains("REMOTE:Unreachable"), "got: {err}");
        let _ = child.kill();
        let _ = child.wait();
    }

    // --- port_is_free / the Critical-1 pre-existing-listener defense --------

    #[test]
    fn port_is_free_is_false_when_something_is_already_listening() {
        // Does not also assert the port becomes free again after `drop` —
        // cargo runs tests in this file concurrently on several threads,
        // each picking its own ephemeral port via `bind("127.0.0.1:0")`, and
        // the OS is free to immediately hand a just-released port to one of
        // those *other* tests, making a "recheck after drop" assertion here
        // flaky by construction rather than by any bug in `port_is_free`.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(!port_is_free(port));
        drop(listener);
    }

    #[tokio::test]
    async fn connect_refuses_to_spawn_when_a_stranger_already_holds_the_port() {
        // Simulates exactly the Critical-1 scenario: something that is NOT
        // our tunnel (an orphaned prior `ssh -N`, a hand-started tunnel, this
        // Mac's own localhost-only remote_share) is already bound to the
        // local port *before* connect_with is ever called. Without the
        // port_is_free pre-check this would have spawned `ssh` anyway and
        // then "succeeded" by reading the stranger's listener.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        let state = SshTunnels::default();
        let err = connect_with("ssh", "ssh://wis@macmini", port, Duration::from_secs(1), Duration::from_millis(20), &state)
            .await
            .unwrap_err();
        assert!(err.starts_with("SSH_TUNNEL_PORT_IN_USE"), "got: {err}");
        // The slot must not be left claimed after a refused connect.
        assert!(matches!(*state.active.lock().unwrap(), TunnelSlot::Empty));
        drop(listener);
    }

    // --- connect_with / disconnect / shutdown_all: the full lifecycle, with
    // a harmless local stand-in for `ssh` (never the real binary, never a
    // real host) -----------------------------------------------------------------

    #[cfg(unix)]
    fn fake_ssh_script(dir: &std::path::Path) -> String {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join("fake_ssh.sh");
        // Ignores whatever argv it's given (the real ssh's `-o
        // ExitOnForwardFailure=yes -N -L ... user@host` included) and just
        // sits there — the test's own TcpListener (bound *before* this
        // spawns) is what makes the readiness probe succeed, not anything
        // this script does.
        std::fs::write(&script, "#!/bin/sh\nsleep 5\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script.to_string_lossy().into_owned()
    }

    /// Picks a fresh ephemeral port, spawns a background acceptor standing
    /// in for `ssh`'s own successful bind, and calls `connect_with` against
    /// it — retrying with a brand-new port up to 5 times whenever the
    /// probe-then-release-then-reclaim gap loses the port to an unrelated
    /// concurrent test in the same `cargo test` binary (see the doc comment
    /// on `connect_reuses_the_same_host_and_refuses_a_second_one`, the first
    /// test that hit this). Shared by that test and
    /// `tunnel_serves_flips_to_the_new_host_after_a_dead_tunnel_is_reaped_and_replaced`,
    /// which hits the identical race — do not let a third test reimplement
    /// this loop.
    #[cfg(unix)]
    async fn connect_with_retrying_port_race(program: &str, host: &str, timeout: Duration, poll: Duration, state: &SshTunnels) -> u16 {
        for _ in 0..5 {
            let port = {
                let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
                probe.local_addr().unwrap().port()
            };
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(5)).await;
                if let Ok(listener) = tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
                    loop {
                        if listener.accept().await.is_err() {
                            break;
                        }
                    }
                }
            });
            match connect_with(program, host, port, timeout, poll, state).await {
                Ok(()) => return port,
                Err(e) if e.starts_with("SSH_TUNNEL_PORT_IN_USE") => continue,
                Err(e) => panic!("unexpected connect_with failure: {e}"),
            }
        }
        panic!("connect_with kept losing the port race after 5 retries");
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

        let state = SshTunnels::default();
        let timeout = Duration::from_secs(2);
        let poll = Duration::from_millis(20);

        // Picks a free ephemeral port, releases it immediately, then spawns
        // a background task that reclaims that same port shortly after —
        // standing in for ssh's own successful bind (the fake "ssh" script
        // above is a no-op `sleep`; nothing it does ever opens the port),
        // deliberately delayed so it lands *after* `connect_with`'s
        // synchronous, pre-await `port_is_free` check (fix round 1,
        // Critical 1) but well before `wait_until_ready`'s timeout.
        //
        // The probe-then-release-then-reclaim gap is occasionally lost to
        // an unrelated concurrent test in this same binary also cycling
        // through `bind("127.0.0.1:0")` (observed under a full `cargo test`
        // run, not `cargo test remote_ssh` alone) — that shows up as this
        // test's own `connect_with` seeing `SSH_TUNNEL_PORT_IN_USE` for a port that
        // some other test's socket, not ours, ended up holding for a
        // moment. That's test-infra noise, not a regression in the guard
        // this test exists to exercise, so a few retries with a fresh port
        // (`connect_with_retrying_port_race`, shared with
        // `tunnel_serves_flips_to_the_new_host_after_a_dead_tunnel_is_reaped_and_replaced`
        // below, which hits the exact same race) absorb it rather than the
        // test flaking outright.
        let port = connect_with_retrying_port_race(&program, "ssh://wis@macmini", timeout, poll, &state).await;
        match &*state.active.lock().unwrap() {
            TunnelSlot::Active(t) => assert_eq!(t.host, "ssh://wis@macmini"),
            _ => panic!("expected TunnelSlot::Active after a successful connect"),
        }

        // Reconnecting to the same host reuses the tunnel — never errors.
        connect_with(&program, "ssh://wis@macmini", port, timeout, poll, &state).await.unwrap();

        // A different host is refused while this one is active — the
        // port-collision guard.
        let err = connect_with(&program, "ssh://other@host", port, timeout, poll, &state)
            .await
            .unwrap_err();
        assert!(err.starts_with("SSH_TUNNEL_BUSY"), "got: {err}");

        disconnect("ssh://wis@macmini", &state).await;
        assert!(matches!(*state.active.lock().unwrap(), TunnelSlot::Empty));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn disconnect_is_a_noop_when_nothing_is_connected() {
        let state = SshTunnels::default();
        disconnect("ssh://nobody@nowhere", &state).await; // must not panic
        assert!(matches!(*state.active.lock().unwrap(), TunnelSlot::Empty));
    }

    #[tokio::test]
    async fn disconnect_ignores_a_host_that_is_not_the_active_one() {
        let mut child = spawn_sleep(5);
        assert!(!has_exited(&mut child));
        let state = SshTunnels::default();
        *state.active.lock().unwrap() = TunnelSlot::Active(ActiveTunnel { host: "ssh://a@h".into(), child });

        disconnect("ssh://different@host", &state).await;
        assert!(
            matches!(*state.active.lock().unwrap(), TunnelSlot::Active(_)),
            "disconnect for the wrong host must be a no-op"
        );

        disconnect("ssh://a@h", &state).await;
        assert!(matches!(*state.active.lock().unwrap(), TunnelSlot::Empty));
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

    // --- shutdown_all: the app-exit cleanup hook (fix round 1, Critical 2) --

    #[test]
    fn shutdown_all_kills_the_active_child() {
        let child = spawn_sleep(30);
        let pid = child.id();
        let state = SshTunnels::default();
        *state.active.lock().unwrap() = TunnelSlot::Active(ActiveTunnel { host: "ssh://a@h".into(), child });

        shutdown_all(&state);

        assert!(matches!(*state.active.lock().unwrap(), TunnelSlot::Empty));
        // The process must actually be gone, not just forgotten by our slot:
        // `kill -0` fails once the pid is no longer running (or has become a
        // reaped zombie, which `wait()` inside Drop already cleaned up).
        let still_alive = std::process::Command::new("kill").args(["-0", &pid.to_string()]).status().map(|s| s.success()).unwrap_or(false);
        assert!(!still_alive, "shutdown_all must actually kill the child, pid {pid} is still alive");
    }

    #[test]
    fn shutdown_all_is_a_noop_when_nothing_is_connecting_or_active() {
        let state = SshTunnels::default();
        shutdown_all(&state); // must not panic
        assert!(matches!(*state.active.lock().unwrap(), TunnelSlot::Empty));
    }

    // --- tunnel_serves: the cross-host token-leak guard (fix round 3,
    // Important 3) ---------------------------------------------------------

    #[test]
    fn tunnel_serves_is_false_when_nothing_is_active() {
        let state = SshTunnels::default();
        assert!(!tunnel_serves(&state, "ssh://a@h"));
    }

    #[test]
    fn tunnel_serves_is_true_only_for_the_host_the_active_tunnel_actually_serves() {
        let child = spawn_sleep(5);
        let state = SshTunnels::default();
        *state.active.lock().unwrap() = TunnelSlot::Active(ActiveTunnel { host: "ssh://a@h1".into(), child });

        assert!(tunnel_serves(&state, "ssh://a@h1"), "활성 터널이 실제로 서비스하는 호스트여야 한다");
        assert!(
            !tunnel_serves(&state, "ssh://a@h2"),
            "다른 호스트를 대상으로 한 터널로 오인하면 안 된다 — 토큰이 잘못된 호스트로 전송될 수 있다"
        );
    }

    #[test]
    fn tunnel_serves_is_false_while_only_connecting_not_yet_active() {
        let state = SshTunnels::default();
        *state.active.lock().unwrap() = TunnelSlot::Connecting("ssh://a@h".into());
        assert!(
            !tunnel_serves(&state, "ssh://a@h"),
            "연결 중일 뿐 아직 서비스할 수 없는 터널을 서비스 중이라고 보고하면 안 된다"
        );
    }

    /// The exact scenario `tunnel_serves`'s doc comment describes: host A's
    /// tunnel dies (simulating a reboot — the child process exits on its
    /// own), a `connect_with` for a different host B reaps the dead slot and
    /// takes it over, and a stale caller still asking about A must get
    /// `false`, never a leftover `true` from before the takeover.
    #[cfg(unix)]
    #[tokio::test]
    async fn tunnel_serves_flips_to_the_new_host_after_a_dead_tunnel_is_reaped_and_replaced() {
        let dir = std::env::temp_dir().join(format!(
            "mermark_ssh_tunnel_serves_{}_{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let program = fake_ssh_script(&dir);
        let state = SshTunnels::default();

        // Host A's tunnel: a child that exits immediately on its own,
        // standing in for "the remote host rebooted, so ssh's connection
        // died and it exited" — connect_with itself is not exercised here,
        // only the slot's contents, since this test cares about
        // tunnel_serves reading the slot correctly across a takeover, not
        // about the reaping logic (already covered by
        // `connect_with`'s own tests).
        let mut dead = Command::new("sh").args(["-c", "exit 0"]).spawn().unwrap();
        let _ = dead.wait();
        *state.active.lock().unwrap() = TunnelSlot::Active(ActiveTunnel { host: "ssh://a@h1".into(), child: dead });
        assert!(tunnel_serves(&state, "ssh://a@h1"));

        // A connect for a different host reaps the dead slot and claims it.
        // Uses the same retrying probe-bind as
        // `connect_reuses_the_same_host_and_refuses_a_second_one` — this
        // test hits the identical concurrent-port-reuse race under a full
        // `cargo test` run and would otherwise panic on the same
        // `SSH_TUNNEL_PORT_IN_USE` a bare single-shot bind can lose to.
        connect_with_retrying_port_race(&program, "ssh://b@h2", Duration::from_secs(2), Duration::from_millis(20), &state).await;

        assert!(
            !tunnel_serves(&state, "ssh://a@h1"),
            "죽은 A 터널이 재사용된 후에는 A를 서비스한다고 보고하면 안 된다"
        );
        assert!(tunnel_serves(&state, "ssh://b@h2"), "새로 연결된 B가 지금 서비스 중인 호스트여야 한다");

        std::fs::remove_dir_all(&dir).ok();
    }
}
