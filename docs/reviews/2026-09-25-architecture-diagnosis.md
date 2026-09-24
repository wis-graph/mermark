# 아키텍처 진단 — 2026-09-25: 거대 파일과 플러그인 API 준비

> 읽기 전용 진단. 코드는 고치지 않는다. 대상은 HEAD `eb5d254`(v0.19.0). 숫자는 전부 직접 셌다(`wc -l`, `grep`, `git log`). 이전 진단: `docs/reviews/architecture-review-2026-06-13.md`(그때 32파일/2,015줄 → 지금 TS 테스트 2,240건 + cargo 393건, 커밋 529).

## 0. 요약

| 대상 | 줄 | 그중 테스트 | 판정 | 한 줄 |
|---|---|---|---|---|
| `src/main.ts` | 2,325 | 0 (테스트는 `tests/main-wiring.test.ts` 68건이 `import("../src/main")`로 통째 부팅) | **여러 일을 한다 — 분할** | `boot()` 하나가 L379–2323 = 1,945줄. 문서 세션·뷰어 디스패치·패널 배선·단축키·외부변경 처리가 한 클로저의 ~20개 mutable 셀을 공유 |
| `src-tauri/src/commands.rs` | 2,675 | ~1,200 (95 `#[test]`, 6개 모듈) | **여러 일을 한다 — 분할** | 경로 규칙·파일 IO·링크 피커·이미지 스캔·디렉터리 리스팅·드라이브 열거·창 스폰·클립보드가 한 파일. `remote_host.rs`가 이 함수들을 라이브러리로 직접 호출 |
| `src-tauri/src/remote_host.rs` | 1,977 | 1,023 (L954–) | **응집 — 그대로** | prod 954줄이 "봉쇄 → `commands::` 위임 → vault-relative 재작성" 한 패턴. 단 async 핸들러 4개가 블로킹 fs 워크를 직접 호출(§2.6) |
| `src/extensions/pdf-viewer/index.ts` | 1,521 | 0 | **응집 — 소분할 2건만** | 페이지 스케줄러(evict/draft/sharpen/text-layer)가 `onSettled`→`reconcile` 콜백으로 맞물려 있어 쪼개면 결합만 이동. `webview-compat.ts`·`pdfjs-types.ts`만 떼면 됨 |
| `src/mocks/tauri-core.ts` | 1,342 | — | **도메인별 분할 + 생성 불가** | 52개 `case`, 그중 `remote_*` 17개. 진짜 위험은 이 파일이 아니라 **35개 테스트 파일이 각자 `vi.mock("@tauri-apps/api/core")`로 4번째 mock을 손으로 쓴다**는 것(§2.3) |
| `src/sidebar/explorer/explorer-panel.ts` | 1,236 | 0 | **응집 쪽 — a11y 한 조각만** | 로빙 탭인덱스(L375–499)는 도메인 무관 → 분리. 나머지는 `renderTree`의 generation-guard/`focusOwed` 불변식이 클로저를 관통해 분할 비용 > 이득 |

2차 대상(>700줄)은 §1.7 표. **결론: 실제 분할 후보는 `main.ts`와 `commands.rs` 둘이고, 나머지는 테스트가 절반이거나 응집돼 있다.** 플러그인 API 개방의 전제 조건은 §5.

---

## 1. 파일별 책임 지도

### 1.1 `src/main.ts` — 조합 루트가 애플리케이션 계층을 삼킨 경우

**의존**: 72 import(L1–133). `src/api`가 아닌 내부 모듈 전부에 닿는 유일한 파일. 역방향 의존은 `tests/main-wiring.test.ts:415–469`가 export된 순수 함수 5개(`shouldPreserveGlobalExplorerRoot`·`isVaultRootLocked`·`tabScopeForVault`·`resolveHomeRoot`·`permanentRootsOf`)를 `../src/main`에서 import — **테스트가 조합 루트를 라이브러리처럼 import**한다(분할 시 첫 번째로 끊을 고리).

**책임 지도** (전부 `boot()` 클로저 안):

| 줄 | 일 | 소유 상태 | 자연 이음새 |
|---|---|---|---|
| L141–299 | 볼트 라우팅 순수 규칙 9개(`baseDirForOpenedDocument`, `isVaultRootLocked`, `tabScopeForVault`, `routingTrustsCurrentVault`, `resolveTargetVault`, `standardLinkRejectionFor`, `resolveHomeRoot`, `permanentRootsOf`) | 없음 (pure) | `workspace/vault-routing.ts` — 이미 순수+테스트됨, 이동만 하면 됨 |
| L301–377 | 크롬 위젯 3개(`setButtonContent`, `makeSaveStatus`, `makeModeToggle`) | `hideTimer` | `chrome/status-bar/save-status.ts`, `chrome/title-bar/mode-toggle.ts` |
| L385–439 | 설정→CSS var sink 바인딩 12건 | 없음 | `settings/boot-sinks.ts` — 전부 `setting.bind(sink)` 한 줄짜리 |
| L440–485 | 부팅 마이그레이션 3종(favorites L444–460, recent L480–481, reload handoff L441) + CLI 라우트 + `homeRoot` | `workspaceStore` | `workspace/boot-migrations.ts` |
| L486–524, 607–717 | **앱 상태 셀 ~20개**: `routedVault`, `current`, `currentFile`, `currentBaseDir`, `currentExplorerFolder`, `currentIsRemote`, `currentOpenVaultId`, `navHistory`, `detachScroll`, `cancelSessionTimer`, `openConflict`, `openRecovery`, `lifecycleRequest`, `pendingPrepare`, `watcherHandoff`, `viewerSlot`(L843), `searchScanVault`(L1558), `autoInstallArmed`(L2129), `flashTimer`(L2220) | 이것이 문제의 핵심 | 아래 두 객체로 귀속 |
| L1192–1225, 1668–1732, 1784–1962 | **문서 세션 트랜잭션**: `openDocument`, `openDocumentSafely`, `commitBeforeSwitch`, `teardownCurrent`, `openInWindow`, `saveSessionState`, `navigateHistory`, `recordNavigation` | `current*` 셀, `lifecycleRequest`, `pendingPrepare`, `navHistory` | `document/session.ts` — `DocumentSession` 객체 |
| L869–1062 | **열기 디스패치**: `viewerForEntry`, `openWithViewer`, `openPathEntry`, `openImageFromEditor`, `closeOpenViewer`, `openInNewWindow` | `viewerSlot` | `chrome/viewer/open-dispatch.ts` |
| L719–806, 1368–1398 | 복구 모달 3종(`showRecovery`, `showOpenRecovery`, `showDocumentRecovery`, `discardCurrentDocument`) | `openRecovery` | `document/recovery-flow.ts` |
| L1983–2046 | 외부 변경 → reload/충돌 모달(`resolveExternalChange` + `onFileChanged`/`onFileUnavailable`) | `openConflict`, `conflictRecovery` | `document/external-change-flow.ts` |
| L1064–1172, 1442–1530, 1537–1588 | 패널 3개 배선(explorer 26개 콜백, workspace sidebar, search) | `searchScanVault` | 각 패널 어댑터(`sidebar/explorer/wire.ts` 등) 또는 세션 객체에 위임 |
| L1590–1666 | 셸 DOM 조립(`arrangeTitleBar`, `arrangeStatusBar`, `registerSidebarPanel`×5, sash) | 없음 | `chrome/app-shell.ts` |
| L2101–2141 | 업데이트 자동 설치 | `autoInstallArmed` | `update/auto-install.ts` (`tests/main-update-autorestart.test.ts` 4건이 이미 이 규칙만 검증) |
| L2143–2276 | 단축키 핸들러 18개 + `flashStatus` | `flashTimer`, `flashBaseline` | `shortcuts/app-commands.ts` |
| L1966–1981, 2066–2099, 2286–2287 | 윈도우 전역 sink 12건(테마→mermaid, 에디터 설정, 피처 레지스트리) | 없음 | `document/session.ts`의 `bindSettingSinks()` |

