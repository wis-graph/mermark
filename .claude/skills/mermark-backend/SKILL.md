---
name: mermark-backend
description: >-
  mermark의 Rust/Tauri 백엔드 구현 플레이북. src-tauri/src/{commands.rs,lib.rs,cli.rs}의
  #[tauri::command] 추가·수정, FileContent 같은 serde 반환 구조체 설계, atomic 파일 쓰기(temp+rename),
  mtime conflict-guard(read→baseline→write) 계약, CSP/capabilities/assetProtocol 보안 설정,
  cargo #[cfg(test)] 작성에 사용한다. backend-engineer 에이전트가 호출한다. 트리거 — "read_file/write_file
  시그니처 바꿔줘", "새 invoke 커맨드 추가", "conflict guard 손봐줘", "CSP에 katex/mermaid 허용",
  "capabilities/assetProtocol scope 수정", "cargo 테스트 추가". 단, CodeMirror/live-preview/위젯 등
  프론트엔드 TS 작업은 이 스킬이 아니라 mermark-frontend다 — 백엔드 커맨드 시그니처가 바뀔 때만
  src/mocks/tauri-core.ts와 invoke<>() 타입을 함께 고치는 게 이 스킬의 경계다.
---

# mermark-backend

mermark의 백엔드는 의도적으로 작다. IPC 표면이 좁을수록 보안 검토가 쉽고 콜드 로드가 빠르기 때문이다. 새 기능을 백엔드에 넣기 전에 "이게 정말 OS/파일시스템 권한이 필요한 일인가"를 먼저 묻는다. 프론트에서 끝낼 수 있으면 커맨드를 늘리지 않는다.

대상 파일은 `src-tauri/src/{commands.rs, lib.rs, cli.rs}`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`이다. 커맨드 시그니처를 건드리면 `src/mocks/tauri-core.ts`도 같은 커밋에서 고친다(아래 동기화 규칙).

## 커맨드 패턴

모든 커맨드는 `#[tauri::command]` + 순수 함수 + `Result<T, String>` 반환이다. 에러를 문자열로 평탄화하는 이유는 프론트가 `invoke<>()`에서 reject 메시지를 그대로 읽어 처리하고(예: `CONFLICT:` 프리픽스 분기), 커스텀 에러 enum을 serde로 왕복시키는 비용이 이 앱 규모에선 정당화되지 않기 때문이다.

반환이 단일 스칼라가 아니면 named serde 구조체를 만든다. 튜플/맵으로 던지면 프론트에서 위치 의존이 생긴다:

```rust
/// A file's contents plus the modification time observed when it was read.
#[derive(serde::Serialize)]
pub struct FileContent {
    pub text: String,
    pub mtime: u64,
}

#[tauri::command]
pub fn read_file(path: String) -> Result<FileContent, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))?;
    Ok(FileContent { text, mtime: mtime_ms(&path) })
}
```

### 단일 단어 인자 이름

커맨드 인자는 가능하면 한 단어(`path`, `text`, `baseline`)로 짓는다. JS는 camelCase, Rust는 snake_case라서 `base_line` ↔ `baseLine` 같은 멀티 워드 이름은 Tauri의 변환 레이어에서 어긋나기 쉽다. 한 단어는 어느 규칙에서도 동일하게 매핑되어 이 함정을 원천 차단한다. 이건 `write_file`의 `baseline`이 두 단어가 아닌 이유다.

### lib.rs 등록

새 커맨드는 `lib.rs`의 `invoke_handler![read_file, write_file, path_exists, open_path]` 목록에 추가해야 프론트에서 보인다. 등록을 빠뜨리면 런타임에 "command not found"로만 터지니, 커맨드 추가 = handler 등록을 한 단위로 본다.

## Atomic 파일 쓰기

`write_file`은 절대 대상 파일에 직접 쓰지 않는다. 형제 temp 파일에 쓴 뒤 `rename`으로 덮어쓴다. rename은 같은 파일시스템에서 원자적이라, 쓰기 도중 크래시가 나도 사용자 파일이 잘리는 일이 없다. 이건 conflict guard와 별개인 "절대 손상 없음"의 강한 보장이다.

```rust
let tmp = format!("{path}.mermark-tmp.{}", TMP_SEQ.fetch_add(1, Ordering::Relaxed));
std::fs::write(&tmp, &text).map_err(|e| format!("write {tmp}: {e}"))?;
std::fs::rename(&tmp, &path).map_err(|e| {
    let _ = std::fs::remove_file(&tmp); // 실패 시 temp를 남기지 않는다
    format!("rename {tmp} -> {path}: {e}")
})?;
Ok(mtime_ms(&path))
```

두 가지를 지킨다: temp 이름에 `TMP_SEQ` 같은 프로세스 단위 카운터를 넣어 동시 쓰기 충돌을 피하고, rename 실패 경로에서 temp를 반드시 정리한다. autosave 테스트(`write_leaves_no_temp_file`)가 잔여 temp를 검사하므로 정리를 빠뜨리면 즉시 빨개진다.

