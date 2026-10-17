# Intent Review — 2026-10-18 · 파트 D: `src-tauri/src/**` (Rust 백엔드)

함수 의도(이름)와 구현(동작)의 괴리를 Rust 백엔드 전체에서 검토했다. `#[cfg(test)] mod` 블록과
테스트 전용 파일(`watcher_characterization.rs`, `fs/test_support.rs`)은 평가에서 뺐다.
1차 스캔은 `quick-check.sh`다. 이 스크립트는 JS 문법 기준으로 함수 시작을 인식해서 `fn … -> T {` 형태를
대부분 놓친다. 그래서 테스트 모듈만 건너뛰는 Rust 전용 길이 스캐너를 따로 돌려 보완했다. 판정은 전부 코드를 직접 읽고 내렸다.

## 요약

- **스캔**: 33개 `.rs` 파일(프로덕션 31개). 전체 ~18.9k줄 중 프로덕션 ~10.0k줄. 프로덕션 함수 ~410개, `#[tauri::command]` 52개.
- **후보**: 32건 (high 10 / medium 10 / low 12). False positive로 제외한 것은 아래 「Skip」에 따로 적었다.
- **CQS 위반(사기꾼 ⭐)**: **0건**. `get_`/`is_`/`find_`/`resolve_` 같은 질의형 이름 가운데 관찰 가능한 상태를 바꾸는 함수는 없다.
  `resolve_*` 계열(`resolve_image`·`resolve_target`·`resolve_recipient`·`HtmlViewRoots::resolve_target`·`EpubViewRoots::resolve`·
  `resolve_bind_ip`·`resolve_openable_file`·`resolve_app_for`)은 모두 순수하거나 읽기 전용이다.
  경계 사례는 `resolve_import_source`(`attachment_import.rs:417/429`) 하나다. release 빌드에서 네이티브 파일 선택 대화상자를 띄우지만,
  앱 상태가 아니라 사용자 상호작용이라서 ⭐⭐⭐⭐로 판정했다. Result를 반환하면서 상태를 바꾸는 함수(`redeem`, `rollback_import`, `set_watch`,
  `claim_for_delivery`, `begin_open`, `complete` 등)는 전부 명령형 이름이라 정상인 Command다. 06-13·07-03 리뷰가 TS에서 확인한
  "CQS 0건" 규율이 Rust에서도 유지된다.
- **God 함수**: `lib.rs:281 run()` 372줄 하나다. Tauri 부트스트랩 관례라서 예외로 인정했다. 다만 안에 박힌 도메인 규칙 5건은 아래 M7에 적었다.
  이 밖에 80줄 이상은 `fs/image_resolve.rs:82 scan_match` 85줄과 `fs/listing.rs:206 walk_files_recursive` 82줄 두 개다.
- **최대 이슈**: **IPC 오류 문자열 접두사 계약이 타입 없이 7개 모듈의 `format!` 리터럴로 흩어져 있다.** `CONFLICT:`·`REMOTE:*`·`ATTACH_*`·
  `ROLLBACK_*`·`PORT_*`·`SSH_TUNNEL_*`·`"not-zip"`이 그렇다. TS는 이 문자열을 `startsWith`/`includes`로 다시 파싱한다.
  `REMOTE:`는 `RemoteStatus`의 **Debug 이름**(`AuthExpired`)을 쓰는데, 같은 enum의 serde 와이어 형태는 kebab(`auth-expired`)이다.
  한 enum이 와이어에 두 가지 인코딩으로 나간다.
- **결론**: 함수 하나하나의 네이밍 규율은 TS 쪽처럼 높다. 도메인 규칙 대부분이 이미 명명 함수(`is_hidden_entry`, `is_mermark_artifact`,
  `safe_path`, `canonicalize_within` 등)로 뽑혀 있다. 남은 부채는 개별 함수보다 **같은 규칙을 여러 모듈이 각자 구현하는 분산 의도**다.
  high 10건이 전부 이 유형이다. 대표적으로 문서 창 빌더 3벌, 원격 커맨드 프리앰블 8벌, 이미지 확장자/MIME 5벌, 유계 읽기 4벌,
  설정 JSON 저장소 3벌, 경로 인입 정책 4종이 있다. 09-25 아키텍처 진단의 `commands.rs` 분할은 해소됐지만, 봉쇄 primitive 통합과
  원격 호스트의 블로킹 IO 정리는 잔존한다.

---

## 이전 리뷰 대조 (해소 / 잔존)

`intent-review-2026-06-13.md`와 `intent-review-2026-07-03.md`는 범위가 `src/**/*.ts`라서 Rust 항목이 없다. 해당 없음.
Rust를 다룬 이전 리뷰는 `2026-09-25-architecture-diagnosis.md` 하나뿐이라, 그 Rust 항목을 기준으로 대조했다.

| 09-25 항목 | 상태 | 근거 |
|---|---|---|
| §3.2 `commands.rs` → `fs/*` 도메인 + 얇은 어댑터 | ✅ 해소 | `commands.rs` 프로덕션 189줄에 어댑터 17개, 전부 1~5줄. `fs/{paths,file_io,listing,link_targets,image_resolve,drives}.rs` 존재 |
| §2.1 `remote_host` → `commands::` 역의존 | ✅ 해소 | `remote_host.rs:917,942,961,974`가 `crate::fs::*` 직접 호출 |
| `mint_view_token` → `crypto_token.rs` 승격 | ✅ 해소 | `crypto_token.rs:26 mint_token`, 호출처 4곳 |
| 단계 1의 `window.rs`로 `DEFAULT_WINDOW`/`MIN_WINDOW`/`with_document_chrome` 이동 | ⚠️ 부분 잔존 | `window.rs:1-2` 모듈 doc이 "still live in `lib.rs`"라고 인정함. 상수·크롬은 `lib.rs:122-160`에 있고, 창 빌더는 3곳에 복제(H3) |
| `ListingPolicy` / `&Path` 시그니처 재형성 | ⏳ 잔존(계획된 후속) | `fs/mod.rs:3-5` "later step" |
| §2.6 / 단계 14 원격 호스트 블로킹 IO | ❌ 잔존 | `read_asset_handler`(`remote_host.rs:878-891`), `list_dir_handler`(:917), `list_files_recursive_handler`(:942), `resolve_image_handler`(:961), `list_link_targets_handler`(:974)가 여전히 async 본문에서 동기 fs IO를 한다. `spawn_blocking`은 `read_file_handler`(:765)만 쓴다 |
| §2.2 경로 봉쇄 4벌, `canonicalize_within` 승격 | ❌ 잔존 | H10 참고. `htmlview` 판은 여전히 비정규 `candidate`를 반환한다(`htmlview.rs:227`) |
| §2.2 롤백 오류 문자열 왕복 | ❌ 잔존 | `attachment_import.rs:329-351` 생성 → `:510-516` `starts_with` 재파싱 (H1에 포함) |
| §2.2 이미지 확장자 Rust↔TS | ❌ 잔존 + 악화 | 09-25 표에 없던 Rust 내부 사본 `bundle.rs:162-169`(미고정)과 MIME 표 2벌이 추가로 확인됨 (H4) |
| §2.2 아티팩트 접미사 | ❌ 잔존 | H5 |
| §2.4 `htmlview` ↔ `epubview` CORS/403/토큰 파싱 의도적 중복 | ⏭️ 존중(skip) | `epubview.rs:9-18` 모듈 doc의 명시 결정 |
| `lib.rs`의 비배선 로직(`write_stdin_to_scratch`, `dispatch_bundle`, qa) | ⏳ 잔존(조건부) | 09-25는 "자라면 `cli_dispatch.rs`"라고 했다. 아직 자라지 않았다 |