**이벤트 배선**: `listen("cli-open-request")` L1245, `onFileChanged` L2037, `onFileUnavailable` L2041, `win.onCloseRequested` L2052, `document.addEventListener("mermaid-open-fullscreen")` L1979, 설정 subscribe/bind 약 27건.

**같은 규칙이 여러 곳에 (main.ts 내부)**:
- **열기 트랜잭션 4벌**: `beginLifecycleRequest → read → commitBeforeSwitch → watcherHandoff.handoff → openInWindow`(실패 시 `sourceEditor.resumeWrites()`)이 `openDocument` L1192–1218, `onSelectVault` welcome 분기 L1467–1479, `onCloseTab` L1498–1526, `navigateHistory` L1936–1962에 각각 손으로 풀려 있다. `requestId !== lifecycleRequest` 검사가 4곳×2~3회. 이게 `main.ts` 분할의 **1순위 이유**다 — 세션 객체 하나가 `open(path, {vault, onCommit, viaHistory})`로 흡수해야 한다.
- **"첫 열기는 리로드, 아니면 제자리" 3벌**: `!currentFile && kind !== "remote" → location.href = createDocumentReloadUrl(...)`이 explorer `onOpenFile` L1081–1082, `openRecentEntry` L1319–1320, search `onOpenFile` L1567–1568.
- `currentVault() ?? workspaceStore.getGlobalVault()` 6회(L1021, 1066, 1113, 1561, 1566, 1577).
- `persistenceKind` switch 5개 함수(L186, 209, 629, 659, 1344) — `assertNever`로 잠근 건 좋으나 볼트 종류가 늘면 5곳.

**"big because many jobs" 판정.** 다만 주석 밀도가 매우 높아(설계 결정 이력) 실제 코드는 절반 이하 — 이동 시 주석을 잘라내지 말 것(그 주석이 회귀 6건의 기록이다).

### 1.2 `src-tauri/src/commands.rs` — 도메인 라이브러리와 IPC 어댑터의 융합

| 줄 | 일 | 호출자 |
|---|---|---|
| L6–7 | `WINDOW_SEQ`, `TMP_SEQ` statics | `open_path`, `write_file_with_state` |
| L9–190 | **경로 형태 규칙**: `expand_home(_with)`, `home_dir`, `resolve_home_dir_{unix,windows}`, `normalize_path`, `strip_verbatim_prefix` | `bundle.rs:20`, `hwp.rs:17`, 이 파일의 모든 커맨드 |
| L250–352 | **파일 IO**: `FileContent`, `read_file`, `write_file`→`write_file_with_state`(atomic temp+rename, CONFLICT guard, `requires_absolute_write_path`), `mtime_ms` | `remote_host.rs:771–781`이 `FileContent`/`mtime_ms` 재사용 |
| L359–373 | `watch_file`/`unwatch_file` — `watcher.rs` 얇은 래퍼 | |
| L377–397 | `create_markdown_file` | wikilink |
| L415–420 | `copy_to_clipboard`(arboard) — **파일 도메인과 무관** | `clipboard.ts` |
| L423–439 | `path_exists`/`directory_exists`/`canonicalize_path` | 9개 TS 호출점(가장 많이 invoke되는 커맨드) |
| L544–570 | `document_window_spec` + `open_path`(WebviewWindowBuilder) — **창 스폰, lib.rs의 창 코드와 같은 관심사** | `single_instance.rs:99` 주석이 참조 |
| L576–579 | `bundle_doc` 래퍼 | |
| L581–942 | **링크 피커 + 이미지 스캔**: `LinkTarget`, `is_image_ext`, `nfc_fold`, `basename_matches`, `is_within_base`, `file_target_is_within_base`, `scan_match`(BFS), `resolve_image`, `is_mermark_artifact`, `is_editor_text_ext`, `uses_stem_as_link_name`, `classify_link_target`, `list_link_targets` | `attachment_import.rs:52`(`is_image_ext`), `remote_host.rs:936,949` |
| L944–1074 | **한 단계 리스팅**: `DirEntry`, `entry_is_dir`, `is_hidden_entry`, `classify_dir_entry`, `list_dir` | `remote_host.rs:827,892` |
| L1076–1251 | **재귀 스캔**: `FileHit`, `ScanResult`, `EXCLUDED_SCAN_DIRS`, `walk_files_recursive`, `list_files_recursive` | `remote_host.rs:917` |
| L1253–1372 | **드라이브 열거**: `DriveEntry`, `windows_drives`, `mounted_volumes`, `dedupe_root_aliases`, `list_drives` | explorer "내 컴퓨터" |
| 테스트 6모듈 | L192, 447, 503, 531, 1374, 1477(이 마지막 하나가 ~1,200줄 — 위 도메인 전부의 테스트가 한 `mod tests`) | |

