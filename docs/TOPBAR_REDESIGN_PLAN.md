# mermark 상단 바 재설계 마스터플랜

> 작성 2026-07-03 · feature-architect. 구현 없음 — 설계 + 마일스톤 분할 문서.
> 입력: `docs/ENONCE_TITLEBAR_RECIPE.md`(Enonce 이식 레시피) + 현 크롬 코드 실측(아래 §2).
> 실행 단위: 각 마일스톤(M1~M4)이 **mermark-dev 파이프라인 1회**(설계→구현→검증→감사)이자 독립 커밋 묶음이다.

---

## 1. 목표 (사용자 비전)

앱 크롬 재편 4건:

1. **커스텀 타이틀바** — 네이티브 데코 대신 macOS `Overlay`(신호등 유지) + 상단 스트립 확보. Enonce 방식(Rust 최소, 프론트 CSS/DOM 중심).
2. **사이드바 토글을 상단으로** — 탐색기·목차·최근(그리고 M4의 즐겨찾기) 토글 버튼을 상단 바로 이동, 하단을 비운다.
3. **브레드크럼 푸터** — 현재 루트 경로를 푸터 풀폭 브레드크럼으로. 세그먼트 클릭 = 조상 폴더 점프(폴더 이동 통증 해결).
4. **즐겨찾기 = B2** — 별도 좌측 사이드바 뷰(4번째 토글), 기존 상호배타 그룹에 편입.

비협상 제약: 빠른 콜드로드(plain TS 모듈 + 구독 콜백, 프레임워크 금지), 줌가드(모든 크롬은 `.cm-content` 측정트리 밖), SSOT(`defineSetting` + sink, 손 fan-out 금지), 보안 자세(CSP·capabilities 최소 확장).

---

## 2. 현재 상태 실측 (근거)

| 사실 | 근거 |
|------|------|
| 창은 conf.json이 아니라 **런타임 빌더**로 생성. `app.windows: []` | `/Users/wis/Documents/programming/mermark/src-tauri/tauri.conf.json:14` |
| main 창: `WebviewWindowBuilder::new(app,"main",url).title("mermark").min_inner_size(...)` | `/Users/wis/Documents/programming/mermark/src-tauri/src/lib.rs:220-229` |
| **창 생성 지점이 2곳**: lib.rs setup(main) + `commands.rs open_path`(wikilink 새 창, `w*`). `DEFAULT_WINDOW` 상수 주석이 "두 경로가 같은 종류의 창"임을 명시 | `/Users/wis/Documents/programming/mermark/src-tauri/src/lib.rs:46-50` |
| capabilities: `windows: ["main","w*"]`, `core:default` + `allow-destroy`/`allow-close` + `opener:default`뿐 | `/Users/wis/Documents/programming/mermark/src-tauri/capabilities/default.json` |
| `index.html`은 `<div id="app">` 하나 + 테마 프리페인트 스크립트. 타이틀바 DOM 없음, `data-tauri-drag-region` 전무 | `/Users/wis/Documents/programming/mermark/index.html` |
| 레이아웃: `#app = column( .workspace(row: recent.aside, explorer.aside, outline.aside, sash, host), .status-bar )` | `/Users/wis/Documents/programming/mermark/src/main.ts:180-334`, `src/styles.css:146-151` |
| 상태바 계약이 명명 함수로 존재: `arrangeStatusBar` — 탐색기·최근·경로열기·목차·[pos·spacer·save]·모드·테마(·설정) | `/Users/wis/Documents/programming/mermark/src/status-bar.ts:27-33` + `tests/status-bar-order.test.ts` |
| `.status-bar { height:36px; border-top }` 하단 고정. `.status-btn` ghost 버튼, `.status-bar.path-editing > *` 숨김 트릭(경로열기 입력행이 bar 자식) | `/Users/wis/Documents/programming/mermark/src/styles.css:429-525` |
| 사이드바 상호배타: `closeOtherSidebars(keep: "explorer"|"outline"|"recent")` 단일 코디네이터 | `/Users/wis/Documents/programming/mermark/src/main.ts:258-262` |
| 토글 버튼 렌더는 공용 `renderSidebarButton(button,label,isOpen,controlsId)` (icon + aria-expanded/controls) | `/Users/wis/Documents/programming/mermark/src/sidebar-toggle.ts:26-37` |
| 탐색기 헤더 = 루트 경로 표시(`formatRootLabel`), 루트 변경은 `changeRoot → renderTree`(단일 정규화 지점, `normalizePath`) | `/Users/wis/Documents/programming/mermark/src/explorer/explorer-panel.ts:300-347` |
| 경로 유틸: `normalizePath`(백엔드 `normalize_path` 쌍둥이), `formatRootLabel`, `abbreviateHome`(private), `dirOf` | `/Users/wis/Documents/programming/mermark/src/path.ts` |
| 사이드바 뷰 선례: `recent-panel.ts`(SSOT 구독형) / `outline-panel.ts`. 설정 선례: `recentDocsSetting = defineSetting<string[]>` (localStorage JSON 배열, corrupt→[]) | `/Users/wis/Documents/programming/mermark/src/recent/recent-panel.ts`, `src/settings/app.ts:420-430` |
| 단축키: `shortcuts/actions.ts`에 `{ id:"explorer.toggle", defaultBinding:"Mod+B" }` 식 선언 + main에서 `registerHandler(id, () => button.click())` | `/Users/wis/Documents/programming/mermark/src/shortcuts/actions.ts:28`, `src/main.ts:600-602` |
| mac 판별 로직이 이미 존재: `/Mac|iPhone|iPad|iPod/.test(navigator.platform...)` | `/Users/wis/Documents/programming/mermark/src/shortcuts/keys.ts:127` |
| 사이드바 폭 SSOT 선례: `sidebarWidthSetting.bind(cssVarSink("--sidebar-width", ...))` | `/Users/wis/Documents/programming/mermark/src/main.ts:165` |
| 검증 표면: vitest(`tests/status-bar-order`, `sidebar-toggle`, `explorer-panel`, `recent-panel`, `path`, `render-smoke` 등) + CDP 골든(`scripts/{mermaid,settings,toc,footnote}-golden.mjs`, `nav-trace.mjs`) + `cargo test` | `tests/`, `scripts/` 목록 실측 |