---

## 🔴 High Priority

### H1. IPC 오류 접두사 계약 — 단일 원천 없음 — ⭐⭐⭐ (분산) — 7개 모듈

**실제 책임**: 오류 *종류*를 문자열 접두사로 TS에 전달한다. TS는 이걸 `startsWith`/`includes`로 분기한다.
**발견 위치**:
- `fs/file_io.rs:101` `INVALID_PATH:` · `:105` `MISSING:` · `:117` `CONFLICT:`
- `attachment_import.rs:129,134,137,170,176,183,226,237,244-256,286,289,406,450,452` `ATTACH_*` · `:329,334,340,351` `ROLLBACK_*` → `:513-514` 재파싱
- `remote_client.rs:189` `unreachable` · `:197` `token_for_or_expired` · `:236` `classify`(`REMOTE:{:?}`) · `:225` `SSH_TUNNEL_MISMATCH:` · `:439` `REMOTE_ASSET_TOO_LARGE:`
- `remote_ssh.rs:410,420` `REMOTE:{:?}` 직접 포맷(같은 접두사의 **두 번째 생산자**) · `:462` `SSH_TUNNEL_CONNECTING:` · `:466` `SSH_TUNNEL_BUSY:` · `:481` `SSH_TUNNEL_PORT_IN_USE:`
- `remote_host.rs:410` `PORT_IN_USE:` · `remote_share.rs:66` `PORT_INVALID:` · `epubview.rs:309,330` `"not-zip"` · `hwp.rs:81` `"superseded"`

**문제**:
1. 접두사가 전부 리터럴이다. 오타나 이름 변경을 컴파일러가 못 잡고, 생산자와 소비자(TS)를 묶는 테스트도 없다.
2. `REMOTE:`는 `format!("{:?}", RemoteStatus::…)`, 즉 **Debug 출력**을 와이어 계약으로 쓴다(`remote_client.rs:189,197,236`, `remote_ssh.rs:410,420`).
   같은 enum의 serde 표현은 `rename_all = "kebab-case"`(`remote_client.rs:42`)다. 변형 이름을 바꾸면 serde 쪽은 그대로인데 오류 문자열만 조용히 바뀐다.
   TS는 둘 다 따로 알고 있다(`file-host.ts:47` kebab 타입, `:57` `includes("REMOTE:AuthExpired")`).
3. `PORT_IN_USE:`가 `SSH_TUNNEL_PORT_IN_USE:`의 부분 문자열이다. 지금은 TS가 `startsWith`로 검사해서 안전하다. `includes`로 바뀌면 충돌한다.
4. 오류 정책도 모듈마다 다르다. `epubview`은 kind(`"not-zip"`)만 넘기고 문구는 TS가 만든다. `hwp`/`external_open`/`remote_*`은 한국어 문구를 백엔드에서 만든다.

**추출 제안**:
```rust
// before (7 modules)
Err(format!("CONFLICT: file changed on disk since it was opened (baseline={baseline}, disk={current})"))
Err(format!("REMOTE:{:?}: SSH 터널이 …", crate::remote_client::RemoteStatus::Unreachable, …))

// after — src-tauri/src/ipc_error.rs
pub enum ErrorCode { Conflict, Missing, InvalidPath, Remote(RemoteStatus), RemoteAssetTooLarge,
                     SshTunnelMismatch, SshTunnelBusy, SshTunnelConnecting, SshTunnelPortInUse,
                     PortInUse, PortInvalid, Attach(AttachKind), Rollback(RollbackKind), NotZip }
impl ErrorCode { pub const fn prefix(&self) -> &'static str { … } }   // 와이어 문자열 단일 원천
pub fn tagged(code: ErrorCode, detail: impl Display) -> String       // "PREFIX: detail"
impl RemoteStatus { pub const fn wire_tag(self) -> &'static str }     // Debug 의존 제거
```
`qa_rollback_result_label`(`attachment_import.rs:510`)은 `rollback_import`가 `Result<(), RollbackError>`를 반환하게 하고 문자열 재파싱을 없앤다.
**영향 범위**: Rust 7파일 + 접두사 표를 TS와 공유 픽스처로 고정(09-25 §2.3의 `remote-host-truth-table.json` 선례).

### H2. 원격 클라이언트 커맨드 프리앰블 8벌 — 보안 게이트 포함 — ⭐⭐⭐⭐ (DRY) — `remote_client.rs`

**실제 책임**: 커맨드마다 `ensure_tunnel_serves` → `token_for_or_expired` → `format!("{}/route", base_url(&host)?)` → query 조립 → `send_authorized` → `decode_response`를 반복한다.
**발견 위치**: `remote_client.rs:303-315, 324-328, 340-349, 361-370, 381-386, 404-420, 539-550, 561-566`.
`fetch_vault_asset`(:404-420)은 `send_authorized`를 쓰지 않고 `x-mermark-token` 헤더 부착과 전송을 다시 구현한다(:410).
헤더 이름은 `remote_host.rs:475`와 `remote_client.rs:246,410`에 리터럴 3벌로 있다.
**문제**: `ensure_tunnel_serves`는 **토큰 유출 방지 게이트**다(`remote_ssh.rs:551-569`가 설명하는 A→B 터널 교체 시나리오).
새 원격 커맨드가 이 줄을 빠뜨리면 다른 호스트로 토큰이 나간다. 보안 규칙이 "각 커맨드가 기억할 것"에 맡겨진 상태다.
`#[tauri::command]` 어댑터에 HTTP 배관이 새어 들어와 있는 상태이기도 하다.
**추출 제안**:
```rust
// before (×8)
ensure_tunnel_serves(&host, &tunnels)?;
let token = token_for_or_expired(&store, &host)?;
let url = format!("{}/list_dir", base_url(&host)?);
let res = send_authorized(client()?.get(&url).query(&[...]), &token).await?;
decode_response(res).await

// after
struct RemoteCall { url_base: String, token: String }
impl RemoteCall {
    fn open(host: &str, store: &ClientTokens, tunnels: &SshTunnels) -> Result<Self, String>; // guard+token+base_url
    async fn get_json<T: DeserializeOwned>(&self, route: Route, q: &[(&str, &str)]) -> Result<T, String>;
    async fn get_bytes(&self, route: Route, q: &[(&str, &str)]) -> Result<(String, Vec<u8>), String>;
}
const TOKEN_HEADER: &str = "x-mermark-token";   // remote_host::authorize와 공유
enum Route { Vaults, ListDir, ... }             // remote_host::get_routes 표와 같은 원천
```
매개변수 3개. 각 커맨드는 `RemoteCall::open(..)?.get_json(Route::ListDir, &q).await` 한 줄이 된다.

### H3. 문서 창 빌더 3벌 + 창 라벨 규칙 2벌 — ⭐⭐⭐ (분산) — `lib.rs` / `window.rs` / `single_instance.rs` / `cli_control.rs`

