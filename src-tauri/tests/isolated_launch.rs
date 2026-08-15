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
    let primary = Command::new(bin_path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("failed to spawn primary mermark process");

    // Give the primary time to install the single-instance plugin and open
    // its window before the secondary launches.
    std::thread::sleep(Duration::from_secs(2));

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
