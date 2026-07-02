# Enonce 커스텀 타이틀바 → mermark 이식 레시피

> 참조: `/Users/wis/Documents/programming/Enonce`(Tauri 2 프로젝트). 상단 바 재설계(커스텀 타이틀바 + 토글 상단 이동 + 브레드크럼 푸터 + 즐겨찾기 B2)의 설계 입력. 조사 2026-07-03.

## 결론 요약
Enonce는 **Rust 코드로 신호등을 조작하지 않는다.** `titleBarStyle: "Overlay"` + `hiddenTitle: true` 두 키만으로 macOS 네이티브 신호등을 얻고, 신호등 겹침 방지 여백·드래그 영역은 전부 **프론트 CSS/DOM**에서 처리. `cocoa`/`objc`/`window-vibrancy` crate 없음, `trafficLightPosition` 없음, win/linux 커스텀 버튼 없음 — **macOS 전용 Overlay 단일 전략**.

## (a) tauri.conf.json (Enonce 방식 — 정적 창)
```json
"app": { "windows": [{ "title": "", "titleBarStyle": "Overlay", "hiddenTitle": true, "width": 800, "height": 600 }] }
```
- `titleBarStyle: "Overlay"`(mac 전용): 네이티브 타이틀바 바탕 제거·웹뷰를 창 최상단까지 확장, 신호등은 웹뷰 위에 유지.
- `hiddenTitle: true`: 타이틀 텍스트 숨김.
- **함정**: `decorations: false`로 두면 Overlay 무효화 → 신호등 사라짐. **decorations는 건드리지 말 것**(기본 true 유지).

## (b) Rust: 없음
`lib.rs`/`main.rs`/`Cargo.toml`에 신호등 관련 코드·crate 전무. tauri.conf만으로 충분.

## (c) 프론트 타이틀바 DOM/CSS
- 상단 헤더 바 전체에 `data-tauri-drag-region`(순수 HTML 속성, `-webkit-app-region` CSS 안 씀).
- 좌측 신호등 여백: `padding-left`로 확보(Enonce는 `80px`/`72px` 매직넘버 — mac 신호등 폭).
- 버튼/인터랙티브 요소: drag-region의 **자식**으로 두되 자체엔 `data-tauri-drag-region` **미부여**(Tauri가 클릭 가능 자식을 자동 통과 — 명시적 `="false"` 불필요).
- 더블클릭 최대화: Tauri 기본 동작 위임(커스텀 JS 없음).
- **위임 패턴**: 전역 Header가 보이면 신호등 여백을 Header가 처리(pl-80), Header 숨기면 최상단 Tabbar가 `72px`로 떠안음.

## (d) 플랫폼 분기: 없음
`titleBarStyle: Overlay`는 mac 전용 키 → win/linux는 tauri가 무시하고 네이티브 데코 폴백. Enonce는 win/linux 커스텀 버튼 없음(사실상 mac 전용 설계). 패딩도 분기 없이 항상 적용 → win/linux엔 불필요 여백.

## (e) 함정
1. **decorations × titleBarStyle**: decorations:false면 Overlay 무효. 건드리지 말 것.
2. **매직넘버 이중관리**(80px/72px 흩어짐) → mermark는 CSS var `--traffic-light-inset` 하나로 통일 권장.
3. **플랫폼 분기 부재**: win/linux에 불필요 좌측 여백. mermark가 win/linux 배포하면 분기 필요.
4. **드래그 영역이 클릭 삼킴**: 버튼 아닌 순수 텍스트/아이콘을 drag-region에 잘못 배치 시 클릭 씹힘.

## mermark 이식 델타 (현재 구조 대비)
현재 mermark:
- `tauri.conf.json`의 `app.windows`는 **빈 배열** — 창은 `src-tauri/src/lib.rs:220` `WebviewWindowBuilder::new(app,"main",url).title("mermark")...build()` **런타임 생성**.
- decorations/titleBarStyle/hiddenTitle 설정 없음 → 네이티브 기본 타이틀바.
- 상단 바 없음(`index.html`은 `<div id="app">`뿐, CodeMirror가 그 안에 렌더). 상태바는 `src/status-bar.ts` 조립 + `styles.css` `.status-bar { height:36px; border-top }` **하단**.
- `data-tauri-drag-region` 전무(드래그는 네이티브 타이틀바 의존).
- `capabilities/default.json`: `core:window:allow-destroy`/`allow-close`, scope `["main","w*"]`.

바꿔야 할 것:
1. **Rust (lib.rs:220 빌더 체인)**: `.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true)` 추가. **conf.json 방식 복붙은 무효**(빈 windows라 런타임 생성) — 이 지점이 최대 구조 차이. decorations 미변경.
2. **새 상단 바 모듈**: mermark는 Svelte 아닌 순수 TS+DOM(`status-bar.ts` 패턴) → `src/title-bar.ts` 신설, `#app` 최상단에 `<div class="title-bar" data-tauri-drag-region>` 삽입 + `styles.css .title-bar { height:30~36px; padding-left: var(--traffic-light-inset)(mac) }`.
3. **CSS var 통일**: `:root { --traffic-light-inset: 78px }` 하나로.
4. **플랫폼 분기 검토**: win/linux 배포 시 `@tauri-apps/plugin-os`(또는 navigator.platform)로 Overlay는 mac만, win/linux는 커스텀 버튼 or 네이티브 유지 — Enonce엔 참고 코드 없어 신설 필요.
5. **드래그/클릭 충돌**: 상단 바에 올릴 버튼(토글 등)엔 drag-region 미부여(Enonce 패턴).
6. **capability**: 신호등만이면 CSP/window capability 확장 불필요. 단 JS에서 `getCurrentWindow().toggleMaximize()`/`startDragging()` 등 직접 호출(win/linux 커스텀 버튼)하면 `core:window:allow-toggle-maximize`/`allow-minimize`/`allow-start-dragging` 추가 필요.

## 상단 바 재설계 연결 (mermark 목표)
Enonce 레시피 위에 얹을 mermark 재편:
- 상단 title-bar 확보 → 사이드바 토글(탐색기·목차·최근·**즐겨찾기 B2**) 버튼을 이 상단으로 이동.
- 하단 상태바는 **브레드크럼(현재 루트 경로) 풀폭**으로 — 세그먼트 클릭 = 조상 폴더 점프(폴더 이동 통증 해결).
- 즐겨찾기 = 별도 사이드바 뷰(최근을 사이드바로 옮긴 패턴 재사용, 상호배타 그룹에 편입).
- 줌가드·측정트리 무접촉 유지(상단/하단 바 전부 `.cm-content` 밖).
