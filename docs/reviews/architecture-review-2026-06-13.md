# Architecture Review — 2026-06-13

> 진단 + 방향 제안까지만. 단계별 plan·커밋 계획·Golden Master 시나리오 목록은 `superpowers:writing-plans`가 담당. 이 문서는 코드를 수정하지 않는다.

## 컨텍스트 (자동 추론 + 사용자 확인)

- **서비스**: CLI로 단일 `.md` 파일을 여는 경량 데스크톱 Markdown+Mermaid 에디터. 터미널에서 AI로 문서작업할 때 빠르게 확인/편집하는 용도. 원래 read-only 뷰어였으나 편집·저장·Obsidian식 라이브프리뷰로 진화. [확인됨]
- **코드베이스 규모**: ~2,015줄 TS(프론트) + Rust(Tauri 4 commands: read_file/write_file/path_exists/open_path). 32개 파일. [추론]
- **주요 도메인**: 라이브프리뷰 렌더(데코/위젯), CM 확장 배선, 파일 IO(Tauri), 테마/모드/폴드, 커스텀 마크다운 문법(wikilink/math/footnote, Lezer 노드). [추론]
- **주 사용자**: 본인(터미널+AI 워크플로우). 멀티탭/파일탐색기 불필요 — **여러 문서 = 여러 창**. [확인됨]
- **다음 방향**: 탭·탐색기 없음. **빠른 로딩 속도**가 중요. **설정(테마·레이아웃·폰트·플러그인 설정)** 패널 필요. **플러그인 시스템(확장성) 필수** — "아키텍처를 잘 만들어놓는 게 중요". [확인됨]
- **개발 환경**: 혼자. [확인됨]

> ℹ️ 이 컨텍스트는 이번 진단 한 번에만 사용됩니다. 누적 원칙 문서가 필요해지면 `service-design`을 실행하세요. (혼자 작업이라 현재는 불필요.)

## 요약

- **진단 대상**: 32파일 / ~2,015줄 / 단일 창·단일 파일 앱
- **주요 증상**: **사용자 설정(preference) 상태가 단일 소스 없이 설정마다 ~5개 sink로 수동 fan-out** — 새 설정 1개 추가 시 4~5개 파일 수정 필요
- **권장 패턴**: **Single Source of Truth (설정 스토어)** — 1개
- **플랜 스킬 호출 필요**: Yes

---

## 상태 지도 (State Map)

| 값의 정체성 | 쓰기(writer) | 읽기/반영(sink) | 중복/평가 |
|---|---|---|---|
| **문서 텍스트** | CM `EditorState`(autosave가 Tauri write_file로 영속) | 모든 데코/위젯 | ✅ CM이 SSOT. 양호 |
| **폴드 범위** | CM fold state | 불릿 halo, 데코 rebuild | ✅ CM이 SSOT. 양호 |
| **mode (read/edit)** | `controller.setMode` (editor.ts:87) | localStorage `mermark.mode` · `modeCompartment`(editor.ts:91) · `modeFacet`(core.ts:54·196·347·365·404) · 상태바 라벨(main.ts) · Mod-e 핸들러 2곳 | ⚠️ 단일 writer지만 **sink 5+곳 수동 fan-out** |
| **theme (light/dark)** | `makeThemeToggle` 클릭(theme.ts:33-36) | localStorage `mermark.theme` · `documentElement.dataset.theme`(theme.ts:16) · mermaid가 dataset 직접 읽기(mermaid-widget.ts:11·43) · mermaid `themeVersion`/baked SVG · CSS vars · 상태바 라벨 · onChange→`refreshMermaidTheme`+`editor.refresh`(main.ts:83-84) | 🔴 **단일 writer, sink 6+곳 수동 fan-out. push(refreshMermaidTheme)+pull(dataset 직접읽기) 이중 채널.** 과거 동기화 버그 이력(테마 전환 레이아웃 깨짐·mermaid 재렌더 후 invisible) |
| **lastHeight** (mermaid reserve) | `fitHeight` 클로저(mermaid-widget.ts:116) | `toDOM` 읽기·reserve(:73) | ⚠️ 생산↔소비 분산(intent-review 별건) |
| **svg/html 렌더 캐시** | cachePut | toDOM | ✅ 파생 캐시. 양호 |

**핵심 발견**: `문서`·`폴드`는 CM이 SSOT로 잘 잡혀 있다. 문제는 **사용자 설정(preference) 계층**이다. `mode`·`theme`는 각각 *단일 writer*를 갖지만, 그 값이 **localStorage 키 + DOM/CSS-var + CM facet/compartment + mermaid 재bake + 상태바 chrome** 으로 **설정마다 손으로 배선된 fan-out**을 가진다. 설정 추상화(settings/config 스토어)는 **존재하지 않는다**(grep 확인).

