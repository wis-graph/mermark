# mermark 전체 시각 디자인 리뷰 — 2026-10-18

> 리뷰어: 시니어 아트디렉터 관점(Claude, `design:design-critique` 프레임: 첫인상 → 사용성 → 위계 → 일관성 → 접근성)
> 대상: v0.21.0 작업 트리. 코드는 수정하지 않았고 리뷰만 했다.
> 맥락 문서: `docs/SETTINGS_REDESIGN_BRIEF.md`, `docs/SETTINGS_COMPONENT_SPEC.md`, `docs/TOPBAR_REDESIGN_PLAN.md`, `docs/ENONCE_TITLEBAR_RECIPE.md`, `docs/FEATURES.md` L5, `src/styles.css` 토큰(:root·light·claude), `src/theme.ts`, `DESIGN.md`(ElevenLabs), `DESIGN_CLAUDE.md`.

---

## 0. 방법과 한계

- **캡처**: `npm run dev:browser`(:1430)를 띄우고, 격리된 헤드리스 Chrome 155(`--remote-debugging-port=9333`, 임시 `--user-data-dir`)를 Playwright `connectOverCDP`로 조작했다. 테마는 `localStorage["mermark.theme"]`로 고정했고, 문서는 mock의 `window.__mockExternalChange`로 주입한 리뷰용 샘플(헤딩 H1–H6, 콜아웃 note/warning/tip, 표, 체크리스트, 순서 목록, mermaid, TS 코드, KaTeX, 인용, 이미지, 각주)을 썼다.
- **매트릭스**: 라이트·다크·클로드 × 1280px 전 화면, 라이트·다크 × 900px 주요 화면, 2x 디테일 크롭(타이틀바·상태바·레일 상단·포커스 링·콜아웃·코드블록).
- **실측**: 대비비는 `getComputedStyle` 값을 실제 배경 위에 알파 합성한 뒤 WCAG 2.x 공식으로 계산했다. 크기·위치는 `getBoundingClientRect`로 쟀다.
- **스크린샷 위치**: `/private/tmp/claude-501/-Users-wis-Documents-programming/abdf7642-3c25-4c29-8ed9-364962a700c2/scratchpad/design-review/` (파일명 규칙은 `<번호>-<화면>_<테마>-<폭>.png`. 세션 scratchpad라 영구 보존되지 않는다.)
- **dev:browser의 한계** (실앱과 다를 수 있는 부분):
  1. **네이티브 타이틀바·신호등이 없다.** 좌측 78px 인셋(`--traffic-light-inset`)은 빈 공간으로만 보인다. 실앱에서는 그 자리에 신호등이 있으므로 레일 상단 오버플로(🔴3)는 실앱에서 더 나빠질 수는 있어도 나아지지는 않는다.
  2. **렌더 엔진이 다르다.** Chromium이고 실앱은 WKWebView다. `ui-monospace`, `system-ui` 한글 폴백, `text-wrap: pretty`, range 슬라이더 렌더가 엔진마다 조금씩 다르다.
  3. **커스텀 스킴이 없다.** `asset://`·`epub://`·HWP 렌더 같은 이미지·뷰어 경로는 mock 고정 픽스처로 대체됐다. PDF·이미지 뷰어는 픽스처 내용(마커 텍스트, 64px 사각형)만 보여서 실제 문서 표현은 평가하지 못했다.
  4. 호버 상태는 헤드리스 마우스 위치에 따라 일부 섞였을 수 있다(폴드 마커 .3 ↔ .75).

---

## 1. 총평 — 이 앱의 디자인 언어

mermark는 이미 하나의 정체성을 갖고 있다. **"조용한 에디토리얼 캔버스 + 어두운 작업대 레일"**이다. 본문은 중앙 정렬된 68% 측정폭 위에 웜 잉크(`#0c0a09`/`#141413`)로 쓰이고, 크롬은 아이콘 전용 28px 고스트 버튼과 13px 뮤트 텍스트로 최대한 물러나 있다. 좌측 레일은 테마 극성과 상관없이 늘 어두운 pole(SIDEBAR CONTRAST RULE)이라서 "도구"와 "원고"를 두 톤으로 가른다. 테마별로 액센트의 성격이 다르다. 라이트는 잉크 단색(ElevenLabs식 무채 에디토리얼), 다크는 스카이 블루, 클로드는 크림+코랄+세리프 헤딩(Anthropic 에디토리얼)이다. 줌 가드, `--block-fill`/`--block-edge` 파생 토큰, 테마 var 경유 같은 **시스템적 사고는 개인 앱 수준을 넘어섰다.**

문제는 **언어는 있는데 문법이 없다**는 점이다. 색·반경·그림자·글자 크기는 토큰이 있지만 **간격 토큰이 0개**이고, 글자 크기 리터럴은 약 30종, padding 값은 86종이다. 그래서 같은 역할의 요소(패널 헤더, 버튼, 모달, 오류 문구)가 화면마다 다르게 생겼다. 테마 3종 중 **클로드 테마는 라이트용 보정을 물려받지 못해 대비가 무너진 곳**이 여럿 있다. 다듬을 대상은 "새 비주얼"이 아니라 **이미 있는 언어의 문법화(토큰화)와 테마 패리티**다.

---