**핵심 관찰**: `remote_host.rs`의 HTTP 핸들러가 `crate::commands::list_dir(...)`(L892)·`list_files_recursive`(L917)·`resolve_image`(L936)·`list_link_targets`(L949)를 **`#[tauri::command]` 함수 그대로** 호출한다. 도메인 함수가 IPC 어댑터와 같은 심볼이라 (a) 시그니처가 IPC 편의(String 인자)에 묶여 있고, (b) 원격 호스트가 "커맨드"를 라이브러리로 쓴다는 의존 방향이 어색하다(§2.1). 분할 시 `fs::listing::list_dir(&Path, ListingPolicy) -> Vec<DirEntry>`가 라이브러리, `commands::list_dir(path: String, show_hidden: bool)`이 5줄 어댑터가 되어야 한다.

**"big because many jobs" 판정.** prod 약 1,370줄에 7개 도메인.

### 1.3 `src-tauri/src/remote_host.rs` — 응집

prod L1–953. 책임: `ArmedVault`+2단 봉쇄 `resolve_within` L62/`canonicalize_within` L91 → 페어링 상태기계 L113–211(`PairingState`, `issue_pairing_code`, `redeem`, `constant_time_eq`) → axum 라우터/서버 L372–447 → 요청 게이트 `authorize` L460/`armed_vault` L474/`safe_path` L518/`vault_relative` L558 → 핸들러 7개 L581–952. `#[tauri::command]` 없음(제어면은 `remote_share.rs`). 모든 핸들러가 같은 4행(authorize → armed_vault → safe_path → `commands::` 위임 → vault-relative 재작성)이라 **한 패턴의 반복이지 여러 일이 아니다.** 17 `#[test]`가 L954–1977. 분할 불필요. 단 §2.6의 블로킹 IO 불일치는 고칠 것.

### 1.4 `src/extensions/pdf-viewer/index.ts` — 응집, 소분할 2건

책임: 스타일 주입 L1–114 · pdf.js 타입 shim L116–162 · 페이지 기하 L164–299 · IntersectionObserver L301–361 · 스케줄러 상수/상태 L363–489 · 축출/랭킹 L491–592 · `reconcile()` L594–735 · 후보 선택 L737–821 · 래스터 L823–908 · 3단 렌더(draft/sharpen/text-layer) L910–1197 · 리사이즈 재렌더 L1199–1223 · WKWebView 호환 shim(`makeBlobWorker`, `ensureReadableStreamAsyncIterator`) L1225–1305 · 라이프사이클 `openPdfViewerFromBytes`/`registerPdfViewer` L1307–1521. 모듈 레벨 mutable 상태 0(전부 `const`), 문서별 상태는 `open()` 클로저 — **`open()`마다 새 스케줄러, 누수 없음**. 리스너 전부 `shell.onTeardown`으로 해제(L1344, 1482, 1484). import는 `../../api`와 sibling `./fit-width-scale`뿐, `pdfjs-dist`는 L1359–1361 동적 import — 콜드로드 원칙 준수.

떼어낼 것: `webview-compat.ts`(L1225–1305, 80줄, 다른 뷰어도 쓸 수 있음)와 `pdfjs-types.ts`(L116–162). 스케줄러는 그대로. **중복**: `pageIndexOf` L197·`PDF_PAGE_WIDTH_FRACTION` L164·`observePages` L330이 `hwp-viewer.ts`의 동명 함수와 "lockstep으로 바꿔라" 주석으로 묶인 손복사 — 페이지 가상화 primitive를 `chrome/viewer/page-virtualizer.ts`로 올리고 `src/api`로 재수출하면 pdf/hwp/미래 뷰어가 공유.

### 1.5 `src/mocks/tauri-core.ts` — 도메인별 분할 가능, 생성은 불가

구조: SAMPLE 문서 L6–88 · in-memory FS `store` L91 · 첨부 mock L93–116 · 워처 mock L153–230 · smoke bridge L202–222 · `Resource`/`Channel` stub L232–260 · 원격 mock 상태(`remoteMockError`, `refusesEscapingRemotePath`, `sshTunnelHost`, `hostShare`) L300–465 · 고정 `TREE` L467–573 · SQLite/HWP 픽스처 L575–648 · **`invoke` switch 52 case L650–1334**. 47 `#[tauri::command]`(lib.rs 413–462) 대비 case 52(플러그인 `open_url`·`check` 포함) — 커버리지는 완전.

**생성 가능한가**: 시그니처(이름·인자·반환 타입)는 Rust에서 생성 가능(`#[tauri::command]` + serde 구조체를 파싱하는 스크립트, 또는 `specta`/`tauri-specta`). **동작은 불가** — mock의 가치는 `refusesEscapingRemotePath` L344·`beginMockWatch`의 상대경로 거절 L179·`remoteMockError` L300 같은 **백엔드가 거절하는 것을 mock도 거절한다**는 의도적 parity이고 이건 손으로 쓴 도메인 규칙이다. 따라서 권고는 (1) **시그니처 표 생성**(Rust→`src/ipc/commands.generated.ts`: 커맨드명·인자·반환 타입의 단일 원천)과 (2) **mock을 도메인별 파일로 분할**(`mocks/ipc/{fs,remote,viewers,attachments,window}.ts` + 디스패처)이며, `tests/mock-parity.test.ts`를 "생성된 시그니처 표의 모든 커맨드에 mock case가 존재한다"는 구조 테스트로 확장하는 것.

