# mermark 기능 계층 문서

> mermark의 전체 기능을 아키텍처 계층별로 구조화한 단일 참조. **기능을 추가/변경하면 이 문서를 갱신한다**(mermark-dev 파이프라인 Phase 6 규약). 정체성: 볼트 무게 없이 단일 마크다운 파일을 CLI로 즉시 열어 Obsidian급 품질로 편집·렌더하는 경량 에디터.
>
> 기준 버전: v0.5.9 · 최종 갱신: 2026-07-12

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
- **CJK 인접 플랭킹 완화** — 한국어 조사 등 CJK 글자가 볼드 마커에 바로 붙을 때(`**"New Policy"**를`, `**…(\`user_id\`)**와`) CommonMark 표준 플랭킹 판정으로는 실패하던 `**` 볼드를 성립시킨다. CJK 인접에서만 적용하는 의도적 CommonMark 표준 이탈(`**` 볼드 한정, `*`/`***`/`_` 비대상). 라이브프리뷰 데코 레이어(`live-preview/features/cjk-bold.ts`)에서만 동작 — outline/read-mode 렌더러(`inline-render.ts`)는 미반영(별도 정규식 렌더러라 M7 스코프 밖).
- **하이라이트** — `==mark==`(GFM 확장).
- **링크 / 위키링크** — `[text](url)`, `[[target]]`(피커·자동완성·active/missing/asset). **자동 URL 감지(autolink)** — 맨손 `https://…`/`www.…`/이메일과 `<https://…>` 모두 클릭 가능한 링크로 렌더(GFM Autolink는 기존에 이미 파싱되고 있었고, 이번에 `features/autolink.ts`가 렌더·클릭을 얹었다). **`[[https://…]]`/`[[https://…|별칭]]`(위키링크 외부 URL)** — 파일 해석(`wikilinkPath`)·`path_exists`·`create_markdown_file`을 전혀 타지 않고 바로 외부로 연다(옵시디언 습관으로 URL을 위키링크에 붙였을 때 쓰레기 파일이 생기던 결함 제거). **외부 열기 단일 출구** — 마크다운 링크/위키링크/autolink/표 셀·설정판 링크 넷이 `open-external.ts`의 `isExternalUrl`(화이트리스트: `http(s)/mailto/tel`)+`openExternal` 하나를 공유(실패 시 조용한 무반응 대신 에러 표식+title). **표 셀 링크** — 표 안 `[text](url)`/맨손 URL도 이제 렌더·클릭된다(`inline-render.ts`의 `matchLinkToken`); 표 안 `[[wikilink]]`/상대경로는 링크 스타일로 보이되 클릭은 기존처럼 블록 진입(원문 노출)으로 폴스루(스코프 밖, 후속 과제).
- **풋노트 참조** — `[^name]` 위첨자 칩.
- **인라인 수식** — `$…$`(KaTeX).

### 3.2 블록 요소
- **헤딩** — 위계 스케일 + 폴딩 + 포커스 라인. **연속 헤딩 클러스터 여백**(`continuesHeadingCluster`(heading.ts, 빈 줄 skip 상한 2) → `cm-heading-cont` 라인 클래스 — 직전 비공백 라인이 헤딩이면 상단 `padding-top` 축소(.7em→.15em), 문단 뒤 헤딩은 불변. em·padding만, 줌가드).
- **리스트** — Workflowy식 불릿(작게, `.30em`) + fold halo, task 체크박스(줌 연동, 체크 시 `--accent` 채움 — 3테마 브랜드색 일관, 네이티브 파랑 아님). **wrap hanging indent + 인덴트 가이드**(통합 라인 데코 `list-line.ts` — `listItemDepth` 조상 카운트로 `cm-list-line cm-list-d{n}` 라인 클래스, 블록 위젯 아님). 자동줄바꿈 시 이어지는 줄이 텍스트 열에 hanging 정렬(depth별 `padding-inline-start` + 음수 `text-indent` 상쇄, em·줌 라이드), 중첩 깊이별 은은한 세로 가이드선(`--border` 저채도 background). specificity `.cm-editor .cm-line.cm-list-d{n}`로 CM baseTheme 이김. 줌가드(font-size 무접촉). **가이드 x는 부모 불릿 도트 중심에 정렬**(`--guide-col: calc(var(--bullet-size)/2)`, `.cm-bullet`과 가이드가 `--bullet-size` 공유 — 리터럴 오프셋 대신 `--list-step`·`--bullet-size` 파생이라 마커 기하 변경에도 재발 없음, CDP 실측 delta≈0).
- **블록쿼트 / 콜아웃** — `> [!type]` 13종(아이콘·색·커스텀 제목, 별칭, note 폴백).
- **코드 블록** — 펜스 블록 위젯, 언어 토큰 conceal, fold. **모던 모노 스택**(`--font-mono`: ui-monospace→SF Mono→…, 단일 토큰이 코드 5개소 소유). **자동 줄바꿈 + 행잉 인던트**(per-row `.cm-code-row` 렌더 — `codeHangCh(line)`가 행별 선행 들여쓰기 폭을 계산해 wrap된 이어짐 줄이 코드 들여쓰기 열에 정렬(padding+음수 text-indent, 리스트 행잉 패턴 재사용), 빈 소스 행은 `<br>`로 높이 보존, 가로스크롤 안전망 유지).
- **테이블** — GFM 정렬(`:--:`), 셀 인라인 마크.
- **구분선** — `---`(중간), 상단 `---`는 frontmatter.
- **프론트매터** — 문서 최상단 `---…---` YAML → 키-값 2열 표(scalar, conceal/reveal).
- **블록 수식** — `$$…$$`(KaTeX).