## 2. 🔴 치명 (5건)

### 🔴1. 코드 뷰어가 토큰 사이 공백과 들여쓰기를 지운다
- **화면**: 소스 코드 뷰어(`sample.ts`) — `32-viewer-code_light-1280.png`, `32-viewer-code_dark-1280.png`
- **문제**: `importtype`, `exportfunctiongreet`, `return42`, `exportconstVERSION`처럼 키워드 사이 공백이 사라졌고, 함수 본문의 2칸 들여쓰기도 0이 됐다. 하이라이트되지 않은 줄(`const greeting = …`)만 공백이 산다.
- **원인**: `src/extensions/code-viewer/index.ts`의 주입 CSS `.code-viewer-line { display: flex; white-space: pre; }`. flex 컨테이너에서는 `<span>` 사이의 공백만 있는 텍스트 런이 익명 flex item이 되고, CSS Flexbox 규칙상 렌더되지 않는다. 엔진 공통 동작이라 WKWebView에서도 재현될 것이다.
- **왜 치명인가**: 코드 뷰어의 존재 이유(코드를 정확히 보여 주기)가 깨진다. 디자인 이전에 신뢰 문제다.
- **개선안**: 줄 내용을 인라인 래퍼 하나로 감싸 inline formatting context를 되살린다. `row.innerHTML = '<span class="code-viewer-text">' + html + '</span>'` 그리고 `.code-viewer-text { white-space: pre; min-width: 0; }`. 또는 `.code-viewer-line { display: block; padding-left: calc(var(--code-gutter-digits)*1ch + 2.5ch); position: relative }`로 바꾸고 `::before`를 `position:absolute; left:0`으로 둔다. 같은 블록의 `var(--mono, …)`도 존재하지 않는 토큰이니 `var(--font-mono)`로 고친다.

### 🔴2. 클로드 테마 콜아웃 제목 대비가 1.2–1.3:1이다
- **화면**: 문서 콜아웃 — `45-callouts_claude-2x.png`, `02-doc-top_claude-1280.png`, `_sheet_A.png`(우하)
- **실측**: warning 제목 `#fcd34d` on `#fbf1d8` = **1.28:1**, tip 제목 `#67e8f9` on `#ddf1f1` = **1.24:1**. 사실상 보이지 않는다.
- **원인**: `styles.css:664-697`에서 콜아웃 머리색의 기본값은 **다크 캔버스용 파스텔**이고, 어두운 값으로 덮는 보정은 `:root[data-theme="light"]`에만 있다. 클로드는 밝은 테마인데도 보정을 받지 못해 11종(abstract/info/todo/tip/success/question/warning/failure/danger/bug/example) 전부가 같은 상태일 것으로 추정한다(warning/tip은 실측, 나머지는 같은 규칙).
- **왜 치명인가**: 콜아웃의 핵심 신호(종류·제목)가 사라진다. 기본 테마 중 하나에서 WCAG 1.4.3을 크게 위반한다. 커스텀 JSON 밝은 테마도 같은 함정에 빠진다.
- **개선안**:
  1. 즉시: 셀렉터를 `:root:is([data-theme="light"],[data-theme="claude"]) .cm-callout-*.cm-callout-head`로 넓힌다.
  2. 근본: 머리색을 테마 극성에서 **파생**한다. `--callout-head: color-mix(in srgb, <hue> 55%, var(--fg))` 패턴을 쓰면 다크에서는 밝게, 라이트·클로드·커스텀에서는 어둡게 자동으로 수렴한다(`--block-fill`과 같은 기법).
  3. 라이트 보정값도 대부분 AA 미달이다(아래 §5 표). tip `#0891b2` → `#155e75`(5.99:1), warning `#b45309` → `#92400e`(6.09:1), success `#16a34a` → `#15803d` 이상으로 함께 올린다.

### 🔴3. 레일을 열면 좌측 커맨드 그룹이 레일 밖으로 넘쳐 잘린다
- **화면**: 사이드바(탐색기·목차·최근·검색·워크스페이스) 전부 — `10-explorer_light-1280.png`, `42-rail-top_light-2x.png`, `_sheet_rail.png`
- **실측**: 레일 오른쪽 끝 241px, `.left-command-group`의 오른쪽 끝 **256px**. 6번째 버튼(경로 열기)이 레일 경계에서 반쯤 잘리고 에디터 쪽으로 새어 보인다. 계산은 `78px 인셋 + 6×28px + 간격 5×~2px ≈ 256`.
- **왜 치명인가**: 기본 폭(240)에서 늘 깨져 보이는 1차 크롬이다. "공개 품질"의 첫인상을 해친다. 실앱에서는 신호등이 좌측 78px를 실제로 차지하므로 회피할 방법도 없다.
- **개선안**(택1):
  - (A) 레일 기본폭과 최소폭을 그룹 폭에서 파생한다. `clampSidebarWidth` 최소를 `78 + groupWidth + 12 ≈ 264px`로, 기본도 264로 둔다.
  - (B) 레일 안에서는 그룹을 패널 토글 4개(워크스페이스·탐색기·최근·목차)만 남기고, 검색·경로 열기는 메인 타이틀바 좌측에 둔다. 레일 상단 = "어떤 패널", 타이틀바 = "무엇을 할지"로 역할도 갈린다.
  - (C) 폭이 모자라면 `…` 오버플로 메뉴로 접는다(ResizeObserver 1개).
  - 권장은 (B)다. 레일 상단 스트립의 역할이 깔끔해지고 폭 의존이 사라진다.