Enonce 레시피 핵심(요약): `titleBarStyle:"Overlay"` + `hiddenTitle:true` 두 키, Rust 신호등 코드 0, `decorations`는 **건드리지 않음**(false면 Overlay 무효), 드래그는 `data-tauri-drag-region` HTML 속성, 신호등 여백은 CSS(매직넘버 → mermark는 `--traffic-light-inset` var 하나로), 버튼은 drag-region 자식으로 두되 속성 미부여(클릭 자동 통과). **mermark 델타: 창이 빌더 런타임 생성이므로 conf.json이 아니라 빌더 체인에 붙인다.**

---

## 3. 최종 상태 (목표 레이아웃)

```
┌─[●●●]──[탐색기][최근][목차][즐겨찾기][경로열기] ····drag···· [모드][테마][⚙]─┐  ← .title-bar (신규, drag-region)
│ ┌sidebar┐│┌──────────────────────────────────────────────┐                  │
│ │aside   ‖│  editor host (.cm-editor)                     │                  │  ← .workspace (불변)
│ └────────┘└──────────────────────────────────────────────┘                  │
└─[~ / … / docs / superpowers / plans]················[저장됨][Ln 3, Col 7]───┘  ← .status-bar = 푸터(브레드크럼 풀폭 + 인디케이터)
```

- **상단 = 명령**(토글·모드·테마·설정: 사용자가 누르는 것), **하단 = 상태**(브레드크럼·저장상태·커서위치: 앱이 보고하는 것). VSCode 관행과 일치하고, "저장상태/커서위치는 어디로" 미결(§6)에 대한 권장안이다.
- `#app = column( .title-bar, .workspace, .status-bar )` — workspace/사이드바/sash/에디터 host는 **무변경**이므로 `host.querySelector(".cm-scroller")` 참조·측정트리·⌘± 줌가드가 그대로 성립한다.

---

## 4. 결정 사항 (근거와 함께)

### 4.1 M1 — 커스텀 타이틀바 인프라

**분류**: Tauri **backend**(빌더 체인) + 신규 프론트 크롬 모듈(`src/title-bar.ts`). live-preview 파이프라인·parser·IPC command **무접촉**(신규 command 0 — 창 설정은 빌더 소관).

결정:

1. **Rust — 두 창 생성 지점을 하나의 명명 함수로 묶는다.** `title_bar_style(TitleBarStyle::Overlay)` + `.hidden_title(true)`는 tauri 2에서 macOS 전용(cfg-gated) 빌더 메서드다. main 창(`lib.rs:220`)과 wikilink 창(`commands.rs open_path`)이 같은 규칙을 받아야 하므로, 인라인 두 줄 복붙이 아니라 명명 함수로 분리한다(intent-review: 도메인 규칙 = 명명 함수):
   ```rust
   /// mermark 문서 창의 크롬 규칙: macOS는 Overlay 타이틀바(신호등 유지,
   /// 타이틀 텍스트 숨김), 그 외 OS는 네이티브 데코 그대로. decorations는
   /// 절대 만지지 않는다(false면 Overlay 무효 — Enonce 레시피 함정 1).
   fn with_document_chrome(builder: WebviewWindowBuilder<...>) -> WebviewWindowBuilder<...> {
       #[cfg(target_os = "macos")]
       let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
       builder
   }
   ```
   위치는 `lib.rs`(창 상수 `DEFAULT_WINDOW`/`MIN_WINDOW`가 이미 사는 곳 — "두 창 경로의 공유 사실은 lib.rs에 산다"는 기존 배치 규칙을 따름). `commands.rs`의 open_path 빌더도 이 함수를 통과시킨다. 시그니처의 정확한 제네릭은 구현 시 tauri 2 API로 확정(빌더 메서드의 cfg-gate 여부 포함 — TDD 첫 단계에서 `cargo check`로 검증).
2. **conf.json 무변경** — `app.windows`는 빈 배열 유지(레시피 델타 1). `decorations` 미변경(함정 1).
3. **신규 `src/title-bar.ts`** — `status-bar.ts`와 동형의 plain DOM 모듈. `#app` 최상단에 `<div class="title-bar" data-tauri-drag-region>` 삽입. M1 시점 내용물은 비어 있어도 된다(스트립 + 드래그만) — 토글 이주는 M2.
4. **신호등 인셋 = CSS var 단일 관리**: `:root { --traffic-light-inset: 78px }` 하나. `.title-bar { padding-left: var(--traffic-light-inset) }`은 **mac에서만**. Enonce의 80/72px 흩어짐(함정 2)을 var 하나로 방지.
5. **플랫폼 분기 = "mac만 Overlay, 나머지는 네이티브 유지"를 권장** (결정 지점 — §6.1 사용자 확인 필요):
   - Rust 쪽은 cfg-gate가 자동으로 처리(win/linux는 네이티브 타이틀바 유지 + 우리의 title-bar는 그 아래 일반 툴바 스트립으로 렌더).
   - 프론트 인셋은 mac에서만: 신규 의존성(`@tauri-apps/plugin-os`) 대신 **기존 `shortcuts/keys.ts:127`의 mac 판별을 재사용** — private이므로 `isMacPlatform()`으로 승격(export)해 title-bar가 import. 콜드로드 제약상 플러그인 추가보다 navigator 판별이 옳다(이미 검증된 코드).
   - win/linux 커스텀 최소/최대/닫기 버튼은 **만들지 않는다**(Enonce 동일 전략). 따라서 `core:window:allow-minimize/toggle-maximize/start-dragging` **capability 확장 불필요** — 보안 표면 무증가. win/linux 배포가 확정되면 그때 별도 마일스톤.
6. **드래그 vs 클릭**: drag-region 속성은 `.title-bar` 컨테이너에만. 버튼들은 자식으로 두되 속성 미부여(Tauri가 mousedown target의 속성만 보므로 클릭이 삼켜지지 않음 — 레시피 (c)). 더블클릭 최대화는 Tauri 기본 동작 위임(커스텀 JS 0).
7. **줌가드·콜드로드**: title-bar는 `.workspace` 밖(`#app` 직계 자식)이라 측정트리 무접촉. plain DOM + CSS라 콜드로드 비용 ~0.

### 4.2 M2 — 사이드바 토글 상단 이동

**분류**: 프론트 크롬 재배치. 파이프라인·백엔드 무접촉.

결정:

1. **이동 대상**: 탐색기·최근·목차 토글 + 경로열기 버튼(좌측 네비 그룹 전체). 경로열기도 "명령"이므로 상단행이 맞다. 잔류 대상(footer): `pos`, `save`. 상단 우측으로 이주: `mode`, `theme`, `⚙ settings`(mountSettingsButton의 대상 엘리먼트를 title-bar로).
2. **계약은 함수로 유지**: `arrangeStatusBar`가 하던 "순서는 명명 함수 한 곳" 규칙을 계승해 **`arrangeTitleBar(bar, parts)`**(신규, `title-bar.ts`)와 축소된 `arrangeStatusBar`(footer: 브레드크럼 자리 placeholder + spacer + save + pos — M3 전까지는 좌측이 비어 있어도 계약만 먼저 확정)로 분리. `tests/status-bar-order.test.ts`는 두 계약 테스트로 분할(`title-bar-order.test.ts` 신설).
   - 상단 순서 계약: `[inset] 탐색기 · 최근 · 목차 · (M4: 즐겨찾기) · 경로열기 · [drag spacer] · 모드 · 테마 · ⚙`.
