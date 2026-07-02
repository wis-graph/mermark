# mermark 기능 계층 문서

> mermark의 전체 기능을 아키텍처 계층별로 구조화한 단일 참조. **기능을 추가/변경하면 이 문서를 갱신한다**(mermark-dev 파이프라인 Phase 6 규약). 정체성: 볼트 무게 없이 단일 마크다운 파일을 CLI로 즉시 열어 Obsidian급 품질로 편집·렌더하는 경량 에디터.
>
> 기준 버전: v0.4.0 · 최종 갱신: 2026-07-02

---

## L1 · 백엔드 계층 (Rust / Tauri)

### 1.1 파일 IO
- **read_file / write_file** — 원자적 쓰기(temp + rename)로 부분 저장 손상 방지.
- **conflict guard** — read 시 mtime baseline 기록 → write 시 디스크 변경 감지(`CONFLICT:`), `.mermark-recovered` 복구.
- **fs 와처** — `notify` 크레이트로 **열린 파일 1개만** watch(`watch_file`/`unwatch_file`, 경로 전환 시 슬롯 교체). 외부 변경 시 `file-changed` 이벤트(`{text,mtime}`) emit. 자기 쓰기 self-trigger 방지(mtime baseline `record_self_write`/`is_self_write`).
- **path_exists** — 위키링크 대상 존재 확인.
- **list_dir** — 한 디렉토리 레벨을 `Vec<DirEntry>`(`{name, path, is_dir}`)로 반환하는 레이지 리스팅. 폴더 먼저·이름순 정렬, 숨김(`.`)·아티팩트 제외, read-only. 없는/막힌 폴더는 graceful `Err`(빈 폴더는 `[]`). 파일 탐색기가 폴더 클릭마다 한 레벨씩 호출.
- **resolve_image** — 리터럴 경로에서 못 찾은 이미지를 baseDir 가두리(≤3 depth) 안에서 read-only 재귀 스캔해 basename 일치 파일의 절대경로를 반환(`Option<String>`). 경로 탈출/심링크 가드, 확장자 화이트리스트, 깊이·엔트리 상한. 못 찾으면 `None`(graceful).
- **경로 정규화** — `normalize_path`(`..` collapse) + `expand_home`(선두 `~`/`~/` 홈 확장, `~user` 과확장 금지).

### 1.2 CLI / 창
- **단일파일 열기** — CLI 인자로 .md 1개 즉시 마운트(반볼트 정체성).
- **누락 파일 자동 생성** — 없는 경로 인자 시 Vim식 생성.
- **`--right`** — 창을 화면 우측 절반에 배치.
- **bundle CLI / `bundle_doc`** — 위키링크 추종해 문서를 LLM 컨텍스트로 패키징(부모/절대 경로 포함).

### 1.3 보안 설정
- **CSP** — `img-src`/`font-src`(asset:·data:·https:), `media-src`(로컬 비디오), `frame-src`(youtube-nocookie/youtube), `connect-src`(ipc:·asset:), `object-src 'none'`.
- **assetProtocol scope** — `["**"]` + `requireLiteralLeadingDot:false`(숨김폴더 이미지 로드).
- **capabilities** — 최소 권한 셋.

---

## L2 · 프론트 인프라 계층 (CodeMirror 6 / TypeScript)

### 2.1 라이브프리뷰 파이프라인
- **플러그인 레지스트리** — 기능별 모듈(`InlineFeature` / `BlockFeature`) 등록 구조.
- **conceal / reveal** — 마크다운 마커를 숨기고(conceal) 캐럿이 줄에 들어오면 원문 노출(reveal). core `revealed()`가 단독 소유.
- **데코 경로 분리** — 인라인=ViewPlugin, 블록 위젯=StateField(render-smoke 불변식).
- **블록 진입** — 키보드(기하 모션)·클릭(`clickEntry`)으로 블록 위젯 안으로.

### 2.2 에디터 상태
- **세션 영속** — 파일별 scroll/cursor 위치 저장·복원.
- **모드 / Vim compartment** — 런타임 재구성(edit↔read, vim on/off).
- **drawSelection** — EditorState 셀렉션 레이어(Vim 비주얼·멀티커서 가시화, `--selection-bg` 토큰).
- **경로 열기 re-point** — `openInWindow` + `current` SSOT로 새 파일을 현재 창에 재마운트(baseDir/filePath/autosave/세션 전수 갱신).
- **저장/리로드 자동화** — 자동저장(타이핑 멈춤 200ms debounce, 수동 저장 버튼 없음). 외부 변경 감지 시 미저장 없으면 자동 리로드, **충돌(미저장+외부변경)이면 VSCode식 diff 모달**(라인 LCS, 로컬 유지 / 외부 채택 선택). 저장 상태 인디케이터로 신호.