### 1.6 `src/sidebar/explorer/explorer-panel.ts` — 응집 쪽

책임: DI 계약 `ExplorerHandlers` L130–242(26개 콜백) · 캐시/상태 L332–365 · **로빙 탭인덱스 a11y** L375–499 · `readChildren` L501–532 · 행 빌더 5종 L534–635 · "내 컴퓨터" L647–689 · 접기/펴기 L691–762 · `renderTree` L769–908(140줄, generation guard + focus-owed 프로토콜) · 네비게이션 L910–1054 · 설정 sink L1056–1088 · 이벤트 L1090–1235. 유일 소비자 `main.ts:10`. 로컬/원격 판정은 **이 파일에 없다** — `hasLocalPath?.()`(L227, 1125)·`canBookmarkFolders?.()`(L216, 595) 주입 술어만 존중. 볼트 어휘(`onToggleVault`, `isVaultRegistered`, `getBaseDir`)는 한 계층 위 것이지만 상태는 소유하지 않는다. 테어다운 메서드 없음(앱 수명 싱글턴이라 현재는 무해).

분리: `explorer-tree-a11y.ts`(L375–499)만. 내부 중복: `?? true` 관용 3회(L595, 1103, 1125), 하이라이트 해제 루프 2벌(L465–468 vs 481–484), `..` 행이 `renderTree` 안에 인라인(L821–855, 형제 빌더들과 달리 미추출).

### 1.7 2차 대상

| 파일 | prod/테스트 | 판정 |
|---|---|---|
| `htmlview.rs` 1,231 | 594/637 | 응집. `mint_view_token` L125가 epubview·remote_host·remote_token 4곳의 CSPRNG primitive로 자랐음 → `crypto_token.rs`로 승격 |
| `epubview.rs` 1,140 | 543/596 | 응집. htmlview와의 CORS/403/토큰 파싱 중복(§2.4)은 모듈 doc L9–17이 **의도적**이라 명시 |
| `attachment_import.rs` 964 | 533/431 | 응집. 4번째 봉쇄 구현 `picked_source_is_inside_vault` L199 |
| `remote_ssh.rs` 927 · `remote_client.rs` 891 · `single_instance.rs` 853 | 각 절반이 테스트 | 응집. `remote_client.rs`의 9개 커맨드가 `send_authorized`/`decode_response` 공용 위에서 한 패턴 |
| `lib.rs` 749 | 608/141 | 조합 루트로 응집. `write_stdin_to_scratch` L83–111·`dispatch_bundle` L245–270·qa_trace L185–238은 배선이 아닌 로직 → 자라면 `cli_dispatch.rs` |
| `settings/app.ts` 756 | — | **SSOT 표로 응집**(`registerSetting` 22 + `defineSetting` 5). 다만 세션/볼트/마이그레이션 상태는 `localStorage` 직접 접근 9개 파일(`main.ts:388,1678,1859`, `vault-tabs.ts:25,66`, `vault-collapse.ts:8`, `workspace-state.ts:87,141`, `favorite-vault-migration.ts`, `recent-vault-migration.ts:32`, `remote-vault-dialog.ts:24`) — 규약 위반은 아니나 "두 번째 영속 계층"이 각자 corrupt-value 처리를 함 |
| `settings/panel/controls.ts` 719 | — | 렌더 디스패치 표 + `buildGeometrySection` L212–330(형제 `theme-preview.ts`/`color-inspector.ts`처럼 추출됐어야 할 미니 기능) + Escape 중첩 해제 모듈 상태 L191–199 → `panel/theme-geometry.ts` |
| `theme-schema.ts` 705 | — | 순수 스키마, 응집 |
| `mermaid-widget.ts` 719 | — | 58%(L296–719)가 mermaid와 무관한 `attachPanZoom` primitive이고 `image-viewer.ts:15`·`mermaid-lightbox.ts:11`이 import → `chrome/viewer/pan-zoom.ts`로 이동(markdown 계층이 chrome 계층에 primitive를 공급하는 역방향 해소). **import 시 부작용** `themeForceSetting.subscribe` L179. `svgCache` L131·`lastHeight` L185는 앱 전역 싱글턴(창/문서 무관) |

---

## 2. 횡단 발견

### 2.1 의존 방향

- **원격 호스트 → IPC 커맨드**(`remote_host.rs:892,917,936,949`): HTTP 서버가 Tauri 커맨드 함수를 호출. 방향은 "어댑터 → 도메인"이어야 한다. `commands.rs` 분할(§3.2)이 해결.
- **markdown → chrome primitive 역류**: `attachPanZoom`이 `markdown/mermaid-widget.ts`에 살고 `chrome/viewer/*`가 import(§1.7). 설계 문서가 "chrome은 sidebar를 import하지 않는다"(main.ts:864–866)를 지키려 애쓴 것과 대조.
- **테스트 → 조합 루트**: `tests/main-wiring.test.ts:415–469`가 `../src/main`에서 순수 함수를 import. `main.ts`를 분할하면 이 import 경로부터 바뀐다(무해, 기계적).
- **viewer 내장 3종은 IPC를 직접 invoke**(`hwp-viewer.ts` 3, `sqlite-viewer.ts` 4, `epub-viewer.ts` 5)하고 `chrome/viewer/`에 살며, 확장 5종은 `src/api`만 통해 `file-bytes` 경유. 즉 "뷰어"가 두 신뢰 등급으로 나뉘어 있고 그 경계가 디렉터리로만 표현된다 — 플러그인 API에서 이게 정확히 "1st-party viewer vs plugin viewer" 구분이 된다(§5).

### 2.2 SSOT 누수 / 분산된 의도 (같은 규칙 ≥2곳)