3. **경로열기 입력행 이주**: `createOpenPathPrompt({ bar })`는 bar 엘리먼트에 입력행을 넣고 `.status-bar.path-editing > *` CSS로 형제를 숨긴다(styles.css:513). 버튼이 상단으로 가면 입력행도 title-bar에서 펼친다 — CSS 셀렉터를 `.title-bar.path-editing`으로 옮기거나 공용 클래스(`.chrome-bar`)로 일반화. **주의**: path-editing 중 형제가 숨겨져도 drag-region 컨테이너는 유지되므로 드래그 회귀 없음(입력 필드 자체는 비-drag 자식).
4. **클래스 네이밍**: `.status-btn`이 title-bar로 이주하면 이름이 거짓말이 된다. `.chrome-btn`으로 개명하고 styles.css에서 `.status-btn` 셀렉터를 함께 갱신(기계적 sweep). `scripts/*.mjs` 골든 스크립트가 `.status-btn`/`.status-bar` 셀렉터를 쓰는지 grep 후 동기 갱신 — 안 하면 골든이 깨진다. (스코프가 부담이면 M2에서 개명을 보류하고 감사 지적으로 남기는 選도 가능 — 권장은 개명.)
5. **무회귀 보존**: `closeOtherSidebars` 상호배타, sash(CSS-only 가시성), `registerHandler("explorer.toggle", () => explorer.button.click())` 패턴은 버튼 DOM 위치와 무관하므로 **무변경**. `renderSidebarButton`도 무변경(버튼이 어느 바에 살든 동일).

### 4.3 M3 — 브레드크럼 푸터 (세그먼트 클릭 = 조상 점프)

**분류**: 프론트 크롬 + `path.ts` 순수 함수 추가. 백엔드 무접촉(조상 경로는 텍스트 연산 — `list_dir`는 점프 후 explorer의 기존 경로로 호출됨).

결정:

1. **브레드크럼이 비추는 것 = explorer 루트** (사용자 지시대로 `changeRoot` 재사용). explorer가 닫혀 있으면 seed인 `currentBaseDir`(문서 폴더)를 비춘다 — 문서를 열 때마다 `resetToBaseDir`가 루트를 재시드하므로 두 값은 자연 수렴.
2. **explorer 패널 API 확장** (`explorer-panel.ts`):
   - `onRootChange?(root: string): void` 핸들러 추가 — `renderTree`가 정규화 직후 1회 호출(단일 정규화 지점을 그대로 관찰 지점으로 씀. 헤더/트리/브레드크럼이 한 지점에서 갱신되므로 드리프트 불가).
   - `jumpToRoot(absPath: string): void` 공개 메서드 추가 — 내부적으로 `changeRoot`와 동일 경로(캐시 클리어 + renderTree). 닫힌 패널에서 호출되면 **패널을 연 뒤** 점프(브레드크럼 클릭의 기대 동작: "그 폴더를 보여줘").
3. **순수 도메인 함수** (`path.ts`, CQS query — 실패 테스트 먼저):
   ```ts
   /** 정규화된 절대경로 → 브레드크럼 세그먼트 목록.
    *  각 세그먼트 = { label, abs }: label은 표시명(홈 프리픽스는 "~" 1개 세그먼트로
    *  축약 — abbreviateHome 재사용), abs는 그 조상의 절대경로(클릭 점프 대상 —
    *  축약과 무관하게 항상 실경로). posix/windows 구분은 detectSeparator 재사용. */
   export function breadcrumbSegments(path: string): { label: string; abs: string }[]
   ```
   `abbreviateHome`/`detectSeparator`는 현재 private — export 승격 또는 내부 재사용(같은 파일이므로 승격 불필요, 내부 호출로 충분).