**실제 책임**: "mermark 문서 창 = `with_document_chrome` + `title("mermark")` + `inner_size(DEFAULT)` + `min_inner_size(MIN)` + `index.html[?file=…]`".
**발견 위치**:
- 빌더: `lib.rs:608-618`(startup main), `window.rs:27-32`(`open_path`), `single_instance.rs:460-465`(`spawn_main_window`)
- URL: `lib.rs:574-583`과 `window.rs:16`(`document_window_spec`)이 둘 다 `format!("index.html?file={}", urlencoding::encode(..))`
- 라벨 규칙 "main 또는 `w`로 시작": `single_instance.rs:103-105 is_document_window`와 **`cli_control.rs:352` 인라인 재구현**(`l == "main" || l.starts_with('w')`). 생산자는 `window.rs:15 format!("w{seq}")`
- 라벨 리터럴 `"main"`: `lib.rs:609`, `single_instance.rs:104,118-119,138,157,180,256,461`

**문제**: `lib.rs:118-121`의 doc은 "size lives here once"라고 약속한다. 그런데 적용 지점이 3곳으로 늘었고, 세 번째(`spawn_main_window`)는 doc이 말하는 "two paths"에 없다.
라벨 규칙의 인라인 사본은 `is_document_window`의 doc(:96-102)이 경고하는 바로 그 형태다("rather than by auditing every call site").
**추출 제안** (09-25 단계 1의 잔여분 완결):
```rust
// window.rs
pub const MAIN_LABEL: &str = "main";
pub(crate) fn document_window_label(seq: u32) -> String;           // "w{seq}"
pub(crate) fn is_document_window(label: &str) -> bool;              // single_instance에서 이동
pub(crate) fn document_url(file: Option<&Path>) -> WebviewUrl;      // ?file= 단일 원천
pub(crate) fn document_window<'a, R, M>(m: &'a M, label: &str, file: Option<&Path>) -> WebviewWindowBuilder<'a, R, M>;
```
`lib.rs`는 `.inner_size/.position`만 덧붙이고 나머지 두 곳은 `document_window(..).build()`가 된다.

### H4. 이미지 확장자 집합 + 확장자→MIME 표 — Rust 내부 5벌 — ⭐⭐⭐ (분산 + drift) — 4개 모듈

**발견 위치**:
- `fs/link_targets.rs:29-34 is_image_ext`: 정본. TS `wikilink.ts:50`와 손으로 복사한 테스트로 짝지어 둠(`:273`)
- `bundle.rs:162-169 is_image_embed`: **독자 `IMAGE_EXTS` 배열, 어떤 테스트도 `is_image_ext`와 묶지 않음**
- `attachment_import.rs:74 IMAGE_DIALOG_FILTERS`: 사본이지만 `:955` 테스트로 고정됨
- `remote_host.rs:803-815 asset_content_type`: 같은 8개 확장자의 MIME 표(avif/bmp 포함)
- `htmlview.rs:325-343 mime_for_path`: 별도 MIME 표, **avif/bmp 없음** → `octet-stream`. `epubview.rs:376-391`은 이걸 위임 사용

**문제**: 이미지 확장자를 하나 추가할 때 고칠 곳이 Rust 4곳, TS 2곳(`wikilink.ts:50`, `file-icons.ts:35`)이다.
이미 drift가 하나 있다. scripted HTML 뷰어(`htmlview`)는 문서 폴더의 `.avif`/`.bmp`를 `application/octet-stream`으로 서빙한다.
원격 `/read_asset`은 같은 파일을 `image/avif`로 서빙한다.
**추출 제안**:
```rust
// fs/media.rs (신규)
pub(crate) const IMAGE_EXTS: [&str; 8] = ["png","jpg","jpeg","gif","webp","svg","avif","bmp"];
pub(crate) fn is_image_ext(ext: &str) -> bool;                 // link_targets에서 이동
pub(crate) fn image_mime(ext: &str) -> Option<&'static str>;   // remote_host·htmlview 공용
```
`bundle::is_image_embed`는 `has_extension` 뒤에 `is_image_ext`를 호출하게 바꾸고, `IMAGE_DIALOG_FILTERS = &IMAGE_EXTS`로 둔다.

### H5. mermark 아티팩트 이름 — 생산자와 판정자가 연결되지 않음 — ⭐⭐⭐ (분산) — `fs/file_io.rs` / `attachment_import.rs` / `fs/listing.rs`

**발견 위치**: 생산 `fs/file_io.rs:122`(`{normalized}.mermark-tmp.{seq}`), `attachment_import.rs:231`(`{file_name}.mermark-tmp.{seq}`). 판정 `fs/listing.rs:9-11 is_mermark_artifact`.
`.mermark-recovered`는 **TS가 생산**(`editor.ts:120`)하고 Rust가 판정한다.
**문제**: 판정 함수 doc(:5-8)이 "Mirrors the autosave temp suffix"라고 적어 둔 상태로만 묶여 있다. 생산 포맷이 바뀌면 탐색기/피커/원격 피어
(`remote_host.rs:837`)에 임시 파일이 노출된다. 그런데 이를 잡을 컴파일 타임 연결이 없다.
**추출 제안**:
```rust
// fs/artifacts.rs
const TMP_MARKER: &str = ".mermark-tmp.";
pub(crate) const RECOVERED_SUFFIX: &str = ".mermark-recovered";      // TS editor.ts:120 미러
pub(crate) fn tmp_sibling_name(base: &str, seq: u64) -> String;      // file_io·attachment_import 공용
pub(crate) fn is_mermark_artifact(file_name: &str) -> bool;          // listing에서 이동
```

### H6. 크기 상한 + 유계 읽기 — 4벌, 한 곳은 TOCTOU 형태 — ⭐⭐⭐ (분산) — `remote_host.rs` / `hwp.rs` / `epubview.rs` / `fs/file_io.rs`

**발견 위치**:
- `remote_host.rs:786-797 read_file_bounded`와 `:878-891`(`read_asset_handler` 인라인): **같은 시퀀스 2벌**(open → handle metadata → cap → `take(cap)` → `read_to_end`)
- `hwp.rs:136-147 assert_hwp_file_within_cap` + `:266 std::fs::read`: **경로로 stat한 다음 경로로 다시 읽음**. `remote_host.rs:871-877` 주석이 피한다고 명시한 바로 그 TOCTOU 창이다. `take` 상한도 없다
- `epubview.rs:258-275 read_at_most` + `entry_within_cap`: 같은 의도의 세 번째 구현(`cap+1` 방식)
- `fs/file_io.rs:33 read_file`: 상한 없음(`remote_host.rs:774`가 의도적으로 우회한다고 기록함)
- 상수: `hwp.rs:22`(100 MiB) · `epubview.rs:86`(8 MiB) · `remote_host.rs:745,826`(20 MiB ×2) · `epubview.rs:103-107`(MAX_IN_MEMORY_EPUBS 주석이 "2 × 호스트 20 MiB"에 기대지만 상수 참조는 없음)