### 3.3 임베드 / 위젯
- **Mermaid** — 펜스 다이어그램 SVG, CSS-transform 팬/줌, 더블클릭 토글, 플로팅 리셋, fold, 자연 크기. **앱 테마 동기화**(`mermaidPaletteSource`/`mermaidThemeVariables`(mermaid-widget.ts, 순수 query)가 테마 SSOT(`themeJsonSetting.colors`)에서 `theme:"base"` themeVariables를 파생 — 노드/텍스트/보더가 3테마(라이트·클로드·다크) 팔레트를 따르고 `edgeLabelBackground=bg`로 엣지 라벨이 선을 안 가림. 테마 전환·스와치 편집 시 재베이크. 순백 `surface`는 노드 fill로 캔버스에서 떠 보여 `mermaidNodeFill`이 `bg`와 반 섞음(`#ffffff→#fafafa`, 팔레트-성질 규칙 — 이미 틴트된 클로드·다크는 passthrough)).
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
- **리스트 Tab/Shift-Tab 들여쓰기** — 커서가 리스트 항목(불릿·숫자)에 있을 때 Tab=한 단계 중첩(4-space)·Shift-Tab=해제(`list-indent.ts` 리스트 인식 커스텀 핸들러 — `indentMore`/`indentLess` 위임). 리스트 밖 Tab은 기존 동작(포커스 이동) 보존. `[[` 완성 팝업 열림 시 Tab=완성 수락(indent 아님). `indentUnit` 4-space(ordered 리스트 중첩 성립).