### 2.3 설정 SSOT
- **`defineSetting` 프리미티브** — 의존성 없는 단일 출처 설정.
- **sink 구독** — 설정 변경 → sink가 DOM/에디터에 반영(theme/mode/vim/fontScale/conflictPolicy/panZoom 등).
- **단축키 레지스트리** — 전역 앱 단축키의 단일 SSOT(`src/shortcuts/`). `actions.ts`(rebindable action 선언, 순수 데이터·핸들러 미포함) + `keys.ts`(`e.code` 물리키 기반 chord 직렬화 `Mod+B`, mac ⌘⇧ / other Ctrl+Shift 표시, 한글 레이아웃 대응) + `registry.ts`(단일 전역 capture 디스패처, `effectiveBinding`=사용자 override ?? 기본값, `findConflict` 충돌 감지). 흩어진 하드코딩 키맵(구 ⌘E/⌘±/⌘⇧C·CM `Mod-e`)을 전부 수렴 — 앱-chord 하드코딩 keydown 0. `keybindingsSetting`(override분만 localStorage 저장)이 SSOT, 사용자 재정의는 설정 "단축키" 카테고리에서.
- **최근 문서 SSOT** — `recentDocsSetting`(`string[]` localStorage, 재시작 유지). `openInWindow` 단일 지점에서 `pushRecent`(dedup→최근순→상한 15), 없는 경로는 `pruneMissing`으로 정리.
- **줌 가드(ZOOM GUARD)** — `.cm-content`/`.cm-line`에 font-size 직접 금지(async 위젯 0-height 붕괴 방지), `.cm-line` em만.

---

## L3 · 렌더링 계층 (마크다운 요소)