→ 같은 정체성(="하나의 사용자 설정 값")이 **2곳 이상에서 ad-hoc 동기화**되고, theme에는 **실제 동기화 버그 이력**이 있다. 상태 중복 의심 **성립**.

---

## 이벤트 지도 (Event Map)

| 이벤트 | 핸들러 위치 | 해석 일관성 |
|---|---|---|
| **Mod-e (모드 토글)** | CM 키맵(editor.ts) + `window` keydown 폴백(main.ts:103-108) | ✅ 둘 다 `controller.toggleMode` 1곳에 위임 — 해석 통일. 포커스 견고성 위한 이중 등록(양호) |
| **클릭→소스 reveal** | `core.ts:399` `clickEntry`(capture, `.cm-table`/`.cm-math-block`) + `table-widget.ts:29` + `math-widget.ts:50` (위젯별 mousedown) | 🔴 **같은 이벤트가 3곳에서 각자 해석. 중앙 clickEntry가 이미 같은 요소를 덮음 → 위젯별 핸들러 중복(이중 배선)** |
| 화살표↑↓ 블록 진입 | `entryKeymap`(core.ts) | ✅ 단일 |
| 링크/위키링크/체크박스 클릭 | feature/위젯별 | ✅ 각자 고유 대상 |
| 테마 토글 클릭 | makeThemeToggle | (상태 지도의 theme fan-out 참조) |
| ResizeObserver / autosave 타이머 / mermaid async | 위젯·editor | ✅ 시스템 이벤트, 고유 |

→ **명령 분산**은 "클릭→소스 reveal" 1건(중복 이중배선). Mod-e는 분산처럼 보이나 단일 해석으로 위임 → 문제 아님.

---

## 의존 방향 지도

```
main.ts ──► editor.ts ──► live-preview/index ──► core.ts ──► features/* ──► widgets/*
   │                                                                          ▲
   └──► theme.ts                                                              │
   └──► mermaid-widget.refreshMermaidTheme ──────────────────────────────────┘  ← 교차 관통
mermaid-widget ──► document.documentElement.dataset.theme (UP-reach: 전역 DOM 직접 읽기)
```

문제 있는 관계만 발췌:
- **`main.ts` → `mermaid-widget.refreshMermaidTheme()`** (main.ts:5,83): 엔트리포인트가 "테마가 바뀌면 mermaid를 재bake해야 한다"는 **도메인 지식을 보유**하고 위젯 모듈 내부 함수를 직접 호출. 테마 민감 렌더러가 늘면 main.ts onChange에 호출을 계속 추가해야 함.
- **`mermaid-widget` → `document.dataset.theme` 직접 읽기** (:11,:43): 위젯이 전역 DOM 상태를 위로 당겨 읽음(pull). 동시에 main이 재렌더를 밀어넣음(push) → **이중 채널**.
- **순환 의존**: 없음.
- **직접 내부 접근 ≥3건**: 없음(레이어링은 대체로 단방향·건전).

---

## 선택된 패턴 및 근거

**패턴: Single Source of Truth — 설정(preference) 스토어**

**왜 이 패턴인가**: 증상의 핵심은 "하나의 설정 값"이 단일 소스 없이 여러 sink로 수동 동기화된다는 것. SSOT는 설정 값을 한 곳에 두고 sink(CSS-var, CM facet, mermaid 재bake, chrome, 영속)들이 **구독**하게 만든다.

**왜 지금인가**:
1. **사용자 로드맵이 정확히 이 지점을 압박**한다 — 설정 패널(테마·레이아웃·폰트·플러그인 설정)은 곧 설정이 2개→5개+로 늘어남을 의미. 현재 구조로는 설정 1개 추가 = localStorage 키 + apply 경로 + chrome + onChange 배선 + CSS = **4~5개 파일 수정**(= 호출 조건 충족).
2. **theme에 실제 동기화 버그 이력**이 있다(레이아웃 깨짐·mermaid invisible) — fan-out 수동 동기화의 전형적 실패.
3. **플러그인 시스템과 직결**: 라이브프리뷰 레지스트리(InlineFeature/BlockFeature)는 이미 좋은 플러그인 씨앗. 설정 SSOT를 "코어 설정 + 플러그인 설정을 같은 방식으로 선언, sink가 구독"으로 설계하면 플러그인이 자기 설정을 등록하는 길이 자연히 열린다.