**추출 제안**:
```rust
// fs/bounded.rs
pub(crate) enum CappedRead { Ok(Vec<u8>), TooLarge(u64), NotAFile }
pub(crate) fn read_capped(path: &Path, cap: u64) -> io::Result<CappedRead>;  // 단일 핸들, take(cap+1)
pub(crate) fn read_at_most(r: &mut impl Read, cap: usize) -> io::Result<Vec<u8>>; // epubview에서 이동
```
`hwp_open`·`read_file_bounded`·`read_asset_handler`가 `read_capped`를 쓰게 하고, `MAX_ASSET_BYTES`를 `pub(crate)`로 열어 epubview 상수가 참조하게 한다.

### H7. 설정 디렉터리 JSON 저장소 load/save — 3벌 + 부팅 시 관용 정책 — ⭐⭐⭐ (분산) — `remote_token.rs` / `remote_share.rs` / `lib.rs`

**실제 규칙**: "파일 없음 = 빈 상태(조용히), 손상 = 경고 후 빈 상태, 앱 실행은 절대 막지 않음. 저장 = `create_dir_all` + 직렬화 + `atomic_write_0600`".
**발견 위치**:
- load: `remote_token.rs:102-110`(Err로 반환하고 `lib.rs:515-518`에서 empty+warn으로 변환), `remote_token.rs:172-185 ClientTokens::load`(직접 eprintln), `remote_share.rs:158-179 load_selection`(Option + eprintln + 버전 검사)
- save: `remote_token.rs:115-119`, `:234-238 ClientTokens::persist`, `remote_share.rs:193-199`

**문제**: 관용 정책이 세 함수와 `lib.rs` 한 곳에 따로 있다. 셋 다 같은 규칙인데 반환 타입이 `Result` / `Self` / `Option`으로 제각각이다.
`ClientTokens::load`는 "missing"과 "읽기 IO 오류"를 구분하지 않는다(:182 `Err(_) => Default`). 하지만 `load_selection`은 구분한다.
**추출 제안**:
```rust
// config_store.rs
pub(crate) fn load_json_tolerant<T: DeserializeOwned + Default>(path: &Path, what: &str) -> T; // missing→default, 손상→warn+default
pub(crate) fn save_json_0600<T: Serialize>(dir: &Path, file: &str, value: &T) -> Result<(), String>;
```

### H8. 프론트 경로 인입 정책 4종 혼재 + watcher/write identity 불일치 — ⭐⭐⭐ (분산) — 11개 커맨드

**실제 개념**: "웹뷰가 보낸 로컬 경로 문자열 → 호스트 경로".
**발견 위치**:
- `expand_home`(`~` 확장 + 정규화): `fs/file_io.rs:34 read_file`, `fs/paths.rs:228,233,237`, `fs/listing.rs:126,314`, `hwp.rs:256`
- `normalize_path`만: `fs/file_io.rs:103 write_file`, `:138 create_markdown_file`, `fs/link_targets.rs:123`, `fs/image_resolve.rs:188`, `window.rs:22`, `bundle.rs:339`
- `fs::canonicalize` 원본: `htmlview.rs:296`, `epubview.rs:307`, `attachment_import.rs:449`
- 정규화 없음: `sqlite.rs:132,168,236`, `watcher.rs:106,123 set_watch`, `remote_share.rs:87 arm_vaults`, `external_open.rs:56`(절대경로 요구)

**문제**: 같은 개념에 정책이 4종이다. 구체적인 위험이 하나 있다. `write_file`은 `normalize_path`된 경로로 self-write identity를 기록한다(`file_io.rs:131`).
반면 `watch_file`은 **받은 문자열 그대로** watcher 경로와 identity 비교 키로 쓴다(`watcher.rs:93,152`). 프론트가 `..`나 `~`가 섞인 경로로 watch하면
자기 저장이 "외부 변경"으로 오인된다. 지금은 TS가 정규 절대경로를 넘겨서 잠재 상태다.
**추출 제안**: `fs::paths::host_path(arg: &str) -> PathBuf`(= `expand_home`)를 로컬 경로를 받는 모든 커맨드의 단일 인입구로 지정한다.
`set_watch`는 `host_path(&path)`로 정규화한 문자열을 `WatchSession.path`로 저장한다. 쓰기 쪽 절대경로 강제(`requires_absolute_write_path`)는 그대로 둔다.

### H9. 목록 가시성 정책 인라인 재구현 — ⭐⭐⭐⭐ (분산, 같은 파일 + 인접 파일) — `fs/listing.rs` / `fs/link_targets.rs`

**실제 규칙**: "mermark 아티팩트는 무조건 숨김, dotfile은 `show_hidden=false`일 때 숨김, 심링크-디렉터리는 한 번 따라가 분류".
**발견 위치**: 정본 `fs/listing.rs:79-95 classify_dir_entry` + `:40-46 entry_is_dir`.
재구현 1: `fs/listing.rs:234-264`(`walk_files_recursive`, 82줄. 주석 :235 "Mirrors entry_is_dir", :257 "same two exclusion rules").
재구현 2: `fs/link_targets.rs:77`(`file_name.starts_with('.')`). `is_hidden_entry`를 두고 `.` 검사를 원시로 다시 씀. 이 파일에서 유일하게 SSOT 함수를 우회한다.
**추출 제안**:
```rust
// before (listing.rs:259-264)
if is_mermark_artifact(file_name) { continue; }
if !show_hidden && is_hidden_entry(file_name) { continue; }
// after
pub(crate) fn is_listed(file_name: &str, show_hidden: bool) -> bool {
    !is_mermark_artifact(file_name) && (show_hidden || !is_hidden_entry(file_name))
}
```
`classify_dir_entry`, `walk_files_recursive`(파일·디렉터리 분기), `classify_link_target`(`is_listed(name, false)`)이 공유한다.
피어 정책(`remote_host.rs:835 is_withheld_from_peers`)은 `.attachments` 예외가 있는 **다른 규칙**이라 통합하지 않는다.

### H10. 경로 봉쇄(containment) primitive 4~5벌 — 09-25 잔존 — ⭐⭐⭐ (분산) — 4개 모듈

**발견 위치**: `fs/paths.rs:339 is_within_base`(어휘) · `:355 file_target_is_within_base`(심링크만 canonical) ·
`htmlview.rs:276 is_within_armed_root`(양쪽 canonical, bool, 호출자 `:227`이 **비정규 `candidate`**를 반환함) ·
`attachment_import.rs:200 picked_source_is_inside_vault`(source만 canonical, root는 호출자가 미리 canonical) ·
`remote_host.rs:91 canonicalize_within`(양쪽 canonical, **canonical 경로 반환** = TOCTOU 방지판).
어휘 게이트도 2벌이다: `remote_host.rs:62 resolve_within` ↔ `htmlview.rs:251 is_joinable_remote_rel`(doc이 "mirror"라고 명시).
**문제**: 09-25 진단 그대로다. 가장 안전한 버전(canonical 반환)이 가장 늦게 생겼고, 나머지 모듈로 승격되지 않았다.
`attachment_import.rs:194` doc은 아직 `file_target_is_within_base in commands.rs`를 가리킨다(분할 이후 stale 참조).
**추출 제안**:
```rust
// fs/containment.rs
pub(crate) fn contained_canonical(root: &Path, candidate: &Path) -> Option<PathBuf>; // 양쪽 canonical, 반환=canonical
pub(crate) fn is_plain_relative(rel: &Path) -> bool;                                  // 전부 Normal, 비어 있지 않음
```
`HtmlViewRoots::resolve_target`은 반환 경로를 canonical로 바꾸고, `remote_host::canonicalize_within`은 위 함수를 감싸게 한다.