### 🔴4. 클로드 테마의 활성 세그먼트가 흰 글자 on 코랄(3.11:1)이고, 코랄이 남발된다
- **화면**: 설정 › 에디터 — `20-settings-2_claude-1280.png`, 설정 › Mermaid·원격 공유(클로드)
- **실측**: 활성 pill 글자 `#faf9f5` on `#cc785c` = **3.11:1**(13px, AA 4.5 미달). 슬라이더 thumb·포커스 링 같은 비텍스트 UI도 코랄 on surface `#efe9de` = **2.71:1**(비텍스트 3:1 미달).
- **왜 치명인가**: (1) 설정 화면 전체에서 "현재 값"을 읽는 텍스트가 AA 미달이다. (2) `DESIGN_CLAUDE.md`와 `SETTINGS_REDESIGN_BRIEF.md` §3의 핵심 규칙("코랄은 scarce — primary·active에만")을 어긴다. 한 pane에 코랄 pill이 4~5개 동시에 켜져서 코랄이 액센트가 아니라 배경 패턴이 된다.
- **개선안**: 클로드 테마의 세그먼트 활성 상태를 **"카드 칩"**으로 바꾼다. 배경 `#ffffff`(또는 `color-mix(in srgb, var(--bg) 60%, #fff)`), 글자 `var(--fg)` `#141413`(18.4:1), 1px `var(--border)` 헤어라인, 그림자 `0 1px 2px rgba(20,20,19,.08)`. 코랄은 pane당 1개의 primary 액션(예: 업데이트 확인)과 포커스 링에만 쓴다. 코랄을 유지해야 한다면 글자를 잉크 `#141413`으로(5.63:1) 바꾼다. 슬라이더 thumb은 `var(--link)` `#a9583e`(on `#efe9de` 4.19:1, 비텍스트 3:1 충족)로 바꾼다.

### 🔴5. 문서를 편집하는 동안 현재 파일명이 화면 어디에도 없다
- **화면**: 문서 편집·리더 전 화면 — `02-doc-top_light-1280.png`, `05-doc-edit_light-1280.png`, 대조: `32-viewer-code_light-1280.png`(뷰어는 파일명을 표시)
- **문제**: 타이틀바의 `titleSlot`(`.title-bar-doc-title`)은 **뷰어만** 쓴다. 문서 모드의 타이틀바 가운데는 비어 있고, 상태바 브레드크럼은 "탐색기 루트"(`/ › mock › vault`)를 보여 줄 뿐 열린 파일(`demo.md`)은 아니다. 네이티브 타이틀은 `hidden_title(true)`로 숨겼다.
- **왜 치명인가**: 위치 감각(wayfinding)은 문서 에디터의 기본 약속이다. 위키링크·⌘[/⌘]로 문서를 넘나드는 앱에서 "지금 어느 파일인가"를 알 수 없다. 같은 앱 안에서 뷰어는 파일명을 보여 주고 문서는 보여 주지 않는 비대칭도 생긴다.
- **개선안**: 문서 모드에서도 `titleSlot`에 `파일명`(13px/500, `var(--fg)`)과 미저장 점(6px 원, `var(--muted)`, 저장 중 pulse)을 넣는다. 가운데 정렬은 하지 않고 좌측 그룹 뒤에 둔다(뷰어와 같은 자리). 브레드크럼 마지막 세그먼트로 파일명을 이어 붙이는 안(`vault › demo.md`, 파일 세그먼트는 비클릭·`aria-current="page"`)도 일관적이다.

---

## 3. 🟡 중요 (16건)