| 규칙 | 위치 | 비고 |
|---|---|---|
| 이미지 확장자 집합 | `commands.rs:604–609 is_image_ext` · `wikilink.ts:50` 정규식 · `file-icons.ts:36 IMAGE_EXTENSIONS` | Rust 테스트 `image_ext_set_matches_isimagetarget`(commands.rs tests L+530)가 Rust↔TS 한 쌍만 잠금. 3번째(file-icons)는 미잠금 |
| 편집 가능 텍스트 확장자 | `commands.rs:852 is_editor_text_ext` · `file-icons.ts EDITABLE_TEXT_EXTENSIONS`(소비 5파일) | 주석으로만 동기화 |
| 이미지 스캔 깊이 12 | `commands.rs:706 MAX_IMAGE_SCAN_DEPTH` · `image-search-root.ts:15 VAULT_IMAGE_SCAN_DEPTH` | 주석으로만 동기화 |
| 제외 디렉터리 목록 | `commands.rs:1093 EXCLUDED_SCAN_DIRS` · `mocks/tauri-core.ts:739`(동일 리터럴 재선언) | |
| 아티팩트 접미사 `.mermark-tmp.`/`.mermark-recovered` | `commands.rs:841` · `main.ts` · `editor.ts` · `mocks/tauri-core.ts` | |
| 경로 봉쇄 "canonicalize 양쪽 + starts_with, fail closed" | `commands.rs:653,669` · `htmlview.rs:292` · `attachment_import.rs:199` · `remote_host.rs:91` | 4벌. `remote_host`판만 canonicalize된 경로를 반환해 TOCTOU를 피함 — 가장 좋은 버전이 가장 늦게 생겼고 나머지는 승격 안 됨 |
| CSPRNG 토큰 | `htmlview.rs:125 mint_view_token` ← epubview·remote_host×2·remote_token | 위치가 "scripted HTML 전용" 모듈 |
| 열기 트랜잭션 / 리로드-vs-제자리 | §1.1 | main.ts 내부 4벌/3벌 |
| 페이지 가상화(`pageIndexOf`/`observePages`/폭 비율) | `pdf-viewer/index.ts:164–361` · `hwp-viewer.ts` | lockstep 주석 |
| 롤백 오류 종류 | `attachment_import.rs:324–352`가 `ROLLBACK_*` 문자열 생성, `:508–515`가 `starts_with`로 재파싱 | 타입 없이 문자열 왕복 |

이 표의 상단 5개는 전부 **"Rust 상수 ↔ TS 상수 ↔ mock 상수"** 3중 복사다. 이건 §2.3의 시그니처 생성과 같은 해법(공유 상수를 한 곳에서 생성)으로 한 번에 닫힌다.

### 2.3 3-경계 정합의 실상: 경계는 3개가 아니라 38개

- Rust `#[tauri::command]` 47개 ⇄ TS `invoke<>` 호출 18파일 ⇄ `src/mocks/tauri-core.ts` 52 case — 여기까지가 문서화된 3경계.
- **그런데 vitest 테스트 35개 파일이 각자 `vi.mock("@tauri-apps/api/core", …)`로 자기만의 invoke mock을 쓴다**(`tests/main-wiring.test.ts:12–70` 등). `src/mocks/tauri-core.ts`를 쓰는 테스트는 4개뿐. 즉 브라우저 mock의 parity 노력(`beginMockWatch` 상대경로 거절 L179 등)은 골든 스크립트만 보호하고, 단위 테스트 35개는 각자의 손 mock이 백엔드와 얼마나 다른지 아무도 모른다. `tests/mock-parity.test.ts`는 `remote_pair`·`list_drives` 2건만 검증.
- TS 쪽 와이어 타입도 분산: `document/types.ts`(5개 shape) · `file-host.ts:47`(`RemoteConnectionState`) · `remote-vault-dialog.ts:32`(`RemoteVaultListing`) · `workspace-state.ts:35` · 각 뷰어 파일. `invoke`는 18파일에서 `@tauri-apps/api/core`를 직접 import — **타입 있는 IPC 클라이언트 모듈이 없다.**
- 처방(§3.3): `src/ipc/` 한 곳에 커맨드별 타입 함수(`ipc.readFile(path): Promise<FileContent>`)를 두고, 35개 테스트 mock은 그 모듈을 mock하게 옮긴다. 그러면 mock 대상이 "문자열 커맨드명 + any 인자"에서 "타입 있는 함수"로 바뀌어 tsc가 drift를 잡는다. `src/mocks/tauri-core.ts`는 그대로 골든용으로 남되 도메인별 파일로 쪼갠다.

### 2.4 의도적 중복 — 건드리지 말 것

`htmlview.rs` ↔ `epubview.rs`의 CORS/403/토큰 파싱 5쌍(`forbidden_response` 421≅405, `resource_origin` 433≅453, `cors_allow_origin` 460≅465, `build_preflight_response` 476≅476, `token_and_rel_path` 378≅417)은 epubview.rs:9–17이 "CSP 자세가 다른 두 스킴이 한 분기를 공유하지 않도록" 명시 결정. 이 진단은 그 결정을 존중한다. 단 `mint_view_token`만은 이미 4곳이 쓰므로 승격.

### 2.5 콜드로드 원칙 준수 여부

전 뷰어가 `open()` 내부 동적 import(pdf L1359, excel/docx/code는 `extensions/index.ts` 주석대로). `mermaid` L117 동적. **위반 없음.** 유일한 import-시 부작용은 `mermaid-widget.ts:179`의 구독 등록(비용은 0에 가깝지만 테스트 격리를 깨는 종류).

### 2.6 원격 호스트의 블로킹 IO 불일치

`read_file_handler`는 `spawn_blocking`(remote_host.rs:750)을 쓰지만 `list_dir_handler`(880)·`list_files_recursive_handler`(905, 최대 10k 엔트리 워크)·`resolve_image_handler`(927, BFS 10k 예산)·`list_link_targets_handler`(941)는 async 핸들러 안에서 동기 fs 워크를 직접 호출. LAN 1:1 서버라 실용상 문제는 작지만, 같은 파일 안에서 규칙이 둘이다. `commands.rs` 분할로 도메인 함수가 `&Path`를 받게 되면 `spawn_blocking(move || fs::listing::walk(...))`로 통일하기 쉬워진다.

---

## 3. 목표 구조

### 3.1 `src/main.ts` → 조합 루트 ~200줄