4. **신규 `src/breadcrumb.ts`** — recent/outline과 동형의 plain DOM 크롬. footer 좌측 풀폭(flex:1) 컨테이너, `breadcrumbSegments` 결과를 버튼 나열로 렌더, 클릭 위임 리스너 1개(explorer의 단일 활성화 경로 패턴) → 주입된 `onJump(abs)`(main에서 `explorer.jumpToRoot`로 배선). 긴 경로는 `overflow-x` + `formatRootLabel`식 축약이 아니라 **세그먼트 자체가 축약 단위**이므로 중간 세그먼트 접기(`…`)는 후속 폴리시로 미룸(최소 스코프).
5. **탐색기 헤더 판정**: 푸터 브레드크럼이 경로 표시의 단일 출처가 되므로 aside 헤더는 정적 라벨 "탐색기"로 되돌린다(표시 2곳 → 드리프트·중복 제거). 전체 경로 title/aria는 브레드크럼 쪽이 이어받는다. (대안: 헤더 유지 — renderTree 단일 지점이 둘 다 갱신하므로 기술적 드리프트는 없음. 그러나 같은 정보 2곳은 재설계 목적(하단 비우기·정보 재배치)과 상충 → 제거 권장.)
6. **줌가드**: footer는 측정트리 밖(기존 status-bar 그대로). 브레드크럼은 데코레이션이 아니므로 render-smoke 불변식과 무교차.

### 4.4 M4 — 즐겨찾기 = B2 (4번째 사이드바)

**분류**: **setting**(SSOT) + 사이드바 뷰(recent-panel 선례 복제). 백엔드 무접촉(폴더 존재 검사도 추가 IPC 없이 — 아래 3).

결정:

1. **SSOT**: `favoriteFoldersSetting = defineSetting<string[]>({ key: "mermark.favoriteFolders", default: [], parse: <recentDocsSetting과 동일한 JSON 배열 가드> })` — `src/settings/app.ts`. 손 fan-out 금지: 패널은 `getFavorites()` 클로저로 읽고, main의 단일 `favoriteFoldersSetting.subscribe(() => favorites.refresh())`가 재렌더(recent 패턴 그대로, main.ts:338 선례).
2. **순수 도메인 모듈** `src/favorites/favorite-folders.ts` (recent-docs.ts 쌍둥이):
   - `pushFavorite(list, absPath): string[]` — normalizePath 후 dedupe·뒤가 아닌 **추가 순서 유지**(즐겨찾기는 MRU가 아니라 사용자가 큐레이션하는 목록 — recent와 다른 도메인 규칙이므로 pushRecent 재사용이 아니라 별도 함수. cap 없음).
   - `removeFavorite(list, absPath): string[]`, `isFavorite(list, absPath): boolean` (CQS query).
3. **★ 추가 방법 판정**: 패널 헤더의 "현재 폴더 추가" 버튼(★)을 권장 — 현재 explorer 루트(닫혀 있으면 `currentBaseDir`)를 추가. 근거: (a) explorer 폴더 행 별 토글은 hover 어포던스 + 행 DOM 변경으로 explorer-panel 테스트 면적을 키움, (b) 우클릭 컨텍스트 메뉴는 신규 UI 체계라 스코프 초과. 헤더 버튼 + 항목별 제거(X) 버튼이 최소·발견가능. (후속 폴리시: explorer 행 별 토글 — 문서화만.)
4. **없는 경로 정책**: 자동 prune **안 함**(recent와 다름 — 외장디스크/일시적 언마운트 폴더를 즐겨찾기에서 지우면 사용자 큐레이션 파괴). 클릭 시 `list_dir` 거부 → explorer의 기존 "빈 트리" 처리로 자연 수용. 제거는 수동(X)만.
5. **클릭 동작**: 항목 클릭 → `explorer.jumpToRoot(path)` (M3 산출 API 재사용) — "그 폴더로 루트 이동"이지 파일 열기가 아니다. 즐겨찾기 패널은 점프 후 닫히고 explorer가 열린다(상호배타가 자동 처리 — jumpToRoot가 explorer를 열면 `closeOtherSidebars("explorer")`가 favorites를 닫음).
6. **상호배타 편입**: `closeOtherSidebars`의 keep 유니온에 `"favorites"` 추가 + 4개 close 분기. `workspace.prepend(favorites.aside)` + `.sidebar-aside` 셸·`renderSidebarButton`·`aria-controls` id(`favorites-aside`) — 전부 recent 선례 복제.
7. **토글 버튼**: title-bar의 M2 그룹에 편입(`arrangeTitleBar` 계약 갱신: 탐색기·최근·목차·**즐겨찾기**·경로열기). 단축키: `shortcuts/actions.ts`에 `{ id: "favorites.toggle", label: "즐겨찾기 토글", defaultBinding: <미할당 or 합의값> }` + main `registerHandler`.

### 4.5 전 마일스톤 공통