## mtime conflict-guard 계약

read→baseline→write가 한 계약이다. `read_file`이 돌려준 `mtime`을 프론트가 baseline으로 들고 있다가 `write_file(path, text, baseline)`에 되돌려준다. 백엔드는 디스크의 현재 mtime이 baseline보다 **엄격히 크면**(`>`) 외부 변경으로 보고 `CONFLICT:` 프리픽스 에러로 거부한다. 우리 자신의 쓰기에 false-positive를 내지 않으려면 `>=`가 아니라 `>`여야 한다.

```rust
#[tauri::command]
pub fn write_file(path: String, text: String, baseline: u64) -> Result<u64, String> {
    if baseline != 0 {
        let current = mtime_ms(&path);
        if current > baseline {
            return Err(format!(
                "CONFLICT: file changed on disk since it was opened (baseline={baseline}, disk={current})"
            ));
        }
    }
    // ... atomic write ...
}
```

`baseline == 0`은 "baseline 없음"을 뜻하는 약속이라 conflict 검사를 건너뛴다(첫 저장·복구 경로). `mtime_ms`는 fs가 modified time을 못 주면 0을 반환하는데, 그러면 conflict 검사가 자동으로 무력화된다 — 안전 쪽으로 fail-open이 아니라 검사 생략이라는 점을 의식하고, mtime 의존 로직을 새로 짤 때 0의 의미를 깨지 않는다. 거친 해상도 fs(HFS+ 1s, FAT 2s)에선 같은 초 버킷의 외부 편집이 동률로 새어나갈 수 있지만, APFS/ext4/NTFS의 sub-second mtime에선 정확하다. 손상 방지의 최종 보루는 어차피 위의 atomic rename이다.

## 보안 설정

IPC와 권한 표면은 최소로 유지한다. 변경할 일이 생기면 다음을 기준으로 판단한다.

### CSP (`tauri.conf.json` → `app.security.csp`)

KaTeX/Mermaid는 인라인 스타일을 주입하므로 `style-src`에 `'unsafe-inline'`이 필요하다. 스크립트는 절대 인라인 허용하지 않는다(`script-src 'self'`만). 로컬 이미지/폰트를 위젯에 띄우려면 `asset:`와 `asset.localhost` 오리진이 `img-src`/`font-src`/`connect-src`에 있어야 한다. 현재 값:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
font-src 'self' data: asset: http://asset.localhost https://asset.localhost;
img-src 'self' data: https: asset: http://asset.localhost https://asset.localhost;
connect-src 'self' ipc: http://ipc.localhost asset: http://asset.localhost https://asset.localhost;
object-src 'none'; base-uri 'self'
```

새 리소스 출처를 허용할 땐 가장 좁은 directive에만 추가한다. `script-src`에 `'unsafe-inline'`/`'unsafe-eval'`을 넣자는 요구가 오면 거부하고 대안(로컬 번들)을 제시한다 — XSS 방어선이 무너진다. `devCsp`는 `null`로 둬서 dev/prod CSP가 갈라지지 않게 한다(개발 중 통과한 게 배포에서 막히는 사고 방지).

### assetProtocol scope

`assetProtocol.scope`는 `convertFileSrc`로 위젯이 읽을 수 있는 로컬 파일 경로 범위다. 현재 `["**"]`(전체)인 이유는 사용자가 임의 위치의 노트를 열고 그 옆 이미지를 참조하기 때문이다. 스코프를 좁히자는 제안이 오면 이 사용 사례를 깨지 않는지 먼저 확인한다.

### withGlobalTauri 와 capabilities

`withGlobalTauri`는 `false`로 유지한다 — 전역 `window.__TAURI__`를 노출하면 공격 표면이 늘고, 프론트는 어차피 `@tauri-apps/api`를 import해서 쓴다. 새 플러그인 권한이 필요하면 `tauri.conf.json`이 아니라 `capabilities/default.json`의 `permissions` 배열에 추가한다. 필요한 권한만 핀포인트로 넣고, 와일드카드 권한은 피한다.

## cargo 테스트

모든 fs 동작 커맨드는 `#[cfg(test)] mod tests`로 실제 파일시스템 왕복을 검증한다. 모킹하지 않는 이유는 atomic rename·mtime 같은 보장이 fs 의미론 자체에 의존하기 때문이다. temp 경로는 PID + 카운터로 격리하고, 각 테스트 끝에서 `fs::remove_file(&p).ok()`로 정리한다.

```rust
fn temp_path(tag: &str) -> String {
    let n = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir()
        .join(format!("mermark_test_{}_{}_{tag}.md", std::process::id(), n))
        .to_string_lossy()
        .into_owned()
}
```

