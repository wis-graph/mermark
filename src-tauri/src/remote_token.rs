//! Device token storage for the remote vault feature (host and client sides).
//!
//! Never handed to the frontend: if the webview held the token, any script
//! running in it (including an injected one) could read it out of
//! `localStorage`. Instead every `remote_*` Tauri command takes only
//! `host`/`vault` and Rust looks the token up itself — from `ClientTokens`
//! on the client side, or from the paired-device list here on the host
//! side. The token never crosses the IPC boundary into TypeScript in either
//! direction. Revoking a device instead identifies it by `PairedDevice::id`
//! (see below) — a non-secret handle a host UI *can* pass through IPC
//! without ever exposing the token itself.
//!
//! Stored in the app config dir at 0600 (owner read/write only). The
//! textbook-correct place for a long-lived secret like this is the OS
//! Keychain, but this token only ever grants "read a vault the user already
//! chose to share" — bounded blast radius — so a permissioned file is judged
//! sufficient for v1. See `docs/design/remote-vault.md` §5.
//!
//! Every store write goes through `atomic_write_0600`: a sibling temp file
//! (0600 set at creation) followed by `rename` over the target, mirroring
//! `commands.rs`'s `write_file` atomicity. A plain truncate-then-write would
//! leave a half-written (or empty) file behind if the process died
//! mid-write; `rename` is atomic on the same filesystem, so readers only
//! ever see the old complete file or the new complete file, never a partial
//! one. `load` in turn treats "file missing" (not paired yet — legitimate
//! empty state) and "file present but unparseable" (corruption) as
//! different outcomes rather than collapsing both into a silent empty
//! result — a corrupt store should be reported, not misread as "you have no
//! paired devices anymore".

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Process-unique counter for this module's atomic-write temp file names,
/// mirroring `fs/file_io.rs`'s `TMP_SEQ` — kept as a separate counter (not
/// shared) so the two concerns don't share state across module boundaries,
/// same rationale as `lib.rs`'s `STDIN_SEQ`.
static TOKEN_TMP_SEQ: AtomicU64 = AtomicU64::new(1);

/// Writes `bytes` to `path` atomically at 0600: a sibling temp file (0600
/// set at `open()` time, not chmod'd after) followed by `rename` over the
/// target. On Unix, `rename` replaces the destination's inode wholesale, so
/// the temp file's own mode is what the final path ends up with — there is
/// no second chmod step on the destination that could race a concurrent
/// reader. Shared by every store in this module (host device list, client
/// token map) so the atomicity guarantee isn't duplicated per call site.
fn atomic_write_0600(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp_name = format!(
        "{}.tmp-{}-{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("remote-store"),
        std::process::id(),
        TOKEN_TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    );
    let tmp = path.with_file_name(tmp_name);

    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let write_result = opts.open(&tmp).and_then(|mut f| f.write_all(bytes));
    if let Err(e) = write_result {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("write {}: {e}", tmp.display()));
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename {} -> {}: {e}", tmp.display(), path.display())
    })
}

/// One device the host has paired with: a non-secret `id` a UI can name it
/// by (e.g. a "연결 해제" button — see this module's doc comment on why the
/// `token` itself must never make that round trip), its long-lived
/// `token`, a human-readable `label`, and when pairing happened. `id` is
/// minted the same way as the token (`crypto_token::mint_token`, OS
/// CSPRNG) so it's unguessable too — an attacker who can enumerate ids
/// shouldn't gain anything toward guessing the corresponding token.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct PairedDevice {
    pub id: String,
    pub token: String,
    pub label: String,
    pub paired_at_ms: u64,
}

/// Where the host's paired-device list lives under the app config dir.
/// Called by `save`/`load` below, and directly by `remote_host.rs`'s tests.
pub fn store_path(config_dir: &Path) -> PathBuf {
    config_dir.join("remote-devices.json")
}