- **SSOT**: 신규 사용자 선호값은 M4의 `favoriteFoldersSetting` 하나. M1~M3은 설정 무증가(타이틀바 on/off 옵션 등 골드플레이팅 금지).
- **테마 var**: 신규 CSS는 전부 토큰(`--surface`/`--border`/`--muted`/`--fg`)만 — dark/light/claude 3테마 자동 일관. 하드코딩 hex 금지(styles.css 기존 규율).
- **경계면**: 신규 Tauri command **0**. `src/mocks/tauri-core.ts` 무접촉(read_file/write_file/list_dir 시그니처 불변). 3-경계 parity 회귀 없음.
- **FEATURES.md**: M1~M4 각각 사용자 관측 기능 변경이므로 **각 마일스톤 커밋 묶음에서 `docs/FEATURES.md` 갱신**(mermark-dev Phase 6 규약).

---

## 5. 마일스톤 분할

의존 사슬: **M1 → M2 → M3 → M4** (M3·M4는 M2의 footer 비우기/버튼 그룹에 의존, M4는 M3의 `jumpToRoot` API에 의존). 각 M은 그 자체로 릴리스 가능한 상태를 남긴다.

### M1 — 커스텀 타이틀바 인프라 (리스크 최고: Rust·플랫폼·드래그)

| 항목 | 내용 |
|------|------|
| 범위 | `with_document_chrome` 빌더 함수 + 2개 창 지점 적용(**backend**) · `src/title-bar.ts` 신설(빈 드래그 스트립) · `--traffic-light-inset` var · `isMacPlatform()` 승격(`shortcuts/keys.ts`) · `#app` column에 title-bar 삽입 |
| 영향 파일 | `/Users/wis/Documents/programming/mermark/src-tauri/src/lib.rs`, `/Users/wis/Documents/programming/mermark/src-tauri/src/commands.rs`(open_path 빌더), `/Users/wis/Documents/programming/mermark/src/title-bar.ts`(신규), `/Users/wis/Documents/programming/mermark/src/main.ts`(boot 삽입 1곳), `/Users/wis/Documents/programming/mermark/src/styles.css`, `/Users/wis/Documents/programming/mermark/src/shortcuts/keys.ts` |
| backend | **필요** (유일하게 Rust를 만지는 마일스톤). conf.json·capabilities·mock 무변경 |
| 리스크 | ① tauri 2 빌더 메서드의 정확한 시그니처/cfg-gate — 첫 단계 `cargo check`로 확정 ② 신호등 인셋 78px 매직넘버 — 실기 눈검증으로 튠(var 1곳이라 수정 비용 0) ③ 전체화면에서 신호등 자동 숨김 시 좌측 여백 잔존(코스메틱, 알려진 제한으로 문서화) ④ 드래그 스트립이 미래 버튼 클릭을 삼킬 가능성 — M1에서 drag-region 규칙(컨테이너만) 확정 ⑤ wikilink 창 누락 시 크롬 이중화 — 공유 함수가 방어 |
| 검증 게이트 | `cargo test`(기존 무회귀) + `cargo check`(mac) · vitest 신규 `title-bar.test.ts`(drag-region 속성 존재, mac 분기 시 인셋 클래스/var, 비-mac 무인셋) · `tsc --noEmit` · **실기 수동 스모크(필수)**: 신호등 표시·드래그 이동·더블클릭 최대화·wikilink 새 창 동일 크롬 · CDP 골든 재실행(dev:browser에선 title-bar가 일반 스트립으로 렌더 — 상단 ~38px 레이아웃 시프트로 스크린샷 기준선 재베이스라인 가능성) |
| TDD 순서 | (backend) cargo: 창 2곳이 공유 함수를 통과하는지는 타입으로 강제 — 함수 도입 후 두 호출부 컴파일 확인 → (frontend) vitest red: title-bar DOM 계약 → 구현 → green → 실기 스모크 |

### M2 — 토글 상단 이동 (frontend only)