### 3.1 인라인 요소
- **강조** — bold(`**`), italic(`*`), code(`` ` ``), strikethrough(`~~`) — **테이블 셀 안에서도 렌더**(inline-render.ts).
- **하이라이트** — `==mark==`(GFM 확장).
- **링크 / 위키링크** — `[text](url)`, `[[target]]`(피커·자동완성·active/missing/asset).
- **풋노트 참조** — `[^name]` 위첨자 칩.
- **인라인 수식** — `$…$`(KaTeX).

### 3.2 블록 요소
- **헤딩** — 위계 스케일 + 폴딩 + 포커스 라인.
- **리스트** — Workflowy식 불릿 + fold halo, task 체크박스(줌 연동).
- **블록쿼트 / 콜아웃** — `> [!type]` 13종(아이콘·색·커스텀 제목, 별칭, note 폴백).
- **코드 블록** — 펜스 블록 위젯, 언어 토큰 conceal, fold.
- **테이블** — GFM 정렬(`:--:`), 셀 인라인 마크.
- **구분선** — `---`(중간), 상단 `---`는 frontmatter.
- **프론트매터** — 문서 최상단 `---…---` YAML → 키-값 2열 표(scalar, conceal/reveal).
- **블록 수식** — `$$…$$`(KaTeX).

### 3.3 임베드 / 위젯
- **Mermaid** — 펜스 다이어그램 SVG, CSS-transform 팬/줌, 더블클릭 토글, 플로팅 리셋, fold, 자연 크기.
- **이미지** — 로컬(asset protocol·숨김폴더)·원격·data. `![]()` / `![[…]]`. 리터럴 경로 로드 실패 시 **재귀 검색 폴백**(`resolve_image` invoke → 발견 경로로 src 교체, `이미지 재귀 검색` 설정 on일 때만, 리터럴 우선·정상 경로 비용 0).
- **비디오 / 유튜브** — `![[url]]`/`![](url)`: 유튜브=썸네일 facade→클릭 시 nocookie iframe, 비디오파일=`<video>`.

---

## L4 · 편집·상호작용 계층

### 4.1 모드
- **edit / read 토글** — ⌘E, 설정 영속.
- **Vim** — `@replit/codemirror-vim`, 비주얼 셀렉션 가시화.

### 4.2 입력 보조
- **줌** — ⌘ +/−/0(본문 스케일, 뷰포트 한도).
- **괄호 자동 닫기** — `[`→`[]`, `[[`→`[[]]`.
- **마크업 래핑** — 선택 위 `=`(==highlight==), `*`(italic→bold→both).
- **붙여넣기 링크화** — 선택 + URL paste → `[선택](URL)`.
- **위키링크 자동완성** — `[[` 입력 시 파일 피커.

### 4.3 네비게이션
- **풋노트 양방향** — 참조↔정의 클릭 이동 + ⌘hover 정의 프리뷰(forward 비동기 위젯 재center).
- **위키링크 이동** — 대상 열기(현재 새 창), Alt=원문 편집.
- **경로 열기** — 푸터 왼쪽 버튼 → 인라인 경로 입력 → 현재 창에 문서 전환(vim `:e` 감).
- **목차보기 (Outline/TOC)** — 상태바 버튼 토글 → **좌측 사이드바**(`.outline-aside`, 탐색기와 같은 사이드바 셸). 헤딩 위계 트리, 항목 클릭 시 해당 헤딩으로 이동(footnote와 공유하는 `jumpTo` 랜딩). 문서 변경 시 디바운스 실시간 갱신. 인라인 마크 정규화(`**B**`→`B`, 링크/위키링크는 표시 텍스트). **탐색기와 상호배타**(좌측 사이드바는 한 번에 하나 — 목차 열면 탐색기 닫힘, `closeOtherSidebars` 단일 코디네이터). 사이드바는 에디터 측정 트리 밖(줌 가드).
- **문서 네비게이션 히스토리 (Back/Forward)** — `⌘[` 이전 문서 / `⌘]` 다음 문서. 브라우저식 선형 back/forward 스택(`src/history/nav-history.ts` 순수, 세션 한정 in-memory·비영속). `openInWindow` 단일 지점에서 방문 기록(back/forward 이동은 포인터만 이동 — 재기록 안 함, 무한루프 차단). 최근문서(MRU 목록)와 **별개 개념**(히스토리 = 방문 스택+포인터). 빈 스택 no-op, 삭제된 경로 graceful(스킵+prune), 상한 50. *알려진 트레이드오프: CodeMirror 기본 `⌘[`/`⌘]`(indent)는 전역 디스패처가 우선.*
- **최근 문서 (Recent Documents)** — 상태바 탐색기 다음 버튼(`history` 아이콘) 토글 → 최근 연 문서 목록 패널(outline 패턴, lazy·측정트리 밖). 항목(basename + 흐린 경로) 클릭 → 현재 창 열기(`openInWindow` 재사용). 최근순·중복제거·상한 15, **재시작 후 유지**(localStorage). 없는 경로 클릭은 graceful(에러 표시 + 목록에서 제거).
- **파일 탐색기 (File Explorer)** — 상태바 좌 네비 버튼 또는 **⌘B**로 토글하는 **좌측 사이드바**(`.workspace` flex row: aside ∣ 에디터, 상태바는 폭 전체). 현 문서 폴더 루트의 **레이지 트리**. 폴더 **클릭 시에만** 자식을 `list_dir`로 읽어 펼침(경로별 캐시, 재펼침 재호출 없음) — **hover로는 아무 것도 안 열림**(WCAG 1.4.13). 최상단 `..` **단일클릭/Enter → 상향**(부모가 새 루트, 캐시 clear+재구축). **WAI-ARIA Tree 키보드**: ↑↓(포커스 이동) →(닫힌폴더 열기/열린폴더 첫자식) ←(열린폴더 닫기/부모) Enter(활성화) Home/End, roving tabindex(트리 전체 tab stop 1개). **포커스≠선택 분리**: 화살표는 포커스 링만 이동, Enter/클릭만 파일 활성화(단일선택). 파일 클릭/Enter → **현재 창 열기**(main의 `openInWindow`+`commitBeforeSwitch` 재사용, `activateItem` 단일 경로). 비-md 파일은 회색(`.is-nonmd`)+no-op. **폴더/파일 아이콘 구분**: 폴더는 `--accent` 틴트 + 열림/닫힘 글리프 스왑(`folder`↔`folder-open`, `aria-expanded` 동기), 파일은 **확장자별 아이콘**(md=file-text·이미지=file-image·json=braces·코드=file-code·그 외=generic file, `file-icons.ts` 순수 룩업) + `--muted`. 아이콘=타입 / 색=openability 직교(비-md는 확장자 아이콘 유지+dim). `role=tree/treeitem/group`·`aria-expanded/selected/level`. **헤더 = 현재 루트 폴더 경로**(정규화된 실제 폴더 — `normalizePath`가 백엔드 `normalize_path`와 동일 규칙으로 `..`/`.` 해소해 리터럴 `..` 누적 방지, `renderTree` 단일 지점에서 canonical화. 홈은 `~/…/` prefix로 축약하되 **최소 마지막 폴더명은 항상 표시**, title/aria-label엔 절대경로 원문; `..`/문서전환 시 갱신). 자식은 폴더 **아래 세로 계단 들여쓰기**(`.explorer-label` 행 wrapper + `--level`). **토글 버튼 아이콘 = 열림/닫힘 상태 스왑**(`panel-left-open`↔`panel-left-close` + `aria-expanded`/`aria-controls`, 목차와 공유 `renderSidebarButton`). 목차와 상호배타. 기본 닫힘, 루트·열림 상태는 ephemeral(P0 무설정) — 문서 전환 시 baseDir로 리셋. 사이드바는 에디터 측정 트리 밖(줌 가드, 데코 0개), 테마 var만(다크/라이트/클로드 일관). *P1+ 범위 밖: 파일 작업(new/rename/delete)·다중선택·검색·드래그·폭 드래그·열림 영속·fs와처 실시간·OS기본앱 열기.*

---

## L5 · UI 크롬 계층
- **상태바** — **좌 네비 그룹**: 탐색기(⌘B) · 최근문서 · 경로열기 · 목차. **중앙**: 커서/위치 · 저장 상태 인디케이터(저장됨/저장중/충돌, 수동 저장·리로드 버튼 없음). **우측**: 편집/리더 모드 토글(⌘E) · 테마 토글(다크→라이트→클로드 순환, moon/sun/palette 아이콘) · 설정. Lucide 아이콘.
- **경로 열기 인라인** — 경로열기 버튼 클릭 시 **상태바 자체가 입력칸으로 전환**(`.path-editing` — 아래 공간 안 열림, 상태바 높이 유지). 경로 입력 → Enter로 현재 창 열기(`resolveOpenPath` 재사용), ESC/blur/제출 시 상태바 원복. 없는 경로는 인라인 에러.
- **단축키 설정** — 설정 패널 "단축키" 카테고리(신규 `keybind` 컨트롤 kind). 각 action 행 = 라벨 + 현 바인딩 표시 + 키 캡처(재정의) + 개별 리셋, 상단 전체 리셋. 캡처 시 충돌 감지(중복 chord 거부 + 인라인 경고), Esc 취소. 사용자 override는 재시작 후 유지. 기본 바인딩: ⌘E(모드)·⌘B(탐색기)·⌘=(및 ⌘+ 별칭)/⌘-/⌘0(줌)·⌘⇧C(번들 복사)·⌘[(이전 문서)·⌘](다음 문서), 그 외 action(최근문서·목차·경로열기·Vim·저장)은 기본 미바인딩(사용자가 부여 가능). ⌘+ 줌인은 물리키 정규화(Shift+Equal→Equal)로 ⌘=와 동일 취급(브라우저 parity).
- **설정 패널** — 테마 프리셋 드롭다운(다크/라이트/클로드 3종 select), 테마 비주얼 에디터(스워치 그리드 + JSON), 모드/Vim/타이포그래피.
- **테마 프리셋** — 빌트인 3종: 다크 · 라이트 · **클로드**(Anthropic 에디토리얼 — 크림 캔버스 `#faf9f5` + 잉크 본문, 코랄 link/code, 시스템 세리프 헤딩). 프리셋 선택은 JSON 테마와 코히런스 유지(`loadPreset`/`syncJsonToPreset`).
- **타이포그래피** — DESIGN.md(ElevenLabs) 타입 시스템, Pretendard 번들, 헤딩 스케일·트래킹. 클로드 테마는 헤딩에 시스템 세리프(`--font-heading`) 적용, 본문은 산스 유지.

---

## 곁가지 / 미구현 (정체성상 제외 or 후순위)
- **볼트/멀티노트/파일트리/탭/그래프/백링크/태그/동기화** — 반볼트 정체성 위배(→ Obsidian 영역).
- **플러그인 시스템** — 내부 레지스트리(`InlineFeature`/`BlockFeature`)는 있으나 외부 공개 API 미구현. (개선 로드맵 M3 — `docs/IMPROVEMENT_MASTER_PLAN.md`)
- 상세 로드맵: `docs/IMPROVEMENT_MASTER_PLAN.md`(새 기능) · `docs/REFINEMENT_MASTER_PLAN.md`(폴리시).