```
src/main.ts                         boot(): 아래를 순서대로 조립만 (import 25개 내외)
src/workspace/vault-routing.ts      L141–299 순수 규칙 9개 (이동)
src/workspace/boot-migrations.ts    favorites/recent/reload-handoff 마이그레이션 + resolveHomeRoot 호출
src/settings/boot-sinks.ts          L385–439 설정→CSS var 바인딩
src/chrome/app-shell.ts             DOM 골격 + arrangeTitleBar/StatusBar + registerSidebarPanel×5 + sash
src/chrome/status-bar/save-status.ts, src/chrome/title-bar/mode-toggle.ts, src/chrome/status-bar/flash.ts
src/document/session.ts             DocumentSession: current/currentFile/currentBaseDir/currentIsRemote/
                                    currentOpenVaultId/navHistory/lifecycleRequest/pendingPrepare/watcherHandoff
                                    → open(path, {vault, onCommit, viaHistory}), openSafely, commitBeforeSwitch,
                                      teardown, showWelcome, back/forward, bindEditorSinks(settings)
src/document/recovery-flow.ts       showRecovery/showOpenRecovery/showDocumentRecovery (session에 주입)
src/document/external-change-flow.ts resolveExternalChange + onFileChanged/onFileUnavailable 구독
src/chrome/viewer/open-dispatch.ts  viewerForEntry/openWithViewer/openPathEntry/openImageFromEditor/closeOpenViewer
src/workspace/vault-selection.ts    routedVault/currentVault()/selectedWorkspaceVault/toggleExplorerVault/
                                    onSelectVault/onSelectTab/onCloseTab (세션의 open()을 호출하는 쪽)
src/shortcuts/app-commands.ts       registerHandler 18개 (session·panels·dispatch를 인자로)
src/update/auto-install.ts          L2101–2141
```

`DocumentSession`이 `main.ts`의 mutable 셀 20개 중 14개를 가져간다. 나머지(`routedVault`, `searchScanVault`, `viewerSlot`, `flashTimer`)는 각각 vault-selection / search 어댑터 / open-dispatch / flash로. **"열기 트랜잭션 4벌"이 `session.open()` 하나로** 접히는 것이 이 구조의 검증 기준이다.

### 3.2 `src-tauri/src/commands.rs` → 도메인 모듈 + 얇은 어댑터

```
src-tauri/src/fs/mod.rs
src-tauri/src/fs/paths.rs        expand_home, home_dir, resolve_home_dir_*, normalize_path, strip_verbatim_prefix,
                                 is_within_base, file_target_is_within_base  (+ remote_host의 canonicalize_within 승격 검토)
src-tauri/src/fs/file_io.rs      FileContent, read, write_atomic(+conflict guard), mtime_ms, TMP_SEQ, create_markdown
src-tauri/src/fs/listing.rs      DirEntry, ListingPolicy{show_hidden}, list_dir(&Path,…), FileHit/ScanResult,
                                 walk_files_recursive, is_hidden_entry, is_mermark_artifact, EXCLUDED_SCAN_DIRS
src-tauri/src/fs/link_targets.rs LinkTarget, is_image_ext, is_editor_text_ext, uses_stem_as_link_name, classify, list
src-tauri/src/fs/image_resolve.rs scan_match, resolve_image, nfc_fold, basename_matches, MAX_IMAGE_SCAN_DEPTH
src-tauri/src/fs/drives.rs       DriveEntry, windows_drives, mounted_volumes, dedupe_root_aliases, list_drives
src-tauri/src/window.rs          document_window_spec, open_path, DEFAULT_WINDOW/MIN_WINDOW, with_document_chrome (lib.rs L117–155에서)
src-tauri/src/crypto_token.rs    mint_view_token (htmlview.rs L117–129에서)
src-tauri/src/commands.rs        #[tauri::command] 16개만, 각각 3~6줄: String→Path 변환 + fs::* 호출 + String 오류 매핑
```

각 테스트 모듈은 해당 도메인 파일로 따라간다(`mod tests` L1477의 ~1,200줄을 도메인별로 나누는 것 자체가 부수 이득). `remote_host.rs`는 `crate::fs::listing::list_dir(&path, ListingPolicy::peer())`를 호출하게 되어 §2.1·§2.6이 같이 풀린다. 와이어 구조체(`DirEntry` 등)는 `fs/`에 남고 `commands.rs`가 재수출 — TS 생성 스크립트의 입력.

### 3.3 IPC 경계 한 곳으로

```
src/ipc/commands.generated.ts    Rust에서 생성: 커맨드명·인자 키(camelCase 변환 포함)·반환 타입, 공유 상수(확장자 집합·깊이·제외 디렉터리)
src/ipc/index.ts                 타입 있는 함수 47개 (`readFile`, `listDir`, …) — 앱 코드의 유일한 invoke 지점
src/mocks/ipc/{fs,remote,viewers,attachments,window}.ts + src/mocks/tauri-core.ts(디스패처)
tests/mock-parity.test.ts        "generated 표의 모든 커맨드에 mock case 존재" + 기존 2건
```

### 3.4 미래 공개 플러그인 API와의 정렬

`src/api/index.ts`가 지금 노출하는 것: 피처 레지스트리 2, 커맨드/설정/사이드바/뷰어 레지스트리, `openViewerShell`, `readLocalFileBytes`/`readRemoteFileBytes`, 읽기 전용 설정 뷰 2(`fontScale`, `htmlViewerScripts`), `looksNumeric`. 위 재구성 뒤 **추가로 노출해야 할 것**: `page-virtualizer`(§1.4), `pan-zoom`(§1.7), `webview-compat`, `DocumentSession`의 **읽기 전용 뷰**(현재 문서 경로/볼트 종류/모드 — `ReadonlySetting` 패턴 그대로, `set` 없는 frozen 객체), `open-dispatch`의 `openPath(path)`(플러그인이 문서를 열 수 있어야 함 — 단 `viewerFor`는 지금처럼 비노출). **반드시 사설로 남을 것**: `src/ipc/*` 전체(§5), `DocumentSession.open()`의 트랜잭션 내부, `workspaceStore` 쓰기, `watchFile`, `settings/app.ts`의 `Setting.set`.