| # | 화면·요소 | 문제 | 왜(원칙) | 개선안(값 수준) | 근거 |
|---|---|---|---|---|---|
| Y1 | 상태·오류 색 전반 | 시맨틱 상태 토큰이 없다. `#dc2626` 리터럴 21회, `#e28080`·`#ef4444`·`#fca5a5`·`#be123c` 혼용, `var(--danger)`는 정의 없이 폴백으로만 2회 등장. 다크에서 `#dc2626` on `#131110` = **3.90:1**, 라이트에서 충돌 상태 `#d97706` on `#f5f5f5` = **2.92:1** | 같은 의미(오류·충돌)가 테마마다 다른 대비, 위치마다 다른 빨강 | 테마별 `--danger`/`--warning`/`--success` 정의. 라이트 `#b91c1c`(5.93)/`#b45309`(4.61)/`#15803d`(4.60), 다크 `#f87171`(6.81)/`#fbbf24`(11.3)/`#4ade80`(10.8), 클로드 `#b42318`(6.24)/`#92400e`(6.73). 배경 틴트는 `color-mix(var(--danger) 10%, transparent)`로 통일 | `styles.css` 591·740·1002–1069·1531·1613·1636·2462·2586·2747 |
| Y2 | 본문 헤딩 스케일 | 실측 H1 31.25 / H2 25 / **H3 22.36** / H4 17.89 / H5 16 / H6 14.4px. H2→H3 단계가 1.118배뿐이고 굵기도 같은 600이라 "핵심 지표"(H2)와 "아키텍처"(H3)가 구분되지 않는다. 지수가 (3, 2, **1.5**, 0.5, 0, −0.5)로 불규칙하다 | 위계는 크기·굵기·색 중 최소 하나가 확실히 달라야 한다 | 지수를 (3, 2, 1, 0.5, 0, −0.5)로: H3 = ratio¹ = **20px**. H5는 600 + `letter-spacing:.01em`, H6는 `--muted` + 600 + `0.8125em`. 헤딩 위 여백도 H2 `1.6em` / H3 `1.2em` / H4+ `.9em`로 단계화 | `03-doc-mid_light-1280.png`, `04-doc-end_light-1280.png` |
| Y3 | 사이드바 패널 헤더 | 헤더 높이가 목차·최근·검색 30px, 워크스페이스 41px, 탐색기 44px로 제각각이고 첫 행 시작 y도 다르다. 레일을 바꿀 때마다 목록이 위아래로 튄다 | 같은 셸(`.sidebar-aside`) = 같은 헤더 | `.sidebar-header`를 `height: 36px; display:flex; align-items:center; padding: 0 12px`로 고정하고 오른쪽 액션 슬롯(24px 고스트 버튼)을 늘 예약. 글자는 11px/600 `--sidebar-muted` 유지 | `10/12/13/14/15-*_light-1280.png` |
| Y4 | 설정 › 행 레이아웃 | 브리프가 지적한 **라벨 124px 고정**이 그대로라 "웹폰트 (Google Fonts)"가 2줄로 깨진다. 단축키·뷰어 pane은 라벨 하나("단축키", "뷰어")가 20행짜리 목록의 **세로 중앙**에 떠 있다. pane 제목은 "원격 공유"에만 있다. 헤더는 62px 높이에 12px 캡션(uppercase는 한글에 무효) | 그리드 일관성, pane 정체성 | 라벨 열 `minmax(140px, 32%)` + `word-break: keep-all`. list형 kind(keybind·viewer 토글)는 라벨 셀 없이 full-width, 상단에 서브헤딩. 모든 pane 상단에 제목(20px/600, 클로드는 `--font-heading` 400). 헤더 48px, 제목 13px/600 | `20-settings-1/5/6_light-1280.png`, `_sheet_settings_light.png` |
| Y5 | 설정 › 불리언 | Vim·이미지 재귀 검색·숨김 파일·HTML 스크립트 같은 on/off를 "켜기|끄기" 세그먼트로 표시한다. **꺼짐일 때 "끄기"가 진한 칩**이라 꺼진 항목이 시각적으로 가장 강조된다 | 상태 표현: 활성 강조는 "켜짐"이어야 한다 | 불리언은 스위치(32×18, 트랙 `--border`→`--accent`, thumb 14px)로. 세그먼트는 3개 이상 선택지에만 | `20-settings-2/3/6_light-1280.png` |
| Y6 | 버튼 체계 | 확인한 스타일만 7종이다. 폴더 열기(잉크 채움 r8), 업데이트 확인(잉크 채움+아이콘), 재정의/기본값(헤어라인 r6 소형), 전체 리셋, 페어링 코드 만들기(고스트 점선 느낌), 연결 해제, xlsx 시트 탭(아웃라인 pill), 원격 볼트 "페어링"(회색 채움 full-width) | 같은 위계 = 같은 모양 | 3단 × 2사이즈로 정리. `primary`(채움 `--accent`, 글자 `--on-accent`), `secondary`(1px `--border`, 배경 `--surface`), `ghost`(투명, hover 7% fg). 높이 sm 24 / md 32, 반경 `--radius-md`. 단축키 행의 재정의·기본값은 행 hover 시에만 노출(기본값은 변경된 행에만) | `01-welcome_*`, `20-settings-5/8/9_*`, `33-viewer-xlsx_*`, `52-remote-dialog_*` |
| Y7 | 모달·팝오버 surface | 설정 = `--surface` r16 `0 12px 48px .24`, 복구·충돌 = `--bg` r12 `0 16px 48px .35`, 컨텍스트 메뉴 = `--bg` r8 `0 8px 24px .28`, 자동완성 = `--surface`. 다크에서 컨텍스트 메뉴(`#131110`)가 그 아래 레일(`#201c19`)보다 **어둡다**(고도 역전) | 고도는 surface 명도로 일관되게 표현(DESIGN_CLAUDE "깊이는 surface 대비로") | `--elev-1`(팝오버: `--surface`, r8, `0 4px 16px rgb(0 0 0/.18)`), `--elev-2`(모달: `--surface`, r12, `0 12px 40px rgb(0 0 0/.24)`) 두 단계만 둔다. 레일 위 메뉴는 `--sidebar-*`에서 한 단계 밝힌 `color-mix(var(--sidebar-bg) 88%, #fff)` | `11-context-menu_dark-1280.png`, `styles.css:1016·1042·2074·2420` |
| Y8 | 한국어 줄바꿈 | 본문(`집중했/다`, `인/라인`, `중요/한 결정`), 워크스페이스 빈 상태(`있습/니다`), 변경 내역(`열/기`)이 음절 중간에서 끊긴다. `keep-all`은 오류 문구·표 셀 등 6곳에만 흩어져 있다 | 한국어 조판 관례(어절 단위), 규칙의 전역성 | 크롬 전역: `body { word-break: keep-all; overflow-wrap: anywhere; }`. 본문(`.cm-line`)은 설정 "한국어 어절 줄바꿈"(기본 켬)으로 두고, 끄면 `normal` | `02-doc-top_light-900.png`, `15-workspace_light-1280.png`, `20-settings-8_light-1280.png` |
| Y9 | 블록 위젯 문법 | mermaid = 아웃라인 프레임(투명), 코드 = `--block-fill` 채움 r8, 콜아웃·인용 = 채움 + 좌측 바(반경 0), 표 헤더 = `--surface`(라이트에서 **흰색이라 캔버스보다 밝아** 역전). 블록 좌측 시작 230px과 본문 텍스트 236px이 **6px 어긋난다**(순서 목록 번호도 230) | 같은 "블록" 계층 = 같은 컨테이너 규칙 | 블록 공통 `--block-radius: 8px`, 공통 인셋(텍스트 x와 블록 내부 텍스트 x를 정렬해 블록 외곽이 `-12px` 바깥으로 나가게), 표 헤더 `--block-fill`, mermaid 프레임도 `--block-edge` 1px + 투명으로 "코드와 같은 가족" 유지. 콜아웃은 `border-radius: 0 8px 8px 0` | `02-doc-top_light-1280.png`, `03-doc-mid_*` |
| Y10 | 표 헤더 정렬 | 정렬 미지정 열의 헤더("항목")는 가운데, 본문은 왼쪽이다. UA 기본 `th { text-align:center }`가 그대로 남았다 | 열 정렬 일관성 | `.cm-table th { text-align: left }` 후 GFM `:--:`/`--:` 정렬 클래스만 덮어쓴다 | `02-doc-top_*` |
| Y11 | 폴드 마커 | 모든 헤딩·콜아웃 왼쪽에 셰브런이 있다. 평소 .3, **에디터 어디든 hover하면 전부 .75**로 켜진다. 리더 모드에서도 보인다 | 읽기 화면의 잡음, 점진적 노출 | hover한 줄의 마커만 1.0, 나머지는 0. 리더 모드에서는 접힌 블록의 마커만 표시. 접힌 상태는 `▸` + `…` 칩으로 | `02/03/04-doc-*` |
| Y12 | 라이트 뮤트 텍스트 | `--muted #777169` on `#f5f5f5` = **4.43:1**. 브레드크럼, Ln/Col, H6, 타이틀바 아이콘 등 13px 크롬 텍스트 전부가 AA를 근소하게 놓친다. 클로드 설정 help `#6c6a64` on `#efe9de` = 4.48:1 | WCAG 1.4.3 | 라이트 `--muted: #6f6a63`(4.92), 클로드 설정 surface 위 보조 텍스트 `#5f5d58`(5.44) | `41-statusbar_light-2x.png` |
| Y13 | 코드블록 ↔ 코드 뷰어 | 에디터 코드블록은 **무채색**, 코드 뷰어는 hljs 7색(테마별 하드코딩 hex 3세트). 같은 앱 안에서 "코드"가 두 얼굴이다. 언어 라벨 "TS"는 9px대 모노로 거의 안 보인다 | 같은 콘텐츠 = 같은 표현 | 에디터 코드블록도 같은 `--code-*` 토큰을 쓰도록 승격(styles.css :root/테마 블록으로 이동). 언어 라벨 11px/500 `--muted`, `letter-spacing:.04em` | `44-codeblock_light-2x.png`, `32-viewer-code_*` |
| Y14 | 뷰어 캔버스 | 이미지 뷰어 체커보드가 **pane 전체**를 덮어 64px 이미지가 노이즈 속에 묻힌다. PDF 페이지는 흰 면이 pane 끝까지 닿아 페이지 경계가 없다 | 피사체-배경 분리 | 체커보드는 이미지 박스 뒤에만(`background` on `img` 래퍼), pane은 `--bg`. PDF는 페이지 간 16px 간격 + `0 1px 3px rgb(0 0 0/.12)` + pane `--block-fill` | `30-viewer-image_*`, `31-viewer-pdf_*` |
| Y15 | 상태바 맥락 | 문서가 없는 웰컴에서도 너비 슬라이더가 보인다. 리더 모드와 뷰어에서도 `Ln 1, Col 1`이 남아 있다(뷰어에서는 의미 없는 stale 값). 슬라이더에는 라벨도 값도 없다 | 맥락 없는 크롬 = 잡음 | 웰컴·뷰어에서 슬라이더와 pos를 숨기고, 리더 모드에서는 pos를 단어 수/읽기 시간으로 바꾼다. 슬라이더 hover 시 `68%` 툴팁 | `01-welcome_*`, `30~33-viewer-*` |
| Y16 | 아이콘 의미 | 탐색기(folder)와 경로 열기(folder-open)가 거의 같은 글리프다. 워크스페이스·목차 아이콘도 둘 다 "리스트+선"이다. 모드 토글은 **현재 상태**(리더=눈)를 보여 줘서 "누르면 무엇이 되는가"를 짐작하기 어렵다 | 아이콘 = 고유 의미, 토글 = 일관된 규약 | 경로 열기 → `corner-down-right`/`terminal-square`, 워크스페이스 → `layers`/`library`. 모드·테마 토글은 "현재 상태 표시 + 활성 시 4% 채움" 규약으로 통일하거나, 둘 다 "다음 동작"으로 통일(현재 테마 토글은 상태 표시) | `40-titlebar-closed_*-2x.png` |