---

## 🟡 Medium / 🟢 Low

| 파일:라인 | 함수명 | 별점 | 실제 책임 (1줄) | 추출 가치 |
|---|---|---|---|---|
| `fs/image_resolve.rs:82` | `scan_match` | ⭐⭐⭐⭐ | BFS 2패스(이미지 매칭 / 하위 디렉터리 큐잉). 85줄이고 두 패스가 각각 `symlink_metadata`와 `file_name`을 다시 추출 | medium: `first_image_match(children,…)` / `descendable_dirs(children)` |
| `remote_ssh.rs:432` | `connect_with` | ⭐⭐⭐⭐ | 슬롯 결정, 포트 확인, spawn, 준비 대기. `release_claim` 수동 호출 4회(:479,488,495,502) | medium: `attachment_import::TempGuard`처럼 RAII `ConnectClaim` 가드로 |
| `attachment_import.rs:220` | `import_attachment_from` | ⭐⭐⭐⭐ | 검증, 임시 복사, 충돌 회피 하드링크 설치, 영수증 발급(71줄) | medium: `install_no_replace(temp, dir, stem, ext) -> Result<(PathBuf,String)>` |
| `hwp.rs:255,298` | `hwp_open` / `hwp_render_page` | ⭐⭐⭐⭐ | 어댑터 본체에 확장자, 존재, 상한, 읽기 검증과 세션 take/put/timeout 분기가 들어 있음. "지원하지 않는 확장자입니다" 메시지 2벌(:211,:258) | medium: 어댑터 두께. `read_local_hwp(path)` 추출 (H6과 함께) |
| `cli_control.rs:574` | `run_share_client` | ⭐⭐⭐⭐ | 소켓 경로, 인자 절대화, 접속, 오프라인 계획, spawn 후 폴링(매직 20s/200ms, :605-607) | medium: `connect_after_spawn(socket, deadline)` + 상수화 |
| `lib.rs:281` | `run` | ⭐⭐⭐⭐ (관례 예외) | Tauri 부트스트랩. 아래 「`lib.rs run()` 인라인 도메인 규칙」 참고 | medium: 규칙 단위 추출만 |
| `watcher.rs:200` | `read_external_change` (`#[cfg(test)]`) | ⭐⭐⭐ | `handle_fs_event`(:151-197)의 판정을 **순서가 다르게** 다시 구현한 테스트 전용 사본. characterization 테스트가 프로덕션이 아니라 사본을 검증함 | medium: 순수 `classify_fs_event(state, path) -> FsEventOutcome{Unavailable(kind), SelfWrite, Changed}`를 양쪽이 공유 |
| `fs/listing.rs:181` vs `:270-274` | `FileHit.rel_path` | ⭐⭐⭐ | doc은 "forward-slash joined"를 약속하는데 구현은 `to_string_lossy()`, 즉 플랫폼 구분자. TS `sidebar/search/fuzzy.ts:67-68`이 `lastIndexOf("/")`에 의존해서 Windows에서 basename 점수가 깨짐. `bundle.rs:271-279 relative_to_base`도 같음 | medium: `remote_host.rs:573 vault_relative`의 component-join을 `fs::paths::slash_relative(root, abs)`로 승격 |
| `remote_host.rs:860-977` | `*_handler` ×6 | ⭐⭐⭐⭐ | 같은 4단(authorize → armed_vault → safe_path → root) + `vault_relative` 재작성 ×3. 블로킹 IO 불일치는 09-25 잔존 | medium: `authorized_target(state, headers, vault, rel) -> Result<(PathBuf /*root*/, PathBuf), StatusCode>` + `spawn_blocking` 통일 |
| `cli_control.rs:327` | `deliver_outstanding` | ⭐⭐⭐ | 이름은 "전달"인데 준비된 창이 없으면 `focus_only` → `SpawnMain`으로 **main 창을 다시 만듦**(:348-355). doc에는 적혀 있지만 이름에는 없음 | medium-low: `deliver_or_respawn`이나 분기를 호출자로 |
| `remote_host.rs:279` | `IGNORE_PEER_SHOW_HIDDEN` | ⭐⭐⭐ | 값은 `false`이고 `show_hidden` 인자로 넘어감. 이름("무시한다")과 값(false)의 극성이 반대로 읽힘 | low: `PEER_SHOW_HIDDEN: bool = false` |
| `bundle.rs:289` | `stem_with_ext` | ⭐⭐⭐ | 실제로는 `file_name()`. "stem"은 확장자 없는 이름이라 이름이 모순 | low: `file_name_of` |
| `remote_host.rs:723` | `remote_host_redeem_or` | ⭐⭐⭐ | `redeem` 결과를 401로 사상. "or" 뒤 목적어가 없음 | low: `redeem_or_unauthorized` |
| `single_instance.rs:563` | `register_window_ready` | ⭐⭐⭐ | 준비 등록, 열기 요청 펌프, **`cli_control::deliver_outstanding` 호출(share 요청 전달)** | low: doc 있음. 이름 유지, 대신 `mark_ready` 직후 단일 `on_window_ready(app,label)` 훅으로 |
| `remote_share.rs:525` | `share_start` | ⭐⭐⭐ | 서버 시작과 함께 **last selection 영속화**(:566). 유일 writer라는 사실은 doc에만 있음 | low |
| `hwp.rs:207` / `:136` | `check_remote_hwp_path` / `assert_hwp_file_within_cap` | ⭐⭐⭐ / ⭐⭐⭐⭐ | 범용 동사 `check`, `assert`는 패닉을 연상시키지만 실제로는 Result 반환 | low: `require_hwp_ext` / `ensure_hwp_size_within_cap` |
| `lib.rs:179` / `cli.rs:219` | `is_bundle_subcommand` / `is_share_subcommand` | ⭐⭐⭐⭐ | 같은 "첫 토큰 = 서브커맨드" 규칙인데 모듈이 갈려 있음. cwd 절대화 `lib.rs:258` ↔ `cli.rs:278`도 중복 | low: 둘 다 `cli.rs`로, `absolutize(cwd, raw)` |
| `htmlview.rs:110` / `:369` | (인라인) | ⭐⭐⭐⭐ | `host == "htmlview.localhost" \|\| host == "localhost"` Windows 폴백 판정이 같은 모듈에 2벌 | low: `is_fallback_host(host)` |
| `single_instance.rs:251` | `ready_recipient` | ⭐⭐⭐⭐ | `resolve_recipient`(:114)의 선호 순서를 "ready" 필터를 붙여 다시 구현(doc "mirrors") | low |
| `lib.rs:60` | `setup_cli_path_in` | ⭐⭐⭐⭐ | 실행할 때마다 `~/.zshrc`에 PATH 줄을 덧붙임. 앱 경로 리터럴 2벌(:71,:72) | low: `const MAC_CLI_DIR` |
| `sqlite.rs:131,167,230` | `sqlite_*` | ⭐⭐⭐⭐ | 커맨드 본체가 곧 로직. 다른 모듈의 core/adapter 분리 관례에서 유일하게 예외 | low: 작고 문자열 인자라 이미 테스트 가능 |
| `attachment_import.rs:444` | `import_vault_attachment` | ⭐⭐⭐⭐ | 어댑터 44줄 중 절반이 qa_trace 3분기 match(:463-486) | low: `qa_attach_outcome_fields(&Result)`(lib.rs의 `qa_*_fields` 관례) |