### 4.3 네비게이션
- **풋노트 양방향** — 참조↔정의 클릭 이동 + ⌘hover 정의 프리뷰(forward 비동기 위젯 재center).
- **위키링크 이동** — 대상 열기(현재 새 창), Alt=원문 편집. **`[[#헤딩]]`(앞 `#`, 파일부 없음)은 현재 문서 내 헤딩으로 이동**(옵시디언식 — `sameFileHeadingAnchor` 판정 → `findHeadingByText`로 collectHeadings 매칭(대소문자·마커 무시) → `jumpTo` 랜딩, 파일 열기 아님·IPC 0). 없는 헤딩은 graceful no-op. `[[#^block]]`(블록 참조)·`[[file#헤딩]]`(크로스파일)은 현행 유지(범위 밖).
- **경로 열기** — 푸터 왼쪽 버튼 → 인라인 경로 입력 → 현재 창에 문서 전환(vim `:e` 감).
- **목차보기 (Outline/TOC)** — 상태바 버튼 토글 → **좌측 사이드바**(`.outline-aside`, 탐색기와 같은 사이드바 셸). 헤딩 위계 트리, 항목 클릭 시 해당 헤딩으로 이동(footnote와 공유하는 `jumpTo` 랜딩). 문서 변경 시 디바운스 실시간 갱신. 인라인 마크 정규화(`**B**`→`B`, 링크/위키링크는 표시 텍스트). **탐색기와 상호배타**(좌측 사이드바는 한 번에 하나 — 목차 열면 탐색기 닫힘, `closeOtherSidebars` 단일 코디네이터). 사이드바는 에디터 측정 트리 밖(줌 가드).
- **문서 네비게이션 히스토리 (Back/Forward)** — `⌘[` 이전 문서 / `⌘]` 다음 문서. 브라우저식 선형 back/forward 스택(`src/history/nav-history.ts` 순수, 세션 한정 in-memory·비영속). `openInWindow` 단일 지점에서 방문 기록(back/forward 이동은 포인터만 이동 — 재기록 안 함, 무한루프 차단). 최근문서(MRU 목록)와 **별개 개념**(히스토리 = 방문 스택+포인터). 빈 스택 no-op, 삭제된 경로 graceful(스킵+prune), 상한 50. *알려진 트레이드오프: CodeMirror 기본 `⌘[`/`⌘]`(indent)는 전역 디스패처가 우선.*
- **최근 문서 (Recent Documents)** — 상태바 탐색기 다음 버튼 토글 → **좌측 사이드바**(`.recent-aside`, 탐색기·목차와 같은 `.sidebar-aside` 셸 공유 — 공유 폭 sash·토글 아이콘 스왑·상호배타). 최근 연 문서 목록, 항목(basename + **좌측 생략 경로** `<bdi>`+`direction:rtl` — 즐겨찾기와 동일 패턴, 뒤쪽 폴더명/파일명 노출) 클릭 → 현재 창 열기(`openInWindow` 재사용). 최근순·중복제거·상한 15, **재시작 후 유지**(localStorage). 없는 경로 클릭은 graceful(에러 표시 + 목록에서 제거). **탐색기·목차와 3-way 상호배타**(좌측 사이드바는 한 번에 하나 — `closeOtherSidebars` 단일 코디네이터).
- **폴더 즐겨찾기 (Favorite Folders)** (M4 도입 → **M5 재구조화**) — 별도 사이드바 뷰가 아니라 **탐색기 사이드바 하단 분리 섹션**(`.explorer-favorites` `<section>`, 상=파일 트리 `flex:1` / 하=즐겨찾기 `max-height:40vh`+자체 스크롤 — 트리와 **동시 상시 노출**). 사용자가 큐레이션하는 폴더 핀 목록. **추가/해제 = 탐색기 트리 폴더 행 우측 별 토글**(`.explorer-star`, 3-state: 평소 흐림 → hover 진함 → favorited 채워진 별 `--accent` 상시 우선; 파일·`..` 무별). 별 클릭은 `toggleFocusedFolderFavorite`로 `favoriteFoldersSetting` 토글(폴더 열기와 무충돌 — 위임 click에서 `findStarButton` early-return, 키보드 **Space** WCAG 2.1.1, `tabindex=-1`·`aria-pressed`로 roving tabindex 불변식 무손상). 항목(basename + **좌측 생략 경로** `<bdi>`+`direction:rtl` — 뒤쪽 폴더명 노출) **클릭 → `explorer.jumpToRoot(abs)`**(M3 재사용), 항목별 **X 제거**. **최근문서(MRU)와 별개 도메인**: 즐겨찾기 = 추가 순서 유지·중복제거·**cap 없음·자동 prune 없음**(외장/언마운트 폴더 큐레이션 보호 — `src/favorites/favorite-folders.ts` 순수 `pushFavorite`/`removeFavorite`/`isFavorite`/`reorderFavorite`). **드래그 앤 드롭 순서 변경**: 항목을 pointer 드래그로 재정렬(4px 임계로 클릭과 구분 — 드래그 아니면 기존 jump/별/X 그대로, sash식 DRAG=프리뷰/RELEASE=커밋, `pickDropIndex`+`dropIndexToFinalIndex` 순수 계산으로 하향 드롭 인덱스 시프트 보정), 키보드 대체 **Alt+↑/↓**(포커스 복원). 순서는 `favoriteFoldersSetting`에 즉시 영속(main 단일 writer). SSOT `favoriteFoldersSetting`(`string[]` localStorage, **재시작 유지**) **단일 subscribe sink가 두 뷰(하단 섹션 + 트리 별) 동시 갱신**(손 fan-out 0). **⌘⇧B**(`favorites.toggle`) = 탐색기 열고 즐겨찾기 섹션으로 스크롤·포커스(`revealFavorites`→주입된 `focusFavorites`, 별도 상단 토글 버튼 없음). 섹션·별은 에디터 측정 트리 밖(줌 가드), 테마 var만. 신규 IPC command 0(frontend 단독).
- **파일 탐색기 (File Explorer)** — 상태바 좌 네비 버튼 또는 **⌘B**로 토글하는 **좌측 사이드바**(`.workspace` flex row: aside ∣ 에디터, 상태바는 폭 전체). 현 문서 폴더 루트의 **레이지 트리**. 폴더 **클릭 시에만** 자식을 `list_dir`로 읽어 펼침(경로별 캐시, 재펼침 재호출 없음) — **hover로는 아무 것도 안 열림**(WCAG 1.4.13). 최상단 `..` **단일클릭/Enter → 상향**(부모가 새 루트, 캐시 clear+재구축). **WAI-ARIA Tree 키보드**: ↑↓(포커스 이동) →(닫힌폴더 열기/열린폴더 첫자식) ←(열린폴더 닫기/부모) Enter(활성화) Home/End, roving tabindex(트리 전체 tab stop 1개). **포커스≠선택 분리**: 화살표는 포커스 링만 이동, Enter/클릭만 파일 활성화(단일선택). 파일 클릭/Enter → **현재 창 열기**(main의 `openInWindow`+`commitBeforeSwitch` 재사용, `activateItem` 단일 경로). 비-md 파일은 회색(`.is-nonmd`)+no-op. **폴더/파일 아이콘 구분**: 폴더는 `--accent` 틴트 + 열림/닫힘 글리프 스왑(`folder`↔`folder-open`, `aria-expanded` 동기), 파일은 **확장자별 아이콘**(md=file-text·이미지=file-image·json=braces·코드=file-code·그 외=generic file, `file-icons.ts` 순수 룩업) + `--muted`. 아이콘=타입 / 색=openability 직교(비-md는 확장자 아이콘 유지+dim). `role=tree/treeitem/group`·`aria-expanded/selected/level`. **헤더 = 정적 "탐색기"**(M3에서 경로 표시는 푸터 브레드크럼으로 이관 — 경로 단일 출처화). 루트 경로 정규화(`normalizePath`, `renderTree` 단일 지점 canonical화)는 유지되고 그 값이 `onRootChange`로 브레드크럼에 흐른다. 자식은 폴더 **아래 세로 계단 들여쓰기**(`.explorer-label` 행 wrapper + `--level`). **토글 버튼 = 뷰별 정체성 아이콘**(탐색기 `folder` · 최근 `history` · 목차 `list-tree`, 공유 `renderSidebarButton(button, iconName, …)`) — 아이콘은 고정, 열림/닫힘은 `aria-expanded` + `.chrome-btn[aria-expanded="true"]` active 하이라이트(VSCode 액티비티바식, 정체성=아이콘/상태=active). 목차·최근과 상호배타. **하단 즐겨찾기 섹션**(M5)이 트리 아래 세로 분할로 상시 동반(트리 `flex:1` / 즐겨찾기 `max-height:40vh`), 폴더 행 우측 별 토글로 즐겨찾기 추가·해제(→ 폴더 즐겨찾기 항목). 기본 닫힘, 루트·열림 상태는 ephemeral(P0 무설정) — 문서 전환 시 baseDir로 리셋. 사이드바는 에디터 측정 트리 밖(줌 가드, 데코 0개), **전용 강한 대비 팔레트**(`--sidebar-bg/fg/muted/accent/border`, 탐색기·목차·최근이 공유하는 `.sidebar-aside` 셸 전체 적용 — 라이트·클로드는 **어두운** 사이드바/밝은 캔버스 반전, 다크는 반전(눈부신 밝은 사이드바) 대신 **에디터 캔버스(`#131110`)보다 한 단계 밝은 웜 다크 사이드바(`#211d1a`)** — 극성 계약은 `EXPECTED_POLE_IS_LIGHT`(sidebar-contrast.test.ts)가 잠금, `var(--bg)` 8%(≤20% pole-dominant 불변식) 앵커 혼합이라 커스텀 JSON 테마가 어떤 `--bg`를 넣어도 사이드바 텍스트 가독성 보장). *P1+ 범위 밖: 파일 작업(new/rename/delete)·다중선택·검색·드래그·열림 영속·fs와처 실시간·OS기본앱 열기.*