커맨드를 추가/수정하면 최소한 happy-path 1개 + 핵심 도메인 규칙 1개씩 테스트를 단다. `write_file` 계약의 회귀를 막는 표준 케이스: `write_persists_and_returns_mtime`, `write_leaves_no_temp_file`(잔여 temp 검사), `stale_baseline_is_a_conflict`(거부 + 파일 불변 동시 확인), `matching_baseline_writes`, `zero_baseline_skips_conflict_check`. 새 분기를 넣으면 이 패턴을 따라 대응 테스트를 추가한다. 도메인 규칙(예: conflict 판정)은 인라인 `if`로 흩지 말고 의미가 드러나는 헬퍼(`mtime_ms` 같은)로 뽑아 이름으로 의도를 박는다.

검증은 `src-tauri`에서 `cargo test`로 돌린다. CLI 인자 해석은 `cli.rs`의 `resolve_target(args, cwd)`에 테스트와 함께 있다 — 인자 처리 로직을 바꾸면 거기 테스트를 갱신한다.

## 동기화 규칙 (절대 빠뜨리지 말 것)

커맨드 시그니처(이름·인자·반환 형태)를 바꾸면 **세 곳을 한 커밋에서** 맞춘다. 하나라도 빠지면 브라우저 골든마스터(`npm run dev:browser` + CDP)가 실제 백엔드와 다른 동작을 검증하게 되어 위양성/위음성이 난다:

1. `src-tauri/src/commands.rs` — 실제 Rust 구현
2. `src/mocks/tauri-core.ts` — 브라우저 모드 인메모리 mock의 해당 `case`
3. 프론트 호출부의 `invoke<ReturnType>(...)` 제네릭 타입

예: `write_file`가 `Result<u64>`(mtime) 대신 다른 구조체를 반환하게 바꾸면, mock의 `case "write_file"`도 그 구조체를 돌려주도록 고치고(`return Date.now() as T`가 아니라 새 형태로), 프론트의 `invoke<u64>` 제네릭도 바꾼다. mock은 `cmd`에서 `plugin:` 프리픽스를 떼고 인자를 `a.path`/`a.text`/`a.baseline`처럼 단일 단어로 읽으므로, 인자 이름을 바꾸면 mock의 키 접근도 같이 바꾼다. 이 mock은 Rust가 없는 평범한 브라우저에서 프론트가 돌아가게 해 CDP/DevTools 디버깅을 가능케 하는 장치라, 백엔드 계약과 어긋나면 디버깅 환경 전체가 거짓이 된다.

## 입력·출력 프로토콜

- 입력: feature-architect의 설계서 `_workspace/{NN}_architect_design.md`와 계획 `_workspace/{NN}_architect_plan.md`를 읽고 백엔드 변경 범위를 확정한다.
- 출력: 변경 요약을 `_workspace/{NN}_backend_changes.md`에 쓴다 — 건드린 파일 경로, 커맨드 시그니처 before/after, 추가한 cargo 테스트, 동기화 규칙 3곳 반영 여부 체크리스트, qa-verifier가 돌릴 검증 명령(`cargo test`, 필요 시 `npm run dev:browser` 골든마스터)을 명시한다.
- 코드는 리포에 직접 랜딩하고 `_workspace/`는 감사 추적용으로 남긴다.

## 에러 핸들링

- 설계서가 없거나 백엔드 변경이 불필요하다고 판단되면, 추측으로 커맨드를 만들지 말고 그 사실을 `_workspace/{NN}_backend_changes.md`에 "백엔드 변경 없음 + 근거"로 적고 feature-architect에게 SendMessage로 확인을 요청한다.
- 시그니처 변경인데 mock/타입 동기화 위치가 불명확하면, 임의로 추정하지 말고 프론트 호출부를 `invoke<` grep으로 먼저 확인한다.
- `cargo test`가 실패하면 통과시키기 전에는 출력 산출물을 "완료"로 표시하지 않는다.

## 협업 (팀 통신 프로토콜)

- feature-architect: 설계서 모호·누락 시 SendMessage로 질의.
- frontend-engineer: 커맨드 시그니처를 바꾸면 SendMessage로 통지한다 — 프론트의 `invoke<>()` 호출부와 `src/mocks/tauri-core.ts`가 함께 갱신돼야 하므로 누가 mock을 맡을지 합의한다(기본은 시그니처를 바꾼 쪽인 backend-engineer가 mock도 함께 고친다).
- qa-verifier: 출력서에 실행할 검증 명령을 명시해 넘긴다.
- code-auditor: 보안 설정(CSP/capabilities/scope) 변경 시 감사 포인트를 출력서에 표시한다.

## 이전 산출물이 있을 때 (재호출)

`_workspace/{NN}_backend_changes.md`가 이미 있으면 처음부터 다시 쓰지 않는다. qa-verifier/code-auditor의 피드백(`{NN}_qa_report.md`, `{NN}_audit_report.md`)을 읽고 지적된 항목만 수정한다. 수정 시 동기화 규칙 3곳을 다시 점검하고, 출력서의 체크리스트와 검증 명령을 갱신한다. 피드백을 좁게 패치하지 말고, 같은 부류의 회귀가 재발하지 않도록 도메인 규칙 수준에서 일반화해 반영한다.