### Skip (False Positive — 유지)
- `htmlview.rs` ↔ `epubview.rs`의 `forbidden_response`/`resource_origin`/`cors_allow_origin`/`build_preflight_response`/`token_and_*_path`: `epubview.rs:9-18`의 명시적 "의도적 중복". 09-25도 존중함.
- `qa_trace!` / `with_routing_trace` / `resolve_import_source`의 `cfg(debug_assertions)` 쌍둥이: 빌드 구성 관례.
- `single_instance::Routing`(순수 코어 + 얇은 셸), `remote_share`의 `remote_*` ↔ `share_*` 분리, `fs/drives.rs`, `crypto_token.rs`, `cli.rs`의 분류기: 이름과 구현이 일치함(⭐⭐⭐⭐⭐~⭐⭐⭐⭐).
- `HtmlViewRoots::resolve`(`#[cfg(test)]`, :205-214): 테스트 전용 접근자이고 doc이 이유를 기록함.
- `cli_control::dispatch`/`handle_request`, `watcher::handle_fs_event`: 범용 동사지만 Boundary 레이어 예외.

---

## `#[tauri::command]` 어댑터 두께 점검 (52개)

| 모듈 | 개수 | 판정 |
|---|---|---|
| `commands.rs` | 17 | ✅ 전부 얇음(1~5줄 위임). `open_in_external_app`은 `spawn_blocking` 래퍼 |
| `remote_share.rs` | 6 | ✅ 얇음. `validate_share_port`를 어댑터에서만 호출하는 건 문서화된 의도(:59-63) |
| `htmlview.rs` 2 / `epubview.rs` 3 / `remote_ssh.rs` 2 / `single_instance.rs` 2 / `cli_control.rs` 1 | 10 | ✅ 얇음 |
| `remote_client.rs` | 9 | ❌ **로직 누수**: 각 커맨드가 HTTP 배관과 보안 게이트를 직접 수행 (H2) |
| `hwp.rs` | 4 | ⚠️ `hwp_open`/`hwp_render_page`에 검증과 세션 상태기계 분기 (M) |
| `attachment_import.rs` | 3 | ⚠️ `import_vault_attachment`의 root 검증과 trace 분기 (low) |
| `sqlite.rs` | 3 | ⚠️ 어댑터=로직 (low) |

## `lib.rs run()` 인라인 도메인 규칙 (관례 예외 안에서 짚을 것)

1. **CLI 오류 → 메시지 + 종료 코드 2** (`lib.rs:302-328`): `CliError` 3분기가 각각 `eprintln!` + `exit(2)`를 함. 종료 코드 `2`는 `lib.rs:275`(bundle), `:559`(stdin 미파이프), `cli_control.rs:631`, `die(2,…)`(:588)에도 있음 → `const EXIT_USAGE: i32 = 2` + `fn exit_with_cli_error(CliError) -> !`.
2. **시작 URL 조립 `index.html?file=`** (`:574-583`): `window.rs:16`과 중복 (H3).
3. **문서 창 빌더** (`:608-618`): 3벌 중 하나 (H3).
4. **모니터 물리 → 논리 크기 변환** (`:592-597`): `right_half_geometry`는 이름이 있지만 `size / scale_factor` 변환은 클로저 인라인 → `monitor_logical_size(&Monitor) -> (f64,f64)`.
5. **원격 장치 목록 손상 시 관용 정책** (`:515-518`): "손상 → 경고 + 빈 목록, 실행은 막지 않음"이 `lib.rs`에 있음. 형제 저장소 2개는 이 정책을 자체적으로 가짐 (H7).
6. (참고, 양호) `class.joins_singleton()` 2회 게이트, `RunEvent::Exit` 정리, `cli_control::mermark_config_dir` `debug_assert` 고정은 전부 명명돼 있음.

---

## 패턴 분석

- **분산된 의도** (10건, 전부 high):
  - 오류 접두사 계약: H1 (7 모듈)
  - 원격 호출 프리앰블과 토큰 헤더: H2 (`remote_client.rs` ×8, 헤더 리터럴 3)
  - 문서 창 생성과 라벨 규칙: H3 (`lib.rs`, `window.rs`, `single_instance.rs`, `cli_control.rs`)
  - 이미지 확장자와 MIME: H4 (`fs/link_targets.rs`, `bundle.rs`, `attachment_import.rs`, `remote_host.rs`, `htmlview.rs`)
  - 아티팩트 이름: H5 (`fs/file_io.rs`, `attachment_import.rs`, `fs/listing.rs`, TS `editor.ts`)
  - 유계 읽기와 크기 상한: H6 (`remote_host.rs` ×2, `hwp.rs`, `epubview.rs`)
  - 설정 JSON 저장소: H7 (`remote_token.rs` ×2, `remote_share.rs`, `lib.rs`)
  - 경로 인입 정책: H8 (11 커맨드, 4종)
  - 목록 가시성: H9 (`fs/listing.rs` ×2, `fs/link_targets.rs`)
  - 경로 봉쇄: H10 (4 모듈)
- **표면적 중복**: 원격 호스트 핸들러 4단 스켈레톤 ×6(`remote_host.rs:860-977`). 원자적 쓰기 tmp + rename 2벌(`file_io.rs:122-127` ↔ `remote_token.rs:48-73`. `fsync`는 `attachment_import.rs:247`만 함). 순차 ID 카운터 6종(`WINDOW_SEQ`, `TMP_SEQ`×2, `STDIN_SEQ`, `TOKEN_TMP_SEQ`, `TOKEN_SEQ`. 의도적으로 분리했다는 기록 있음, 유지).
- **새 모듈 후보**: `ipc_error.rs`(H1), `fs/media.rs`(H4), `fs/artifacts.rs`(H5), `fs/bounded.rs`(H6), `config_store.rs`(H7), `fs/containment.rs`(H10). 그리고 `window.rs` 완결(H3).

## 아키텍처 제안

1. **"와이어 계약 단일 원천" 계층.** H1(오류 접두사), H4(확장자/MIME), H5(아티팩트 접미사), H3(라벨/URL), 이벤트 이름이 모두 "Rust 리터럴 ↔ TS 리터럴 ↔ mock 리터럴" 3중 복사다.
   Rust 쪽을 `const`/`enum` 한 곳으로 모은 다음, 09-25 §3.3의 `commands.generated.ts` 생성기에 **상수 표**로 같이 내보낸다. 이 리뷰의 high 10건 가운데 5건이 이 한 번의 조치로 닫힌다.
2. **`fs/` 하위의 보안 primitive를 마무리한다.** `containment`(H10), `bounded`(H6), `artifacts`(H5), 인입 `host_path`(H8)까지 정리하면 `fs/`가 "웹뷰나 피어가 보낸 경로를 안전하게 다루는 유일한 층"이 된다.
   `remote_host`/`htmlview`/`hwp`/`attachment_import`는 그 위의 소비자가 된다.
