# Intent Review — 2026-10-18 (합본)

> 전체 코드베이스(TS `src/**` + Rust `src-tauri/src/**`) 대상 intent-review의 합본이다. 파트별 상세는 아래 4개 보고서에 있다.
> - [파트 A — markdown / document / text / editor.ts](intent-review-2026-10-18/part-A.md)
> - [파트 B — chrome / sidebar / workspace / extensions](intent-review-2026-10-18/part-B.md)
> - [파트 C — settings / main.ts / api / shortcuts / update / qa / 루트 단일 파일](intent-review-2026-10-18/part-C.md)
> - [파트 D — src-tauri/src (Rust)](intent-review-2026-10-18/part-D.md)
>
> 방법: `~/.claude/skills/intent-review/SKILL.md` Phase 1–3. 합본 단계에서는 각 파트의 「교차 영역 단서」(A 18 · B 10 · C 23 · D 48)를 서로 대조해 **파트를 가로지르는 분산된 의도**를 통합 클러스터로 묶었다. 일부 교차 사실은 합본 단계에서 grep으로 재확인했다(본문에 "합본 확인"으로 표시). 코드는 수정하지 않았다.

---

## 요약

| 항목 | A | B | C | D | 합계 |
|---|--:|--:|--:|--:|--:|
| 스캔 파일 | 77 | 66 | 30 | 33 (.rs) | **206** |
| 명명 함수·메서드(약) | 480 | 500 | 320 | 410 | **~1,710** (+ `#[tauri::command]` 52) |
| 후보 | 33 | 31 | 31 | 32 | **127** |
| └ high | 12 | 9 | 11 | 10 | **42** |
| └ medium | 14 | 13 | 14 | 10 | **51** |
| └ low | 7 | 9 | 6 | 12 | **34** |
| CQS 위반(⭐) | 1 | 1 | 0 | 0 | **2** |
| 분산된 의도(파트 내 집계) | 17 | 11 | 9 | 10 | **47** (파트 간 중복 포함) |

- **통합 후**: high 42건 중 12건이 파트 간 같은 의도의 중복이다. 이를 병합하면 **고유 high 30건**이다(확인된 결함 4 + 교차 클러스터 15 + 파트 내부 high 11).
- **교차 분산 의도 클러스터**: **15개**. 그중 TS↔Rust 미러가 걸린 클러스터는 9개이고(X1·X2·X3·X4·X6·X7·X10·X11·X15), 입력 예시로 **동작이 이미 갈라진 것을 보일 수 있는 클러스터**는 11개다.
- **CQS ⭐ 2건**: `conflict/conflict-recovery.ts:55 detect`(A, 조회 이름인데 기록함) · `workspace/cli-routing.ts:31 routeCliFile` / `vault-selection.ts:39 routeDocumentPath`(B, 해석 이름인데 `store.selectVault`를 호출함).
- **최대 이슈**: 같은 규칙을 "일부 호출부만 지키는" 부분 적용이 결함으로 드러났다. 재시작 전 버퍼 확정은 3경로 중 1곳만, 구독 해제는 8개 렌더러 중 4개만 지킨다. 원격 볼트 분기는 이미지만 고치고 동영상은 빠졌다. 그 위에 **와이어 계약**(오류 접두사·확장자·아티팩트 접미사·수치 상수)이 Rust·TS·mock에 손으로 3중 복사돼 있고, 이를 막기로 했던 09-25 진단의 단계 11–12(`src/ipc` + 생성기)는 아직 착수하지 않았다(합본 확인: `src/ipc/` 없음).

---

## 확인된 결함

오케스트레이터가 코드로 직접 확인한 판정이다.