---

## 4. 마이그레이션 순서

원칙: 순수 이동 먼저, 동작 변경은 마지막. 각 단계는 `npm test`(2,240)·`cargo test`(393)·`tsc --noEmit` green으로 독립 배포 가능. **[M]** = 기계적(sonnet), **[D]** = 설계 판단 필요(opus).

| # | 단계 | 파일 | 위험 | 증명 테스트 | 모델 |
|---|---|---|---|---|---|
| 1 | `commands.rs` → `fs/{paths,file_io,listing,link_targets,image_resolve,drives}.rs` + `window.rs` 순수 이동, `commands.rs`는 `pub use` + 어댑터. `mod tests` 도메인별 분배 | Rust 8파일, `lib.rs`(mod 선언) | 낮음 — 심볼 경로만 변경, 와이어 shape 불변 | `cargo test` 전부(95건 그대로) + `tests/mock-parity.test.ts` | [M] |
| 2 | `mint_view_token` → `crypto_token.rs` | `htmlview.rs`, `epubview.rs`, `remote_host.rs`, `remote_token.rs` | 낮음 | `cargo test` | [M] |
| 3 | `main.ts` L141–299 → `workspace/vault-routing.ts`; `main-wiring.test.ts:415–469` import 경로 갱신 | 2파일 + 테스트 1 | 낮음 | `main-wiring.test.ts` 68건 | [M] |
| 4 | `main.ts` L385–439 → `settings/boot-sinks.ts`, L301–377 → chrome 위젯 3파일, L2101–2141 → `update/auto-install.ts` | 5파일 | 낮음 | `main-update-autorestart.test.ts`, `status-bar-*.test.ts`, `title-bar*.test.ts` | [M] |
| 5 | `attachPanZoom` → `chrome/viewer/pan-zoom.ts`; `mermaid-widget.ts:179` 구독을 `refreshMermaidTheme` 초기화 시점으로 이동 | 4파일 | 낮음 | `mermaid-widget.test.ts`, `image-viewer.test.ts`, `viewer-zoom.test.ts` | [M] |
| 6 | pdf-viewer `webview-compat.ts`·`pdfjs-types.ts` 추출 | 3파일 | 낮음 | `pdf-viewer.test.ts` | [M] |
| 7 | **`DocumentSession` 설계**: 셀 목록·`open()` 시그니처·`onCommit` 계약·`resumeWrites` 실패 경로 확정. 4벌 트랜잭션의 차이점(onCloseTab의 `nextTab` 선읽기, navigateHistory의 `pruneAt`)을 옵션으로 흡수하는 설계 | 설계 문서 | **높음** — 여기서 잘못 자르면 8단계가 회귀 | 설계 시점엔 없음; 골든 `workspace-smoke.mjs`·`integrated-recovery-smoke.mjs` 시나리오를 수용 기준으로 지정 | [D] |
| 8 | `DocumentSession` 구현: `openDocument`/`commitBeforeSwitch`/`teardownCurrent`/`openInWindow`/`navigateHistory`를 `document/session.ts`로 이동, `main.ts`의 4벌을 `session.open()` 호출로 치환 | `main.ts`, `document/session.ts` | 중간 | `main-wiring.test.ts` 68 + `session-persistence` + `file-watch` + 골든 2종 | [M]+[D] 리뷰 |
| 9 | `open-dispatch.ts`, `recovery-flow.ts`, `external-change-flow.ts`, `vault-selection.ts`, `app-commands.ts`, `app-shell.ts` 순차 추출(각각 독립 커밋) | 6파일 | 중간 | `main-wiring`, `viewer-toggle`, `conflict-recovery`, `shortcuts-registry` | [M] |
| 10 | "리로드-vs-제자리" 3벌 → `session.openFromPanel(path, vault)` 하나로 | `session.ts`, `main.ts` | 낮음(8 이후) | `main-wiring`의 reload 케이스, `reload-handoff.test.ts` | [M] |
| 11 | `src/ipc/index.ts` 타입 함수 47개 신설, 18파일의 `invoke` 직접 호출 치환 | 19파일 | 중간 — 인자 키 camelCase 변환 실수 가능 | `tsc` + 골든 전체(`viewer-golden`, `workspace-smoke`) | [M] |
| 12 | Rust→TS 시그니처/상수 생성 스크립트(`scripts/gen-ipc.mjs` 또는 `tauri-specta` 검토) + `mock-parity` 구조 테스트 | 스크립트 1, 테스트 1 | 중간 — 생성기 자체의 정확성 | 생성 결과 == 손으로 쓴 §3.3 표 diff 0 | [D] 선택, [M] 구현 |
| 13 | 35개 테스트의 `vi.mock("@tauri-apps/api/core")` → `vi.mock("../src/ipc")` 이관; `src/mocks/tauri-core.ts` 도메인별 분할 | 테스트 35 + mock 6 | 낮음(기계적, 양이 많음) | 해당 테스트 전부 | [M] |
| 14 | `remote_host.rs` 핸들러 4개 `spawn_blocking` 통일; `commands::`→`fs::` 호출 전환 | 1파일 | 낮음 | `remote_host.rs` 17건 + `remote-host-truth-table.test.ts` | [M] |
| 15 | `explorer-tree-a11y.ts` 추출, `..` 행 빌더 추출, `controls.ts`→`theme-geometry.ts` | 4파일 | 낮음 | `explorer-panel.test.ts`, `settings-controls.test.ts` | [M] |

1–6은 서로 독립(병렬 가능). 7→8→9→10은 직렬. 11→12→13 직렬. 14는 1 이후. 15는 언제든.

---

## 5. 플러그인 API 준비

`docs/design/plugin-system.md` rev 2의 §6.1 위협 사실 4건은 지금도 전부 성립한다: `window.__TAURI_INTERNALS__`가 웹뷰에 존재(main.ts:2050이 실제로 검사), `write_file`의 `baseline: 0`이 conflict guard 우회(commands.rs:326), `list_dir`은 의도적으로 `is_within_base` 없음(commands.rs:1042–1046), `readLocalFileBytes`가 파사드로 노출(api/index.ts:94). **서드파티를 받는 순간 rev 2에서 바뀌는 것:**