**적용 시 영향 범위(개괄)**: theme·mode를 설정 스토어의 첫 두 항목으로 이주. sink(`dataset.theme`/CSS-var, `modeFacet`/compartment, mermaid 재bake, 상태바 라벨, localStorage)는 스토어 변경을 구독. `main.ts`의 `refreshMermaidTheme` 직접 호출과 mermaid의 `dataset` 직접 읽기는 "mermaid가 theme 설정을 구독"으로 대체(push/pull 이중 채널 제거).

---

## 방향 제안

- **패턴**: Single Source of Truth (설정 스토어)
- **적용 범위**: 신규 설정 스토어 1개(예: `src/settings.ts`) + 기존 sink들(`theme.ts`, `main.ts` onChange 배선, `mermaid-widget`의 theme 읽기, `editor.ts`의 modeFacet/compartment, localStorage 키 2개). 설정 항목은 `{ 기본값, 영속키, 적용자(appliers) }`로 **선언**되고, 값 변경 시 스토어가 구독 sink를 호출.
- **개괄 접근**: 설정 스토어 뼈대를 먼저 도입(빈 껍데기 + 구독 메커니즘) → theme를 첫 항목으로 이전(dataset/CSS-var/mermaid 재bake/chrome/localStorage를 구독자로 전환, 기존 경로와 병행) → mode 이전 → 레거시 fan-out 제거. 빠른 로딩 제약상 스토어는 의존 없는 경량(외부 상태 라이브러리 도입 금지, plain 모듈+콜백으로 충분).
- **주의점**:
  - **빠른 로딩**이 1급 제약 — 무거운 상태 라이브러리/리액티브 프레임워크 도입 금지. 동기 init + 구독 콜백 수준 유지.
  - theme 이전이 가장 위험(과거 버그 지점). 병행 기간에 dataset push/pull 이중 채널이 잠시 공존 → reveal/render 깨짐 주의.
  - 멀티 *창* 모델이므로 창 간 공유 상태 불필요 — 스토어는 창 로컬이면 충분(과대설계 회피).
- **Golden Master 필요**: **Yes**. (테마 전환 시 mermaid 재렌더·레이아웃 무변, 모드 토글 시 autosave flush — 과거 버그 이력이 있는 동작. 시나리오 구체화는 플랜 스킬이 담당.)

## 대기 리스트 (이번 라운드 적용 안 함)

- **Command Pattern — 클릭→소스 reveal 단일화**: `core.ts:clickEntry`로 일원화하고 `table-widget`/`math-widget` 위젯별 mousedown 제거(이중배선 해소). 범위 작음 — intent-review 함수 단위 수정으로도 처리 가능. 다음 라운드 또는 별건.
- **플러그인 시스템 일반화**: InlineFeature/BlockFeature 레지스트리를 정식 플러그인 API로 승격(설정 등록 포함). 이는 *경로 재설계*보다 *설계 결정*에 가까움 → 규모가 커지면 `service-design` 고려(현재 혼자라 보류).
- **함수 단위 부채**: `applySvg` 분해, `boundedCache`/`fencedBody` 공유 — intent-review-2026-06-13.md 참조.

## 다음 단계 — 플랜 작성

이 방향 제안을 실행 가능한 plan으로 변환하려면 `superpowers:writing-plans` 스킬을 호출하세요.
본 문서를 입력으로 전달하면 플랜 스킬이 라운드별 plan, 단계별 task + 검증 절차,
Golden Master 시나리오 구체 목록(테마/모드 전환 스냅샷), 커밋 계획까지 작성합니다.

---

### 자가 검증

- [x] 제안 패턴 **하나**(SSOT)뿐 — Command Pattern은 대기 리스트로 분리
- [x] 과대설계 필터 재검토: 설정 2개로 오늘은 경미하나 (a)theme 동기화 **버그 이력 실재**, (b)사용자가 설정 패널+플러그인 확장을 **명시 로드맵**으로 확정, (c)관찰 도구(vitest 58 테스트·소켓 하니스) 존재 → 대공사 금지 가드 통과. YAGNI 아님
- [x] 보고서에 단계별 task·커밋 수·Golden Master 시나리오 목록 **미포함**(플랜 스킬 영역)
- [x] 방향 제안이 개괄 한 문단 수준
- [x] 코드 미수정
- [x] 새 구조 매개변수 ≤3 (설정 항목 = {기본값, 키, 적용자})
- [x] 대기 리스트 명시
- [x] 마지막에 플랜 스킬 호출 안내 포함