---

## 4. 🟢 다듬기 (9건)

| # | 요소 | 관찰 | 제안 |
|---|---|---|---|
| G1 | 라이트 테마 레일 | 밝은 캔버스 옆의 `#1c1c1e` 레일은 의도된 두 톤(SIDEBAR CONTRAST RULE)이다. 다만 컬러 파일 아이콘과 흰 컨텍스트 메뉴가 겹쳐 "VS Code 다크 사이드바"처럼 읽혀 라이트의 에디토리얼 톤과 결이 다르다 | 유지하되 **"레일 톤: 대비/조화"** 설정(조화 = `color-mix(var(--bg) 92%, var(--fg))`, 대략 `#e9e9e8`)을 추가하는 것을 검토 |
| G2 | 웰컴 | 워드마크가 Inter Bold 32px뿐이라 클로드 테마의 세리프 정체성이 빠진다. 화면 중앙의 정보 밀도가 매우 낮다 | 워드마크에 `--font-heading`(클로드=세리프 400), 아래 한 줄 태그라인(`--muted` 14px), 단축키 힌트를 `kbd` 칩(1px border, r4, 11px)으로 |
| G3 | 검색 퍼지 하이라이트 | 일치 글자마다 회색 사각 블록이 붙어(`note s/a.m d`) 얼룩져 보인다 | 블록 배경 대신 `color: var(--sidebar-accent); font-weight: 600` |
| G4 | 원격 볼트 다이얼로그 | 240px 레일 안에 인라인으로 열려 placeholder가 잘리고(`wis-macmini 또는 wis-`), help 텍스트가 밝은 굵은 글씨라 본문보다 튄다 | 설정 모달과 같은 `--elev-2` 소형 모달(400px)로 옮기거나, help를 `--sidebar-muted` 12px regular로 |
| G5 | 목차 | 현재 읽는 섹션 표시가 없다. H1–H3가 모두 600이라 무겁다 | 스크롤 연동 현재 항목에 2px 좌측 바(`--sidebar-accent`), H1만 600·나머지 400 |
| G6 | 기본 본문 글꼴 | `--font-sans: Inter, system-ui`라 한글은 OS 폴백(엔진마다 다를 수 있다). Pretendard는 번들돼 있지만 opt-in이다 | 한국어 사용자 기본값으로 `"Inter", "Pretendard Variable", system-ui`(Pretendard는 한글 글리프 매칭 시에만 로드) |
| G7 | 죽은 토큰·폰트 | `--font-display`(Cormorant Garamond 300)는 선언되고 woff2도 번들됐지만 **사용처가 0**이다. `var(--radius-sm, 4px)`는 토큰(6px)과 폴백이 어긋난다. `14px`·`999px`·`2px` 반경 리터럴이 있다 | 제거하거나 웰컴 워드마크(G2)에 사용. 폴백 정리 |
| G8 | 간격·글자 토큰 | 간격 토큰 0개, padding 값 86종, font-size 리터럴 약 30종(13px×30, 12px×20 …) | `--space-1..6`(4/8/12/16/24/32), `--text-xs/sm/md`(11/12/13) 크롬 3단만 먼저 도입하고 신규 코드부터 강제 |
| G9 | 설정 헤더 타이틀 | 12px uppercase + tracking은 영문 마케팅 스케일의 번역이라 한글 "설정"에는 효과가 없고 작기만 하다 | 13px/600, tracking 0 |

