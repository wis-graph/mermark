use super::{read_external_change, WatchState};

use std::fs;
use std::fs::{File, FileTimes};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, SystemTime};

use notify::{RecursiveMode, Watcher};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn temp_path(tag: &str) -> PathBuf {
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "mermark_watcher_{}_{}_{tag}.md",
        std::process::id(),
        sequence
    ))
}

struct Fixture(PathBuf);

impl Fixture {
    fn create(tag: &str, text: &str) -> Self {
        let path = temp_path(tag);
        fs::write(&path, text).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
        let _ = fs::remove_dir(&self.0);
    }
}

fn bytes(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|_| "<unreadable-or-missing>".to_owned())
}

fn set_mtime_after(path: &Path, baseline: u64) {
    set_mtime(path, baseline.saturating_add(1));
}

fn set_mtime(path: &Path, mtime: u64) {
    let modified = SystemTime::UNIX_EPOCH + Duration::from_millis(mtime);
    File::open(path)
        .unwrap()
        .set_times(FileTimes::new().set_modified(modified))
        .unwrap();
}

fn report(tag: &str, event: &str, frontend: &str, disk: &str, false_negative: &str) {
    report_delivery(tag, event, frontend, disk, false_negative, "direct-seam");
}

fn report_delivery(
    tag: &str,
    event: &str,
    frontend: &str,
    disk: &str,
    false_negative: &str,
    delivery: &str,
) {
    println!(
        "SCENARIO={tag} delivery={delivery} event={event} frontend_decision={frontend} disk_bytes={disk:?} false_negative={false_negative}"
    );
}

#[test]
fn self_save_is_muted_while_preserving_saved_bytes() {
    // Given: a successful self-save and its recorded post-write mtime.
    let fixture = Fixture::create("self_save", "saved by mermark");
    let path = fixture.path();
    let state = WatchState::default();
    state.record_self_write(crate::commands::mtime_ms(&path.to_string_lossy()));

    // When: the production callback's disk-decision seam inspects the event.
    let change = read_external_change(&state, &path);

    // Then: no frontend event is emitted and the save remains on disk.
    assert!(change.is_none());
    assert_eq!(bytes(path), "saved by mermark");
    report("self-save", "no-event", "not-invoked", &bytes(path), "no");
}

#[test]
fn clean_external_edit_emits_reload_with_new_bytes() {
    let fixture = Fixture::create("clean_external", "before");
    let baseline = crate::commands::mtime_ms(&fixture.path().to_string_lossy());
    let state = WatchState::default();
    state.record_self_write(baseline.saturating_sub(1));
    fs::write(fixture.path(), "after clean edit").unwrap();
    set_mtime_after(fixture.path(), baseline);

    let change = read_external_change(&state, fixture.path()).unwrap();

    assert_eq!(change.text, "after clean edit");
    assert!(change.mtime > baseline);
    assert_eq!(bytes(fixture.path()), "after clean edit");
    report(
        "clean-external-edit",
        "event",
        "reload",
        &bytes(fixture.path()),
        "no",
    );
}

#[test]
fn dirty_external_edit_emits_conflict_with_new_bytes() {
    let fixture = Fixture::create("dirty_external", "before");
    let baseline = crate::commands::mtime_ms(&fixture.path().to_string_lossy());
    let state = WatchState::default();
    state.record_self_write(baseline.saturating_sub(1));
    fs::write(fixture.path(), "after dirty edit").unwrap();
    set_mtime_after(fixture.path(), baseline);

    let change = read_external_change(&state, fixture.path()).unwrap();

    assert_eq!(change.text, "after dirty edit");
    assert!(change.mtime > baseline);
    assert_eq!(bytes(fixture.path()), "after dirty edit");
    report(
        "dirty-external-edit",
        "event",
        "conflict",
        &bytes(fixture.path()),
        "no",
    );
}

