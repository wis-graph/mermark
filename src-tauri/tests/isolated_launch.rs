//! Ignored integration test for single-window-opening Todo 2's isolated
//! launch path (`mermark -`). Spawns two real processes — a singleton
//! primary (no args) and a piped-stdin secondary (`-`) — and asserts the
//! secondary is never intercepted by the primary's single-instance plugin
//! (`Isolated` launches never install that plugin, see
//! `LaunchClass::joins_singleton`) and that its piped bytes land, byte for
//! byte, in the scratch file `write_stdin_to_scratch` buffers them into.
//!
//! Spawns real GUI windows, so this is `#[ignore]` and meant to be run
//! locally, once, by hand:
//!
//!     cargo test --test isolated_launch -- --ignored
//!
//! `--right` window-geometry assertions are explicitly out of scope here —
//! moved to Todo 6 (see `_workspace/01_architect_todo2_design.md`, 분기4):
//! this crate has no observation surface for real window coordinates, so a
//! process-level test can't assert on them without inventing one.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

fn bin_path() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_mermark"))
}

/// The single-instance socket the *production* identifier resolves to.
///
/// This binary is built with `tauri.conf.json`'s real `identifier`
/// (`com.mermark.app`), which is what `tauri-plugin-single-instance` derives
/// its socket path from — so a debug build spawned here joins **the same
/// singleton as an installed mermark the developer is actually using**. It
/// cannot be overridden at runtime; the identifier is baked in at build time
/// (`scripts/window-routing-smoke.mjs` sidesteps this by building its own
/// binary under a QA identifier, which a cargo integration test cannot do).
///
/// So this test refuses to run while that socket exists. See
/// `assert_no_foreign_singleton`.
const PRODUCTION_SINGLETON_SOCKET: &str = "/tmp/com_mermark_app_si.sock";

/// Refuse to run when someone else already holds the production singleton.
///
/// Without this the test does real harm *and* lies: the spawned "primary"
/// finds the socket taken, so it forwards its argv to the developer's running
/// mermark and exits immediately — the app is signalled (its window is pulled
/// to the front by the `FocusOnly` route), and every later assertion is then
/// measured against *that* app instead of the primary this test meant to
/// start. The test still passed when this happened, which is the worse half:
/// a green that proved nothing.
fn assert_no_foreign_singleton() {
    assert!(
        !PathBuf::from(PRODUCTION_SINGLETON_SOCKET).exists(),
        "refusing to run: {PRODUCTION_SINGLETON_SOCKET} exists, so another mermark already owns \
         the singleton. This test would signal that app instead of its own primary and would \
         then assert against the wrong process. Quit the running mermark and re-run."
    );
}

fn kill_and_wait(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
#[ignore = "spawns real GUI windows"]
fn stdin_pipe_survives_running_singleton() {
    // 1. Start the primary (singleton) process with no args — an ordinary
    // `SingletonRouted(None)` launch that installs the single-instance
    // plugin and opens the default `main` window.
    assert_no_foreign_singleton();

    let mut primary = Command::new(bin_path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("failed to spawn primary mermark process");

    // Give the primary time to install the single-instance plugin and open
    // its window before the secondary launches.
    std::thread::sleep(Duration::from_secs(2));

    // The primary must still be running, which is what proves it actually
    // *claimed* the singleton. A process that found the socket already held
    // notifies the existing owner and exits inside the plugin's setup
    // (tauri-plugin-single-instance's `platform_impl/macos.rs` calls
    // `std::process::exit(0)` there), so an exited "primary" means the
    // singleton under test belongs to some other process — and everything
    // below would be measuring that one. Checking liveness here makes that
    // false green impossible even if the socket-path guard above ever goes
    // stale (a changed identifier, a different tmp dir).
    if let Some(status) = primary.try_wait().expect("try_wait primary") {
        panic!(
            "primary exited immediately (status: {status:?}) — it did not claim the singleton, so \
             another mermark owns it. Refusing to assert against a foreign process."
        );
    }

    // 2. Launch a second, isolated process with piped stdin (`mermark -`).
    let mut secondary = Command::new(bin_path())
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("failed to spawn secondary mermark process");

    {
        let mut stdin = secondary.stdin.take().expect("secondary stdin handle");
        stdin.write_all(b"# pipe").expect("write piped stdin");
        // Dropping `stdin` here closes the write end, so the secondary's
        // blocking read of stdin (`write_stdin_to_scratch`) sees EOF.
    }

    // 3. The secondary must survive — `Isolated` launches never install the
    // single-instance plugin (`LaunchClass::joins_singleton` is false for
    // them), so the primary must not intercept or kill it. Give it time to
    // read stdin, buffer it to scratch, and start its own window, then
    // assert it's still running rather than having exited immediately.
    std::thread::sleep(Duration::from_secs(2));
    if let Some(status) = secondary.try_wait().expect("try_wait secondary") {
        kill_and_wait(primary);
        panic!(
            "secondary process exited early (status: {status:?}) — an isolated `-` launch must \
             keep running its own window, not be intercepted by the primary singleton"
        );
    }

    // 4. The scratch file the secondary buffered its piped stdin into must
    // exist, named `mermark-stdin-{pid}-1.md` (seq starts at 1 per
    // process — see `write_stdin_to_scratch`), with exactly the piped bytes.
    let secondary_pid = secondary.id();
    let scratch = std::env::temp_dir().join(format!("mermark-stdin-{secondary_pid}-1.md"));
    let contents = std::fs::read_to_string(&scratch);

    // 5. Clean up regardless of the assertion outcome below.
    kill_and_wait(secondary);
    kill_and_wait(primary);

    let contents = contents.unwrap_or_else(|e| panic!("expected scratch file {scratch:?}: {e}"));
    let _ = std::fs::remove_file(&scratch);
    assert_eq!(contents, "# pipe");
}