---

## 5. 테마별 문제 (WCAG 실측)

| 쌍 | 라이트 | 다크 | 클로드 | 판정 |
|---|---|---|---|---|
| 본문 잉크 / 캔버스 | 18.12 | 18.83 | 17.50 | 통과 |
| 링크 | `#1d6fb8` 4.79 | `#a8c8e8` 10.84 | `#a9583e` 4.80 | 통과(라이트·클로드는 여유 적음) |
| 인라인 코드 | 14.66 | 10.39 | `#a9583e` on `#f3efe7` **4.41** | 클로드 근소 미달 → `#93492f`(5.66) |
| 하이라이트 | 16.36 | 14.16 | 13.34 | 통과 |
| 뮤트(브레드크럼·Ln/Col·H6·아이콘) | **4.43** | 7.47 | 5.13 | 라이트 근소 미달(Y12) |
| 콜아웃 warning 제목 | **4.31** | 10.49 | **1.28** | 🔴2 |
| 콜아웃 tip 제목 | **3.03** | 11.00 | **1.24** | 🔴2 |
| 활성 세그먼트 글자 | 13.9(잉크 칩) | 10.8(스카이 칩) | **3.11**(코랄 칩) | 🔴4 |
| 코랄 thumb·링(비텍스트) / 설정 surface | — | — | **2.71** | 🔴4 |
| 오류 빨강 `#dc2626` | **4.43** | **3.90** | — | Y1 |
| 충돌 앰버 `#d97706` | **2.92** | — | **3.02** | Y1 |
| 레일 뮤트 / 레일 bg | 6.52 | 6.71 | 6.91 | 통과 |
| 클로드 레일 액센트 `#e0906f` | — | — | 6.99 | 통과 |