#[test]
fn same_mtime_rewrite_is_not_emitted_and_exposes_false_negative() {
    let fixture = Fixture::create("same_mtime", "before");
    let original_mtime = fs::metadata(fixture.path()).unwrap().modified().unwrap();
    let baseline = crate::commands::mtime_ms(&fixture.path().to_string_lossy());
    let state = WatchState::default();
    state.record_self_write(baseline);
    fs::write(fixture.path(), "after same-mtime rewrite").unwrap();
    File::open(fixture.path())
        .unwrap()
        .set_times(FileTimes::new().set_modified(original_mtime))
        .unwrap();

    let change = read_external_change(&state, fixture.path());

    assert_eq!(
        crate::commands::mtime_ms(&fixture.path().to_string_lossy()),
        baseline
    );
    assert_eq!(bytes(fixture.path()), "after same-mtime rewrite");
    assert!(change.is_none());
    report(
        "same-mtime-rewrite",
        "no-event",
        "not-invoked",
        &bytes(fixture.path()),
        "yes",
    );
}

#[test]
fn atomic_replacement_emits_new_bytes() {
    let fixture = Fixture::create("atomic-replacement", "before");
    let baseline = crate::commands::mtime_ms(&fixture.path().to_string_lossy());
    let state = WatchState::default();
    state.record_self_write(baseline);
    let (event_tx, event_rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |result| {
        let _ = event_tx.send(result);
    })
    .unwrap();
    watcher
        .watch(fixture.path(), RecursiveMode::NonRecursive)
        .unwrap();
    let replacement = fixture.path().with_extension("replacement.tmp");
    fs::write(&replacement, "after atomic replacement").unwrap();
    set_mtime_after(&replacement, baseline);
    fs::rename(&replacement, fixture.path()).unwrap();

    let notify_event = event_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(notify_event.is_ok(), "notify delivered an error: {notify_event:?}");
    let change = read_external_change(&state, fixture.path()).unwrap();

    assert_eq!(change.text, "after atomic replacement");
    assert_eq!(bytes(fixture.path()), "after atomic replacement");
    report_delivery(
        "atomic-replacement",
        "event",
        "reload",
        &bytes(fixture.path()),
        "no",
        "notify",
    );
}

#[test]
fn tab_activation_reuses_old_self_write_baseline_for_new_path() {
    let tab_a = Fixture::create("tab-a", "tab A");
    let tab_b = Fixture::create("tab-b", "tab B before");
    set_mtime(tab_a.path(), 200);
    set_mtime(tab_b.path(), 150);
    let state = WatchState::default();
    state.record_self_write(crate::commands::mtime_ms(&tab_a.path().to_string_lossy()));

    fs::write(tab_b.path(), "tab B after external edit").unwrap();
    set_mtime(tab_b.path(), 150);
    let change = read_external_change(&state, tab_b.path());

    assert!(change.is_none());
    assert_eq!(bytes(tab_b.path()), "tab B after external edit");
    report(
        "watcher-replacement-tab-activation",
        "no-event",
        "not-invoked",
        &bytes(tab_b.path()),
        "yes",
    );
}

#[test]
fn deletion_is_not_emitted_and_original_bytes_are_gone() {
    let fixture = Fixture::create("deletion", "before deletion");
    let baseline = crate::commands::mtime_ms(&fixture.path().to_string_lossy());
    let state = WatchState::default();
    state.record_self_write(baseline);
    fs::remove_file(fixture.path()).unwrap();

    let change = read_external_change(&state, fixture.path());

    assert!(change.is_none());
    assert_eq!(bytes(fixture.path()), "<unreadable-or-missing>");
    report("deletion", "no-event", "not-invoked", &bytes(fixture.path()), "no");
}

#[test]
fn unreadable_path_is_not_emitted() {
    let fixture = Fixture::create("unreadable", "before unreadable");
    let baseline = crate::commands::mtime_ms(&fixture.path().to_string_lossy());
    let state = WatchState::default();
    state.record_self_write(baseline.saturating_sub(1));
    fs::remove_file(fixture.path()).unwrap();
    fs::create_dir(fixture.path()).unwrap();

    let change = read_external_change(&state, fixture.path());

    assert!(change.is_none());
    assert_eq!(bytes(fixture.path()), "<unreadable-or-missing>");
    report(
        "unreadable-path",
        "no-event",
        "not-invoked",
        &bytes(fixture.path()),
        "no",
    );
}
