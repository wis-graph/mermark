//! Device token storage for the remote vault feature (host and client sides).
//!
//! Never handed to the frontend: if the webview held the token, any script
//! running in it (including an injected one) could read it out of
//! `localStorage`. Instead every `remote_*` Tauri command takes only
//! `host`/`vault` and Rust looks the token up itself — from `ClientTokens`
//! on the client side, or from the paired-device list here on the host
//! side. The token never crosses the IPC boundary into TypeScript in either
//! direction.
//!
//! Stored in the app config dir at 0600 (owner read/write only). The
//! textbook-correct place for a long-lived secret like this is the OS
//! Keychain, but this token only ever grants "read a vault the user already
//! chose to share" — bounded blast radius — so a permissioned file is judged
//! sufficient for v1. See `docs/design/remote-vault.md` §5.

use std::io::Write;
use std::path::{Path, PathBuf};

/// One device the host has paired with: its long-lived token, a
/// human-readable label (e.g. the device name offered during pairing), and
/// when pairing happened.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct PairedDevice {
    pub token: String,
    pub label: String,
    pub paired_at_ms: u64,
}

/// Where the host's paired-device list lives under the app config dir.
pub fn store_path(config_dir: &Path) -> PathBuf {
    config_dir.join("remote-devices.json")
}

/// Loads the host's paired-device list. A missing or unparseable file reads
/// as "no devices paired yet" rather than an error — the file doesn't exist
/// until the first successful pairing.
pub fn load(config_dir: &Path) -> Vec<PairedDevice> {
    std::fs::read_to_string(store_path(config_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Saves the host's paired-device list at 0600. The mode is set **at
/// creation** via `OpenOptionsExt::mode`, not `chmod`'d afterward — a
/// create-then-chmod sequence leaves a window where the file exists on disk
/// with the default (world-readable-ish) permissions before the chmod
/// lands, and a concurrent reader could win that race. Setting the mode in
/// the same `open()` call that creates the file closes that window
/// entirely: the file is never observable with any mode but 0600.
pub fn save(config_dir: &Path, devices: &[PairedDevice]) -> Result<(), String> {
    std::fs::create_dir_all(config_dir).map_err(|e| e.to_string())?;
    let path = store_path(config_dir);
    let json = serde_json::to_string_pretty(devices).map_err(|e| e.to_string())?;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&path).map_err(|e| e.to_string())?;
    f.write_all(json.as_bytes()).map_err(|e| e.to_string())
}

/// Removes every `PairedDevice` whose token matches `token` (compared in
/// constant time, reusing `remote_host::constant_time_eq` rather than a
/// second minter/comparator). Returns whether anything was actually
/// removed, so a caller revoking an already-gone token can tell the two
/// cases apart instead of silently no-opping either way.
pub fn revoke(devices: &mut Vec<PairedDevice>, token: &str) -> bool {
    let before = devices.len();
    devices.retain(|d| !crate::remote_host::constant_time_eq(&d.token, token));
    devices.len() != before
}

/// Client-side token store: "which token do I use when I talk to host
/// `X`". The mirror image of `PairedDevice` — that's the host's record of
/// who it trusts; this is the client's record of what it was given. Held as
/// Tauri managed state (`Mutex<HashMap>`) rather than round-tripped through
/// the frontend on every call, which is precisely what keeps the token out
/// of the webview: a `remote_*` command takes `host`, looks the token up
/// here, and TypeScript never sees the value in either direction.
#[derive(Default)]
pub struct ClientTokens(pub std::sync::Mutex<std::collections::HashMap<String, String>>);

impl ClientTokens {
    pub fn token_for(&self, host: &str) -> Option<String> {
        self.0.lock().unwrap().get(host).cloned()
    }

    pub fn remember(&self, host: &str, token: &str) {
        self.0.lock().unwrap().insert(host.to_string(), token.to_string());
    }

    pub fn forget(&self, host: &str) {
        self.0.lock().unwrap().remove(host);
    }
}

/// Where the client's per-host token map is persisted across restarts under
/// the app config dir. (`ClientTokens` itself is the in-memory managed-state
/// mirror; a future task that loads/saves this file on startup/pairing will
/// use the same 0600-at-creation approach as `save` above.)
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
        let devices = vec![PairedDevice { token: "aa".into(), label: "맥북".into(), paired_at_ms: 1 }];
        save(&dir, &devices).unwrap();
        assert_eq!(load(&dir), devices);
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

    #[test]
    fn client_tokens_are_keyed_by_host_and_never_leave_rust() {
        let store = ClientTokens::default();
        assert_eq!(store.token_for("wis-macmini"), None);
        store.remember("wis-macmini", "deadbeef");
        assert_eq!(store.token_for("wis-macmini").as_deref(), Some("deadbeef"));
        store.forget("wis-macmini");
        assert_eq!(store.token_for("wis-macmini"), None);
    }

    #[test]
    fn revoke_removes_only_the_named_token() {
        let mut devices = vec![
            PairedDevice { token: "aa".into(), label: "맥북".into(), paired_at_ms: 1 },
            PairedDevice { token: "bb".into(), label: "폰".into(), paired_at_ms: 2 },
        ];
        assert!(revoke(&mut devices, "aa"));
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].token, "bb");
        assert!(!revoke(&mut devices, "zz"), "없는 토큰 철회는 false");
    }
}