/// Loads the host's paired-device list. A *missing* file reads as "no
/// devices paired yet" (`Ok(vec![])`) — that's the normal state before the
/// first successful pairing. A file that exists but fails to read or parse
/// is reported as `Err` instead of silently collapsing to empty: swallowing
/// that error would look to the user like every paired device vanished,
/// when what actually happened is the store is corrupt and needs attention.
pub fn load(config_dir: &Path) -> Result<Vec<PairedDevice>, String> {
    let path = store_path(config_dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    serde_json::from_str(&text).map_err(|e| format!("parse {}: {e}", path.display()))
}

/// Saves the host's paired-device list via `atomic_write_0600` (see module
/// doc comment for why: no truncate-then-write window, no create-then-chmod
/// window).
pub fn save(config_dir: &Path, devices: &[PairedDevice]) -> Result<(), String> {
    std::fs::create_dir_all(config_dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(devices).map_err(|e| e.to_string())?;
    atomic_write_0600(&store_path(config_dir), json.as_bytes())
}

/// Removes the `PairedDevice` with the given non-secret `id` (never the
/// token — see module doc comment). Returns whether anything was actually
/// removed, so a caller revoking an already-gone id can tell the two cases
/// apart instead of silently no-opping either way. Plain equality is fine
/// here (not `constant_time_eq`): `id` is a handle, not a secret, so there
/// is nothing for a timing side channel to leak.
pub fn revoke(devices: &mut Vec<PairedDevice>, id: &str) -> bool {
    let before = devices.len();
    devices.retain(|d| d.id != id);
    devices.len() != before
}

/// Client-side token store: "which token do I use when I talk to host
/// `X`". The mirror image of `PairedDevice` — that's the host's record of
/// who it trusts; this is the client's record of what it was given. Held as
/// Tauri managed state, constructed once via `load` with the app's config
/// dir, so a `remote_*` command can take just `host`, look the token up
/// here, and never let TypeScript see the value in either direction.
///
/// `remember`/`forget` persist immediately (through `atomic_write_0600`)
/// rather than leaving the caller to remember a separate save step — pairing
/// is meant to happen once per host, ever; if persistence depended on some
/// later save that never came (a crash, a missed call), every relaunch
/// would force the user back to the host to re-pair, and the host's device
/// list would grow a duplicate entry each time it tried. Persisting inside
/// `remember` itself closes that gap structurally instead of relying on
/// every call site to get it right.
pub struct ClientTokens {
    dir: PathBuf,
    tokens: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

impl ClientTokens {
    /// Loads whatever was persisted under `config_dir` (or starts empty if
    /// nothing has been paired yet) and remembers `config_dir` so later
    /// `remember`/`forget` calls can persist without the caller re-supplying
    /// it every time.
    /// A missing store file reads as "no host paired yet" and stays silent
    /// — that's the ordinary state before the first `remember`. A store
    /// file that exists but fails to parse is a different situation (see
    /// this module's doc comment on why `remote_token::load`, the host-side
    /// twin of this function, distinguishes the two) and is reported to
    /// stderr rather than swallowed the same way — an earlier version of
    /// this function collapsed both cases into the same silent empty map
    /// via `.ok().and_then(...).unwrap_or_default()`, which would make a
    /// corrupt client token store look identical to "never paired with
    /// anyone", forcing every host back through a confusing re-pair with no
    /// hint why. Still infallible (`Self`, not `Result`) — every call site
    /// (`lib.rs`'s managed-state setup among them) treats construction as
    /// unconditional, so this starts empty and reports rather than
    /// propagating an error nothing here is set up to receive.
    pub fn load(config_dir: &Path) -> Self {
        let path = client_store_path(config_dir);
        let tokens = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str(&text) {
                Ok(parsed) => parsed,
                Err(e) => {
                    eprintln!("remote_token: {} 파싱 실패, 빈 토큰 상태로 시작합니다: {e}", path.display());
                    Default::default()
                }
            },
            Err(_) => Default::default(),
        };
        Self { dir: config_dir.to_path_buf(), tokens: std::sync::Mutex::new(tokens) }
    }

    pub fn token_for(&self, host: &str) -> Option<String> {
        self.tokens.lock().unwrap().get(host).cloned()
    }

    /// Builds the post-insert map, persists *that*, and only swaps it into
    /// the live map once the write to disk has actually succeeded. Never
    /// mutates `self.tokens` first: a disk-then-memory ordering means
    /// memory can never run ahead of what's durable, so a failed write
    /// (full disk, read-only volume, permissions) can't leave this launch
    /// remembering a token that vanishes the next time the store is loaded.
    /// Holds a **single** lock acquisition across clone → persist →
    /// write-back — the same fix (and for the same reason)
    /// `remote_host.rs`'s `persist_devices_atomically` applies on the host
    /// side (Ruling 28): a version that locked, cloned, and dropped the
    /// guard before persisting, then locked again to write back, left a
    /// window where a concurrent `remember`/`forget` on the *same* store
    /// could interleave and lose one caller's update once the second's
    /// write-back landed. Held across `self.persist`'s file I/O — a lock
    /// held during I/O is a worse trade than a lost update here, since this
    /// store's whole job is "remember what pairing already granted".
    pub fn remember(&self, host: &str, token: &str) -> Result<(), String> {
        let mut tokens = self.tokens.lock().unwrap();
        let mut candidate = tokens.clone();
        candidate.insert(host.to_string(), token.to_string());
        self.persist(&candidate)?;
        *tokens = candidate;
        Ok(())
    }

    /// Mirror of `remember`'s disk-first ordering: on a failed persist the
    /// token must still be considered present (both on disk and in
    /// memory), never treated as forgotten. Reporting `forget` as
    /// successful when the removal didn't actually make it to disk would
    /// let a caller believe a device was un-paired while its token still
    /// authorizes reads on the next launch.
    /// Same single-lock-acquisition fix as `remember`, same reason — see
    /// its doc comment.
    #[allow(dead_code)] // "un-pair this host" UI (a later task) is the real call site.
    pub fn forget(&self, host: &str) -> Result<(), String> {
        let mut tokens = self.tokens.lock().unwrap();
        let mut candidate = tokens.clone();
        candidate.remove(host);
        self.persist(&candidate)?;
        *tokens = candidate;
        Ok(())
    }

    fn persist(&self, tokens: &std::collections::HashMap<String, String>) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(tokens).map_err(|e| e.to_string())?;
        atomic_write_0600(&client_store_path(&self.dir), json.as_bytes())
    }
}

/// Where the client's per-host token map is persisted across restarts under
/// the app config dir.
pub fn client_store_path(config_dir: &Path) -> PathBuf {
    config_dir.join("remote-client-tokens.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "mermark-tok-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn round_trips_devices() {
        let dir = tmp();
        let devices = vec![PairedDevice {
            id: "dev1".into(),
            token: "aa".into(),
            label: "맥북".into(),
            paired_at_ms: 1,
        }];
        save(&dir, &devices).unwrap();
        assert_eq!(load(&dir).unwrap(), devices);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn stores_with_0600_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp();
        save(&dir, &[]).unwrap();
        let mode = std::fs::metadata(store_path(&dir)).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "토큰 파일은 소유자만 읽을 수 있어야 한다");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A store file that exists but isn't valid JSON (simulating a crash
    /// mid-write under the old truncate-then-write scheme, or plain disk
    /// corruption) must be reported as an error, never silently read back
    /// as "no devices paired" — that would look like every paired device
    /// quietly vanished.
    #[test]
    fn load_reports_a_corrupt_store_rather_than_silently_emptying() {
        let dir = tmp();
        std::fs::write(store_path(&dir), b"not json").unwrap();
        let err = load(&dir).unwrap_err();
        assert!(err.contains("parse"), "got: {err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_store_is_not_an_error() {
        let dir = tmp();
        assert_eq!(load(&dir).unwrap(), Vec::<PairedDevice>::new());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `ClientTokens::load` is infallible by design (see its doc comment),
    /// so a corrupt store can't propagate an `Err` the way the host-side
    /// `load` does — but it must not silently misbehave either: it starts
    /// empty (same as "never paired with anyone") and, crucially, a
    /// subsequent `remember` still works and persists normally, proving the
    /// corrupt bytes were discarded rather than left to reappear or wedge
    /// the store.
    #[test]
    fn client_tokens_load_recovers_from_a_corrupt_store_instead_of_wedging() {
        let dir = tmp();
        std::fs::write(client_store_path(&dir), b"not json").unwrap();
        let store = ClientTokens::load(&dir);
        assert_eq!(store.token_for("wis-macmini"), None, "손상된 저장소는 빈 상태로 시작해야 한다");
        store.remember("wis-macmini", "deadbeef").unwrap();
        assert_eq!(store.token_for("wis-macmini").as_deref(), Some("deadbeef"));

        let reloaded = ClientTokens::load(&dir);
        assert_eq!(
            reloaded.token_for("wis-macmini").as_deref(),
            Some("deadbeef"),
            "손상된 저장소를 정상적으로 덮어쓴 뒤에는 새로 읽어도 값이 남아 있어야 한다"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn client_tokens_are_keyed_by_host_and_never_leave_rust() {
        let dir = tmp();
        let store = ClientTokens::load(&dir);
        assert_eq!(store.token_for("wis-macmini"), None);
        store.remember("wis-macmini", "deadbeef").unwrap();
        assert_eq!(store.token_for("wis-macmini").as_deref(), Some("deadbeef"));
        store.forget("wis-macmini").unwrap();
        assert_eq!(store.token_for("wis-macmini"), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The whole point of persisting `ClientTokens` (Finding 3): a token
    /// remembered in one process must still be there after the process
    /// exits and a fresh one loads from the same directory — otherwise
    /// every relaunch forces the user back to the host to re-pair.
    #[test]
    fn remembered_token_survives_a_store_reload() {
        let dir = tmp();
        let store = ClientTokens::load(&dir);
        store.remember("wis-macmini", "deadbeef").unwrap();
        drop(store);

        let reloaded = ClientTokens::load(&dir);
        assert_eq!(reloaded.token_for("wis-macmini").as_deref(), Some("deadbeef"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Pins the disk-first ordering in `remember`: when the write to disk
    /// fails (here, a directory with no write permission), the in-memory
    /// map must be left exactly as it was — `token_for` must still say
    /// `None` — rather than accepting the token in memory while the disk
    /// silently falls behind.
    #[cfg(unix)]
    #[test]
    fn remember_leaves_memory_untouched_when_persist_fails() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp();
        let store = ClientTokens::load(&dir);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();

        let result = store.remember("wis-macmini", "deadbeef");

        // Restore write permission before any cleanup, regardless of outcome.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err(), "쓰기 실패는 Err로 보고돼야 한다");
        assert_eq!(
            store.token_for("wis-macmini"),
            None,
            "디스크 쓰기가 실패하면 메모리도 갱신되지 않아야 한다"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Mirror of the test above for `forget`: a token already remembered
    /// must survive in memory if the removal can't be made durable — the
    /// worse failure mode, since a caller that saw `Ok` would believe the
    /// device was un-paired while its token still authorizes reads.
    #[cfg(unix)]
    #[test]
    fn forget_leaves_token_present_when_persist_fails() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp();
        let store = ClientTokens::load(&dir);
        store.remember("wis-macmini", "deadbeef").unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();

        let result = store.forget("wis-macmini");

        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err(), "쓰기 실패는 Err로 보고돼야 한다");
        assert_eq!(
            store.token_for("wis-macmini").as_deref(),
            Some("deadbeef"),
            "디스크 쓰기가 실패하면 이미 있던 토큰이 유지돼야 한다"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn revoke_removes_only_the_named_device() {
        let mut devices = vec![
            PairedDevice { id: "dev1".into(), token: "aa".into(), label: "맥북".into(), paired_at_ms: 1 },
            PairedDevice { id: "dev2".into(), token: "bb".into(), label: "폰".into(), paired_at_ms: 2 },
        ];
        assert!(revoke(&mut devices, "dev1"));
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].id, "dev2");
        assert!(!revoke(&mut devices, "zz"), "없는 id 철회는 false");
    }
}
