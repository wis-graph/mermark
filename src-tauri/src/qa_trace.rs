//! Debug-only QA trace seam (single-window-opening Todo 6). Every event a
//! call site wants observed goes through the `qa_trace!` macro, never
//! through this module's functions directly — the macro is what makes the
//! seam disappear from a release binary, not a runtime check.
//!
//! ## Why a macro, not a plain function behind `if cfg!(debug_assertions)`
//! A runtime `if` still *compiles* the guarded code (and its string
//! literals) into every binary; only the branch is skipped. `qa_trace!` is
//! two `macro_rules!` arms selected by `#[cfg(debug_assertions)]` at the
//! *item* level: the release arm's body is `{{}}` and never references its
//! arguments, so the event-name string and the `serde_json::json!` fields
//! literal at each call site are parsed but never macro-expanded, name-
//! resolved, or code-generated — structurally absent, not merely unreached.
//! Verified mechanically, not just argued: `cargo build --release && strings
//! target/release/mermark | grep -cE 'MERMARK_QA_(TRACE_DIR|PICK_FILE)|qa-trace'`
//! must be `0` (see `.omo/evidence/single-window-opening/task-6-backend.md`).
//!
//! Even in a debug build, emission is a further opt-in: no line is written
//! unless `MERMARK_QA_TRACE_DIR` is set, so an ordinary `cargo build`/`tauri
//! dev` session run by a developer (no QA harness attached) pays only one
//! `OnceLock` read per event and touches no filesystem.
//!
//! ## Where lines go
//! One JSONL file per process, `$MERMARK_QA_TRACE_DIR/{pid}.jsonl`, so two
//! processes (the primary window and a routed second CLI invocation, or an
//! isolated launch) can never interleave writes into the same file — no
//! shared-file locking discipline to get right, just filename-level
//! separation. Each line is one `trace_line`-formatted JSON object.

#[cfg(debug_assertions)]
mod debug_only {
    use serde_json::Value;
    use std::fs::{File, OpenOptions};
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Mutex, OnceLock};

    /// Process-unique, monotonic trace sequence number. Mirrors the
    /// `STDIN_SEQ`/`TMP_SEQ` pattern used elsewhere in this crate: a counter
    /// gives the harness a total order within one process without depending
    /// on clock resolution (trace lines from the same process can arrive
    /// within the same millisecond).
    static SEQ: AtomicU64 = AtomicU64::new(1);

    /// This process's trace sink, opened at most once. `None` (cached, not
    /// re-checked) when `MERMARK_QA_TRACE_DIR` is unset — the common case for
    /// an ordinary debug build with no QA harness attached — so every
    /// `emit()` call after the first costs one `OnceLock` read and nothing
    /// else.
    static SINK: OnceLock<Option<Mutex<File>>> = OnceLock::new();

    fn open_sink() -> Option<Mutex<File>> {
        let dir = std::env::var("MERMARK_QA_TRACE_DIR").ok()?;
        let path = std::path::Path::new(&dir).join(format!("{}.jsonl", std::process::id()));
        OpenOptions::new().create(true).append(true).open(&path).ok().map(Mutex::new)
    }

    /// Format one trace record as a single line of JSON with no trailing
    /// newline — `{"seq":..,"pid":..,"event":"...","fields":{...}}`. Pure:
    /// touches no env var and no file, which is what makes it the one piece
    /// of this module a unit test exercises directly, independent of
    /// `MERMARK_QA_TRACE_DIR` being set.
    pub(crate) fn trace_line(seq: u64, pid: u32, event: &str, fields: Value) -> String {
        serde_json::json!({ "seq": seq, "pid": pid, "event": event, "fields": fields }).to_string()
    }

    /// Append one trace record to this process's sink, if trace collection
    /// is enabled. A sink that failed to open (bad `MERMARK_QA_TRACE_DIR`,
    /// permissions, …) is treated as "tracing off" rather than an error —
    /// a QA harness misconfiguration must never take down the app it is
    /// observing.
    pub fn emit(event: &str, fields: Value) {
        let Some(mutex) = SINK.get_or_init(open_sink) else { return };
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let line = trace_line(seq, std::process::id(), event, fields);
        if let Ok(mut file) = mutex.lock() {
            let _ = writeln!(file, "{line}");
        }
    }
}

#[cfg(debug_assertions)]
pub(crate) use debug_only::emit;
// Only the test module below reaches `trace_line` directly (`emit` calls it
// via the same-module path, not through this re-export) — gated to `test`
// too so a plain (non-test) debug build doesn't warn "unused import".
#[cfg(all(test, debug_assertions))]
pub(crate) use debug_only::trace_line;

/// The seam's only entry point for call sites. Debug builds expand to
/// `crate::qa_trace::emit(event, fields)`; release builds expand to an empty
/// block that never references `$event`/`$fields` at all — see this
/// module's doc comment for why that is a structural (not runtime) guarantee.
#[cfg(debug_assertions)]
macro_rules! qa_trace {
    ($event:expr, $fields:expr) => {
        $crate::qa_trace::emit($event, $fields)
    };
}
#[cfg(not(debug_assertions))]
macro_rules! qa_trace {
    ($event:expr, $fields:expr) => {{}};
}
pub(crate) use qa_trace;

#[cfg(all(test, debug_assertions))]
mod qa_trace_tests {
    use super::trace_line;
    use serde_json::json;

    #[test]
    fn trace_line_is_one_json_object_per_line() {
        let line = trace_line(7, 1234, "launch-class", json!({ "class": "isolated" }));
        assert!(!line.contains('\n'), "must be exactly one line: {line:?}");
        let parsed: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed["seq"], 7);
        assert_eq!(parsed["pid"], 1234);
        assert_eq!(parsed["event"], "launch-class");
        assert_eq!(parsed["fields"]["class"], "isolated");
    }
}
