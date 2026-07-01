# mermark 기능 계층 문서

> mermark의 전체 기능을 아키텍처 계층별로 구조화한 단일 참조. **기능을 추가/변경하면 이 문서를 갱신한다**(mermark-dev 파이프라인 Phase 6 규약). 정체성: 볼트 무게 없이 단일 마크다운 파일을 CLI로 즉시 열어 Obsidian급 품질로 편집·렌더하는 경량 에디터.
>
> 기준 버전: v0.4.0 · 최종 갱신: 2026-07-01

---

## L1 · 백엔드 계층 (Rust / Tauri)

### 1.1 파일 IO
- **read_file / write_file** — 원자적 쓰기(temp + rename)로 부분 저장 손상 방지.
- **conflict guard** — read 시 mtime baseline 기록 → write 시 디스크 변경 감지(`CONFLICT:`), `.mermark-recovered` 복구.
- **fs 와처** — `notify` 크레이트로 **열린 파일 1개만** watch(`watch_file`/`unwatch_file`, 경로 전환 시 슬롯 교체). 외부 변경 시 `file-changed` 이벤트(`{text,mtime}`) emit. 자기 쓰기 self-trigger 방지(mtime baseline `record_self_write`/`is_self_write`).
- **path_exists** — 위키링크 대상 존재 확인.
- **list_dir** — 한 디렉토리 레벨을 `Vec<DirEntry>`(`{name, path, is_dir}`)로 반환하는 레이지 리스팅. 폴더 먼저·이름순 정렬, 숨김(`.`)·아티팩트 제외, read-only. 없는/막힌 폴더는 graceful `Err`(빈 폴더는 `[]`). 파일 탐색기가 hover마다 한 레벨씩 호출.
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
- **목차보기 (Outline/TOC)** — 푸터 버튼 토글 → 헤딩 위계 트리 팝오버. 항목 클릭 시 해당 헤딩으로 이동(footnote와 공유하는 `jumpTo` 랜딩). 문서 변경 시 디바운스 실시간 갱신. 인라인 마크 정규화(`**B**`→`B`, 링크/위키링크는 표시 텍스트). 패널은 에디터 측정 트리 밖(줌 가드).
- **파일 탐색기 (File Explorer)** — 푸터 버튼 토글 → 현 문서 폴더 루트의 **레이지 트리** 팝오버. 폴더 hover 시 자식을 `list_dir`로 읽어 펼침(120ms 디바운스 + 경로별 캐시, 재-hover 재호출 없음), 폴더 클릭은 펼침/접힘 토글. 최상단 `..` **더블클릭 → 상향**(부모가 새 루트, 캐시 clear+재구축). 파일 클릭 → **현재 창 열기**(main의 `openInWindow`+`commitBeforeSwitch` 재사용). 비-md 파일은 회색+클릭 no-op. 루트는 ephemeral(설정 아님) — 문서 전환 시 baseDir로 리셋. 패널은 에디터 측정 트리 밖(줌 가드, 데코 0개).

---

## L5 · UI 크롬 계층
- **상태바** — 경로열기 · 목차 · 탐색기(좌 네비 그룹) · 모드 토글 · 커서/위치 · 저장 상태 인디케이터(저장됨/저장중/충돌, 수동 저장·리로드 버튼 없음) · 테마 토글(다크→라이트→클로드 순환, moon/sun/palette 아이콘) · 설정(우). Lucide 아이콘.
- **설정 패널** — 테마 프리셋 드롭다운(다크/라이트/클로드 3종 select), 테마 비주얼 에디터(스워치 그리드 + JSON), 모드/Vim/타이포그래피.
- **테마 프리셋** — 빌트인 3종: 다크 · 라이트 · **클로드**(Anthropic 에디토리얼 — 크림 캔버스 `#faf9f5` + 잉크 본문, 코랄 link/code, 시스템 세리프 헤딩). 프리셋 선택은 JSON 테마와 코히런스 유지(`loadPreset`/`syncJsonToPreset`).
- **타이포그래피** — DESIGN.md(ElevenLabs) 타입 시스템, Pretendard 번들, 헤딩 스케일·트래킹. 클로드 테마는 헤딩에 시스템 세리프(`--font-heading`) 적용, 본문은 산스 유지.

---

## 곁가지 / 미구현 (정체성상 제외 or 후순위)
- **볼트/멀티노트/파일트리/탭/그래프/백링크/태그/동기화** — 반볼트 정체성 위배(→ Obsidian 영역).
- **플러그인 시스템** — 내부 레지스트리(`InlineFeature`/`BlockFeature`)는 있으나 외부 공개 API 미구현. (개선 로드맵 M3 — `docs/IMPROVEMENT_MASTER_PLAN.md`)
- 상세 로드맵: `docs/IMPROVEMENT_MASTER_PLAN.md`(새 기능) · `docs/REFINEMENT_MASTER_PLAN.md`(폴리시).