1. **"파사드 = 경계"라는 전제가 무너진다.** 같은 JS 컨텍스트의 코드는 `__TAURI_INTERNALS__`로 47개 커맨드 전부를 호출할 수 있다 — `read_file`(경로 제한 없음), `write_file`(baseline 0), `open_path`(창 스폰), `remote_pair`(호스트 페어링), `remote_share_start`(내 볼트를 네트워크에 공유), `copy_to_clipboard`. 즉 **웹뷰 안의 권한 모델은 성실한 플러그인의 과실 방지용이지 보안 장치가 아니다**(rev 2 §6.1이 이미 정확히 말한 것). 진짜 경계는 두 가지뿐: (a) Tauri capability 파일로 커맨드를 창별로 제한하고 플러그인을 **별도 웹뷰(iframe/window)** 에 격리, 또는 (b) 플러그인 코드를 Worker/샌드박스 iframe에서 실행하고 postMessage RPC로 파사드만 통과. (b)가 mermark의 CSP `script-src 'self'`와 공존 가능하고 rev 2 §5의 blob: 개방 없이 간다.
2. **IPC 표면이 권한 단위가 된다.** §3.3의 `src/ipc/`가 생기면 "플러그인이 만질 수 있는 커맨드"를 그 모듈의 부분집합으로 정의할 수 있다(읽기 전용 fs 5개: `read_file`·`list_dir`·`path_exists`·`resolve_image`·`list_link_targets`; 나머지 42개 비노출). rev 2 §6.3-3의 "`watch_file`/updater/process 영구 비노출"이 목록으로 실현된다. **전제: 단계 11.**
3. **manifest 권한 + apiVersion 동결**(§6.3-2, -5)은 `src/api/index.ts`가 지금처럼 raw 재수출이면 불가능하다 — CM6 타입을 그대로 노출하므로 CM6 메이저 업그레이드가 곧 API 파괴다. 서드파티 개방은 rev 1이 버린 얇은 래핑 계층을 **뷰어·사이드바·커맨드·설정 4 레지스트리에 한해** 되살려야 한다(마크다운 피처 R3는 CM6 네이티브로 두고 "unstable" 표기). 이 결정은 이번 리팩토링 범위 밖이지만, §3.4의 "읽기 전용 뷰" 패턴(`ReadonlySetting`)을 세션·볼트 상태에 지금부터 적용해 두면 그때 되살릴 표면이 작다.
4. **1st-party viewer와 plugin viewer의 구분이 명시적이어야 한다.** 지금은 "IPC가 필요한 뷰어는 `chrome/viewer/`, 바이트만 필요한 뷰어는 `extensions/`"라는 디렉터리 관례(main.ts:853–867 주석). 공개 API에서는 후자만 플러그인이 만들 수 있고, 전자는 `registerViewer`를 같은 함수로 쓰더라도 `readLocalFileBytes` 외의 능력이 없어야 한다 — `page-virtualizer`·`pan-zoom`·`webview-compat`를 파사드로 올리는 이유가 이것이다(플러그인 뷰어가 hwp-viewer 수준의 품질을 IPC 없이 낼 수 있게).
5. **설정 SSOT 침범 경로**: `registerSetting`은 이미 파사드에 있으나 `Setting.set`은 자기 설정에만 써야 한다는 규칙이 타입으로 없다. 서드파티 개방 시 `registerSetting`이 돌려주는 핸들만 `set`을 갖고 다른 설정은 `ReadonlySetting`으로만 조회 가능하게 — api/index.ts:108–122가 `fontScale`에 이미 한 것을 일반화.

**전제 조건이 되는 리팩토링 단계**: 11(IPC 한 곳) → 12(시그니처 생성; 권한 목록의 원천) → 8(세션 객체; 읽기 전용 뷰를 낼 대상) → 5·6(플러그인 뷰어용 primitive 승격). 1–4·9·10·13–15는 플러그인 API와 직접 관계 없는 위생.

---

## 6. Top 5 권고 (효익/위험 순)

1. **`commands.rs` → `fs/*` 도메인 모듈 + 얇은 어댑터 (단계 1)** — 위험 최저(순수 이동, 95 cargo 테스트가 그대로 증명), 효익 최대: `remote_host`의 역방향 의존·블로킹 IO 불일치·1,200줄 단일 테스트 모듈·TS 생성기의 입력 정리가 한 번에 풀린다.
2. **`DocumentSession` 추출 (단계 7–8)** — `main.ts`의 진짜 병목. 열기 트랜잭션 4벌이 1벌이 되면 "vault-crossing open이 잘못된 백엔드로 읽는" 부류의 버그(Ruling 9/32/33, Task 11 fix round 1–3 주석)가 재발할 자리가 사라진다. 설계 판단이 필요하므로 단계 7을 별도 세션으로.
3. **`src/ipc/` 타입 있는 IPC 클라이언트 + Rust→TS 시그니처 생성 (단계 11–12)** — 3경계가 실제로는 38경계라는 사실(§2.3)을 닫는 유일한 구조적 해법이자 플러그인 권한 목록의 원천. 상수 5종의 3중 복사(§2.2)도 여기서 사라진다.
4. **`main.ts` 순수 이동 6건 (단계 3–6)** — 전부 [M], 하루치. `main.ts`를 2,325→~1,600으로 줄여 단계 8의 diff를 읽을 수 있게 만든다.
5. **35개 테스트 mock을 `src/ipc` mock으로 이관 (단계 13)** — 효익은 3에 종속, 양은 많지만 기계적. 이걸 하지 않으면 3의 가치가 골든 스크립트에만 머문다.

**하지 말 것**: `remote_host.rs`·`htmlview.rs`·`epubview.rs`·`attachment_import.rs`·`theme-schema.ts` 분할(전부 테스트가 절반이거나 응집), htmlview↔epubview 공통화(의도적 중복, 모듈 doc 명시), pdf 스케줄러 분할(결합만 이동).
