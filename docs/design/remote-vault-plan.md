# 원격 볼트 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 맥미니 mermark가 공유한 볼트를 맥북 mermark에서 읽기 전용으로 열람한다.

**Architecture:** 호스트 mermark가 axum 서버로 armed root(공유 체크한 볼트)만 GET으로 서빙하고, 클라이언트 mermark가 reqwest(타임아웃 고정)로 붙는다. 프론트엔드는 새 초크포인트 `file-host.ts`에서 볼트 종류로 로컬/원격을 분기한다. 읽기 전용은 파일 쓰기 라우트를 만들지 않는 것으로 강제한다.

**Tech Stack:** Rust(axum 신규, reqwest/tokio/hyper 기존), TypeScript, Tauri 2, vitest, cargo test

**Spec:** `docs/design/remote-vault.md`

## Global Constraints

- **v1은 읽기 전용.** 파일 라우트는 `GET`만 받는다. 유일한 예외는 `POST /pair`이며 파일을 건드리지 않는다.
- **새 크레이트는 `axum` 하나뿐.** 클라이언트는 이미 그래프에 있는 `reqwest`를 쓴다. 다른 크레이트를 추가하지 않는다.
- **CSP를 수정하지 않는다.** 프론트엔드는 HTTP를 직접 말하지 않고 Rust를 경유한다. `src-tauri/tauri.conf.json`의 `connect-src`는 그대로다.
- **서버 기본 꺼짐.** 사용자가 명시적으로 켜야 바인드한다.
- **토큰은 `localStorage`에 두지 않는다.** Rust 측 앱 설정 디렉터리에 `0600`.
- **보안 관용구를 새로 만들지 않는다.** `htmlview.rs`의 `mint_view_token`(128비트 CSPRNG)과 `is_within_armed_root` 동형 봉쇄 검사를 따른다.
- **조용한 강등 금지.** 실패는 4종(`연결 안 됨`/`인증 만료`/`호스트가 공유를 껐음`/`연결됨`)으로 구분해 표면화한다.
- **경계면 parity 규약:** 새 `#[tauri::command]`를 추가하면 같은 커밋에서 `src/mocks/tauri-core.ts`에 대응 case를 넣는다.
- 커맨드 id·ShortcutAction id는 절대 rename하지 않는다(사용자 키바인딩 override가 그 키에 저장됨).

## File Structure

| 파일 | 책임 |
|------|------|
| `src-tauri/src/remote_host.rs` (신규) | armed root 관리, 봉쇄 검사, 페어링 코드 수명, axum 라우터 |
| `src-tauri/src/remote_token.rs` (신규) | 기기 토큰 발급·저장(0600)·조회·철회 |
| `src-tauri/src/remote_client.rs` (신규) | reqwest 호출(타임아웃 고정) + `remote_*` Tauri 커맨드 |
| `src-tauri/src/remote_ssh.rs` (신규) | `ssh -L` 자식 프로세스 수명 관리 |
| `src/document/file-host.ts` (신규) | 볼트 종류로 로컬/원격 파일 읽기를 분기하는 단일 출처 |
| `src/workspace/workspace-state.ts` (수정) | `RemoteVault` 추가 |
| `src/mocks/tauri-core.ts` (수정) | `remote_*` 커맨드 mock |
| `src/settings/app.ts` 외 설정 UI (수정) | 호스트 공유 설정, 페어링 코드 표시, 기기 철회 |

---

### Task 1: 파일 읽기 초크포인트 `file-host.ts`

원격 기능 없이, 현재 흩어진 읽기 호출을 단일 출처로 모으는 순수 리팩터다. 이 단계만으로도 값이 있다. 탐색기·검색 패널은 이미 backend-blind(주입식)이므로 `main.ts`의 주입 지점만 바꾸면 된다.

**Files:**
- Create: `src/document/file-host.ts`
- Create: `src/document/file-host.test.ts`
- Modify: `src/main.ts:309,716,757,1006,1060,1402`
- Modify: `src/editor.ts:255`
- Modify: `src/markdown/image.ts:216`
- Modify: `src/markdown/local-doc-link.ts:223,235`
- Modify: `src/markdown/wikilink.ts:188`
- Modify: `src/markdown/wikilink-complete.ts:91`

**Interfaces:**
- Consumes: 기존 `invoke` 커맨드 `read_file`/`list_dir`/`list_files_recursive`/`resolve_image`/`list_link_targets`/`path_exists`/`directory_exists`
- Produces: `FileHost` 인터페이스와 `localFileHost`, `fileHostFor(vault)`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
// src/document/file-host.test.ts
import { describe, it, expect, vi } from "vitest";
import { makeFileHost, type FileHostBackend } from "./file-host";

const backend = (): FileHostBackend => ({
  readFile: vi.fn(async () => ({ text: "hi", mtime: 1 })),
  listDir: vi.fn(async () => []),
  listFilesRecursive: vi.fn(async () => ({ files: [], truncated: false })),
  resolveImage: vi.fn(async () => null),
  listLinkTargets: vi.fn(async () => []),
  pathExists: vi.fn(async () => true),
  directoryExists: vi.fn(async () => true),
});