3. **`remote_client`에 호출 객체를 도입한다(H2).** 보안 게이트(`ensure_tunnel_serves`)를 커맨드마다 기억할 일이 아니라 타입이 강제하는 구조로 옮긴다.
   이 작업은 09-25 단계 14(원격 호스트 `spawn_blocking` 통일)와 짝을 이루는 클라이언트 쪽 정리다.

## 다음 단계 권장

이번 검토에서 분산된 의도가 **10건** 나왔다. 이는 함수 단위를 넘어 **아키텍처 차원의 경로 설계 문제**일 가능성이 크다.
특히 H1·H3·H4·H5는 Rust ↔ TS ↔ mock 경계를 가로지른다.

→ 다음 단계로 `/architecture-review` 실행을 권장한다. 범위는 "와이어 계약(오류 접두사, 확장자, 이벤트, 라벨) 생성 경로"와 "`fs/` 보안 primitive 층"이다.

---

## 자가 검증

- [x] 각 제안이 버그 예방이나 도메인 명확성에 기여하는가: H8(watch/write identity 키 불일치), H4(htmlview avif/bmp drift), H6(hwp TOCTOU 형태), M(`rel_path` Windows 구분자, TS fuzzy 의존)은 실제 결함이거나 잠재 결함이다. 나머지는 한쪽만 고쳐질 때의 drift를 예방한다.
- [x] 추출 후 매개변수 3개 이하: `RemoteCall::open(host, store, tunnels)` 3개, `contained_canonical(root, candidate)` 2개, `read_capped(path, cap)` 2개, `document_window(manager, label, file)` 3개, `install_no_replace(temp, dir, stem, ext)`는 4개라서 `(temp, dir, &SplitName)`로 묶어 3개.
- [x] 제안 함수명이 1~2단어로 의도를 전달: `is_listed`, `host_path`, `read_capped`, `image_mime`, `tmp_sibling_name`, `contained_canonical`.
- [x] 영향 범위 파악: 각 항목에 파일:라인을 열거함. H1·H4·H5는 TS 소비처를 아래 교차 단서에 표시함.
- [x] False positive 필터 통과: 의도적 중복(htmlview ↔ epubview), cfg 쌍둥이, 코어/셸 분리, Boundary 레이어 범용 동사는 Skip으로 분리함.
- [x] 분산 구현을 빠짐없이 식별: 확장자는 Rust 5곳 + TS 2곳, 봉쇄는 5곳 + 어휘 게이트 2곳, 접두사는 7개 모듈의 생산 지점을 전수 열거함.

---

## 교차 영역 단서 (TS 파트와 대조용)

🔁 = TS 쪽 미러를 확인함 · ❓ = TS 미러가 있을 법하지만 이 파트에서 확인하지 않음 · — = Rust 전용

### 1. 경로 containment / canonical
| # | 규칙 | Rust 위치 | TS |
|---|---|---|---|
| 1 | 어휘 봉쇄(`..` 접기 후 `starts_with`) | `fs/paths.rs:339 is_within_base` | 🔁 `markdown/local-doc-link.ts:212 isPathInsideRoot`, `image-search-root.ts:23` |
| 2 | 심링크 파일 대상 canonical 재확인 | `fs/paths.rs:355 file_target_is_within_base` | — |
| 3 | 양쪽 canonical + bool | `htmlview.rs:276 is_within_armed_root` (호출자 `:227`이 비정규 경로를 반환) | — |
| 4 | source canonical 기반 볼트 내부 판정 | `attachment_import.rs:200 picked_source_is_inside_vault` | ❓ attach 흐름의 "이미 볼트 안" 판정 |
| 5 | 양쪽 canonical + **canonical 반환** | `remote_host.rs:91 canonicalize_within`, `:533 safe_path` | — |
| 6 | 전부 `Normal` 컴포넌트(상대·비어 있지 않음) | `remote_host.rs:62 resolve_within` ↔ `htmlview.rs:251 is_joinable_remote_rel` | ❓ 원격 상대경로 조립 |
| 7 | `canonicalize_path` + verbatim 접두사 제거 | `fs/paths.rs:237`, `:171 strip_verbatim_prefix` | 🔁 `src/main.ts resolveHomeRoot`, `document/path.ts normalize_path` (Rust doc이 명시) |
| 8 | `~` 확장(`~user`는 그대로) | `fs/paths.rs:54 expand_home_with` | ❓ 푸터 "경로 열기" 입력 |

### 2. hidden / artifact / 제외 판정
| # | 규칙 | Rust 위치 | TS |
|---|---|---|---|
| 9 | dotfile = 숨김 | `fs/listing.rs:54 is_hidden_entry` (+ `fs/link_targets.rs:77` 인라인 사본) | ❓ 탐색기 "숨김 파일 표시" |
| 10 | 아티팩트 판정 `.mermark-tmp.`/`.mermark-recovered` | `fs/listing.rs:9`; 생산 `fs/file_io.rs:122`, `attachment_import.rs:231` | 🔁 생산 `editor.ts:120`(`.mermark-recovered`), `document/session.ts:356` |
| 11 | 스캔 제외 디렉터리 7종 | `fs/listing.rs:161 EXCLUDED_SCAN_DIRS` | 🔁 `mocks/tauri-core.ts:826` 동일 리터럴 재선언 |
| 12 | 피어 비공개(dot, `.attachments`는 예외, + 아티팩트) | `remote_host.rs:835 is_withheld_from_peers` | — |
| 13 | 첨부 폴더명 `.attachments` | `attachments.rs:25,29` | 🔁 `markdown/attach-image.ts:80,84` |

### 3. 확장자 판정
| # | 규칙 | Rust 위치 | TS |
|---|---|---|---|
| 14 | 이미지 8종 | `fs/link_targets.rs:29`, `bundle.rs:162`(미고정), `attachment_import.rs:74` | 🔁 `markdown/wikilink.ts:50`, `sidebar/explorer/file-icons.ts:35 IMAGE_EXTENSIONS` |
| 15 | 편집 가능 텍스트 md/txt | `fs/link_targets.rs:43 is_editor_text_ext` | 🔁 `file-icons.ts:57 EDITABLE_TEXT_EXTENSIONS` |
| 16 | `.md`만 stem으로 삽입 | `fs/link_targets.rs:58 uses_stem_as_link_name` | 🔁 `wikilink.ts wikilinkPath`(확장자 없으면 `.md`) |
| 17 | 위키링크 → 경로(`#` 제거, 확장자 없으면 `.md`, `/` 절대) | `bundle.rs:178 resolve_target_path`, `:198 has_extension` | 🔁 `wikilink.ts wikilinkPath` |
| 18 | 위키링크 스캔(`[[`/`![[`, `\|` 별칭, 중첩 `[` 무효, 펜스 무시) | `bundle.rs:59,82,93` | 🔁 `markdown/parser.ts parseInline` (Rust doc이 명시) |
| 19 | hwp/hwpx | `hwp.rs:122 is_hwp_ext` | 🔁 `chrome/viewer/hwp-viewer.ts:293` |
| 20 | 런처 확장자 거부 목록 | `external_open.rs:33 LAUNCHER_EXTENSIONS` | ❓ "외부 앱으로 열기" 메뉴 노출 조건 |
| 21 | 확장자 → MIME 표 2벌(avif/bmp drift) | `htmlview.rs:325`, `epubview.rs:376`, `remote_host.rs:803`, `remote_client.rs:508 as_image_mime` | ❓ TS 뷰어 쪽 MIME 추정 |