**테마 성격 요약**
- **라이트**: 가장 정돈됐다. 약점은 "거의 AA" 값들(뮤트 4.43, 콜아웃 머리 3.0–4.3)이 몰려 있다는 것이다. 표 헤더가 흰색(`--surface`)이라 캔버스보다 밝은 역전도 라이트에만 있다.
- **다크**: 대비는 가장 건강하다. 다만 **액센트 = 링크 = 스카이 블루**라 링크·포커스·활성 칩·푸터 업데이트 버튼이 모두 같은 색이어서, "누를 수 있는 텍스트"와 "선택된 상태"가 구분되지 않는다. 노트 콜아웃 배경(`#1c1b1a`)과 캔버스(`#131110`)는 차이가 작아 "면"으로 거의 읽히지 않는다. 이를 `--block-fill` 4% → 6%로 올리는 것을 검토한다. 컨텍스트 메뉴의 고도가 역전된다(Y7).
- **클로드**: 정체성(크림·세리프 헤딩·코랄 링크)이 가장 강하다. 그런데 **라이트용 보정의 상속 누락**(콜아웃 머리), **코랄 과다**(세그먼트·thumb), **설정 surface 위 대비 부족**이 겹쳐 대비 결함이 가장 많다. 클로드를 "라이트의 변형"으로 선언하는 `:is([data-theme=light],[data-theme=claude])` 공통 레이어가 필요하다.

---

## 6. 일관성 감사 — 같은 역할, 다른 모양

| 역할 | 변형들 | 통일안 |
|---|---|---|
| **패널 헤더** | 사이드바 30/41/44px(Y3) · 설정 모달 헤더 62px+12px · 원격 공유 pane만 굵은 제목 · 뷰어는 타이틀바에 파일명 | 사이드바 36px 고정, 모달 48px, pane 제목 20px 공통 |
| **버튼** | 7종(Y6) | primary/secondary/ghost × sm/md |
| **탭·세그먼트** | 설정 세그먼트(채움 pill) · xlsx 시트 탭(아웃라인 pill r6) · sqlite 탭 · 레일 토글(채움 r8) | "선택 = 채움 칩, 비선택 = 텍스트" 한 규칙. xlsx·sqlite 탭도 같은 `.seg` 컴포넌트로 |
| **메뉴·팝오버** | 컨텍스트 메뉴 `--bg` r8 · 자동완성 `--surface` · 각주 미리보기 카드 `--surface` r6 | `--elev-1` 하나(Y7) |
| **모달** | 설정 `--surface` r16 · 복구·충돌 `--bg` r12 · 원격 볼트 = 레일 인라인 | `--elev-2` 하나, 원격 볼트도 모달로(G4) |
| **입력** | 검색 입력(레일, 2px 밝은 링) · 설정 텍스트 입력(r8 헤어라인) · 경로 열기(상태바 변신) · 원격 볼트(어두운 박스) | 높이 32, r8, 1px `--border`, 포커스 = 2px `color-mix(var(--accent) 50%)` 공통 |
| **빈 상태** | 웰컴 히어로 · 워크스페이스 "등록된 영구 볼트가 없습니다…"(본문색·음절 끊김) · 플러그인 "등록된 플러그인 설정이 없습니다."(설정 행 안) · 목차 빈 상태 `--sidebar-muted` | 아이콘 20px + 한 줄 제목(600) + 보조 1줄(`--muted`) + 선택적 CTA. `keep-all` |
| **오류 표시** | mermaid 오류 `#dc2626` 텍스트 · 링크 오류 wavy · 버전 오류 10% 틴트 박스 · 워크스페이스 배지 `#e28080` · 원격 다이얼로그 `var(--danger,#e28080)` · JSON 12px | `--danger` 토큰 + "인라인 텍스트 / 틴트 박스" 두 형식만(Y1) |
| **블록 컨테이너** | mermaid 아웃라인 · 코드 채움 · 콜아웃 채움+바 · 표 흰 헤더 | Y9 |
| **상태 아이콘 규약** | 모드 토글 = 현재 상태 · 테마 토글 = 현재 상태 · 레일 토글 = 열림 시 채움 | "채움 = 켜짐" 하나로(Y16) |

---

## 7. 잘 된 점 (유지할 것)