describe("makeFileHost", () => {
  it("로컬 볼트는 로컬 백엔드로 간다", async () => {
    const local = backend();
    const remote = backend();
    const host = makeFileHost({ local, remoteFor: () => remote });
    await host.forVault({ persistenceKind: "permanent" } as never).readFile("/a.md");
    expect(local.readFile).toHaveBeenCalledWith("/a.md");
    expect(remote.readFile).not.toHaveBeenCalled();
  });

  it("글로벌 볼트도 로컬 백엔드로 간다", async () => {
    const local = backend();
    const host = makeFileHost({ local, remoteFor: () => backend() });
    await host.forVault({ persistenceKind: "global" } as never).listDir("/d", false);
    expect(local.listDir).toHaveBeenCalledWith("/d", false);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/document/file-host.test.ts`
Expected: FAIL — `Failed to resolve import "./file-host"`

- [ ] **Step 3: 최소 구현을 쓴다**

```ts
// src/document/file-host.ts
import { invoke } from "@tauri-apps/api/core";
import type { Vault } from "../workspace/workspace-state";
import type { DirEntry, ScanResult, LinkTarget } from "./types";

export interface FileHostBackend {
  readFile(path: string): Promise<{ text: string; mtime: number }>;
  listDir(path: string, showHidden: boolean): Promise<DirEntry[]>;
  listFilesRecursive(root: string, showHidden: boolean): Promise<ScanResult>;
  resolveImage(baseDir: string, name: string, maxDepth: number): Promise<string | null>;
  listLinkTargets(dir: string): Promise<LinkTarget[]>;
  pathExists(path: string): Promise<boolean>;
  directoryExists(path: string): Promise<boolean>;
}

export const localFileHost: FileHostBackend = {
  readFile: (path) => invoke("read_file", { path }),
  listDir: (path, showHidden) => invoke("list_dir", { path, showHidden }),
  listFilesRecursive: (root, showHidden) => invoke("list_files_recursive", { root, showHidden }),
  resolveImage: (baseDir, name, maxDepth) => invoke("resolve_image", { baseDir, name, maxDepth }),
  listLinkTargets: (dir) => invoke("list_link_targets", { dir }),
  pathExists: (path) => invoke("path_exists", { path }),
  directoryExists: (path) => invoke("directory_exists", { path }),
};

export const makeFileHost = (deps: {
  local: FileHostBackend;
  remoteFor: (vault: Vault) => FileHostBackend;
}) => ({
  forVault: (vault: Vault): FileHostBackend =>
    vault.persistenceKind === "remote" ? deps.remoteFor(vault) : deps.local,
});
```

`DirEntry`/`ScanResult`/`LinkTarget` 타입이 아직 공용 모듈에 없으면 `src/document/types.ts`로 모아 재수출한다(현재 `main.ts`에 흩어져 있음).

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `npx vitest run src/document/file-host.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: 기존 12개 호출 지점을 초크포인트 경유로 바꾼다**

`main.ts`·`editor.ts`·`image.ts`·`local-doc-link.ts`·`wikilink.ts`·`wikilink-complete.ts`의 해당 `invoke<>()` 직접 호출을 `fileHost.forVault(currentVault).<method>()` 로 교체한다. 이 단계에서는 `remoteFor`가 아직 로컬을 반환해도 된다(원격 볼트가 존재하지 않으므로 도달 불가).

- [ ] **Step 6: 전체 회귀를 확인한다**

Run: `npx tsc --noEmit && npm test`
Expected: PASS — 동작 변화가 없어야 한다(순수 리팩터)

- [ ] **Step 7: 커밋**

```bash
git add src/document/file-host.ts src/document/file-host.test.ts src/document/types.ts src/main.ts src/editor.ts src/markdown/image.ts src/markdown/local-doc-link.ts src/markdown/wikilink.ts src/markdown/wikilink-complete.ts
git commit -m "refactor(file-host): 파일 읽기 경로를 단일 초크포인트로 모음"
```

---

### Task 2: `RemoteVault` 볼트 종류 추가

**Files:**
- Modify: `src/workspace/workspace-state.ts:6-22`
- Test: `src/workspace/workspace-state.test.ts` (기존 파일에 추가)

**Interfaces:**
- Produces: `RemoteVault`, `PersistenceKind`에 `"remote"` 추가

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
it("원격 볼트는 rootPath가 없고 host로 식별된다", () => {
  const v: RemoteVault = {
    vaultId: "vault-remote-1",
    workspaceId: "workspace-default",
    displayName: "맥미니 노트",
    persistenceKind: "remote",
    rootPath: null,
    explorerRoot: "/",
    host: "wis-macmini:8787",
    remoteVaultId: "rv-abc",
  };
  expect(v.persistenceKind).toBe("remote");
  expect(v.rootPath).toBeNull();
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/workspace/workspace-state.test.ts`
Expected: FAIL — `RemoteVault` 타입 없음

- [ ] **Step 3: 최소 구현을 쓴다**

```ts
export type PersistenceKind = "permanent" | "global" | "remote";

export interface RemoteVault extends VaultBase {
  readonly rootPath: null;
  readonly persistenceKind: "remote";
  readonly explorerRoot: string;
  /** `wis-macmini` 또는 `wis-macmini:9000` 또는 `ssh://user@host`. */
  readonly host: string;
  /** 호스트가 공유 목록에서 이 볼트에 붙인 안정 id. */
  readonly remoteVaultId: string;
}

export type Vault = PermanentVault | GlobalVault | RemoteVault;
```

- [ ] **Step 4: 테스트 통과와 타입 회귀를 확인한다**

Run: `npx tsc --noEmit && npx vitest run src/workspace/`
Expected: PASS. `tsc`가 `Vault`를 switch하는 기존 코드에서 미처리 분기를 지적하면 그 지점들을 명시적으로 처리한다 — **이게 이 태스크의 진짜 산출물이다**(원격 볼트가 새는 곳을 컴파일러가 전부 찾아준다).

- [ ] **Step 5: 커밋**

```bash
git add src/workspace/workspace-state.ts src/workspace/workspace-state.test.ts
git commit -m "feat(workspace): RemoteVault 볼트 종류 추가"
```

---

### Task 3: 호스트 봉쇄 검사 (`remote_host.rs`)

서버 없이 순수 로직만. `htmlview.rs`의 탈출 테스트를 본뜬다.

**Files:**
- Create: `src-tauri/src/remote_host.rs`
- Modify: `src-tauri/src/lib.rs` (`mod remote_host;`)

**Interfaces:**
- Produces: `struct ArmedVault { id: String, display_name: String, root: PathBuf }`, `fn resolve_within(armed: &ArmedVault, rel: &str) -> Option<PathBuf>`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn armed() -> ArmedVault {
        ArmedVault { id: "rv1".into(), display_name: "노트".into(), root: PathBuf::from("/vault") }
    }

    #[test]
    fn resolves_a_plain_relative_path() {
        assert_eq!(resolve_within(&armed(), "a/b.md"), Some(PathBuf::from("/vault/a/b.md")));
    }

    #[test]
    fn rejects_dotdot_escape() {
        assert_eq!(resolve_within(&armed(), "../secret.md"), None);
        assert_eq!(resolve_within(&armed(), "a/../../secret.md"), None);
    }

    #[test]
    fn rejects_absolute_path() {
        assert_eq!(resolve_within(&armed(), "/etc/passwd"), None);
    }

    #[test]
    fn rejects_empty_and_root() {
        assert_eq!(resolve_within(&armed(), ""), None);
    }
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd src-tauri && cargo test remote_host`
Expected: FAIL — `ArmedVault` 미정의로 컴파일 에러

- [ ] **Step 3: 최소 구현을 쓴다**

```rust
//! 호스트 측 원격 볼트 공유. 공유 대상은 사용자가 설정에서 명시적으로 체크한
//! 볼트뿐이며(armed root), 모든 경로 요청은 `resolve_within`을 통과해야 한다.
//! `htmlview.rs`의 `is_within_armed_root`와 같은 봉쇄 관용구를 따른다.

use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug, serde::Serialize)]
pub struct ArmedVault {
    pub id: String,
    pub display_name: String,
    #[serde(skip)]
    pub root: PathBuf,
}

/// armed root 안으로만 해석되는 상대 경로를 절대 경로로 바꾼다.
/// `..`·절대경로·빈 문자열은 전부 `None`. 조인 전에 컴포넌트 단위로 거부하므로
/// 탈출할 경로 자체가 만들어지지 않는다.
pub fn resolve_within(armed: &ArmedVault, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() {
        return None;
    }
    let candidate = Path::new(rel);
    for component in candidate.components() {
        match component {
            Component::Normal(_) => {}
            _ => return None, // RootDir, ParentDir, Prefix, CurDir 전부 거부
        }
    }
    Some(armed.root.join(candidate))
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `cd src-tauri && cargo test remote_host`
Expected: PASS (4 tests)

- [ ] **Step 5: 심볼릭 링크 탈출 테스트를 추가한다**

```rust
#[test]
fn rejects_symlink_that_points_outside_the_armed_root() {
    let tmp = std::env::temp_dir().join(format!("mermark-rv-{}", std::process::id()));
    let root = tmp.join("vault");
    let outside = tmp.join("outside");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.md"), "s").unwrap();
    let link = root.join("link.md");
    let _ = std::fs::remove_file(&link);
    std::os::unix::fs::symlink(outside.join("secret.md"), &link).unwrap();

    let armed = ArmedVault { id: "rv1".into(), display_name: "노트".into(), root: root.clone() };
    let resolved = resolve_within(&armed, "link.md").expect("컴포넌트 검사는 통과한다");
    assert!(!is_canonically_within(&armed, &resolved), "심볼릭 링크 탈출은 막혀야 한다");

    std::fs::remove_dir_all(&tmp).ok();
}
```

- [ ] **Step 6: 실패를 확인하고 `is_canonically_within`을 구현한다**

```rust
/// 컴포넌트 검사를 통과한 뒤의 2차 관문: 실제 파일시스템에서 정규화한 결과가
/// 여전히 armed root 안인지 본다. 심볼릭 링크는 컴포넌트로는 보이지 않으므로
/// 이 검사가 있어야 막힌다.
pub fn is_canonically_within(armed: &ArmedVault, resolved: &Path) -> bool {
    let (Ok(root), Ok(target)) = (armed.root.canonicalize(), resolved.canonicalize()) else {
        return false;
    };
    target.starts_with(&root)
}
```

Run: `cd src-tauri && cargo test remote_host`
Expected: PASS (5 tests)

- [ ] **Step 7: 커밋**

```bash
git add src-tauri/src/remote_host.rs src-tauri/src/lib.rs
git commit -m "feat(remote-host): armed root 봉쇄 검사 (컴포넌트 + 정규화 2중 관문)"
```

---

### Task 4: 페어링 코드 수명과 기기 토큰

**Files:**
- Modify: `src-tauri/src/remote_host.rs`
- Create: `src-tauri/src/remote_token.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `crate::htmlview::mint_view_token`
- Produces: `struct PairingCode`, `fn issue_pairing_code(now_ms: u64) -> PairingCode`, `fn redeem(code_state: &mut PairingState, offered: &str, now_ms: u64) -> Result<String, PairError>`, `fn constant_time_eq(a: &str, b: &str) -> bool`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```rust
#[test]
fn pairing_code_is_six_digits() {
    let c = issue_pairing_code(0);
    assert_eq!(c.code.len(), 6);
    assert!(c.code.chars().all(|ch| ch.is_ascii_digit()));
}

#[test]
fn pairing_code_expires_after_five_minutes() {
    let mut st = PairingState::armed(issue_pairing_code(0));
    let code = st.code().to_string();
    assert!(matches!(redeem(&mut st, &code, 5 * 60_000 + 1), Err(PairError::Expired)));
}

#[test]
fn pairing_code_is_single_use() {
    let mut st = PairingState::armed(issue_pairing_code(0));
    let code = st.code().to_string();
    assert!(redeem(&mut st, &code, 1_000).is_ok());
    assert!(matches!(redeem(&mut st, &code, 2_000), Err(PairError::AlreadyUsed)));
}

#[test]
fn pairing_code_locks_out_after_five_wrong_attempts() {
    let mut st = PairingState::armed(issue_pairing_code(0));
    let code = st.code().to_string();
    for _ in 0..5 {
        assert!(matches!(redeem(&mut st, "000000", 1_000), Err(PairError::Mismatch)));
    }
    assert!(matches!(redeem(&mut st, &code, 1_000), Err(PairError::LockedOut)),
        "정답이어도 시도 초과 후에는 거부한다");
}

#[test]
fn redeeming_yields_a_128_bit_device_token() {
    let mut st = PairingState::armed(issue_pairing_code(0));
    let code = st.code().to_string();
    let token = redeem(&mut st, &code, 1_000).unwrap();
    assert_eq!(token.len(), 32, "16바이트 hex");
    assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
}

#[test]
fn constant_time_eq_matches_normal_equality() {
    assert!(constant_time_eq("abc", "abc"));
    assert!(!constant_time_eq("abc", "abd"));
    assert!(!constant_time_eq("abc", "ab"));
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd src-tauri && cargo test remote_host::tests::pairing`
Expected: FAIL — 컴파일 에러

- [ ] **Step 3: 최소 구현을 쓴다**

```rust
pub const PAIRING_TTL_MS: u64 = 5 * 60_000;
pub const PAIRING_MAX_ATTEMPTS: u8 = 5;

#[derive(Clone, Debug)]
pub struct PairingCode { pub code: String, pub issued_at_ms: u64 }

#[derive(Debug, PartialEq)]
pub enum PairError { Expired, AlreadyUsed, Mismatch, LockedOut, NotArmed }

pub struct PairingState { code: Option<PairingCode>, used: bool, failed_attempts: u8 }

impl PairingState {
    pub fn armed(code: PairingCode) -> Self {
        Self { code: Some(code), used: false, failed_attempts: 0 }
    }
    pub fn code(&self) -> &str { self.code.as_ref().map(|c| c.code.as_str()).unwrap_or("") }
}

pub fn issue_pairing_code(now_ms: u64) -> PairingCode {
    let mut bytes = [0u8; 4];
    getrandom::fill(&mut bytes).expect("OS CSPRNG must be available");
    let n = u32::from_be_bytes(bytes) % 1_000_000;
    PairingCode { code: format!("{n:06}"), issued_at_ms: now_ms }
}

/// 코드를 기기 토큰으로 교환한다. 만료·재사용·시도초과를 **불일치보다 먼저**
/// 판정한다 — 잠긴 뒤에는 정답 여부조차 알려주지 않기 위해서다.
pub fn redeem(state: &mut PairingState, offered: &str, now_ms: u64) -> Result<String, PairError> {
    let Some(issued) = state.code.clone() else { return Err(PairError::NotArmed) };
    if state.used { return Err(PairError::AlreadyUsed); }
    if state.failed_attempts >= PAIRING_MAX_ATTEMPTS { return Err(PairError::LockedOut); }
    if now_ms.saturating_sub(issued.issued_at_ms) > PAIRING_TTL_MS { return Err(PairError::Expired); }
    if !constant_time_eq(offered, &issued.code) {
        state.failed_attempts += 1;
        return Err(PairError::Mismatch);
    }
    state.used = true;
    Ok(crate::htmlview::mint_view_token())
}

/// 길이 차이는 즉시 드러나지만(비밀이 아님), 같은 길이의 내용 비교는
/// 조기 반환 없이 전체를 훑는다.
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() { return false; }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) { diff |= x ^ y; }
    diff == 0
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `cd src-tauri && cargo test remote_host`
Expected: PASS (11 tests)

- [ ] **Step 5: 토큰 저장소를 테스트와 함께 쓴다**

```rust
// src-tauri/src/remote_token.rs
//! 기기 토큰 보관. 프론트엔드 localStorage에 두지 않는다 — 웹뷰 스크립트에
//! 노출되기 때문이다. 앱 설정 디렉터리에 0600으로 둔다.
//! (정석은 Keychain이지만 토큰 권한이 "공유된 볼트 읽기"로 한정돼 v1은 파일.
//!  docs/design/remote-vault.md §5 참조.)

use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct PairedDevice {
    pub token: String,
    pub label: String,
    pub paired_at_ms: u64,
}

pub fn store_path(config_dir: &Path) -> PathBuf { config_dir.join("remote-devices.json") }

pub fn load(config_dir: &Path) -> Vec<PairedDevice> {
    std::fs::read_to_string(store_path(config_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 0600으로 저장한다. 파일을 만든 뒤 권한을 바꾸면 그 사이에 넓은 권한으로
/// 존재하는 창이 생기므로, 생성 시점에 모드를 지정한다.
pub fn save(config_dir: &Path, devices: &[PairedDevice]) -> Result<(), String> {
    std::fs::create_dir_all(config_dir).map_err(|e| e.to_string())?;
    let path = store_path(config_dir);
    let json = serde_json::to_string_pretty(devices).map_err(|e| e.to_string())?;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; opts.mode(0o600); }
    let mut f = opts.open(&path).map_err(|e| e.to_string())?;
    f.write_all(json.as_bytes()).map_err(|e| e.to_string())
}

pub fn revoke(devices: &mut Vec<PairedDevice>, token: &str) -> bool {
    let before = devices.len();
    devices.retain(|d| !crate::remote_host::constant_time_eq(&d.token, token));
    devices.len() != before
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("mermark-tok-{}-{:?}", std::process::id(), std::thread::current().id()));
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
```

- [ ] **Step 6: 테스트 통과를 확인한다**

Run: `cd src-tauri && cargo test remote_token`
Expected: PASS (3 tests)

- [ ] **Step 7: 커밋**

```bash
git add src-tauri/src/remote_host.rs src-tauri/src/remote_token.rs src-tauri/src/lib.rs
git commit -m "feat(remote-host): 페어링 코드 수명·기기 토큰 발급과 0600 보관"
```

---

### Task 5: axum 읽기 전용 서버

**Files:**
- Modify: `src-tauri/src/remote_host.rs`
- Modify: `src-tauri/Cargo.toml` (`axum = "0.7"`)

**Interfaces:**
- Consumes: Task 3의 `resolve_within`/`is_canonically_within`, Task 4의 `redeem`
- Produces: `fn router(state: HostState) -> axum::Router`, `async fn serve(bind: SocketAddr, state: HostState)`

라우트 표면 (이게 전부다):

| 메서드 | 경로 | 용도 |
|--------|------|------|
| `POST` | `/pair` | 페어링 코드 → 기기 토큰 (파일 무관) |
| `GET` | `/vaults` | 공유된 볼트 목록 |
| `GET` | `/list_dir` | 디렉터리 나열 |
| `GET` | `/list_files_recursive` | 재귀 스캔 |
| `GET` | `/read_file` | 파일 읽기 |
| `GET` | `/resolve_image` | 이미지 경로 해석 |
| `GET` | `/list_link_targets` | 위키링크 후보 |

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```rust
#[tokio::test]
async fn file_routes_reject_every_method_but_get() {
    let app = router(test_state());
    for (method, path) in [
        (http::Method::POST, "/read_file"),
        (http::Method::PUT, "/read_file"),
        (http::Method::DELETE, "/read_file"),
        (http::Method::POST, "/list_dir"),
        (http::Method::PUT, "/vaults"),
    ] {
        let res = call(&app, method.clone(), path, None).await;
        assert_eq!(res.status(), http::StatusCode::METHOD_NOT_ALLOWED,
            "{method} {path} 는 405여야 한다 — 읽기 전용은 라우트 부재로 강제된다");
    }
}

#[tokio::test]
async fn requests_without_a_token_are_rejected() {
    let app = router(test_state());
    let res = call_no_token(&app, "/vaults").await;
    assert_eq!(res.status(), http::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn read_file_serves_a_file_inside_an_armed_vault() {
    let (state, dir) = state_with_file("note.md", "# 안녕");
    let app = router(state);
    let res = call_get(&app, "/read_file?vault=rv1&path=note.md").await;
    assert_eq!(res.status(), http::StatusCode::OK);
    let body: crate::commands::FileContent = json_body(res).await;
    assert_eq!(body.text, "# 안녕");
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn read_file_refuses_a_path_outside_the_armed_vault() {
    let (state, dir) = state_with_file("note.md", "x");
    let app = router(state);
    let res = call_get(&app, "/read_file?vault=rv1&path=../outside.md").await;
    assert_eq!(res.status(), http::StatusCode::FORBIDDEN);
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn an_unshared_vault_id_is_not_reachable() {
    let (state, dir) = state_with_file("note.md", "x");
    let app = router(state);
    let res = call_get(&app, "/read_file?vault=NOT_SHARED&path=note.md").await;
    assert_eq!(res.status(), http::StatusCode::NOT_FOUND);
    std::fs::remove_dir_all(dir).ok();
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd src-tauri && cargo test remote_host::tests`
Expected: FAIL — `router` 미정의

- [ ] **Step 3: `axum`을 추가한다**

```toml
# src-tauri/Cargo.toml [dependencies]
# 원격 볼트 호스트 서버. tokio/hyper는 이미 tauri-plugin-updater 경유로
# 그래프에 있어 실질 추가분은 axum 본체뿐이다.
axum = "0.7"
```

Run: `cd src-tauri && cargo metadata --offline --format-version 1 > /dev/null; cargo build`
Expected: 빌드 성공, `Cargo.lock` 갱신

- [ ] **Step 4: 라우터를 구현한다**

```rust
use axum::{extract::{Query, State}, http::StatusCode, response::IntoResponse, routing::{get, post}, Json, Router};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct HostState {
    pub armed: Arc<Mutex<Vec<ArmedVault>>>,
    pub devices: Arc<Mutex<Vec<crate::remote_token::PairedDevice>>>,
    pub pairing: Arc<Mutex<PairingState>>,
}

#[derive(serde::Deserialize)]
pub struct PathQuery { pub vault: String, pub path: String }

pub fn router(state: HostState) -> Router {
    Router::new()
        .route("/pair", post(pair_handler))
        .route("/vaults", get(vaults_handler))
        .route("/list_dir", get(list_dir_handler))
        .route("/list_files_recursive", get(list_files_recursive_handler))
        .route("/read_file", get(read_file_handler))
        .route("/resolve_image", get(resolve_image_handler))
        .route("/list_link_targets", get(list_link_targets_handler))
        .with_state(state)
}

/// 토큰 없는/틀린 요청은 401. `/pair`를 제외한 모든 핸들러의 첫 줄이다.
fn authorize(state: &HostState, headers: &axum::http::HeaderMap) -> Result<(), StatusCode> {
    let offered = headers.get("x-mermark-token").and_then(|v| v.to_str().ok()).unwrap_or("");
    let devices = state.devices.lock().unwrap();
    if devices.iter().any(|d| constant_time_eq(&d.token, offered)) { Ok(()) } else { Err(StatusCode::UNAUTHORIZED) }
}

/// armed 목록에 없는 볼트 id는 404 — 존재 여부 자체를 알려주지 않는다.
fn armed_vault(state: &HostState, id: &str) -> Result<ArmedVault, StatusCode> {
    state.armed.lock().unwrap().iter().find(|v| v.id == id).cloned().ok_or(StatusCode::NOT_FOUND)
}

/// 봉쇄 2중 관문. 둘 중 하나라도 실패하면 403.
fn safe_path(armed: &ArmedVault, rel: &str) -> Result<std::path::PathBuf, StatusCode> {
    let resolved = resolve_within(armed, rel).ok_or(StatusCode::FORBIDDEN)?;
    if !is_canonically_within(armed, &resolved) { return Err(StatusCode::FORBIDDEN); }
    Ok(resolved)
}

async fn read_file_handler(
    State(state): State<HostState>,
    headers: axum::http::HeaderMap,
    Query(q): Query<PathQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    authorize(&state, &headers)?;
    let armed = armed_vault(&state, &q.vault)?;
    let path = safe_path(&armed, &q.path)?;
    let content = crate::commands::read_file(path.to_string_lossy().into_owned())
        .map_err(|_| StatusCode::NOT_FOUND)?;
    Ok(Json(content))
}
```

나머지 핸들러(`list_dir`·`list_files_recursive`·`resolve_image`·`list_link_targets`·`vaults`)도 **같은 4줄 골격**(authorize → armed_vault → safe_path → `commands::` 재사용)으로 쓴다. 파일 로직을 여기서 다시 구현하지 않는다.

`FileContent`가 `Json`으로 나가려면 `Serialize`만으로 충분하지만, Task 6의 클라이언트가 역직렬화해야 하므로 지금 `Deserialize`를 같이 단다:

```rust
// src-tauri/src/commands.rs:160
#[derive(serde::Serialize, serde::Deserialize)]
pub struct FileContent { pub text: String, pub mtime: u64 }
```

`DirEntry`·`ScanResult`·`FileHit`·`LinkTarget`에도 동일하게 `Deserialize`를 추가한다.

- [ ] **Step 5: 테스트 통과를 확인한다**

Run: `cd src-tauri && cargo test remote_host`
Expected: PASS (16 tests)

- [ ] **Step 6: 바인드 진입점을 구현한다**

```rust
/// 서버를 띄운다. 바인드 주소는 호출자가 정한다 — Tailscale 인터페이스 또는
/// 127.0.0.1(SSH 터널용). 기본은 꺼짐이므로 이 함수는 사용자가 공유를 켤 때만
/// 호출된다.
pub async fn serve(bind: std::net::SocketAddr, state: HostState) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind(bind).await.map_err(|e| format!("bind {bind}: {e}"))?;
    axum::serve(listener, router(state)).await.map_err(|e| e.to_string())
}
```

- [ ] **Step 7: 커밋**

```bash
git add src-tauri/src/remote_host.rs src-tauri/src/commands.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(remote-host): 읽기 전용 axum 라우터 (GET 전용 + 토큰 인증 + 봉쇄)"
```

---

### Task 6: 클라이언트 `remote_client.rs`와 `remote_*` 커맨드

**Files:**
- Create: `src-tauri/src/remote_client.rs`
- Modify: `src-tauri/src/lib.rs` (`mod` + `invoke_handler`)

**Interfaces:**
- Consumes: Task 5의 라우트 표면
- Produces: 커맨드 `remote_pair`, `remote_vaults`, `remote_list_dir`, `remote_list_files_recursive`, `remote_read_file`, `remote_resolve_image`, `remote_list_link_targets`, 그리고 `enum RemoteStatus`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```rust
#[test]
fn host_input_defaults_to_port_8787() {
    assert_eq!(base_url("wis-macmini").unwrap(), "http://wis-macmini:8787");
}

#[test]
fn host_input_honors_an_explicit_port() {
    assert_eq!(base_url("wis-macmini:9000").unwrap(), "http://wis-macmini:9000");
}

#[test]
fn ssh_host_targets_the_local_tunnel_end() {
    assert_eq!(base_url("ssh://wis@macmini").unwrap(), "http://127.0.0.1:8787");
}

#[test]
fn rejects_a_host_with_a_path_or_scheme_we_do_not_support() {
    assert!(base_url("http://evil/x").is_err());
    assert!(base_url("").is_err());
}

#[test]
fn http_status_maps_to_the_four_surfaced_states() {
    assert_eq!(status_for(401), RemoteStatus::AuthExpired);
    assert_eq!(status_for(404), RemoteStatus::SharingOff);
    assert_eq!(status_for(200), RemoteStatus::Connected);
    assert_eq!(status_for(500), RemoteStatus::Unreachable);
}
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd src-tauri && cargo test remote_client`
Expected: FAIL — `base_url` 미정의

- [ ] **Step 3: 최소 구현을 쓴다**

```rust
//! 클라이언트 측 원격 볼트. 모든 호출에 명시적 타임아웃이 걸린다 —
//! 마운트(SMB) 방식을 기각한 이유가 정확히 이 지점이다(끊기면 커널에서
//! 무한 블로킹, 타임아웃 수단 없음). docs/design/remote-vault.md §2 참조.

use std::time::Duration;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
pub const RESPONSE_TIMEOUT: Duration = Duration::from_secs(10);
pub const DEFAULT_PORT: u16 = 8787;

#[derive(Debug, PartialEq, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteStatus { Connected, Unreachable, AuthExpired, SharingOff }

/// 사용자가 입력한 호스트 문자열을 base URL로 바꾼다.
/// `ssh://`는 mermark가 띄운 `ssh -L` 터널의 로컬 끝을 가리킨다.
pub fn base_url(host: &str) -> Result<String, String> {
    if host.is_empty() { return Err("호스트가 비어 있습니다".into()); }
    if let Some(_rest) = host.strip_prefix("ssh://") {
        return Ok(format!("http://127.0.0.1:{DEFAULT_PORT}"));
    }
    if host.contains("://") || host.contains('/') {
        return Err(format!("호스트에는 이름과 포트만 적습니다: {host}"));
    }
    if host.contains(':') { Ok(format!("http://{host}")) } else { Ok(format!("http://{host}:{DEFAULT_PORT}")) }
}

/// 조용한 강등 금지: 실패를 하나로 뭉치지 않고 사용자가 고칠 수 있는
/// 네 상태로 나눈다.
pub fn status_for(http_status: u16) -> RemoteStatus {
    match http_status {
        200..=299 => RemoteStatus::Connected,
        401 | 403 => RemoteStatus::AuthExpired,
        404 => RemoteStatus::SharingOff,
        _ => RemoteStatus::Unreachable,
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(RESPONSE_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remote_read_file(host: String, token: String, vault: String, path: String)
    -> Result<crate::commands::FileContent, String>
{
    let url = format!("{}/read_file", base_url(&host)?);
    let res = client()?
        .get(&url)
        .header("x-mermark-token", token)
        .query(&[("vault", vault.as_str()), ("path", path.as_str())])
        .send().await
        .map_err(|e| format!("연결 실패: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("REMOTE:{:?}", status_for(res.status().as_u16())));
    }
    res.json().await.map_err(|e| e.to_string())
}
```

나머지 `remote_*` 커맨드도 같은 골격으로 쓴다. `lib.rs`의 `invoke_handler`에 전부 등록한다.

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `cd src-tauri && cargo test remote_client && cargo build`
Expected: PASS (5 tests), 빌드 성공

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/remote_client.rs src-tauri/src/lib.rs
git commit -m "feat(remote-client): 타임아웃 고정 reqwest 클라이언트와 remote_* 커맨드"
```

---

### Task 7: 브라우저 mock 경계면 parity

프로젝트 상시 규약이다 — 새 커맨드는 mock에 같이 들어가야 한다.

**Files:**
- Modify: `src/mocks/tauri-core.ts`

- [ ] **Step 1: mock case를 추가한다**

```ts
// src/mocks/tauri-core.ts — 기존 switch에 추가
case "remote_vaults":
  return [{ id: "rv-demo", displayName: "원격 데모 볼트" }] as T;
case "remote_read_file":
  return { text: "# 원격 데모\n\n브라우저 mock이 만든 원격 문서입니다.", mtime: 1 } as T;
case "remote_list_dir":
  return [{ name: "원격노트.md", path: "원격노트.md", isDir: false }] as T;
case "remote_list_files_recursive":
  return { files: [{ name: "원격노트.md", path: "원격노트.md" }], truncated: false } as T;
case "remote_resolve_image":
  return null as T;
case "remote_list_link_targets":
  return [] as T;
case "remote_pair":
  return { token: "0".repeat(32), vaults: [{ id: "rv-demo", displayName: "원격 데모 볼트" }] } as T;
```

- [ ] **Step 2: 타입·테스트 회귀를 확인한다**

Run: `npx tsc --noEmit && npm test && npm run dev:browser` (수동으로 브라우저에서 원격 볼트 추가가 동작하는지 확인)
Expected: PASS

- [ ] **Step 3: 커밋**

```bash
git add src/mocks/tauri-core.ts
git commit -m "test(mock): remote_* 커맨드 브라우저 mock 추가 (경계면 parity)"
```

---

### Task 8: `file-host.ts` 원격 분기 연결

**Files:**
- Modify: `src/document/file-host.ts`
- Modify: `src/document/file-host.test.ts`

**Interfaces:**
- Consumes: Task 6의 `remote_*` 커맨드, Task 2의 `RemoteVault`
- Produces: `remoteFileHost(vault: RemoteVault, token: string): FileHostBackend`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
it("원격 볼트는 remote_* 커맨드로 간다", async () => {
  const calls: Array<[string, unknown]> = [];
  const host = remoteFileHost(
    { persistenceKind: "remote", host: "wis-macmini", remoteVaultId: "rv1" } as never,
    "tok",
    (cmd, args) => { calls.push([cmd, args]); return Promise.resolve({ text: "", mtime: 0 }) as never; },
  );
  await host.readFile("note.md");
  expect(calls[0][0]).toBe("remote_read_file");
  expect(calls[0][1]).toMatchObject({ host: "wis-macmini", token: "tok", vault: "rv1", path: "note.md" });
});

it("원격 실패는 4종 상태로 분류된다", () => {
  expect(classifyRemoteError(new Error("REMOTE:AuthExpired"))).toBe("auth-expired");
  expect(classifyRemoteError(new Error("REMOTE:SharingOff"))).toBe("sharing-off");
  expect(classifyRemoteError(new Error("연결 실패: timeout"))).toBe("unreachable");
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/document/file-host.test.ts`
Expected: FAIL — `remoteFileHost` 미정의

- [ ] **Step 3: 구현한다**

```ts
export type RemoteConnectionState = "connected" | "unreachable" | "auth-expired" | "sharing-off";

export const classifyRemoteError = (e: unknown): RemoteConnectionState => {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("REMOTE:AuthExpired")) return "auth-expired";
  if (msg.includes("REMOTE:SharingOff")) return "sharing-off";
  return "unreachable";
};

export const remoteFileHost = (
  vault: RemoteVault,
  token: string,
  call: typeof invoke = invoke,
): FileHostBackend => {
  const base = { host: vault.host, token, vault: vault.remoteVaultId };
  return {
    readFile: (path) => call("remote_read_file", { ...base, path }),
    listDir: (path) => call("remote_list_dir", { ...base, path }),
    listFilesRecursive: (root) => call("remote_list_files_recursive", { ...base, root }),
    resolveImage: (baseDir, name, maxDepth) => call("remote_resolve_image", { ...base, baseDir, name, maxDepth }),
    listLinkTargets: (dir) => call("remote_list_link_targets", { ...base, dir }),
    pathExists: async () => true,      // 원격은 서버가 404로 답한다
    directoryExists: async () => true,
  };
};
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `npx vitest run src/document/file-host.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/document/file-host.ts src/document/file-host.test.ts
git commit -m "feat(file-host): 원격 볼트 분기와 연결 상태 4종 분류"
```

---

### Task 9: 호스트 설정 UI — 공유 켜기·볼트 선택·페어링 코드

**Files:**
- Modify: `src/settings/app.ts` (설정 항목 등록)
- Create: `src/settings/remote-share-panel.ts`
- Create: `src/settings/remote-share-panel.test.ts`

**Interfaces:**
- Consumes: 커맨드 `remote_share_start`, `remote_share_stop`, `remote_share_status`, `remote_issue_code`, `remote_revoke_device` (Task 5·6의 호스트 상태를 감싸는 Tauri 커맨드 — 이 태스크에서 `remote_host.rs`에 추가한다)
- Produces: 설정 패널 `원격 공유`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
it("공유는 기본 꺼짐이고, 볼트를 하나도 고르지 않으면 켤 수 없다", () => {
  const model = makeShareModel({ vaults: [{ vaultId: "v1", displayName: "노트" }] });
  expect(model.enabled).toBe(false);
  expect(model.canEnable()).toBe(false);
  model.toggleVault("v1");
  expect(model.canEnable()).toBe(true);
});

it("페어링 코드는 5분 뒤 만료로 표시된다", () => {
  const model = makeShareModel({ vaults: [], now: () => 0 });
  model.receiveCode({ code: "123456", issuedAtMs: 0 });
  expect(model.codeRemainingMs(0)).toBe(300_000);
  expect(model.codeRemainingMs(300_001)).toBe(0);
  expect(model.codeExpired(300_001)).toBe(true);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/settings/remote-share-panel.test.ts`
Expected: FAIL

- [ ] **Step 3: 모델과 패널을 구현한다**

```ts
export const PAIRING_TTL_MS = 300_000;

export const makeShareModel = (deps: { vaults: Array<{ vaultId: string; displayName: string }>; now?: () => number }) => {
  const shared = new Set<string>();
  let code: { code: string; issuedAtMs: number } | null = null;
  return {
    enabled: false,
    canEnable: () => shared.size > 0,
    toggleVault: (id: string) => { shared.has(id) ? shared.delete(id) : shared.add(id); },
    sharedVaultIds: () => [...shared],
    receiveCode: (c: { code: string; issuedAtMs: number }) => { code = c; },
    codeRemainingMs: (now: number) =>
      code ? Math.max(0, PAIRING_TTL_MS - (now - code.issuedAtMs)) : 0,
    codeExpired: (now: number) => (code ? now - code.issuedAtMs > PAIRING_TTL_MS : true),
  };
};
```

패널 UI는 기존 설정 컴포넌트 규약(`docs/SETTINGS_COMPONENT_SPEC.md`)을 따른다. 구성:
1. `공유 켜기` 토글 — `canEnable()`이 false면 비활성 + `공유할 볼트를 먼저 선택하세요` 안내
2. 볼트 체크박스 목록
3. 바인드 방식 라디오: `Tailscale` / `로컬호스트만 (SSH 터널)` — Tailscale 미감지 시 첫 항목 비활성 + `Tailscale이 감지되지 않았습니다`
4. `페어링 코드 만들기` 버튼 → 6자리 코드 + 남은 시간 카운트다운
5. 페어링된 기기 목록 + `연결 해제`
6. 공유를 처음 켤 때 안내: `macOS가 네트워크 연결 수신을 허용할지 물어봅니다 — 허용해야 다른 기기에서 접속할 수 있습니다.`

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `npx vitest run src/settings/ && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/settings/remote-share-panel.ts src/settings/remote-share-panel.test.ts src/settings/app.ts src-tauri/src/remote_host.rs src-tauri/src/lib.rs
git commit -m "feat(settings): 원격 공유 패널 — 볼트 선택·바인드 방식·페어링 코드·기기 철회"
```

---

### Task 10: 클라이언트 UI — 원격 볼트 추가와 상태 배지

**Files:**
- Create: `src/workspace/add-remote-vault.ts`
- Create: `src/workspace/add-remote-vault.test.ts`
- Modify: `src/workspace/workspace-sidebar.ts` (배지 렌더링)
- Modify: `src/styles.css`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
it("호스트와 6자리 코드가 모두 유효해야 페어링 버튼이 켜진다", () => {
  const f = makeAddRemoteForm();
  expect(f.canSubmit()).toBe(false);
  f.setHost("wis-macmini");
  f.setCode("12345");
  expect(f.canSubmit()).toBe(false);
  f.setCode("123456");
  expect(f.canSubmit()).toBe(true);
});

it("연결 상태 4종이 각각 다른 배지로 매핑된다", () => {
  expect(badgeFor("connected")).toEqual({ label: "연결됨", tone: "ok" });
  expect(badgeFor("unreachable")).toEqual({ label: "연결 안 됨", tone: "warn" });
  expect(badgeFor("auth-expired")).toEqual({ label: "인증 만료", tone: "error" });
  expect(badgeFor("sharing-off")).toEqual({ label: "호스트가 공유를 껐음", tone: "warn" });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/workspace/add-remote-vault.test.ts`
Expected: FAIL

- [ ] **Step 3: 구현한다**

```ts
import type { RemoteConnectionState } from "../document/file-host";

export const badgeFor = (state: RemoteConnectionState): { label: string; tone: "ok" | "warn" | "error" } => {
  switch (state) {
    case "connected": return { label: "연결됨", tone: "ok" };
    case "unreachable": return { label: "연결 안 됨", tone: "warn" };
    case "auth-expired": return { label: "인증 만료", tone: "error" };
    case "sharing-off": return { label: "호스트가 공유를 껐음", tone: "warn" };
  }
};

export const makeAddRemoteForm = () => {
  let host = "";
  let code = "";
  return {
    setHost: (v: string) => { host = v.trim(); },
    setCode: (v: string) => { code = v.trim(); },
    canSubmit: () => host.length > 0 && /^\d{6}$/.test(code),
    values: () => ({ host, code }),
  };
};
```

`workspace-sidebar.ts`의 볼트 행 렌더링에 원격 볼트일 때 배지를 붙인다. 탐색기는 원격 디렉터리 로딩 중 스켈레톤을 표시한다(동기 블로킹 금지).

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `npx vitest run src/workspace/ && npx tsc --noEmit && npm test`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/workspace/add-remote-vault.ts src/workspace/add-remote-vault.test.ts src/workspace/workspace-sidebar.ts src/styles.css
git commit -m "feat(workspace): 원격 볼트 추가 UI와 연결 상태 배지 4종"
```

---

### Task 11: 읽기 전용 표시와 미지원 파일 안내

**Files:**
- Modify: `src/editor.ts` (읽기 전용 모드)
- Modify: `src/chrome/` 상태바
- Create: `src/document/remote-capability.test.ts`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
it("원격 볼트에서 아직 못 여는 확장자를 명시한다", () => {
  expect(remoteCanOpen("note.md")).toBe(true);
  expect(remoteCanOpen("그림.png")).toBe(true);
  for (const f of ["책.epub", "문서.pdf", "보고서.hwp", "db.sqlite"]) {
    expect(remoteCanOpen(f)).toBe(false);
    expect(remoteUnsupportedMessage(f)).toBe("원격 볼트에서는 아직 지원하지 않습니다");
  }
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/document/remote-capability.test.ts`
Expected: FAIL

- [ ] **Step 3: 구현한다**

```ts
// 원격 볼트가 v1에서 열 수 있는 것: 마크다운과 이미지뿐.
// 나머지는 조용히 깨진 뷰어를 띄우는 대신 명시적으로 거절한다.
const REMOTE_UNSUPPORTED = new Set(["epub", "pdf", "hwp", "hwpx", "sqlite", "db", "html", "htm"]);

export const remoteCanOpen = (fileName: string): boolean => {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return !REMOTE_UNSUPPORTED.has(ext);
};

export const remoteUnsupportedMessage = (_fileName: string): string =>
  "원격 볼트에서는 아직 지원하지 않습니다";
```

에디터는 원격 문서를 열 때 `EditorState.readOnly`를 켜고 상태바에 `읽기 전용 (원격)`을 표시한다. 저장 단축키는 무음 무시가 아니라 `원격 볼트는 읽기 전용입니다` 안내를 띄운다.

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/document/remote-capability.ts src/document/remote-capability.test.ts src/editor.ts src/chrome/
git commit -m "feat(remote): 읽기 전용 표시와 미지원 파일 명시 안내"
```

---

### Task 12: SSH 터널 폴백

Tailscale이 없는 사용자를 위한 경로. mermark는 SSH 키를 다루지 않고 사용자의 기존 SSH 설정을 그대로 쓴다.

**Files:**
- Create: `src-tauri/src/remote_ssh.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```rust
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
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd src-tauri && cargo test remote_ssh`
Expected: FAIL

- [ ] **Step 3: 구현한다**

```rust
//! SSH 터널 폴백. mermark는 키를 다루지 않는다 — 사용자의 기존 ~/.ssh 설정을
//! 그대로 쓰는 `ssh -L` 자식 프로세스를 띄울 뿐이다.

/// `ssh://user@host` → `ssh -N -L <port>:localhost:<port> user@host` 의 인자.
/// 셸을 거치지 않고 인자 배열로 직접 exec하지만, 그래도 타깃 문자열을
/// 보수적으로 검증한다 — 옵션 주입(`-o …`)과 메타문자를 막기 위해서다.
pub fn tunnel_args(host: &str, port: u16) -> Result<Vec<String>, String> {
    let target = host.strip_prefix("ssh://").ok_or("ssh:// 호스트가 아닙니다")?;
    if target.is_empty() || target.starts_with('-') {
        return Err("SSH 대상이 올바르지 않습니다".into());
    }
    let ok = target.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '.' | '-' | '_'));
    if !ok { return Err(format!("SSH 대상에 허용되지 않는 문자가 있습니다: {target}")); }
    Ok(vec!["-N".into(), "-L".into(), format!("{port}:localhost:{port}"), target.to_string()])
}
```

터널 프로세스는 `Child`를 관리 상태로 들고 있다가 볼트 제거·앱 종료 시 `kill`한다. 터널이 죽으면 연결 상태는 `unreachable`로 떨어진다(조용한 강등 금지 규칙에 따라 배지로 드러난다).

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `cd src-tauri && cargo test remote_ssh && cargo build`
Expected: PASS (3 tests)

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/remote_ssh.rs src-tauri/src/lib.rs
git commit -m "feat(remote-ssh): ssh -L 터널 폴백 (키는 사용자 설정에 위임)"
```

---

### Task 13: 기능 문서 갱신과 실앱 왕복 검증

**Files:**
- Modify: `docs/FEATURES.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: `docs/FEATURES.md`에 원격 볼트를 계층별로 추가한다**

CLAUDE.md의 Phase 6 규약이다 — 사용자 관측 기능이 바뀌면 같은 커밋 묶음에서 갱신한다.
L1 백엔드(`remote_host`/`remote_client`/`remote_ssh`), L3 볼트 모델(`RemoteVault`), L5 UI 크롬(원격 공유 설정, 원격 볼트 추가, 상태 배지)에 각각 항목을 넣는다.

- [ ] **Step 2: 전체 게이트를 돌린다**

Run: `npm test && npx tsc --noEmit && cd src-tauri && cargo test`
Expected: 전부 PASS

- [ ] **Step 3: 실앱 왕복을 검증한다 (생략 불가)**

골든마스터는 http origin에서 돌아 실앱 전용 문제를 못 잡는다. 네트워크 바인드·방화벽 팝업·Tailscale 인터페이스 선택은 번들에서만 드러난다.

```bash
./scripts/release.sh --dry-run   # 게이트 확인
npm run tauri build              # 또는 release.sh가 빌드까지 소유
```

맥미니에 빌드된 `.app`을 설치해 공유를 켜고, 맥북에서 페어링해 다음을 **직접 눈으로** 확인한다:

1. 첫 바인드에서 macOS 방화벽 팝업이 뜨고, 허용하면 접속된다
2. 맥북에서 `wis-macmini` + 6자리 코드로 페어링된다
3. 탐색기에 맥미니 볼트 트리가 뜨고, 마크다운이 열린다
4. 이미지가 렌더링된다
5. 에디터가 읽기 전용으로 뜨고 ⌘S가 안내를 띄운다
6. **맥미니에서 Wi-Fi를 끊으면** 맥북 UI가 얼지 않고 3초 안에 `연결 안 됨` 배지로 바뀐다 ← 마운트 방식을 기각한 이유를 검증하는 항목
7. 호스트에서 `연결 해제`를 누르면 맥북이 `인증 만료`로 바뀐다
8. 호스트가 공유를 끄면 맥북이 `호스트가 공유를 껐음`으로 바뀐다
9. 원격 볼트의 EPUB/PDF가 `원격 볼트에서는 아직 지원하지 않습니다`로 뜬다

- [ ] **Step 4: CHANGELOG를 쓰고 커밋한다**

```bash
git add docs/FEATURES.md CHANGELOG.md
git commit -m "docs(features): 원격 볼트 기능 계층 문서 갱신"
```

---

## Self-Review 결과

**스펙 커버리지** — `docs/design/remote-vault.md`의 각 절이 태스크에 매핑된다:
§4.1 호스트 → Task 3·4·5·9 / §4.2 클라이언트 → Task 6 / §4.3 초크포인트 → Task 1·8 /
§4.4 볼트 모델 → Task 2 / §5 인증·페어링 → Task 4·9·10, SSH 폴백 → Task 12 /
§6 오프라인·에러 → Task 8(분류)·10(배지)·11(읽기전용·미지원) /
§7 테스트 → 각 태스크에 내장 + Task 7(mock parity)·13(실앱) / §8 비범위 → 태스크 없음(의도적)

**보완한 것** — 스펙에 없던 두 가지를 계획에서 채웠다:
1. **심볼릭 링크 봉쇄**(Task 3 Step 5). 컴포넌트 검사만으로는 심볼릭 링크 탈출이 뚫린다. 2차 정규화 관문을 추가했다.
2. **SSH 타깃 인자 주입 방어**(Task 12). `ssh://` 문자열이 그대로 인자가 되면 `-o ProxyCommand=…` 같은 옵션 주입 여지가 있어 문자 화이트리스트를 넣었다.

**타입 일관성** — `FileHostBackend`의 7개 메서드 이름이 Task 1(정의)·8(원격 구현)에서 동일하다. `RemoteConnectionState` 4개 리터럴이 Task 8(정의)·10(배지 매핑)에서 동일하다. Rust `RemoteStatus`는 `serde(rename_all = "kebab-case")`로 TS 리터럴과 맞춘다.

**남은 판단** — 스펙 §5의 토큰 파일 보관(Keychain 대신 0600)은 의도적 트레이드오프로 유지했다. 뒤집으려면 Task 4 Step 5만 바꾸면 되도록 `remote_token.rs` 한 모듈에 가뒀다.