---

## L5 · UI 크롬 계층
- **셸 레이아웃 — 사이드바 풀하이트 레일** — `#app`은 `.workspace` 하나만 자식으로 갖는 flex column, `.workspace`는 창 전체 높이를 차지하는 flex row(사이드바 레일 좌 + `.main-column` 우). 사이드바(`.sidebar-aside` 3종 중 열린 것)가 창 top~bottom 꽉 찬 세로 레일이 되고, 헤더(`.title-bar`)·푸터(`.status-bar`)는 `.main-column` 안(에디터 컬럼 폭)에만 존재 — VSCode/Slack식 셸. 레일 최상단에 `.sidebar-top-strip`(36px, `createSidebarTopStrip`, sticky + 불투명 `--sidebar-bg`)이 mac 신호등 겹침을 회피 + 창 드래그 영역을 제공. 레일 열림 시 `.title-bar.mac`의 신호등 인셋은 형제 셀렉터(`.sidebar-aside:not([hidden]) ~ .main-column > .title-bar.mac`)로 `.5em`으로 되돌아가고(신호등이 레일 위로 이동), 닫힘 시 기존 78px 인셋 유지. **M6: 좌측 커맨드 그룹 레일 rehome** — 탐색기·최근·목차·경로열기 4버튼이 `createLeftCommandGroup`으로 `.left-command-group` 래퍼(자체 drag-region) 하나에 묶여, 레일이 열리면 그 레일의 `.sidebar-top-strip`으로 통째로 이동하고(레일 전환 시 새 strip으로 재이동) 전부 닫히면 타이틀바로 복귀한다. 트리거는 aside `hidden` 속성 관측 MutationObserver 1개(`installLeftGroupRehoming`) — 패널(탐색기/최근/목차) 코드는 무접촉(shell → panel 단방향 의존 유지). 이동 규칙은 `rehomeLeftCommandGroup`(strip 있으면 레일, 없으면 타이틀바의 `.title-spacer` 앞) 하나로 수렴, 이동으로 끊긴 focus는 자동 복원. 레일 안에서는 `.sidebar-top-strip .chrome-btn`이 `--sidebar-*` 토큰으로 재도색(SIDEBAR CONTRAST RULE). `.editor-host`·CM 측정 트리·`sash.ts` 로직·설정(SSOT)은 무접촉.
- **커스텀 타이틀바** (상단바 재설계 M1) — 네이티브 데코 대신 커스텀 상단 바(`.title-bar`, `.main-column` 상단, `data-tauri-drag-region` 드래그). **mac**: `WebviewWindowBuilder`에 Overlay+hidden_title(신호등 유지·타이틀 숨김, Rust `with_document_chrome` — main·wikilink 두 창 공유) + 좌측 신호등 인셋(`--traffic-light-inset`). **win/linux**: `decorations(false)` + 우측 커스텀 최소/최대/닫기 버튼 3종(`getCurrentWindow().minimize/toggleMaximize/close`, capability 3종). `isTauriRuntime` 가드로 dev:browser no-op. 신규 IPC command 0(창 API는 코어). 줌가드(측정트리 밖). **상단 크롬 버튼**(M2 이주, M6 재편성): 좌측 `.left-command-group`(탐색기(⌘B) · 최근 · 목차 · 경로열기) + drag spacer + 우측 `편집/리더 모드(⌘E) · 테마 토글 · 설정`(win/linux 창버튼 앞). 순서는 `arrangeTitleBar` 단일 계약(`{leftGroup, mode, theme, settings}`, `insertBeforeWindowControls`로 창버튼 항상 마지막). 경로열기 인라인 입력은 `.title-bar.path-editing`으로 전환(편집 중 창버튼 재노출) — 버튼 재클릭 시 **토글로 닫힘**(`keepEditingFocusOnTogglePress`가 버튼 mousedown preventDefault로 입력 blur→click 재활성 경합을 차단, Esc/Enter 닫기와 일관). **M6 디자인 폴리시**: 심리스 크롬(`.title-bar`/`.status-bar` 배경이 `--surface`가 아닌 `--bg` — 헤더/푸터가 캔버스와 같은 색, 두 톤 대비는 사이드바 레일이 전담) + 크롬 버튼 7개(탐색기·최근·목차·경로열기·모드·테마·설정) 전부 아이콘 온리(`.chrome-btn.icon-only`, 라벨은 시각적으로 숨김 — `display:none`이 아닌 clip 기반 visually-hidden이라 접근성 이름은 유지되고, `aria-label`+`title` 툴팁으로 발견성 보장). 활성 뷰(`aria-expanded="true"`)는 타이틀바 스코프에서 `--accent` 워시, 레일 스코프(`.sidebar-top-strip .chrome-btn`)에서 `--sidebar-accent` 워시로 분리. 크롬 버튼 클래스 `.chrome-btn`. *상단바 재설계 M1~M4 완료(타이틀바·토글상단·브레드크럼 푸터·즐겨찾기) 후 **M5에서 즐겨찾기를 탐색기 하단 섹션으로 재구조화**(별도 토글 버튼 제거, ⌘⇧B는 탐색기 열고 섹션 포커스), **M6에서 좌측 그룹 레일 rehome + 심리스/아이콘온리 디자인 폴리시** — `docs/TOPBAR_REDESIGN_PLAN.md`.*
- **상태바 (footer)** — 하단 = **브레드크럼(좌, 풀폭) + 본문 너비 슬라이더 + 커서/위치 + 저장 상태 인디케이터(우)**(저장됨/저장중/충돌, 수동 저장·리로드 버튼 없음). 토글·모드·테마·설정은 상단 타이틀바. `arrangeStatusBar` 단일 계약(순서: breadcrumb·spacer·width·save·pos).
- **본문 너비 슬라이더 (footer)** — `readingWidthSetting`(설정 › 타이포그래피 › 본문 너비와 동일 SSOT, `--measure` 구동)을 즉시 조절하는 푸터 미니 슬라이더(`makeWidthSlider`). 드래그 시 `input` 이벤트로 setting에 바로 반영, 다른 writer(설정 패널)가 값을 바꾸면 thumb도 재반영(양방향 bind). bounds는 `READING_WIDTH_MIN/MAX_CH` 공유 상수로 설정 패널과 드리프트 없음. 측정 트리 밖(줌 가드 준수).
- **자동 업데이트 확인 + 푸터 업데이트 버튼** — 부팅 시 지연 실행되는 조용한 자동 확인(`main.ts`의 `boot()`, `setTimeout(() => ensureCheckedOnce())` — 콜드 로드·첫 페인트 0 영향, 네트워크 실패는 조용히 무시)과 푸터 업데이트 버튼(`makeUpdateButton`, `chrome/status-bar/update.ts`)이 `src/update/update-flow.ts`(단일 상태머신 SSOT: idle→checking→found→downloading→downloaded→installing)를 공유한다. 평소 숨김 → 업데이트 발견 시 `v{버전} 업데이트` 버튼이 accent 톤으로 노출, 클릭 시 다운로드 진행률 캡션 → "설치하고 재시작" → 설치 중 표시. 설정 › 버전 패널도 같은 모듈을 경유(`checkNow`/`startDownload`/`installAndRelaunch`)해 중복 로직 없이 1클릭 설치 UX를 유지하고, 부팅 자동 확인이 이미 찾은 업데이트가 있으면 패널을 열 때 "업데이트 확인" 클릭 없이 카드가 즉시 렌더된다. 신규 Tauri IPC 0(기존 `plugin-updater`/`plugin-process` 재사용), 브라우저 mock은 무변경(기존에 `check`를 이미 null로 강등).
- **브레드크럼 푸터 + 조상 점프** (M3) — 푸터 좌측이 현재 탐색기 루트 경로를 세그먼트로 표시(`breadcrumbSegments` 순수 함수 — 홈 `~` 축약 label ↔ 실경로 abs 분리, posix `/`·windows 드라이브 루트 노드 선두). **각 세그먼트 클릭 = 그 조상 폴더로 루트 점프**(`explorer.jumpToRoot(abs)` — 닫힌 패널이면 `revealShell`로 열고 점프, `changeRoot` 재사용). 브레드크럼 SSOT=explorer 루트(`onRootChange` 관찰, `renderTree` 정규화 직후 단일 지점). 탐색기 aside 헤더는 정적 "탐색기"로 되돌리고(경로 표시 단일 출처화), 전체경로 title/aria는 브레드크럼이 승계. 긴 경로 overflow-x. 측정트리 밖(줌 가드), 테마 var만.
- **경로 열기 인라인** — 경로열기 버튼 클릭 시 **상태바 자체가 입력칸으로 전환**(`.path-editing` — 아래 공간 안 열림, 상태바 높이 유지). 경로 입력 → Enter로 현재 창 열기(`resolveOpenPath` 재사용), ESC/blur/제출 시 상태바 원복. 없는 경로는 인라인 에러.
- **좌측 사이드바 폭 드래그** — 사이드바(탐색기·목차 공유)와 에디터 사이 sash(`.workspace-sash`, `role=separator`) 드래그로 폭 조절. 드래그 중엔 `--sidebar-width` var만 갱신(미리보기), 놓을 때 `sidebarWidthSetting`에 1회 커밋(localStorage 영속·재시작 유지). 키보드 ←/→ 16px 조절. `clampSidebarWidth`로 min 160 ~ max min(480, 뷰포트/2)(저장값 parse도 clamp 경유). 사이드바 닫히면 sash 자동 숨김(CSS 형제선택자). **M6**: rest 배경은 투명(심리스 크롬과 맞춰 대비선을 없앰) — hover/드래그 중에만 `--accent` 틴트로 나타남. 줌 가드: aside 폭 var만 조절, 측정 트리(`.cm-content`/`--measure`) 무접촉.
- **단축키 설정** — 설정 패널 "단축키" 카테고리(신규 `keybind` 컨트롤 kind). 각 action 행 = 라벨 + 현 바인딩 표시 + 키 캡처(재정의) + 개별 리셋, 상단 전체 리셋. 캡처 시 충돌 감지(중복 chord 거부 + 인라인 경고), Esc 취소. 사용자 override는 재시작 후 유지. 기본 바인딩: ⌘E(모드)·⌘B(탐색기)·⌘⇧B(즐겨찾기)·⌘=(및 ⌘+ 별칭)/⌘-/⌘0(줌)·⌘⇧C(번들 복사)·⌘⌥C(문서 경로 복사, `path.copy`)·⌘[(이전 문서)·⌘](다음 문서), 그 외 action(최근문서·목차·경로열기·Vim·저장)은 기본 미바인딩(사용자가 부여 가능). ⌘+ 줌인은 물리키 정규화(Shift+Equal→Equal)로 ⌘=와 동일 취급(브라우저 parity).
- **설정 패널** — 테마 프리셋 드롭다운(다크/라이트/클로드 3종 select), **"테마 색상" 비주얼 에디터**(코어 색 9종은 원형 스와치, 마크다운 스타일 9종은 원 없이 **스타일 프리뷰 텍스트가 곧 피커 트리거**(`is-preview`) — 전부 검정 원 반복이던 정보 없는 그리드 제거), 모드/Vim/타이포그래피. **모달 크롬 폴리시**: 카테고리 `:focus-visible`는 앱 accent 링(브라우저 기본 파란 링 제거), select·range 슬라이더는 `appearance:none` 커스텀(셰브런 래퍼 `.settings-select-wrap`·트랙/썸 토큰), 백드롭은 검정 딤 대신 **테마 배경톤 베일**(`color-mix(var(--bg) 55%, transparent)`), help 텍스트 있는 컨트롤은 설명을 입력칸 우측 압축 대신 **아래로 줄바꿈**(`settings-row-has-help` — 특정 행 예외 아닌 일반 규칙).
- **테마 프리셋** — 빌트인 3종: 다크 · 라이트 · **클로드**(Anthropic 에디토리얼 — 크림 캔버스 `#faf9f5` + 잉크 본문, 코랄 link/code, 시스템 세리프 헤딩). 프리셋 선택은 JSON 테마와 코히런스 유지(`loadPreset`/`syncJsonToPreset`).
- **타이포그래피** — DESIGN.md(ElevenLabs) 타입 시스템, Pretendard 번들, 헤딩 스케일·트래킹. **제목 글꼴 설정**(`headingFontSetting`, 설정 › 타이포그래피 › "제목 글꼴" select): 테마 기본 / Paperlogy(한글, 번들 opt-in) / Georgia(Serif) 3옵션. 기본값 `""`("테마 기본")은 헤딩 글꼴을 강제하지 않고 활성 테마의 `--font-heading` 기본값(클로드 = 시스템 세리프)이나 `--reading-font`(본문 글꼴)로 자연 낙하 — 클로드 테마의 헤딩-전용 세리프는 이제 강제 오버라이드가 아니라 그 테마의 기본값. 사용자가 명시 선택하면 인라인 `--font-heading`이 테마 기본을 이긴다(`headingFontSink`, inline beats `:root[data-theme]`). Paperlogy는 공식 배포 TTF에서 직접 서브셋한 600/700 두 웨이트(한글 음절 11,172자 전량, SIL OFL — `src/fonts/LICENSES.md`), `@font-face`만 선언되고 텍스트가 실제 매칭될 때만 페치되므로 미선택 사용자에게 콜드로드 비용 0.
- **뷰어 레지스트리 (R11)** — 비마크다운 파일을 여는 뷰어의 등록점(`src/chrome/viewer/registry.ts`의 `registerViewer({ id, extensions, open })`/`viewerFor`, R9·R2·R3와 같은 "plain 배열 + 명명 함수" 모양). 확장자 소유는 **first-claim-wins**(등록 순서, 충돌 시 throw 아님), id/extensions 포맷 위반은 fail-fast. 탐색기는 레지스트리를 모른다 — `canOpenWithViewer`/`onOpenWithViewer` 주입 쌍(구 `onOpenImage`의 일반화, isFavorite와 동일 게이팅: 주입 시에만 행이 openable)을 main.ts가 잇는다. don't-stack 싱글턴 오버레이 슬롯(`main.ts`의 `openViewer`, `openConflict`와 동일 패턴)은 레지스트리가 아니라 main.ts 소유(순수 카탈로그 유지). 내장 이미지 뷰어도 이 레지스트리를 경유(도그푸딩, R9의 내장 사이드바 패널과 동형). 오버레이 공통 셸(backdrop/Esc/inert/focus 복원)은 `src/chrome/viewer/shell.ts`의 `openViewerShell`로 추출되어 이미지·Excel 뷰어가 공유. **셸이 패널 크롬을 소유한다** — 배경·테두리·그림자·닫기버튼 위치·캡션 타이포는 공유 클래스 `.viewer-panel`/`-close`/`-caption`(styles.css)이고, 뷰어는 자기 **콘텐츠**만 스타일한다(이전엔 이 크롬이 `.image-viewer` 전용 선택자에 하드코딩돼 있어, 이미지 아닌 뷰어는 배경도 패딩도 없이 떴다). 셸의 `.viewer-panel-body`가 **크기 봉쇄**도 소유: `flex:1; min-height:0; overflow:hidden`이라 어떤 뷰어의 콘텐츠도 패널 밖으로(=본문 위로) 새지 않고 **패널 내부에서 스크롤**된다 — 수십 페이지짜리 HWP/PDF가 올 자리를 미리 막아둔 계약. **`.viewer-panel`은 ⌘± 줌의 두 번째 루트**(`calc(13px * var(--font-scale, 1))`, `.sidebar-aside`와 동형): 뷰어 텍스트는 본문·탐색기와 같은 `--font-scale` SSOT를 따르고, 하위는 13px-base em 분수만 쓴다(px 리터럴 금지 — `tests/viewer-zoom.test.ts`가 styles.css **와 `src/extensions/**` 주입 스타일 문자열까지** 스윕해 강제하므로, 새 확장이 줌을 조용히 무시할 수 없다). 신규 IPC 0 — 로컬 파일 바이트는 `readLocalFileBytes`(`chrome/viewer/file-bytes.ts`)가 `fetch(convertFileSrc(abs))`로 읽는다(CSP `connect-src`의 `asset:`/assetProtocol scope `**`가 이미 열려 있음, 마크다운 이미지가 쓰던 것과 같은 경로).
- **이미지 뷰어 (라이트박스)** — 탐색기에서 이미지 파일(`png/jpg/jpeg/gif/webp/svg/bmp/avif`, `file-icons.ts`의 `IMAGE_EXTENSIONS`가 아이콘·등록 확장자 목록의 단일 소유) 클릭/Enter → **body-level 오버레이**(`.viewer-backdrop` > `.image-viewer[role=dialog]`, `openViewerShell` 공유 셸: Esc/backdrop클릭/닫기버튼, `.editor-host` inert, 이전 focus 복원). **문서 수명주기 무접촉**(스왑 아님 — 열려 있던 마크다운 문서·오토세이브·워처·nav history 전부 그대로, welcome 화면에서도 동일 동작). 이미지 소스는 `resolveImageUrl`(`markdown/image.ts`) 재사용. 체커보드 스테이지 + fit 크기(`max-width:90vw; max-height:85vh; object-fit:contain`, 강제 확대 없음), 하단 캡션(`파일명 — 가로×세로`, 로드 실패 시 안내 문구로 대체). **줌/팬은 mermaid의 `attachPanZoom` 재사용**(타입만 `SVGElement | HTMLImageElement`로 확장, 동작 변경 0 — `panZoomSetting` 공유 게이트). 뷰어 레지스트리(위)를 경유해 `main.ts`가 `{ id: "image", extensions: [...IMAGE_EXTENSIONS] }`로 등록.
- **Excel 뷰어 (R11 — 첫 실물 확장)** — `src/extensions/excel-viewer/`, `../api` 파사드만 거쳐 `registerViewer({ id: "ext.excel", extensions: ["xlsx","xls"] })`. 탐색기에서 xlsx/xls 클릭/Enter → 뷰어 레지스트리 경유로 `openViewerShell` 오버레이가 뜨고, `readLocalFileBytes` + **동적 `import("xlsx")`**(SheetJS, ~1MB — 부팅 번들에 포함 안 됨, 첫 오픈에만 로드)로 워크북을 파싱. 시트별 탭(`role=tablist/tab`) + plain `<table>` 렌더, 서식값(`w`)→원시값(`v`)→수식 문자열(`=f`) 순 폴백, 서식/수식 재계산 없음(값만). **10,000행 초과 시 캡션에 "전체 N행 중 10,000행 표시" 고지**(`truncatedForRender`, 조용한 잘림 없음). 확장 전용 CSS는 자체 `<style>` 1회 주입(CSP `style-src 'self' 'unsafe-inline'`가 허용, styles.css는 확장이 못 만짐). **SheetJS는 npm이 아니라 공식 CDN 타르볼**에서 받는다(`package.json`: `xlsx` → `https://cdn.sheetjs.com/...` — npm 레지스트리판은 0.18.5에서 방치된 취약 구버전).
- **웰컴 대시보드** — 파일 인자 없이 실행 시 에디터 대신 표시(`src/welcome/welcome-pane.ts`의 `createWelcomePane`, 주입식 — main.ts 인라인에서 모듈 추출). 즐겨찾기·최근 문서 카드 그리드 + **빈 상태 CTA**: 둘 다 비어 있으면(`isBlankSlate` 순수 판정 → `reflectBlankSlate`가 `is-blank-slate` 토글, 두 구독 콜백+마운트 3곳에서 idempotent 호출) 즐겨찾기·최근 섹션을 접고 **워드마크 + "폴더 열기" 버튼 + 단축키 힌트만의 단일 히어로**로, 하나라도 항목이 생기면 카드 그리드로 복귀. CTA는 기존 explorer 열기 재사용(신규 IPC 0) + 힌트 ⌘B(`effectiveBinding` 파생이라 사용자 재바인딩 반영). 최근 문서 항목의 보조 경로 행은 **이름==경로일 때 생략**(`redundantPathLabel`(chrome/path-label.ts) — recent-panel·favorites-panel과 공유하는 단일 규칙).

---

## 곁가지 / 미구현 (정체성상 제외 or 후순위)
- **볼트/멀티노트/파일트리/탭/그래프/백링크/태그/동기화** — 반볼트 정체성 위배(→ Obsidian 영역).
- **플러그인 시스템** — 내부 레지스트리(`InlineFeature`/`BlockFeature`)는 있으나 외부 공개 API 미구현. (개선 로드맵 M3 — `docs/IMPROVEMENT_MASTER_PLAN.md`)
- 상세 로드맵: `docs/IMPROVEMENT_MASTER_PLAN.md`(새 기능) · `docs/REFINEMENT_MASTER_PLAN.md`(폴리시).