1. **읽기 컬럼의 기본기**: 68% 측정폭, `justify-content: safe center`, `text-wrap: pretty`, `font-optical-sizing`, 헤딩 음수 트래킹 토큰(em 단위라 줌에서도 유지). 본문 품질은 이미 Obsidian 기본 테마보다 정돈돼 있다.
2. **크롬의 절제**: 28px 아이콘 고스트 버튼, 무경계 타이틀바·상태바, 레일과 에디터의 심리스 경계. 문서가 늘 주인공이다.
3. **파생 토큰 사고**: `--surface-veil`, `--block-fill`/`--block-edge`, `--sidebar-bg`의 `var(--bg) 8%` 앵커는 커스텀 JSON 테마까지 자동으로 따라가는 좋은 설계다. 이 기법을 콜아웃 머리색(🔴2)과 상태색(Y1)으로 넓히는 것이 이번 리뷰의 핵심 처방이다.
4. **포커스 링**: 세 테마 모두 액센트 기반의 뚜렷한 `:focus-visible` 링을 보여 준다(`43-focus-chrome_*-2x.png`). 키보드 사용자를 배려한다.
5. **SIDEBAR CONTRAST RULE**: 레일 텍스트 대비가 세 테마 모두 6.5:1 이상으로 안정적이다. 다크에서 반전 대신 "한 단계 밝은 pole"로 바꾼 판단도 맞다.
6. **클로드 테마의 정체성**: 크림 캔버스 + 세리프 헤딩 + 코랄 링크·인라인 코드 조합은 개인 앱에서 보기 드문 브랜드 완성도다(`02-doc-top_claude-1280.png`). 결함은 보정 누락이지 방향이 아니다.
7. **테마 색상 에디터(시안 B)**: 렌더된 샘플을 직접 클릭해 색을 바꾸는 방식은 설정 UI로서 독창적이고 직관적이다.
8. **좁은 폭 대응**: 900px에서도 측정폭이 창 비례라 레이아웃이 무너지지 않고, 설정 모달은 `92vw`로 깔끔하게 적응한다(`20-settings-1_light-900.png`).

---

## 8. 우선순위 로드맵 Top 5

1. **테마 패리티 패스 (🔴2 · 🔴4 · Y12 · §5)** — `:root:is([data-theme=light],[data-theme=claude])` 공통 레이어를 만들고, 콜아웃 머리색을 `color-mix` 파생으로 바꾸고, 클로드 활성 칩을 잉크 on 카드로, 라이트 `--muted`를 `#6f6a63`으로 바꾼다. *CSS만 손대며 대비 결함의 대부분이 사라진다.* 검증은 이번에 쓴 대비 실측 스크립트(`scratchpad/dr-scripts/metrics.mjs`)를 골든으로 승격하는 것을 권장한다.
2. **즉시 버그 2건 (🔴1 · 🔴3)** — 코드 뷰어 줄 래퍼(공백 복원)와 레일 상단 그룹 재배치(검색·경로 열기를 타이틀바로). 각각 몇 줄 수준이다.
3. **위치 감각 (🔴5 · Y15)** — 문서 모드 타이틀바에 파일명과 미저장 점을 넣고, 상태바 요소를 맥락에 따라 숨긴다.
4. **크롬 문법화 (Y1 · Y3 · Y6 · Y7 · G8)** — `--danger/--warning/--success`, `--elev-1/2`, `--space-*`, `--text-xs/sm/md`, 버튼 3단을 도입한다. 사이드바 헤더 36px를 통일한다. 이후 신규 UI는 토큰만 쓰도록 리뷰 체크리스트에 추가한다.
5. **본문 타이포·블록 문법 (Y2 · Y8 · Y9 · Y10 · Y11 · Y13)** — H3 = ratio¹, 한국어 `keep-all`, 블록 반경·인셋 통일, 표 헤더 정렬, 폴드 마커 점진 노출, 코드블록 구문 강조 토큰 공유. 설정 패널 행 레이아웃(Y4·Y5)은 `SETTINGS_REDESIGN_BRIEF.md`의 미해결 항목이므로 이 단계에서 브리프와 함께 닫는다.

---

### 부록 A. 주요 스크린샷 인덱스

| 화면 | 파일 |
|---|---|
| 웰컴 | `01-welcome_{light,dark,claude}-1280.png`, `01-welcome_{light,dark}-900.png` |
| 문서(리더) 상·중·하 | `02-doc-top_*`, `03-doc-mid_*`, `04-doc-end_*` |
| 문서(편집) | `05-doc-edit_*` |
| 사이드바 | `10-explorer_*`, `12-outline_*`, `13-recent_*`, `14-search_*`, `15-workspace_*` |
| 우클릭 메뉴 | `11-context-menu_*` |
| 설정(10개 카테고리) | `20-settings-{0..9}_*` (0 테마, 1 타이포, 2 에디터, 3 탐색기, 4 Mermaid, 5 단축키, 6 뷰어, 7 플러그인, 8 버전, 9 원격 공유) |
| 뷰어 | `30-viewer-image_*`, `31-viewer-pdf_*`, `32-viewer-code_*`, `33-viewer-xlsx_*` |
| 디테일 2x | `40-titlebar-closed_*`, `41-statusbar_*`, `42-rail-top_*`, `43-focus-chrome_*`, `44-codeblock_*`, `45-callouts_*` |
| 다이얼로그 | `51-vault-add_*`, `52-remote-dialog_*` |
| 비교 시트 | `_sheet_settings_light.png`, `_sheet_A~D.png`, `_sheet_bars.png`, `_sheet_rail.png`, `_sheet_focus.png`, `_sheet_callouts.png` |

### 부록 B. 재현

```
npm run dev:browser   # :1430
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --remote-debugging-port=9333 --user-data-dir=<임시폴더> about:blank
node <scratchpad>/dr-scripts/capture.mjs <light|dark|claude> <1280|900> [welcome,doc,sidebars,settings,viewers]
node <scratchpad>/dr-scripts/metrics.mjs <theme>   # 대비·헤딩·헤더 실측
```