| 항목 | 내용 |
|------|------|
| 범위 | 좌측 네비 그룹(탐색기·최근·목차·경로열기) + 우측(모드·테마·⚙)을 title-bar로 · `arrangeTitleBar` 신설 + `arrangeStatusBar` 축소(save·pos 잔류) · path-editing CSS 이주 · `.status-btn`→`.chrome-btn` 개명 sweep(스크립트 포함) |
| 영향 파일 | `src/title-bar.ts`, `src/status-bar.ts`, `src/main.ts`(arrange 호출부·mountSettingsButton 대상), `src/open-file/path-prompt.ts`(bar 파라미터 대상 변경), `src/styles.css`, `tests/status-bar-order.test.ts`(분할), `tests/title-bar-order.test.ts`(신규), `scripts/*.mjs`(셀렉터 grep 동기) |
| backend | 불필요 — backend-engineer 유휴 명시 |
| 리스크 | ① path-editing 입력행이 drag-region 안에서 포커스/클릭 정상 동작하는지(비-drag 자식이므로 이론상 안전 — 골든으로 확인) ② 골든 스크립트 셀렉터 표류(사전 grep이 방어) ③ 상호배타·sash 회귀(버튼 위치 무관 설계라 낮음 — 기존 테스트가 가드) |
| 검증 게이트 | vitest: `title-bar-order`(신규 계약) + `status-bar-order`(축소 계약) red→green, `sidebar-toggle`·`explorer-panel`·`recent-panel`·`outline-panel`·`sidebar-sash` 무회귀 · `tsc` · CDP: `toc-golden`(목차 토글 경로)·`nav-trace`·`settings-golden`(⚙ 이주) 재실행 |
| TDD 순서 | red: arrangeTitleBar 순서 계약 테스트 → 이주 구현 → green → 골든 |

### M3 — 브레드크럼 푸터 + 조상 점프 (frontend only)

| 항목 | 내용 |
|------|------|
| 범위 | `breadcrumbSegments`(path.ts 순수 함수) · `src/breadcrumb.ts` 신설 · explorer `onRootChange`/`jumpToRoot` API · footer 좌측 풀폭 배선 · 탐색기 헤더 정적화 |
| 영향 파일 | `src/path.ts`, `src/breadcrumb.ts`(신규), `src/explorer/explorer-panel.ts`, `src/status-bar.ts`(footer 계약에 breadcrumb 슬롯), `src/main.ts`(배선), `src/styles.css`, `tests/path.test.ts`, `tests/breadcrumb.test.ts`(신규), `tests/explorer-panel.test.ts` |
| backend | 불필요 |
| 리스크 | ① 홈 축약 세그먼트의 abs 매핑(라벨 `~` ↔ 실경로 — breadcrumbSegments 단위 테스트가 핵심 가드) ② windows 경로(드라이브 프리픽스 세그먼트) — normalizePath/detectSeparator 재사용으로 흡수 ③ 닫힌 explorer에서 점프 시 열림 순서(jumpToRoot가 open→renderTree 순서 보장) ④ 매우 긴 경로의 footer overflow — `overflow-x:auto` 컨테이너로 1차 방어, 중간 접기는 후속 |
| 검증 게이트 | vitest: `path.test.ts`에 breadcrumbSegments red 케이스(posix·home·windows·루트 1세그먼트) → green · `breadcrumb.test.ts`(렌더·클릭 위임→onJump) · `explorer-panel.test.ts`(jumpToRoot·onRootChange) · 무회귀: render-smoke(데코 무교차 확인용 전체 스위트) · CDP: `nav-trace` + 수동 시나리오(문서 열기→브레드크럼 세그먼트 클릭→explorer 루트 점프→`..` 왕복) |
| TDD 순서 | red: breadcrumbSegments 순수 함수 → green → red: 패널 API → green → 배선·CSS |

### M4 — 즐겨찾기 B2 (frontend only)

| 항목 | 내용 |
|------|------|
| 범위 | `favoriteFoldersSetting`(SSOT) · `src/favorites/favorite-folders.ts`(순수) · `src/favorites/favorites-panel.ts`(신규 뷰) · `closeOtherSidebars` 4-way · title-bar 그룹·단축키 액션 편입 · 헤더 ★추가/항목 X제거 |
| 영향 파일 | `src/settings/app.ts`, `src/favorites/favorite-folders.ts`(신규), `src/favorites/favorites-panel.ts`(신규), `src/main.ts`(생성·배선·구독·registerHandler), `src/title-bar.ts`(arrange 계약 갱신), `src/shortcuts/actions.ts`, `src/styles.css`(최소 — `.sidebar-aside` 셸 재사용), `tests/favorite-folders.test.ts`·`tests/favorites-panel.test.ts`(신규), `tests/settings-app.test.ts`, `tests/title-bar-order.test.ts` |
| backend | 불필요 |
| 리스크 | ① 점프 후 패널 전환 순서(favorites 닫힘 ↔ explorer 열림)가 상호배타 코디네이터와 이중 발화하지 않는지 ② 없는 폴더 클릭의 UX(빈 트리 — 의도된 수용, 문서화) ③ localStorage corrupt(파서 가드가 방어 — recent 선례) |
| 검증 게이트 | vitest: `favorite-folders`(push dedupe·remove·isFavorite·normalize) red→green · `favorites-panel`(렌더·추가·제거·클릭→jumpToRoot·상호배타 onOpen) · `settings-app`(파서 가드) · `title-bar-order`(5버튼 계약) · `shortcuts-registry` 무회귀 · CDP: `settings-golden` 무회귀 + 수동 시나리오(추가→재시작 유지→클릭 점프→제거) |
| TDD 순서 | red: favorite-folders 순수 모듈 → green → red: 패널 → green → SSOT·배선·계약 테스트 |