### 4. 크기·깊이 상한
| # | 규칙 | Rust 위치 | TS |
|---|---|---|---|
| 22 | 원격 asset/read_file 20 MiB | `remote_host.rs:745,826` | 🔁 `chrome/viewer/file-bytes.ts:74` 메시지에 "20MB" 하드코딩 |
| 23 | 이미지 스캔 깊이 12 / 항목 10k | `fs/image_resolve.rs:53,62`; `fs/listing.rs:149,155` | 🔁 `markdown/image-search-root.ts:15 VAULT_IMAGE_SCAN_DEPTH` |
| 24 | HWP 100 MiB, EPUB 엔트리 8 MiB, 메모리 EPUB 2권 | `hwp.rs:22`, `epubview.rs:86,107` | ❓ 뷰어 오류 문구 |
| 25 | 공유 포트 1024~65535 | `remote_share.rs:64 validate_share_port`, `remote_ssh.rs:132` | 🔁 `document/share-port-rules.ts:37,50` |
| 26 | 요청 경로 4096B / 페어링 라벨 256B / 제어 요청 64KiB | `remote_host.rs:260,594`, `cli_control.rs:42` | ❓ 페어링 라벨 입력 maxlength |

### 5. 오류 문자열 접두사 계약 (H1)
| # | 접두사 | Rust 생산 | TS 소비 |
|---|---|---|---|
| 27 | `CONFLICT:` / `MISSING:` / `INVALID_PATH:` | `fs/file_io.rs:117,105,101` | 🔁 `editor.ts:170,245`(`startsWith("CONFLICT")`). MISSING/INVALID_PATH는 TS 전용 분기 없음 |
| 28 | `REMOTE:{Debug}` (`Unreachable`/`AuthExpired`/`SharingOff`) | `remote_client.rs:189,197,236`, `remote_ssh.rs:410,420` | 🔁 `document/file-host.ts:57`(`includes("REMOTE:AuthExpired")`), `:47` kebab 타입. **두 인코딩** |
| 29 | `REMOTE_ASSET_TOO_LARGE:` | `remote_client.rs:439` | 🔁 `chrome/viewer/file-bytes.ts:69` |
| 30 | `SSH_TUNNEL_MISMATCH:` / `_BUSY:` / `_CONNECTING:` / `_PORT_IN_USE:` | `remote_client.rs:225`, `remote_ssh.rs:466,462,481` | 🔁 `file-host.ts:123`, `workspace/remote-vault-dialog.ts:64`. `_CONNECTING:`은 TS 소비처 없음 |
| 31 | `PORT_IN_USE:` / `PORT_INVALID:` (`SSH_TUNNEL_PORT_IN_USE:`의 부분 문자열) | `remote_host.rs:410`, `remote_share.rs:66` | 🔁 `settings/remote-share-port.ts:51,65`(`startsWith`이라 현재 안전) |
| 32 | `ATTACH_*` / `ROLLBACK_*` | `attachment_import.rs:129-406`, `:329-351` (자체 재파싱 `:513`) | 🔁 `markdown/attach-image.ts:104-110` |
| 33 | kind `"not-zip"` | `epubview.rs:309,330` | 🔁 `chrome/viewer/epub-parse.ts:352,356` |
| 34 | `"superseded"` (HWP 열기 경합) | `hwp.rs:81` | ❓ TS 분기를 찾지 못함. 원문 그대로 사용자에게 노출될 가능성 |

### 6. 원자적 쓰기
| # | 규칙 | Rust 위치 | TS |
|---|---|---|---|
| 35 | 형제 tmp + rename + conflict/vanish 가드 + self-write 기록 | `fs/file_io.rs:94-133` | 🔁 자동저장/`saveAs`/`.mermark-recovered` 경로(`editor.ts`)가 `baseline`을 전달. `baseline: 0` = 가드 우회 |
| 36 | 0600 tmp + rename(설정 저장소) | `remote_token.rs:48 atomic_write_0600` | — |
| 37 | tmp + `sync_all` + 비대체 `hard_link`(첨부) | `attachment_import.rs:231-289` | 🔁 finalize/rollback 수명주기(`attach-image.ts`) |

### 7. 토큰·식별자 발급
| # | 규칙 | Rust 위치 | TS |
|---|---|---|---|
| 38 | CSPRNG 128bit hex | `crypto_token.rs:26 mint_token` → `htmlview.rs:177`, `epubview.rs:140,152`, `remote_host.rs:202,614` | 🔁 TS가 토큰을 URL host로 조립(`htmlview://<token>/`, `epub://<token>/`) |
| 39 | 6자리 페어링 코드(자체 `getrandom` + `% 1_000_000`) | `remote_host.rs:172` | ❓ 페어링 입력 검증(6자리) |
| 40 | 순차(비난수) 영수증 토큰 u64 | `attachment_import.rs:86,269` | 🔁 `attach-image.ts` (JS number로 받음) |
| 41 | 세대/티켓 카운터 | `watcher.rs:51`(문자열 generation), `hwp.rs:72`, `single_instance.rs:150`, `cli_control.rs:254` | 🔁 `document/file-watch.ts`(generation 비교), `session.ts`(ack id) |
| 42 | 토큰 헤더 `x-mermark-token` | `remote_host.rs:475`, `remote_client.rs:246,410` | — (토큰이 TS로 넘어가지 않음) |

### 8. 이벤트·라벨·URL·와이어 enum (참고)
| # | 계약 | Rust 위치 | TS |
|---|---|---|---|
| 43 | 이벤트 `file-changed`/`file-unavailable`(kind `deleted`/`unreadable`) | `watcher.rs:154-189` | 🔁 `document/file-watch.ts:162` |
| 44 | 이벤트 `cli-open-request` / `cli-share-request` / `remote-share-changed` | `single_instance.rs:499`, `cli_control.rs:341`, `remote_share.rs:522` | 🔁 `main.ts`, `document/session.ts`, `settings/remote-share-ipc.ts`, `settings/remote-share-panel.ts` |
| 45 | 창 라벨 `main`/`w{n}`, `index.html?file=` | `window.rs:15-16`, `lib.rs:577`, `single_instance.rs:103` | 🔁 `?file=` 읽는 쪽(main/welcome) |
| 46 | `FileHit.rel_path` "forward-slash" 약속(구현 미준수) | `fs/listing.rs:181,270` | 🔁 `sidebar/search/fuzzy.ts:67-68` `lastIndexOf("/")` |
| 47 | 호스트 문법(`ssh://…?share-port=N`, ASCII 호스트) | `remote_client.rs:63 base_url`, `remote_ssh.rs:110,151` | 🔁 `document/remote-host-field.ts hostFieldProblem` (공유 픽스처 `tests/fixtures/remote-host-truth-table.json`) |
| 48 | `LinkTarget.kind` `markdown`/`image`, `BindMode` kebab, `ExternalApp` lowercase, `AttachmentImportOutcome` tag `status` camel | `fs/link_targets.rs:87,90`, `remote_share.rs:32`, `external_open.rs:22`, `attachments.rs:157` | ❓ 각 소비 모듈 |

**교차 단서 합계: 48건** (🔁 TS 미러 확인 31 · ❓ 확인 필요 11 · — Rust 전용 6).