1. **확인**: 수동 "설치하고 재시작"(`chrome/status-bar/update.ts:104`, `settings/panel/version-pane.ts:312`)은 `commitBeforeSwitch` 없이 `installAndRelaunch`를 호출한다. 그래서 미저장 편집이 유실될 수 있다. 커밋한 뒤 재시작하는 경로는 `update/auto-install.ts` 하나뿐이다. → 클러스터 **X13**.
2. **확인**: 충돌 정책 "덮어쓰기"(`settings/app.ts:336`)는 UI에 노출되지만, `9dc3e01`(2026-08-11 recovery)에서 sink가 제거됐다. 그 결과 `editor.ts:460 setConflictPolicy`는 no-op이다. 효과 없는 설정이다(파트 A High#1. `editor.ts` doc 주석 :98·:153·:360도 거짓 약속).
3. **확인**: `settings/panel/controls.ts:73,108,144,164`(segmented/select/slider/text)가 구독 해제 함수를 버린다(누수). 설정 카테고리를 전환하거나 다시 열 때마다 분리된 DOM에 reflect 클로저가 쌓인다(파트 C H1).
4. **확인**: `markdown/embed.ts:81`에서 원격 볼트의 동영상이 `resolveImageUrl`(`convertFileSrc`)을 거쳐 로컬 asset URL이 되므로 재생되지 않는다. 원격 뷰어 동등성 원칙 위반이다. 합본 확인 결과 보강할 점이 있다. Rust `remote_host.rs:803 asset_content_type`에 동영상 MIME이 없고(`application/octet-stream`), `/read_asset`은 20 MiB 상한에 전체 버퍼링 방식이다. 따라서 "이미지와 같은 방식으로 원격 읽기"는 바로 쓸 수 없다. 원격 동영상을 **미지원 안내로 거부할지, 지원할지** 결정이 먼저다. → 클러스터 **X4·X5**.
5. **기각**: `hwp.rs:81` `"superseded"`를 TS가 처리하지 않는다는 지적. 이 값이 발생하는 시점에는 해당 뷰어가 이미 닫혀 있으므로 무해하다.

---

## 미확인 의심

파트 보고서가 "버그 의심"으로 올렸으나 아직 재현하지 않은 항목이다. 각 항목에 확인 방법을 한 줄씩 붙였다.

| # | 의심 | 위치 | 확인 방법 |
|---|---|---|---|
| U1 | `unregisterVault`가 `lastSelectedPermanentVaultId`에 원격 볼트 id를 넣을 수 있다. 메모리 상태가 계약("must not launder a remote id")을 위반하고, 재로드 후 현재 볼트와도 달라진다 | `workspace/workspace-state.ts:241` | vitest: 영구 A(lastSelected) + 원격 R을 등록하고 A를 해제한 뒤 `store.get()`의 `lastSelectedPermanentVaultId !== R`을 단언한다. 같은 상태를 `readState`로 재로드했을 때 `currentVaultId`와도 비교한다 |
| U2 | `FileHit.rel_path`가 doc("forward-slash joined")과 달리 `to_string_lossy()`로 플랫폼 구분자를 쓴다. Windows에서 `fuzzy.ts:67` `lastIndexOf("/")`의 basename 점수가 깨진다 | `fs/listing.rs:181,270` ↔ `sidebar/search/fuzzy.ts:67` | `#[cfg(windows)]` cargo 테스트: 하위 폴더 파일을 `walk_files_recursive`로 돌려 `!rel_path.contains('\\')`를 단언한다. TS는 `a\\b\\c.md` 입력의 basename 하이라이트 위치를 테스트한다 |
| U3 | watcher가 받은 문자열을 그대로 identity 키로 쓰고, `write_file`은 `normalize_path` 결과로 self-write를 기록한다. `..`·`~`가 섞인 경로로 watch하면 자기 저장을 외부 변경으로 오인한다 | `watcher.rs:93,106,152` ↔ `fs/file_io.rs:103,131` | cargo 테스트: `set_watch("<tmp>/d/../d/a.md")` 뒤 `write_file("<tmp>/d/a.md")`를 실행하고 `file-changed`가 발생하지 않는지 확인한다(현재 TS가 정규 경로를 넘기므로 잠재 결함) |
| U4 | epub 줌에 html의 identity 빠른 경로(scale≈1이면 transform 제거)가 없다. 기본 줌에서도 `transform: scale(1)`이 붙는다 | `chrome/viewer/epub-viewer.ts:140` ↔ `extensions/html-viewer/index.ts:179,208` | jsdom: scale 1에서 `iframe.style.transform === ""`인지 확인한다. 실기(WKWebView): 긴 epub을 기본 줌으로 스크롤하며 프레임 드랍을 html 뷰어와 비교한다 |
| U5 | recovery 모달은 Esc에서 `stopImmediatePropagation`을 하지 않는다(conflict만 함). Esc가 전역 단축키 디스패처로 샐 수 있다 | `document/recovery-modal.ts:117` ↔ `conflict/conflict-modal.ts:145` | jsdom: recovery 모달을 연 상태에서 Esc keydown을 보내고, Esc에 바인딩된 전역 핸들러(예: 사이드바 닫기)가 호출되지 않는지 단언한다 |
| U6 | 표 셀 이스케이프 판정이 두 번 갈린다. table-widget은 짝홀 규칙, inline-render는 한 글자 규칙이다 | `markdown/inline-render.ts:29` ↔ `table-widget.ts:18` | Golden: 표 셀 `\\*a*`와 같은 문단 텍스트의 렌더 DOM을 비교한다(강조 여부가 다르면 확정) |
| U7 | fold가 텍스트 정규식으로 헤딩을 판정한다. 펜스 안의 `# 주석`은 접히고 Setext는 접히지 않는다 | `markdown/fold.ts:6` | vitest: ```` ```bash\n# c\n``` ```` 문서와 `T\n===` 문서의 `foldable()` 결과를 단언한다 |
| U8 | `dropFences`가 닫는 `~~~`를 인식하지 못한다. `~~~mermaid` 본문 끝에 `~~~`가 섞인다 | `markdown/core.ts:120` | vitest: `~~~mermaid\ngraph TD\n~~~`의 `fencedBody`가 `graph TD`인지 확인한다 |
| U9 | 검색 패널의 `isOpenableEntry`에 `onOpenWithViewer` 조건이 없다. 탐색기와 판정이 다르다("never disagree" 약속 위반) | `sidebar/search/search-panel.ts:129` ↔ `explorer-panel.ts:303` | jsdom: `canOpenWithViewer`만 주입하고 `onOpenWithViewer`는 주입하지 않은 상태에서 `.pdf` 행이 두 패널에서 같은 openable 표시를 받는지 비교한다 |
| U10 | `folderPrefixFor`가 `startsWith`로 포함을 판정한다. 형제 폴더도 접두사를 받는다 | `workspace/workspace-sidebar.ts:202-204` | vitest: 루트 `/a/b`, 문서 `/a/bc/x.md` → 접두사가 `""`(포함 아님)인지 확인한다. 현재 예상 출력은 `"c/"` |
| U11 | scripted HTML 뷰어가 `.avif`/`.bmp`를 `application/octet-stream`으로 서빙한다(MIME 표 누락은 합본에서 코드로 확인함) | `htmlview.rs:325-343` ↔ `remote_host.rs:803` | 실기: `<img src="x.avif">`가 있는 HTML을 scripted 모드로 열어 렌더 여부를 본다. WKWebView가 sniffing으로 살리면 무해하다 |
| U12 | `isVaultRegistered`는 모든 워크스페이스를 보고, `registerCanonicalVault`의 중복 판정은 현재 워크스페이스만 본다 | `main.ts:1066-1069` ↔ `workspace-state.ts:182` | vitest: 워크스페이스 2에 등록된 루트를 워크스페이스 1에서 탐색기 토글할 때 등록과 해제 중 어느 쪽으로 동작하는지 단언한다 |
| U13 | 원격 루트 `""` 특례가 없는 결합 지점 2곳(`attach-image.ts:267`, `path.ts:311 resolveOpenPath`)에서 원격 경로에 `/`가 앞에 붙는다 | `markdown/attach-image.ts:267`, `document/path.ts:311` | 원격 볼트에서 해당 경로가 실제로 실행되는지부터 확인한다(첨부는 읽기 전용으로 거부될 수 있음). 실행된다면 `joinUnderBase("", "a.png") === "a.png"` 테스트를 쓴다 |
| U14 | `SSH_TUNNEL_CONNECTING:`을 소비하는 TS 코드가 없다. 원문이 사용자에게 그대로 노출될 수 있다 | `remote_ssh.rs:462` | mock에서 해당 오류를 발생시키고 사이드바 배지와 오류 문구를 확인한다 |
| U15 | `remote-share-cli.ts:23`의 경로형 인자 판정 `startsWith("/")`이 Windows 경로를 이름형으로 오분류한다 | `settings/remote-share-cli.ts:23` | vitest: `C:\\vault` 입력의 분류 결과를 단언한다 |

---

## 🔴 High Priority (파트 통합·중복 제거·우선순위)

파트별 high 42건을 같은 의도끼리 병합했다. 우선순위는 **P0 버그 → P1 데이터 무결성·보안 → P2 이미 갈라진 분산 의도 → P3 drift 예방**이다. 클러스터(X#)의 상세는 다음 절에 있다.

| 우선 | # | 항목 | 병합한 파트 high | 유형 |
|:-:|---|---|---|---|
| P0 | R1 | 재시작 전 버퍼 확정이 3경로 중 1곳에만 있음 (= 확인 결함 1, X13) | C-H2 | 데이터 유실 |
| P0 | R2 | 충돌 정책 no-op (= 확인 결함 2) | A-H1 | 거짓 설정 |
| P0 | R3 | 설정 컨트롤 구독 누수 (= 확인 결함 3) | C-H1 | 누수 |
| P0 | R4 | 원격 볼트 동영상 임베드 (= 확인 결함 4, X4/X5) | A 교차 단서 | 원격 동등성 |
| P1 | X9 | 볼트 라우팅 폴백·선택·종류 정책 | B-H4, B-H5, C-H3, C-H4, C-H5 | vault leak 계열(6회 기록) |
| P1 | X1 | 경로 포함(containment) | A-H4, B-H7(일부), D-H10 | 보안 경계 |
| P1 | X2 | 경로 정규화·인입 정책 | C-H6, D-H8 | 오라우팅 실측 이력 |
| P1 | D-H2 | 원격 커맨드 프리앰블 8벌. 토큰 유출 방지 게이트(`ensure_tunnel_serves`)를 커맨드마다 손으로 붙임 | D-H2 | 보안(잠재) |
| P1 | D-H6 | 유계 읽기 4벌. hwp는 stat→read TOCTOU 형태이고 `take` 상한이 없음 | D-H6 | 보안(잠재) |
| P1 | X7 | hidden/artifact 판정과 생산자 분리 | D-H5, D-H9 | 임시 파일 노출 |
| P1 | X6 | 오류 접두사 계약·문구 매핑 (`REMOTE:` Debug ↔ serde kebab) | A-H11, D-H1, C-H10, (B-H1 일부) | 와이어 계약 |
| P2 | X5 | 원격 볼트 판정·로컬전용 거부·원격 문구·SSH 판정 | A-H10, A-H12, C-H7 | 이미 갈라짐 |
| P2 | X3 | vault-relative 결합·구분자·basename | A-H5, B-H9(구분자) | 이미 갈라짐 |
| P2 | X4 | 확장자 분류(이미지·동영상·편집 가능·런처·hwp) + MIME | B-H9(확장자), D-H4 | 이미 갈라짐 |
| P2 | X10 | 뷰어 수명주기·페이지 밴드·iframe 줌 | B-H1, B-H2, B-H3 | 이미 갈라짐 |
| P2 | X12 | 모달 셸 | A-H3 | 이미 갈라짐(Esc 3변종) |
| P2 | A-H6 | 이스케이프 판정 3구현(짝홀 대 한 글자) | A-H6 | 이미 갈라짐(U6) |
| P2 | A-H8 | 헤딩 SSOT 부재, fold는 텍스트 정규식 | A-H8 | 이미 갈라짐(U7) |
| P2 | B-H6 | 열기 가능/북마크 가능 게이트 2+2벌 (I2 버그 이력) | B-H6 | 이미 갈라짐(U9) |
| P2 | B-H8 | pdf 맞춤 뷰포트 계산 2벌("ONE place" 약속 위반) | B-H8 | 텍스트 레이어 어긋남 위험 |
| P2 | X14 | 테마 프리셋 열거·키→CSS 변수·폴백 | C-H8, C-H9 | 하드코딩 폴백 |
| P3 | X8 | Promise 메모 캐시 eviction 5+벌 | A-H7 | 제거 조건 3종 |
| P3 | X11 | 문서 창 빌더·라벨·`?file=` URL | D-H3 | 인라인 라벨 규칙 |
| P3 | X15 | 와이어 수치 상수(20 MiB·깊이 12·포트 범위·제외 폴더) | (교차 단서) | 주석 동기화 |
| P3 | A-H2 | `makeAutosave` 내부 상태 전이(복구 진입 ×4, baseline ×3, 읽기 전용 가드 ×7) | A-H2 | 파트 내부 |
| P3 | A-H9 | 위키링크 대상 종류 분류가 feature/widget에 2벌 → `classifyWikilinkTarget` + dispatch table | A-H9 | 파트 내부 |
| P3 | B-H7 | `createWorkspaceSidebar.render/renderGroup` God 함수(~200줄, 4단 중첩) | B-H7 | 파트 내부 |
| P3 | C-H11 | 바인드 방식 기본값 규칙 2벌(`chooseBindMode` 대 패널 인라인) | C-H11 | 파트 내부 |
| P3 | D-H7 | 설정 JSON 저장소 load/save 3벌과 관용 정책 분산 | D-H7 | 파트 내부 |
| — | X13 | (R1의 클러스터 형태: `installAndRelaunch(confirmDurable)`) | — | — |

> 파트 내부 high의 before→after 코드는 각 파트 보고서에 있다. 위 표는 그 위치를 가리키는 인덱스다.

---

## 교차 분산 의도 클러스터 (15)

표기: **[TS↔Rust]** = 언어 경계를 넘는 미러, **[TS↔TS]** = 파트를 넘는 TS 내부 분산. "갈라진 지점"은 지금 코드에서 서로 다른 답을 내는 입력 예시다.

### X1. 경로 포함(containment) — [TS↔Rust] · A·B·D

- **위치**
  - TS: `document/path.ts:30 isPathWithin`(SSOT를 자처) · `markdown/local-doc-link.ts:212 isPathInsideRoot` · `markdown/image-search-root.ts:22 rootOwns`(+`:38` deepest-wins) · `workspace/workspace-sidebar.ts:202-204 folderPrefixFor`(`startsWith`) · `sidebar/explorer/explorer-panel.ts:506 showsFolderOf`, `:1057`
  - Rust: `fs/paths.rs:339 is_within_base`(어휘, TS `isPathInsideRoot`의 미러) · `:355 file_target_is_within_base` · `htmlview.rs:276 is_within_armed_root` · `attachment_import.rs:200 picked_source_is_inside_vault` · `remote_host.rs:91 canonicalize_within` · 어휘 게이트 `remote_host.rs:62 resolve_within` ↔ `htmlview.rs:251 is_joinable_remote_rel`
- **이미 갈라진 지점**
  - `("/v", "/v")`: `isPathWithin`은 true, `isPathInsideRoot`는 false(같은 경로 처리가 다름).
  - `("C:\\v\\a.md", "C:\\v")`: `isPathWithin`은 true, `isPathInsideRoot`와 `rootOwns`는 `\`를 모름.
  - 루트 `/a/b`, 문서 `/a/bc/x.md`: `folderPrefixFor`가 `"c/"`를 반환함. `path.ts:15` 주석이 금지한 bare `startsWith` 방식이다.
  - Rust `HtmlViewRoots::resolve_target`(`htmlview.rs:227`)은 검사한 canonical이 아니라 비정규 `candidate`를 반환한다. `canonicalize_within`만 canonical을 반환한다.
- **통합 제안**
  - TS: `document/path.ts`에 `isPathWithin(path, root)`(같은 경로 포함)과 `isStrictlyInside(path, root)`(같은 경로 제외)를 같은 구분자 규칙으로 둔다. `rootOwns`는 삭제하고 `folderPrefixFor`는 `isPathWithin`을 쓴다.
  - Rust: `fs/containment.rs`에 `contained_canonical(root, candidate) -> Option<PathBuf>`와 `is_plain_relative(rel)`를 둔다. htmlview, attachment_import, remote_host가 이 함수를 감싼다.
- **계약 테스트**: `tests/fixtures/path-containment-truth-table.json`(`{path, root, within, strictlyInside}`). TS `isPathWithin`/`isStrictlyInside`와 Rust `is_within_base`가 같은 파일을 읽는다. `remote-host-truth-table.json` 선례를 따른다.

### X2. 경로 정규화·인입 정책 — [TS↔Rust] · A·B·C·D

- **위치**
  - TS 쌍둥이: `document/path.ts:107 normalizePath` ↔ Rust `fs/paths.rs normalize_path`. `path.ts:262-277` ↔ `expand_home` 리터럴 폴백.
  - TS canonicalize 파이프라인의 실패 정책 4종: `main.ts:187-195`(입력 유지) · `:210`(`resolveHomeRoot` 폴백) · `:1058-1064`(`WorkspaceStateError` throw) · `qa/native-smoke-driver.ts:133`(`.catch(() => input)`). 추가 위치: `markdown/local-doc-link.ts:244,251,263`, `workspace/workspace-state.ts:57`(`canonicalRootPath`), `cli-routing.ts:32,37`(이중 정규화), favorite/recent migration.
  - Rust 인입 정책 4종(D-H8): `expand_home`(read_file·listing·hwp) / `normalize_path`만(write_file·create·link_targets·image_resolve·window·bundle) / `fs::canonicalize`(htmlview·epubview·attachment) / 없음(sqlite·`watcher.rs:106,123`·`remote_share.rs:87`·external_open).
  - "이미 등록됨"의 범위: `main.ts:1066`(전 워크스페이스) ↔ `workspace-state.ts:182`(현재 워크스페이스).
- **이미 갈라진 지점**
  - qa 드라이버가 Rust 단계를 건너뛰어 `/var` ↔ `/private/var` 접두 불일치로 글로벌 볼트로 오라우팅됐다(`qa:114-131`에 실측 기록).
  - watch 키는 원문이고 write 키는 정규화된 경로다(U3, 잠재).
  - 등록 범위 차이(U12).
- **통합 제안**
  - TS: `canonicalizeLocalPath(path, onFail: "keep" | "throw")`를 단일 IPC 래퍼로 둔다(우선 `document/local-path-ipc.ts`, 이후 `src/ipc`로 흡수). `isVaultRegistered`는 `WorkspaceStore.findVaultByRoot`로 위임한다.
  - Rust: `fs::paths::host_path(arg)`(= `expand_home`)를 로컬 경로를 받는 모든 커맨드의 단일 인입구로 지정한다. `set_watch`도 이 함수를 쓴다.
- **계약 테스트**: `tests/fixtures/path-normalize-truth-table.json`(`~`, `~user`, `..`, 끝 `/`, `C:\`, UNC, verbatim `\\?\`). TS `normalizePath`와 Rust `normalize_path`/`expand_home_with`가 같은 기대값을 단언한다.

### X3. vault-relative 결합·구분자·basename (원격 와이어 루트 `""`) — [TS↔Rust] · A·B·C·D

- **위치**
  - 결합: `markdown/wikilink.ts:32-45` · `image.ts:40-41` · `attach-image.ts:267` · `document/path.ts:311 resolveOpenPath` · `local-doc-link.ts:260` · `remote-image.ts:114-117` · `main.ts:316 initialBaseDir`(`baseDirForOpenedDocument`의 "재인라인 금지" 위반, C M-6)
  - 구분자·basename 로컬 사본: `document/file-host.ts:177 remoteParentAndName`(`/`만) · `wikilink.ts:19 split("/").pop()` · `extensions/html-viewer/index.ts:158,168` · `code-viewer/language-map.ts:110` · `workspace/workspace-state.ts:177,180` · `workspace-sidebar.ts:203-204` · `sidebar/search/fuzzy.ts:67`
  - Rust: `remote_host.rs:573 vault_relative`(컴포넌트를 `/`로 결합) ↔ `fs/listing.rs:181,270 FileHit.rel_path`(`to_string_lossy`) · `bundle.rs:271-279 relative_to_base`
- **이미 갈라진 지점**
  - baseDir `""` + `a.png`: wikilink와 image는 `a.png`(같은 버그를 각자 고친 흔적), `attach-image`와 `resolveOpenPath`는 `/a.png`(U13).
  - baseDir `"docs/"`: local-doc-link는 끝 `/`를 정리하지 않는다.
  - Windows의 `rel_path` `a\b.md`와 `fuzzy.ts`의 `lastIndexOf("/")`(U2).
- **통합 제안**
  - TS: `document/path.ts`에 `joinUnderBase(baseDir, rel)`(인자 2개, 순수)를 두고 결합 지점 7곳이 사용한다. `basename`/`dirOf`/`extensionOf`는 `api/index.ts`로 순수 재노출해 extensions의 로컬 사본을 제거한다(api-fence 선례 `looksNumeric`).
  - Rust: `fs::paths::slash_relative(root, abs)`로 승격해 listing·bundle·remote_host가 공유한다.
- **계약 테스트**: serde 출력 계약으로 "`FileHit.rel_path`/`vault_relative`에는 `\`가 없다"를 `#[cfg(windows)]` 테스트로 고정한다. TS는 `joinUnderBase` 진리표(`""`, 끝 `/`, 선행 `/`)를 테스트한다.

### X4. 확장자 분류(이미지·동영상·편집 가능·런처·hwp) + MIME — [TS↔Rust] · A·B·D

- **위치**
  - 이미지 8종: TS `markdown/wikilink.ts:50`(정규식) · `sidebar/explorer/file-icons.ts:35 IMAGE_EXTENSIONS` / Rust `fs/link_targets.rs:29 is_image_ext`(wikilink와 테스트로 짝지음) · `bundle.rs:162-169`(**미고정 사본**) · `attachment_import.rs:74`(고정됨)
  - MIME: `remote_host.rs:803 asset_content_type`(이미지 8종) · `htmlview.rs:325 mime_for_path`(**avif/bmp 없음**, epubview가 위임) · `remote_client.rs:508 as_image_mime`
  - 동영상: TS `markdown/embed.ts:27`(mp4|webm|ogg|ogv|mov|m4v)뿐이다. Rust에는 동영상 MIME이 어디에도 없다(합본 확인).
  - 편집 가능 md/txt: `file-icons.ts:57 EDITABLE_TEXT_EXTENSIONS` ↔ `fs/link_targets.rs:43 is_editor_text_ext`(손 동기화) · `.md` 기본 확장자 `wikilink.ts:31` ↔ `bundle.rs:178 resolve_target_path`, `link_targets.rs:58 uses_stem_as_link_name`
  - 런처 거부: `external_open.rs:33 LAUNCHER_EXTENSIONS`(Rust 전용). TS "기본 앱에서 열기"(`explorer-panel.ts:234`, `wikilink.ts:184`, `main.ts:845`)는 사전 판정 없이 호출하고 Rust가 거부한다(합본 확인).
  - hwp: `hwp.rs:122 is_hwp_ext` ↔ `chrome/viewer/hwp-viewer.ts:293`
  - 파싱 함수 변형: `extensionOf(name)` 대 `extensionOfPath(path)`(`language-map.ts:109`), `material-icon-glyph.ts:54`, `excel-viewer/decode-input.ts:14`, `workspace-sidebar.ts:440`
- **이미 갈라진 지점**
  - `x.avif`를 원격 `/read_asset`은 `image/avif`로, htmlview는 `octet-stream`으로 서빙한다(U11).
  - 원격 볼트의 `![[clip.mp4]]`는 로컬 asset URL로 바뀐다(확인 결함 4). 원격 경로로 돌려도 MIME은 `octet-stream`이 된다.
  - `![[a.png]]`를 bundle은 자체 `IMAGE_EXTS`로 판정한다. 테스트로 고정되지 않아 한쪽만 바뀔 수 있다.
  - `.js` 링크를 클릭하면 UI는 "기본 앱에서 열기"를 시도하고 백엔드가 거부 문구를 반환한다(메뉴 비활성 사유로 미리 알리지 않음).
- **통합 제안**
  - Rust: `fs/media.rs`에 `IMAGE_EXTS`, `is_image_ext`, `image_mime(ext)`(remote_host와 htmlview가 공용), `is_launcher_ext`를 둔다.
  - TS: `document/media-kinds.ts`에 `mediaKindOf(name): "editable" | "image" | "video" | "hwp" | "sqlite" | …` dispatch table을 두고, `extensionOf`만 단일 파서로 쓴다.
- **계약 테스트**: `tests/fixtures/extension-kinds.json`(`{ext, kind, mime?, launcher}`). Rust `is_image_ext`·`is_editor_text_ext`·`image_mime`·`is_launcher_ext`와 TS `mediaKindOf`가 같은 표를 단언한다. 09-25 §2.2가 지적한 "file-icons 미고정"도 여기서 해소된다.

### X5. 원격 볼트 판정·로컬전용 거부·원격 문구·SSH 판정 — [TS↔TS, 일부 TS↔Rust] · A·B·C

- **위치**
  - SSOT: `document/document-vault.ts:44 isRemoteVault`, `:65 rowHasLocalPath`
  - 인라인 재판정: `document/session.ts:609-610`(`persistenceKind` 직접 비교, document-vault.ts:41이 금지한 형태), `main.ts:787`(`=== "remote"`)
  - 게이트 함수 4갈래: `isRemoteVault` / `rowHasLocalPath` / `workspace/vault-routing.ts:108 standardLinkRejectionFor` / `chrome/viewer/registry.ts:94 viewerSupportsRemote`
  - 판정 누락: `markdown/embed.ts:81`(확인 결함 4)
  - 거부를 알리는 표면: `main.ts:761 save.set("error")` 대 `:1580 flashStatus`(같은 `REMOTE_VAULT_LOCAL_LINK_MESSAGE`)
  - 문구: `editor.ts:43 REMOTE_READONLY_MESSAGE` ≡ `document-vault.ts:52`(중복 상수) · `local-doc-link.ts:58`("지원하지 않습니다") 대 `remote-unsupported-message.ts:36,40`("아직 지원하지 않습니다") · `chrome/mode-toggle.ts:19`
  - SSH 판정 `startsWith("ssh://")`: `document/file-host.ts:89,146` · `remote-host-field.ts:90,128` · `workspace/remote-vault-dialog.ts:174` · `workspace-sidebar.ts:564`
  - 호스트 문법: 생성은 `settings/remote-share-panel.ts:318-323`(인라인), 파싱은 `remote-host-field.ts` ↔ Rust `remote_client.rs:63 base_url`(진리표 픽스처는 파서만 고정)
- **이미 갈라진 지점**
  - 원격 볼트에서 이미지 임베드는 원격 읽기, 동영상 임베드는 로컬 URL이다.
  - 같은 거부 메시지가 경로에 따라 상태줄 오류 또는 플래시로 나간다.
  - 구조적 한계에 대한 문구가 '아직' 유무로 갈렸다.
- **통합 제안**
  - `document/document-vault.ts`에 `localOnlyRefusal(vault, action: "new-window" | "bundle" | "viewer" | "video-embed" | …): string | null`를 메시지 표와 함께 두고, main에는 `reportRefusal(msg)` 표면 하나만 남긴다.
  - `document/remote-messages.ts`에 `READONLY`, `UNSUPPORTED_STRUCTURAL`, `UNSUPPORTED_YET`를 모으고 editor.ts의 중복 상수는 삭제한다.
  - `document/remote-host-field.ts`에 `isSshHost(host)`, `SSH_HOST_PREFIX`, `clientHostHint(port, bindMode)`(생성 규칙)를 둔다.
- **계약 테스트**: 기존 `remote-host-truth-table.json`에 "생성 → 파싱 왕복" 행을 추가해 `clientHostHint` 출력을 `hostFieldProblem`과 Rust `base_url`이 받아들이는지 고정한다.

### X6. IPC 오류 접두사·오류 문구 매핑 — [TS↔Rust] · A·B·C·D

- **위치**
  - Rust 생산(7개 모듈): `fs/file_io.rs:101,105,117`(`INVALID_PATH:`/`MISSING:`/`CONFLICT:`) · `attachment_import.rs`(`ATTACH_*`/`ROLLBACK_*`, `:513` 자체 재파싱) · `remote_client.rs:189,197,236`(`REMOTE:{:?}`), `:225`, `:439` · `remote_ssh.rs:410,420`(`REMOTE:{:?}`의 두 번째 생산자), `:462,466,481` · `remote_host.rs:410 PORT_IN_USE:` · `remote_share.rs:66 PORT_INVALID:` · `epubview.rs:309,330 "not-zip"`
  - **Debug ↔ serde 이중 인코딩**: 와이어 오류 문자열은 `RemoteStatus`의 Debug 이름(`AuthExpired`)이고, 같은 enum의 serde 표현은 kebab(`auth-expired`, `remote_client.rs:42`)이다.
  - TS 소비: `document/file-host.ts:55-60 classifyRemoteError`(`includes("REMOTE:AuthExpired")`), `:47` kebab 타입 · `main.ts:491 recoveryDetailFor` · `editor.ts:170,245`(`CONFLICT`) · `attach-image.ts:103-121` · `chrome/viewer/file-bytes.ts:69` · `remote-vault-dialog.ts:64` · `settings/remote-share-port.ts:49-72`(같은 분류 2벌, C-H10) · `epub-parse.ts:352`
  - mock: `mocks/tauri-core.ts:346-348`가 kebab→Debug 매핑표를 **세 번째로** 가지고 있다(합본 확인).
  - 오류 객체 → 문자열 `e instanceof Error ? e.message : String(e)`: 저장소 전체 25곳 이상(A 5 · B 20 · C 9, 중복 포함). Tauri 거절 분류 `instanceof Error || typeof === "string"` 4벌(B), "알 수 없는 오류" 3곳(B).
- **이미 갈라진 지점**
  - `RemoteStatus::AuthExpired`를 `Expired`로 이름만 바꾸면 serde 배지(`auth-expired`)는 그대로인데 오류 문자열은 `REMOTE:Expired`가 된다. TS `classifyRemoteError`는 조용히 `unreachable`로 떨어지고 컴파일러와 테스트 모두 잡지 못한다.
  - `SSH_TUNNEL_CONNECTING:`은 TS 소비처가 없다(U14).
  - `PORT_IN_USE:`는 `SSH_TUNNEL_PORT_IN_USE:`의 부분 문자열이다(현재 `startsWith`라 안전하지만 `includes`로 바뀌면 충돌).
  - 오류 정책도 갈렸다. epubview는 kind만 넘기고 TS가 문구를 만든다. hwp, external_open, remote_*는 백엔드가 한국어 문구를 만든다.
- **통합 제안**
  - Rust: `ipc_error.rs`에 `ErrorCode` enum + `prefix()` + `tagged(code, detail)`를 두고, `RemoteStatus::wire_tag()`(Debug 의존 제거, 현재 문자열을 const로 고정)를 추가한다. `rollback_import`는 `Result<(), RollbackError>`를 반환한다.
  - TS: `src/errors.ts`(이후 `src/ipc/errors.ts`)에 `errorMessage(e)`와 `classifyIpcError(e): IpcError`(판별 유니온)를 둔다. `classifyRemoteError`, `classifyShareStartError`, `isConflictError`는 이 함수의 투영이 된다.
- **계약 테스트**: `tests/fixtures/ipc-error-prefixes.json`(`{code, prefix, remoteStatusSerde?}`). Rust 테스트는 `ErrorCode::ALL`을 순회해 prefix를 단언하고, `RemoteStatus`마다 `wire_tag`와 serde 이름 쌍을 단언한다. TS 테스트는 표의 각 prefix를 `classifyIpcError`가 인식하는지 확인하고, mock은 같은 파일에서 매핑을 읽는다.

### X7. hidden / artifact 판정 — [TS↔Rust] · A·C·D (+mock)

- **위치**
  - Rust 숨김: `fs/listing.rs:54 is_hidden_entry`(SSOT) · `:234-264 walk_files_recursive`(재구현) · `fs/link_targets.rs:77`(`starts_with('.')` 원시 사본) · 피어 규칙 `remote_host.rs:835 is_withheld_from_peers`(`.attachments` 예외가 있는 **다른** 규칙이므로 유지)
  - 아티팩트: 판정 `fs/listing.rs:9 is_mermark_artifact`. 생산 `fs/file_io.rs:122`, `attachment_import.rs:231`(`.mermark-tmp.{seq}`), **TS `editor.ts:120`(`.mermark-recovered`)**.
  - mock 사본: `mocks/tauri-core.ts:375-376`(withheld와 아티팩트), `:808,834`(dotfile), `:826 EXCLUDED_SCAN_DIRS`(↔ `listing.rs:161`)
  - TS에는 숨김 규칙이 없고 `showHidden` 인자만 전달한다(A 단서 9). 바람직한 위임 구조다.
  - 사용자 대상 기본 파일명 `main.ts:1046 ${file}.recovered.md`는 아티팩트 필터에 걸리지 않는다(의도 확인 필요, C 단서 16).
- **이미 갈라진 지점**: 현재 판정 결과는 같지만 **생산자와 판정자 사이에 컴파일 타임 연결이 없다.** `editor.ts:120`의 접미사를 `.mermark-rescue`로 바꾸면 탐색기, 피커, 원격 피어(`remote_host.rs:837`)에 복구 파일이 노출되고, mock은 옛 규칙으로 계속 숨긴다(골든 테스트는 통과함).
- **통합 제안**
  - Rust: `fs/artifacts.rs`에 `TMP_MARKER`, `RECOVERED_SUFFIX`, `tmp_sibling_name(base, seq)`, `is_mermark_artifact`를 두고, `fs/listing.rs`에 `is_listed(name, show_hidden)`을 둔다(classify, walk, link_targets가 공유).
  - TS: `RECOVERED_SUFFIX`는 생성 상수에서 import한다.
- **계약 테스트**: Rust `is_mermark_artifact(&format!("a.md{RECOVERED_SUFFIX}"))`와 `tmp_sibling_name` 왕복. TS는 `editor.ts`의 recoveryPath 빌더 출력이 `tests/fixtures/wire-constants.json`의 접미사로 끝나는지 단언한다. mock도 같은 픽스처를 읽는다.

### X8. Promise 메모 캐시 + 실패·빈 결과 eviction — [TS↔TS] · A·B

- **위치**: `document/file-host.ts:87`(sshTunnelReady, reject면 제거), `:210`(listingCache, TTL 8s + reject면 제거), `:312`(remoteHostCache, 무제한) · `markdown/remote-image.ts:43-50`(reject), `:91-97`(null + reject) · `markdown/image.ts:229-246`(null) · `workspace/workspace-sidebar.ts:43-82 badgeCache/badgeProbes`(listingCache를 따라 만들었다고 명시) · `sidebar/explorer/file-icons.ts:112-134` · `extensions/code-viewer/index.ts:146` · TTL 단일 슬롯 `markdown/wikilink-complete.ts:75-97 loadTargetsOnce`(이름은 Once인데 5s TTL)
- **이미 갈라진 지점**: 제거 조건이 3종이다. 원격 이미지가 일시 오류로 `null`을 반환하면, `:91` 캐시는 다음 렌더에서 다시 시도하고 `:43` 캐시는 reject일 때만 지우므로 다시 시도하지 않는다. "실패는 캐시하지 않는다"는 규칙이 캐시마다 다르게 해석된다.
- **통합 제안**: `bounded-cache.ts`를 `src/markdown/`에서 루트 leaf(`src/bounded-cache.ts`, `pan-zoom.ts` 선례)로 옮긴다. 그리고 `memoPromise(cache, key, make, { evictIf?, ttlMs? })`를 추가한다(reject 제거가 기본). workspace와 sidebar가 markdown을 import하는 역방향 의존도 생기지 않는다.

### X9. 볼트 라우팅 폴백·선택·종류 정책 — [TS↔TS] · A·B·C

- **위치**
  - 3단 폴백 `x ?? currentVault() ?? global`: `main.ts:726,771,805,1187,1194,1201`. SSOT인 `workspace/vault-routing.ts:95 resolveTargetVault`를 우회한다.
  - 선택 커밋 `selectVault + setRoutedVault`: `main.ts:1084-1085,1118-1119,1127-1128,1138-1139`, `toggleExplorerVault:1071`. A `document/session.ts:408 openInWindow`도 routedVault를 설정한다.
  - Query 이름에 Command가 붙은 함수(⭐): `workspace/cli-routing.ts:31,36 routeCliFile/routeCanonicalPath`, `vault-selection.ts:39 routeDocumentPath`
  - 현재 볼트 대체 규칙 3종: `workspace-state.ts:125-132 readState` / `:261-268 commit` / `:241-242 unregisterVault`
  - 종류 정책: main switch 3벌(`:361,392,1015`)과 인라인 비교 5곳(`:237,787,813,947,1081`). 이는 `vault-routing.ts:14-22`의 "switch+assertNever" 정책 위반이다. `vault-routing.ts:10,81` 자신도 `===`를 쓴다. `session.ts:609`, 글로벌 탭의 세션 한정 규칙이 `vault-tabs.ts:40,85`와 `vault-routing.ts:58`에 있다.
  - 현재 워크스페이스 조회 `find(workspaceId === currentWorkspaceId)` 5벌(B)
- **이미 갈라진 지점**: 워크스페이스 `[A(영구, lastSelected), R(원격)]`에서 A를 해제하면 결과가 경로마다 다르다.
  - 메모리: `unregister` 규칙에 따라 `lastSelectedPermanent = R`, `current = R`
  - 저장본: `commit` 규칙에 따라 정제됨
  - 재로드 후: `readState` 규칙(`lastSelectedPermanent ?? GLOBAL`)

  세 규칙이 서로 다른 현재 볼트를 낸다(U1). 이 저장소가 6번 겪었다고 기록한 vault leak 계열이 정확히 이 폴백의 어긋남이다.
- **통합 제안**
  - `workspace/vault-routing.ts`에 `explorerRootFor(vault, ctx)`, `localAnchorDirFor(vault, folder)`, `isGlobalVault`/`isPermanentVault`를 둔다.
  - `workspace/vault-selection.ts`에 `VaultSelection.commit(vault)`와 `currentVaultOrGlobal()`을 둔다.
  - `resolveCliRoute(state, path)`(순수) + `selectRoute(store, route)`(명령)로 나눈다. `routeDocumentPath`는 `selectDocumentVault`로 바꾼다.
  - `WorkspaceStore`에 `currentWorkspaceOf`, `lastSelectedPermanentAfter`, `fallbackCurrentVaultId`를 두고 네 지점이 공유한다.
- **계약 테스트**: TS 내부 문제다. "볼트 집합 × 제거 대상 × 경로(메모리/저장/재로드)" 진리표 테스트를 먼저 봉인하고, `main-wiring.test.ts` 68건을 회귀 가드로 쓴다.

### X10. 뷰어 수명주기·페이지 밴드·iframe 줌·크기 상한 — [TS↔TS, 일부 TS↔Rust] · B·A·D

- **위치**
  - 로딩→본문/오류 9벌: hwp, epub, sqlite, excel, docx, pdf, html, code, image(B-H1). `{close, onClose}` 핸들 9벌, `ensureStyleInjected` 5벌.
  - near-viewport `"200% 0px"` 3벌, 페이지 폭 lockstep(`hwp-viewer.ts:43` ↔ `pdf-viewer/index.ts:131`, 주석으로만 동기화), `hwp-pages.ts:47 isNearViewport`(이름과 달리 `isIntersecting`만 반환)
  - iframe 줌: `html-viewer/index.ts:179,208` ↔ `epub-viewer.ts:140`("SAME"이라고 약속)
  - 크기 상한(TS↔Rust): Rust `remote_host.rs:745,826`(20 MiB ×2), `hwp.rs:22`(100 MiB), `epubview.rs:86,107` ↔ TS `chrome/viewer/file-bytes.ts:56-79`("20MB" 문구 하드코딩), `epub-viewer.ts:235 armErrorMessage`(크기 분기 중복), `code-viewer/source-text.ts:23`, `mocks/tauri-core.ts:411`
- **이미 갈라진 지점**
  - 오류 형식이 3종이다. pdf는 `${name}: ${message}`, epub은 접두사 없음, 나머지는 "문서를 열 수 없습니다:".
  - `closed` 가드가 4/9개 뷰어에만 있다. hwp, excel, pdf, sqlite, html은 닫힌 뒤 도착한 오류를 분리된 노드에 쓴다(대체로 무해).
  - epub은 줌 identity 빠른 경로가 없다(U4).
- **통합 제안**
  - `chrome/viewer/viewer-lifecycle.ts`: `viewerStatusContent`, `showViewerError`(접두사와 err→text 단일 규칙), `viewerHandleOf(shell)`
  - `chrome/viewer/page-band.ts`: `observeNearViewport`, `NEAR_VIEWPORT_MARGIN`, `pageFitWidth`, `isUntracked`
  - `applyIframeZoom(iframe, scale, { fitHeight })`, `injectStyleOnce(id, css)`
  - 위 순수 함수는 api facade로 재노출한다.
  - 오류 정책은 "백엔드는 kind, 프론트가 문구"(epubview 모델)로 통일하고 hwp부터 적용한다.
- **계약 테스트**: 크기 상한은 X15의 상수 픽스처로 고정한다(문구 `20MB`는 상수에서 생성).

### X11. 문서 창 빌더·창 라벨·`?file=` URL — [TS↔Rust] · D·(B/C 소비)

- **위치**
  - 빌더 3벌: `lib.rs:608-618`, `window.rs:27-32`, `single_instance.rs:460-465`
  - URL 2벌: `lib.rs:574-583` ↔ `window.rs:16`(`index.html?file=` + `urlencoding::encode`)
  - 라벨 규칙: `single_instance.rs:103-105 is_document_window` ↔ **`cli_control.rs:352` 인라인**. 생산자는 `window.rs:15 w{seq}`이고 `"main"` 리터럴은 8곳에 있다.
  - TS 소비: `workspace/reload-handoff.ts:21 params.get("file")`, `main.ts:913`(자기 라벨로 `cli-open-request`/`cli-share-request` 대상 지정), `welcome-pane.ts:1`(`?file=` 없음 = 환영 화면)
- **이미 갈라진 지점**: 현재는 같은 답을 낸다. `lib.rs:118` doc은 "size lives here once"와 "two paths"를 약속하지만 실제 적용 지점은 3곳이다. 라벨 접두사를 바꾸면 `cli_control`의 인라인 사본만 옛 규칙을 유지하고, CLI share 요청 배달 대상에서 새 창이 빠진다.
- **통합 제안**: `window.rs`를 완결한다(09-25 단계 1 잔여). `MAIN_LABEL`, `document_window_label(seq)`, `is_document_window`(이동), `document_url(file)`, `document_window(manager, label, file)`를 둔다.
- **계약 테스트**: `tests/fixtures/document-url.json`(공백, `+`, `#`, 한글, `%` 포함 경로). Rust `document_url` 출력을 TS `readDocumentReloadHandoff`로 왕복해 원래 경로가 복원되는지 단언한다.

### X12. 모달 셸(포커스 트랩·inert·포커스 복원·Esc/백드롭) — [TS↔TS] · A·C

- **위치**: `document/recovery-modal.ts:20,35-73,116-131` · `document/conflict/conflict-modal.ts:54-72,121-158`(주석 "mirrors settings/panel/modal.ts") · `settings/panel/modal.ts:190-235`
- **이미 갈라진 지점**(합본 확인): Esc 정책이 3변종이다.
  - conflict: capture + `stopImmediatePropagation`
  - recovery: capture, 전파는 막지 않음
  - settings: capture, `tryDismissNested()`(중첩 해제)를 먼저 묻고, 전파는 막지 않음

  `trapFocus` 반환형이 void와 boolean으로 갈렸고, 모달은 `.editor-host`를 전역 쿼리하고 settings는 `editorHost()` 주입을 쓴다.
- **통합 제안**: `chrome/modal-shell.ts`에 `mountModal({ label, onDismiss, tryDismissNested? }): { modal, close }`를 둔다. Esc 전파 정책은 한 곳에서 결정한다(권장: 모달이 떠 있으면 전역 단축키로 전파하지 않음).

### X13. 재시작 전 버퍼 확정 (부분 적용 계약) — [TS↔TS] · A·B·C → 확인 결함 1

- **위치**: 규칙 `update/auto-install.ts:3-19,34-47`(유일) · 위반 `settings/panel/version-pane.ts:312`, `chrome/status-bar/update.ts:104` · 의존 `document/session.ts commitBeforeSwitch` · 진입 `update/update-flow.ts:157 installAndRelaunch`
- **이미 갈라진 지점**: 편집 중 미저장 상태에서 푸터 "설치하고 재시작"을 누르면 커밋 없이 relaunch한다. 버전 패인 경로는 `setPhase("downloaded")`가 깨운 auto-install의 `commitBeforeSwitch`와 경쟁한다.
- **통합 제안**: `installAndRelaunch(confirmDurable: () => Promise<boolean>)`로 전제를 시그니처에 올린다. 또는 main이 `setRelaunchGuard(session.commitBeforeSwitch)`를 1회 주입해 update-flow 내부에서 강제한다. 세 경로 모두 같은 함수를 지나게 된다. `tests/main-update-autorestart.test.ts`에 수동 경로 2개 케이스를 추가한다.

### X14. 테마 프리셋 열거·키→CSS 변수·폴백 — [TS↔TS(+CSS)] · C·A

- **위치**
  - 프리셋 가드 3벌: `settings/app.ts:27`, `theme-schema.ts:403`, `panel/color-inspector.ts:110`
  - 이중 타입: `theme.ts:3 Theme` ↔ `theme-schema.ts:8 PresetName`
  - 토글 라벨이 순환 순서를 복제: `theme.ts:45-51` ↔ `app.ts:64 nextPreset`
  - 키→변수: `theme-schema.ts:528-591 themeToVars` ↔ `panel/theme-preview.ts:80-171 THEME_TARGETS`(둘 다 SSOT를 자처)
  - 하드코딩 폴백 `#1a1300`/`#fff3a3`(`theme-preview.ts:120`) ↔ `theme-schema.ts:226 HIGHLIGHT_INK`
  - A: `markdown/mermaid-widget.ts:119`가 앱 테마를 DOM(`data-theme`)에서 읽는다(sink 주입 원칙의 예외, `:157` 주석과 모순). init 옵션도 2벌이다(06-13 미해소).
- **이미 갈라진 지점**: `nextPreset` 순서를 바꾸면 툴팁과 aria-label이 사실과 다른 다음 프리셋을 안내한다. `HIGHLIGHT_INK`를 바꾸면 미리보기 폴백만 옛 색으로 남는다.
- **통합 제안**: `theme-schema.ts`에 `PRESETS`, `isPresetName`, `PRESET_LABEL`, `COLOR_VAR`를 두고 export한다. themeToVars, THEME_TARGETS, toggle, parse가 여기서 파생한다. mermaid에는 테마를 인자로 주입한다(`initMermaid(m, theme)`).

### X15. 와이어 수치·이름 상수 — [TS↔Rust] · A·B·D (+mock)

- **위치**
  - 원격 asset 20 MiB: Rust `remote_host.rs:745,826` ↔ TS `file-bytes.ts`, `source-text.ts:23`, `remote-unsupported-message.ts:33`, mock `:411`
  - 이미지 스캔 깊이 12: `fs/image_resolve.rs:53` ↔ `markdown/image-search-root.ts:15`
  - 공유 포트 1024–65535: `remote_share.rs:64`, `remote_ssh.rs:132` ↔ `document/share-port-rules.ts:30,37,46`
  - `EXCLUDED_SCAN_DIRS`: `listing.rs:161` ↔ mock `:826`
  - 첨부 폴더 `.attachments`: `attachments.rs:25,29` ↔ `attach-image.ts:80,84`
  - 이벤트 이름: `file-changed`, `file-unavailable`, `cli-open-request`, `cli-share-request`, `remote-share-changed`
  - Rust 내부의 토큰 헤더 리터럴 3벌: `remote_host.rs:475`, `remote_client.rs:246,410`
- **이미 갈라진 지점**: 확인된 불일치는 없다. 모두 주석("change together")으로만 동기화돼 있다.
- **통합 제안 / 계약 테스트**: Rust `const`를 한 모듈(`wire.rs`)에 모으고, 09-25 단계 12의 생성기로 `src/ipc/wire-constants.generated.ts`를 내보낸다. 생성기를 쓰기 전까지는 `tests/fixtures/wire-constants.json`을 Rust와 TS 테스트가 함께 읽는다. X6·X7·X4의 픽스처와 같은 계층이다.

---

## 🟡 Medium / 🟢 Low

전체 표는 파트 보고서를 참조한다. 아래는 합본 관점에서 따로 짚을 항목이다.

| 파트 | medium / low | 링크 | 합본에서 짚을 항목 |
|---|:-:|---|---|
| A | 14 / 7 | [part-A §Medium/Low](intent-review-2026-10-18/part-A.md#-medium) | `conflict-recovery.ts:55 detect`(⭐, 조회 이름인데 기록) · `session.ts:408 openInWindow`(부수효과 4개, X9) · `dropFences` `~~~`(U8) · `breadcrumbSegments` UNC 루트가 `\`가 됨 · 각주 라벨 파서 바이트 동일 2벌 · 실패 표시 문구에 영어와 한국어 혼재 |
| B | 13 / 9 | [part-B §Medium/Low](intent-review-2026-10-18/part-B.md#-medium--low) | 늦은 결과 가드 4종 세대 카운터 + 4종 `closed`(X10) · 사이드바 셸 사본 3→5 · `registry.ts:148 listViewers`가 doc과 달리 live 배열 반환 · DOM 헬퍼 `el` 10벌(A의 `path-prompt.ts:47`까지 11벌) · 문서 주석 부패 |
| C | 14 / 6 | [part-C §Medium/Low](intent-review-2026-10-18/part-C.md#-medium--low) | main 단축키 핸들러 블록(09-25 `app-commands.ts` 미이행) · `resolveExternalChange`(09-25 `external-change-flow.ts` 미이행) · on/off 설정 5벌 · `api/index.ts` read-only 투영 2벌 · 주석 drift(`clampFontScale` doc 0.8–2.0 대 실제 MAX 3.0 등) |
| D | 10 / 12 | [part-D §Medium/Low](intent-review-2026-10-18/part-D.md#-medium--low) | **`watcher.rs:200 read_external_change`(test 전용)가 프로덕션 판정을 순서만 바꿔 재구현했다. characterization 테스트가 프로덕션이 아니라 사본을 검증한다** · `FileHit.rel_path`(U2) · `remote_host` 핸들러 블로킹 IO(09-25 단계 14 잔존) · `IGNORE_PEER_SHOW_HIDDEN=false` 극성 · `connect_with` 수동 `release_claim` ×4 → RAII |

---

## 이전 리뷰 대비 해소 / 잔존

| 출처 | 항목 | 상태 |
|---|---|---|
| 06-13 | `applySvg` God, 펜스 본문 추출, 바운드 캐시, `setup()` 클로저, `fitHeight`, 클릭→소스 이중 배선, reserve-last-height | ✅ 해소 (A) |
| 06-13 | `table-widget.toDOM` 셀 루프 중복, mermaid `initialize` 옵션 2벌 | ❌ 잔존 (A, X14) |
| 06-13 | `main.ts boot` | ⚠️ 1,508줄. 조합 루트 예외는 인정하나 볼트 규칙 인라인이 남음 (C, X9) |
| 07-03 | 경로 좌측 생략 라벨 | ✅ 해소. ⚠️ `welcome-pane.ts:100` 세 번째 소비자가 공용 라벨 미사용 (B) |
| 07-03 | `basename` twin | ✅ 해소. ⚠️ 구분자 로컬 사본이 새로 6곳 생김 (B·A, X3) |
| 07-03 | CJK 플랭킹 트립와이어, 즐겨찾기 계열 | ✅ 해소·소멸 |
| 07-03 | `flashStatus` | 잔존·변화 없음(테스트로 봉인됨) (C) |
| 09-25 | `commands.rs` → `fs/*` + 얇은 어댑터, `remote_host` 역의존, `crypto_token.rs`, 열기 트랜잭션 4벌 → `session.openFromPanel` | ✅ 해소 |
| 09-25 | `window.rs` 이동(단계 1 일부) | ⚠️ 부분 잔존 (X11) |
| 09-25 §2.2 | 경로 봉쇄 4벌, 아티팩트 접미사, 롤백 오류 문자열 왕복 | ❌ 잔존 (X1, X7, X6) |
| 09-25 §2.2 | 이미지 확장자 Rust↔TS | ❌ 잔존·**악화**(Rust 내부 미고정 사본 `bundle.rs`, MIME 표 2벌 추가 확인) (X4) |
| 09-25 단계 9 | `app-commands.ts`, `external-change-flow.ts` 추출 | ❌ 미이행 (C M-2, M-4) |
| 09-25 단계 11–13 | `src/ipc` 타입 클라이언트, Rust→TS 생성기, 테스트 mock 이관 | ❌ **미착수**(합본 확인: `src/ipc/` 없음). X4·X6·X7·X11·X15가 이 부재 탓에 손 동기화로 남아 있다 |
| 09-25 단계 14 | `remote_host` 핸들러 `spawn_blocking` 통일 | ❌ 잔존 (D) |
| 09-25 §5-3 | 파사드 read-only 뷰 일반화 | ❌ 미수행 (C M-11) |

---

## 아키텍처 제안

1. **와이어 계약 단일 원천 계층을 재가동한다(09-25 단계 11–12).** X4(확장자·MIME), X6(오류 접두사), X7(아티팩트 접미사), X11(`?file=`·라벨), X15(수치 상수)는 모두 "Rust 리터럴 ↔ TS 리터럴 ↔ mock 리터럴"의 3중 손 복사다. Rust 쪽을 `const`/`enum`(`ipc_error.rs`, `fs/media.rs`, `fs/artifacts.rs`, `wire.rs`)으로 먼저 모은다. 생성기를 만들기 전 중간 단계로는 **공유 JSON 픽스처 + 양쪽 테스트**(`remote-host-truth-table.json` 선례)를 쓴다. 이 한 계층으로 교차 클러스터 15개 중 5개가 닫히고, 경로 진리표(X1·X2·X3)도 같은 방식으로 고정할 수 있다.
2. **볼트 경로를 "해석(Query) → 선택(Command) → 원격 게이팅"의 단일 파이프로 만든다.** X9와 X5는 같은 데이터 경로의 두 단면이다. 어느 볼트인지 정하고, 그 볼트로 전환하고, 그 볼트가 원격이면 로컬 전용 동작을 거부하는 흐름이다. 지금은 `main.ts`, `workspace/*`, `document/session.ts`, `document-vault.ts`가 이 흐름을 나눠서 인라인한다. `vault-routing.ts`(순수 해석), `vault-selection.ts`(유일한 선택 명령), `document-vault.ts`(`localOnlyRefusal`)로 책임을 고정하면 CQS ⭐ 1건과 vault leak 계열의 재발 자리가 함께 사라진다.
3. **"부분 적용된 계약"을 소유자가 강제하게 한다.** 확인된 결함 1·3과 X10·X12는 같은 유형이다. 규칙이 주석이나 다른 파일에 있고 호출부가 자율로 지킨다. 다음과 같이 구조로 강제한다.
   - 재시작 확정: `installAndRelaunch(confirmDurable)`
   - 구독 해제: `bindRow`
   - 뷰어 수명주기: 셸이 소유
   - 모달: `mountModal`

   아울러 api-fence에 "상태 없는 순수 함수는 facade로 재노출할 수 있다"는 정책을 명문화한다. extensions의 로컬 사본(X3·X4·X10)은 이 정책이 없어서 생겼다.

---

## 다음 단계 권장

이번 검토에서 **분산된 의도가 파트 합계 47건, 파트를 가로지르는 클러스터 15개** 나왔다(임계 ≥3). CQS ⭐ 2건 중 1건(`routeCliFile`/`routeDocumentPath`)은 `workspace/` 한 모듈에 몰려 있다. 함수 단위를 넘어선 **아키텍처 차원의 경로 설계 문제**다.

→ **`/architecture-review`** 실행을 권장한다. 다음 순서로 진행한다.

1. **첫 번째: X9 볼트 라우팅 + X5 원격 게이팅**(main.ts ↔ workspace ↔ document/session ↔ document-vault). vault leak이 6회 기록된 경로이고 U1(메모리와 재로드 불일치)이 걸려 있다. 데이터 무결성에 가장 가깝다. 범위는 "경로 → 볼트 해석 → 선택 → 원격이면 거부"의 단일 경로 설계다.
2. **두 번째: 와이어 계약 계층**(X6 → X4 → X7 → X15 → X11, 그리고 X1·X2 진리표). 09-25 단계 11–13을 재계획하는 형태로 진행한다. 범위는 `src/ipc` 도입 순서와 생성기 대 공유 픽스처 중 선택이다.
3. **세 번째: 뷰어 셸과 api-fence 경계**(X10, X3·X4의 extensions 사본).

확인된 결함 1–4는 아키텍처 리뷰와 독립적으로 바로 고친다(각각 테스트 1–2개). X12 모달 Esc와 A-H6 이스케이프, A-H8 fold는 Golden Master를 먼저 확보한 뒤 진행한다.

---

## 실행 우선순위 Top 7 (버그 → 데이터 무결성 → 분산 의도)

1. **[버그·데이터 유실] 수동 설치 재시작의 커밋 누락**(확인 결함 1, X13): `installAndRelaunch(confirmDurable)` 또는 `setRelaunchGuard`로 세 경로 모두 `commitBeforeSwitch`를 거치게 한다. `main-update-autorestart.test.ts`에 수동 2경로를 추가한다.
2. **[버그·거짓 설정] 충돌 정책 no-op**(확인 결함 2): 제품 결정이 먼저다. 덮어쓰기를 구현하려면 `makeAutosave`에 `getPolicy`를 주입하고, 철회하려면 UI를 숨기고 `setConflictPolicy`와 doc 주석 3곳을 삭제한다.
3. **[버그·누수] 설정 컨트롤 구독 해제 누락**(확인 결함 3): `bindRow(r, setting, reflect)`로 4개 렌더러를 통일한다. 회귀 테스트는 "N번 전환 후 reflect 1회"다.
4. **[버그·원격 동등성] 원격 동영상 임베드**(확인 결함 4): 당장은 `embed.ts`에 `isRemoteVault` 분기를 넣고 `localOnlyRefusal("video-embed")` 안내를 붙인다. 원격 재생 지원 여부(MIME, 20 MiB 상한)는 별도로 결정한다.
5. **[데이터 무결성] 볼트 라우팅 폴백·선택 단일화**(X9): U1 진리표 테스트를 봉인한 뒤 진행한다. `resolveTargetVault` 6곳 치환, `VaultSelection.commit` 4곳, `fallbackCurrentVaultId`/`lastSelectedPermanentAfter`, `route*` Query/Command 분리.
6. **[데이터 무결성·보안] 경로 계약 진리표**(X1 + X2): 공유 픽스처로 `isPathWithin`/`isStrictlyInside` ↔ `is_within_base`, `normalizePath` ↔ `normalize_path`를 고정한다. `folderPrefixFor` 교정, `host_path` 단일 인입(watcher 포함, U3), Rust `contained_canonical` 승격까지 포함한다.
7. **[분산 의도·와이어 계약] IPC 오류 접두사 단일 원천**(X6): `ipc_error.rs` `ErrorCode` + `RemoteStatus::wire_tag` + `ipc-error-prefixes.json` 픽스처(Rust, TS, mock 공용)와 TS `classifyIpcError`/`errorMessage`. 같은 메커니즘으로 X4(확장자·MIME) → X7(아티팩트) → X15 순서로 확장한다.

---

## 자가 검증

- [x] **버그 예방 또는 도메인 명확성**: 확인 결함 4건과 클러스터 11개가 "이미 갈라진 입력 예시"를 갖는다. 나머지(X7·X11·X15)는 생산자와 판정자의 drift 예방이다.
- [x] **매개변수 3개 이하**: `joinUnderBase(base, rel)`, `contained_canonical(root, cand)`, `memoPromise(cache, key, make, opts)`는 opts를 객체로 묶어 실질 3개다. `localOnlyRefusal(vault, action)`, `installAndRelaunch(confirmDurable)`, `mountModal(opts)`, `document_window(m, label, file)`.
- [x] **이름 1–2단어**: `isStrictlyInside`, `hostPath`/`host_path`, `mediaKindOf`, `classifyIpcError`, `wire_tag`, `is_listed`, `bindRow`.
- [x] **영향 범위**: 각 클러스터에 파일:라인을 열거했다. TS↔Rust 클러스터는 mock 사본까지 포함했다.
- [x] **False Positive**: 파트별 FP(팩토리, 렌더 순차, 선언 모음, htmlview↔epubview 의도적 중복, `is_withheld_from_peers`의 다른 규칙, epub-parse zip `/` 구분자)는 클러스터에 넣지 않았다. hwp `"superseded"`는 기각했다.
- [x] **분산 구현을 모두 식별했는가**: 파트 교차 단서 99건(A 18 · B 10 · C 23 · D 48)을 대조했다. 각 파트가 ❓로 남긴 TS 미러 중 런처 확장자, 동영상 MIME, 아티팩트 mock 사본, REMOTE mock 매핑표, Esc 정책은 합본 단계에서 grep으로 확인해 반영했다.