---

## 6. 리스크 · 미결 · 결정 지점

### 6.1 사용자 결정 (2026-07-03 확정)

1. **win/linux 배포 대상 = 예 (3-OS 다 대응).** → **M1에 win/linux 커스텀 창 컨트롤 포함**(플랜 초안의 M1b를 M1 본선에 편입): mac=`Overlay`+`hidden_title`(신호등 유지), win/linux=`decorations(false)` + **커스텀 최소/최대/닫기 버튼 3종**(title-bar 우측, 플랫폼 분기). capability 확장 필요: `core:window:allow-minimize`·`allow-maximize`(또는 `toggle-maximize`)·`allow-close`(기존)·`allow-start-dragging`(win/linux 드래그는 `data-tauri-drag-region`이 처리하나 커스텀 버튼 클릭 핸들러가 `getCurrentWindow().minimize()/toggleMaximize()/close()`를 호출하므로 해당 allow 필요). 신호등 인셋(`--traffic-light-inset`)은 mac만, win/linux는 좌측 인셋 0 + 우측에 창 버튼.
2. **footer 인디케이터 = 브레드크럼(좌, 풀폭) + save·pos(우).** (권장안 채택 — 상단=명령/하단=상태.)
3. **`favorites.toggle` 기본 단축키 = ⌘⇧B**(Mod+Shift+B). 탐색기 ⌘B와 짝.

### 6.2 기술 리스크 (마일스톤 표에 배정됨, 요약)

- **드래그 영역 클릭 삼킴**: 컨테이너에만 속성, 버튼 무속성(레시피 검증 패턴). path-editing 입력행이 유일한 신규 케이스 — M2 골든으로 확인.
- **신호등 인셋 매직넘버**: `--traffic-light-inset` var 1곳 + 실기 튠. 전체화면 신호등 숨김 시 잔여 여백은 알려진 제한으로 문서화(후속 폴리시: fullscreen 이벤트로 var 0 토글).
- **tauri 2 빌더 API 정확도**: `title_bar_style`/`hidden_title`의 cfg-gate·시그니처는 M1 첫 `cargo check`에서 확정(본 문서는 macOS 전용 메서드로 가정 — Enonce가 conf 키로 검증한 동작의 빌더 등가물).
- **CDP 골든 재베이스라인**: 상단 스트립 삽입은 모든 화면의 세로 오프셋을 바꾼다. M1에서 한 번 재베이스라인하고 M2~M4는 셀렉터 기반이므로 grep 동기만.
- **`.status-btn` 개명 sweep 누락**: styles.css·모듈·scripts를 한 커밋에서 grep로 일괄(M2). 감사(code-auditor)의 네이밍 렌즈가 최종 가드.

### 6.3 명시적 비스코프 (골드플레이팅 금지)

- 타이틀바 on/off 설정, 탭바, 문서 타이틀 중앙 표시, win/linux 커스텀 창 버튼, 브레드크럼 중간 세그먼트 접기(`…`), explorer 행 내 ★ 토글, 즐겨찾기 드래그 정렬 — 전부 후속 폴리시 후보로만 기록.

---

## 7. 파이프라인 실행 가이드 (mermark-dev)

| 마일스톤 | 파이프라인 | engineers | 골든 게이트 |
|----------|-----------|-----------|-------------|
| M1 | mermark-dev 1회 | backend(빌더) + frontend(title-bar.ts) 병렬 | cargo + 실기 스모크 + 재베이스라인 |
| M2 | mermark-dev 1회 | frontend 단독 (backend 유휴 통지) | toc/nav/settings 골든 |
| M3 | mermark-dev 1회 | frontend 단독 | nav-trace + 수동 점프 시나리오 |
| M4 | mermark-dev 1회 | frontend 단독 | settings 골든 + 수동 시나리오 |

각 마일스톤 완료 시: `docs/FEATURES.md` 갱신(L5 UI 크롬 계층) + 커밋. 각 회차의 feature-architect 단계는 본 문서의 해당 M 섹션을 `_workspace/01_architect_design.md`/`01_architect_plan.md`로 구체화하는 델타 작업이 된다(재작성 아님).
