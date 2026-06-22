---
name: mermark-feature-design
description: >
  mermark에 새 마크다운 렌더링·에디터·백엔드 기능을 추가하기 전, 설계를 확정하는
  스킬. 기능을 5종(inline feature / block feature / parser node / Tauri command /
  setting)으로 분류하고, live-preview 파이프라인 계약(Spec·reveal rule·블록은
  StateField)에 맞춰 재사용 맵·SSOT 영향·실패 테스트 우선 TDD 계획·골든마스터
  시나리오를 산출한다. "각주 호버 프리뷰 추가해줘", "콜아웃 접기 기능", "다이어그램
  export 커맨드", "새 설정 추가" 처럼 기능 추가·설계 요청에서 반드시 먼저 호출한다.
  단, 이미 설계가 확정돼 코드만 고치는 단순 버그 수정·리팩토링에는 호출하지 않는다
  (그건 frontend/backend 엔지니어 스킬이 직접 처리). 신규 기능 추가는 항상 이 스킬이 먼저 — 구현 스킬(mermark-frontend/backend)보다 앞선다.
---

# mermark 기능 설계

mermark의 모든 기능 추가는 코드보다 **계약**이 먼저다. live-preview 파이프라인은
Spec·reveal rule·"블록은 StateField" 같은 불변식 위에 서 있고, 이 불변식을 깨면
render-smoke 테스트가 무너지거나 커서 reveal이 망가진다. 그래서 이 스킬은 코드를
짜지 않는다. **무엇을 어디에 어떻게 꽂을지**를 확정해 두 개의 산출물
(`01_architect_design.md`, `01_architect_plan.md`)로 넘긴다. frontend-engineer와
backend-engineer는 이 설계를 그대로 구현하는 sink다.

설계 없이 바로 구현하면, 엔지니어가 매번 파이프라인 계약을 재발견하다 같은 실수
(블록 위젯을 ViewPlugin에서 만들기, reveal rule 우회, SSOT를 거치지 않은 설정
하드코딩)를 반복한다. 그 실수를 설계 단계에서 차단하는 것이 이 스킬의 존재 이유다.

## 1단계: 기능을 5종으로 분류한다

새 기능이 파이프라인의 **어느 확장점**에 붙는지 먼저 못 박는다. 확장점이 곧
구현 위치이자 테스트 전략이다. 하나의 기능이 여러 종에 걸칠 수 있다(예: 콜아웃
접기 = parser node + block feature + setting).

| 종류 | 이것인가? | 붙는 곳 | 계약 |
|---|---|---|---|
| **inline feature** | 한 줄 안의 텍스트 스타일/치환 (bold, link, wikilink, 인라인 math) | `markdown/live-preview/features/*.ts`, `InlineFeature` | `enter()`가 `ctx.push(Spec)`. 데코는 **ViewPlugin**이 모은다 |
| **block feature** | 줄 전체를 위젯으로 교체 (mermaid, table, display math, code block) | 같은 폴더, `BlockFeature` | `match()`가 `BlockSpec` 반환. 위젯은 **StateField**가 그린다 |
| **parser node** | Lezer가 모르는 새 문법 (wikilink, `$…$`, `[^ref]`) | `markdown/parser.ts`, `MarkdownConfig` | 새 노드를 `defineNodes`로 선언, feature가 그 노드를 claim |
| **Tauri command** | 디스크/OS 접근이 필요 (read/write/open/export) | `src-tauri/src/commands.rs` + `lib.rs` invoke_handler | 쿼리는 순수, 커맨드는 atomic, conflict guard 유지 |
| **setting** | 사용자 토글/선호 (theme, mode, 새 on-off) | `settings/app.ts`에 `defineSetting` 한 줄 | SSOT — sink가 subscribe, 절대 직접 fan-out 금지 |

분류가 끝나면 **이 기능이 만질 파일 목록**을 design 문서 상단에 박아 둔다.
엔지니어가 탐색에 시간을 쓰지 않게 한다.

## 2단계: live-preview 파이프라인 계약을 지킨다

`src/markdown/live-preview/core.ts`가 정본이다. 설계가 다음 불변식을 어기면 그
설계는 틀린 것이다. 의심되면 core.ts를 다시 읽는다.

### Spec과 reveal rule

inline feature는 데코를 직접 붙이지 않는다. `Spec{from,to,deco,conceal}`을
`ctx.push`로 흘려보내면 core가 모아서 reveal rule을 적용한다:

```ts
// features/text-styles.ts — 마커는 conceal:true(커서가 닿으면 드러남),
// 스타일 클래스는 conceal:false(항상 보임)
ctx.push({ from: node.from, to: node.to, deco: Decoration.mark({ class: cls }), conceal: false });
ctx.push({ from: mark.from, to: mark.to, deco: hide, conceal: true });
```

`conceal: true`인 Spec은 `revealed(state, from, to)`가 참이면 드롭된다. reveal은
**edit 모드 + selection이 그 줄에 닿을 때만** 일어난다(`read` 모드는 절대 안
드러남). 새 inline feature의 "감출 마커"는 반드시 `conceal: true`로, "보일
콘텐츠 스타일"은 `conceal: false`로 분류한다. 이 분류를 설계 문서에 명시한다 —
엔지니어가 헷갈리는 단 하나의 지점이다.

### 블록 위젯은 StateField에서만 나온다 (절대 ViewPlugin 아님)

이건 render-smoke 테스트가 지키는 핵심 불변식이다. block feature의 위젯은
`blockPreview`의 `StateField`가 그린다. inline 데코만 ViewPlugin에서 나온다.
블록 위젯을 ViewPlugin으로 옮기면 atomic 블록을 가로지르는 커서 reveal/세로 진입
(`pickBlockLanding`, `moveOrEnter`)이 깨지고 smoke 테스트가 실패한다. 새 block
feature는 `BlockFeature.match()`만 구현하고, core의 StateField가 나머지를
처리하게 둔다:

```ts
// features/table.ts — match가 BlockSpec을 반환하면 끝. 위젯 렌더는 core가 한다.
match(node, ctx) {
  const src = ctx.strippedLines(node.from, node.to).join("\n");
  return { kind: "table", from: node.from, to: node.to, src, widget: () => new TableWidget(src) };
}
```

`widget()`은 selection만 바뀌어도 다시 호출될 수 있으니 **순수**해야 한다(부수효과
금지, src로만 결정). 블록 진입 UX도 설계한다: 세로 화살표 진입은 `pickBlockLanding`이
공짜로 처리하지만, **클릭 진입**은 core의 `BLOCK_SEL`(현재 `.cm-table, .cm-math-block`)에
새 위젯의 클래스를 추가해야 동작한다. 단, mermaid처럼 클릭이 pan/zoom에 쓰여야
하면 일부러 제외한다 — 이 결정을 design 문서에 적는다.

### parser node를 새로 만들 때

기존 노드로 안 잡히는 문법만 `markdown/parser.ts`에 추가한다. 새 노드는 `Link`보다
**먼저**(`before: "Link"`) 파싱해 충돌을 피하고, 마커/타깃/별칭을 자식 노드로
쪼개 feature가 `node.getChild(...)`로 정확한 범위를 집게 한다(wikilink가
`WikilinkTarget`/`WikilinkAlias`로 쪼개는 패턴). 코드 펜스·blockquote 안에서
비활성화되는 것은 트리 기반이라 공짜다 — 정규식 후처리로 가지 않는다.

## 3단계: 재사용 맵을 만든다 (새로 짓지 않는다)

mermark는 위젯 레이어(`markdown/*.ts`)와 feature 레이어(`live-preview/features/*.ts`)가
분리돼 있다. 새 기능 대부분은 **기존 조각의 조합**이다. 설계 문서에 "재사용 / 신규"를
표로 갈라 적어 엔지니어가 중복 구현하지 않게 한다.

| 필요 | 먼저 확인할 기존 자산 |
|---|---|
| 펜스 본문 추출 | `core.dropFences` / `ctx.fencedBody(node)` — code-block과 mermaid가 공유 |
| blockquote `>` 벗기기 | `core.strippedLines` / `ctx.strippedLines` (table-in-blockquote가 이걸로 셀 누수 방지) |
| 펜스 info string | `core.fencedInfo(state, node)` → `"mermaid"`, `"ts"` 등 |
| 렌더 캐시 | `markdown/bounded-cache.ts` (FIFO) — mermaid/math/table 위젯이 공유 |
| 이미지 URL 해석 | `image.ts: resolveImageUrl` (asset 프로토콜) |
| 위젯 클래스 | `mermaid-widget`, `math-widget`, `table-widget`, `code-widget`, `image`, `bullet`, `checkbox`, `fold` 등 — 새 WidgetType 짓기 전에 확인 |

위젯이 무거운 렌더(mermaid/KaTeX)를 한다면 반드시 bounded-cache를 경유한다.
콜드 로드 속도가 1급 제약이라 캐시 없는 재렌더는 설계 결함이다.

## 4단계: SSOT 영향을 판정한다

사용자가 켜고 끌 수 있는 것이면 **무조건** `settings/app.ts`에 `defineSetting` 한
줄로 선언한다. 새 prefs를 main.ts나 위젯에 직접 박지 않는다.

```ts
// settings/app.ts — 선언 한 줄. 읽는 쪽(sink)은 main.ts에서 subscribe/bind.
export const fooSetting = defineSetting<boolean>({
  key: "mermark.foo", default: false,
  parse: (raw) => (raw === "true" ? true : raw === "false" ? false : null),
});
```

블록 위젯이 설정 변화에 반응해야 하면(예: 테마 바뀔 때 mermaid 재렌더) 문서를
바꾸지 않고 `refreshBlocks` StateEffect를 dispatch하게 설계한다 — sink가 setting을
subscribe해서 effect를 쏘는 경로를 design 문서에 그린다. 새 fan-out을 손으로 짜지
않는다.

## 5단계: 실패 테스트 우선 TDD 계획을 쓴다

plan 문서는 **빨강 → 초록** 순서다. 먼저 깨지는 테스트를 어디에 어떤 단언으로
쓸지 못 박는다. mermark의 테스트 지형:

| 대상 | 테스트 위치 | 무엇을 검증 |
|---|---|---|
| inline/block 렌더 + reveal | `tests/render-smoke.test.ts` (에디터 전체 마운트) | conceal/reveal, 위젯 DOM 존재, 블록 진입 |
| 파서 노드 | `tests/parser.test.ts` | 새 노드가 올바른 범위로 파싱, 펜스 안 비활성 |
| 세로 진입 수학 | `tests/live-preview-motion.test.ts` | `pickBlockLanding` 순수 함수 |
| Tauri command | `src-tauri/src/commands.rs` `#[cfg(test)]` | atomic write, conflict guard, 경로 |
| setting | `tests/settings-app.test.ts` / `settings-store.test.ts` | parse/default/subscribe |

inline/block 기능이면 render-smoke 스타일로, "커서가 딴 데 있으면 conceal, 줄에
들어오면 reveal, 다시 나가면 re-conceal" 3단 단언을 반드시 포함한다(wikilink
테스트가 표준 형태). 블록이면 위젯 DOM(`.cm-foo`) 존재 + 커서 진입 시 raw 소스
노출을 단언한다.

## 6단계: 골든마스터 시나리오를 지정한다

유닛 테스트로 못 잡는 회귀(실제 mermaid SVG, 테마 스왑, 세로 네비 leap)는 CDP
골든마스터가 잡는다. plan에 **어느 스크립트가 적용되는지**와 새 시나리오를 적는다.
`npm run dev:browser` + Chrome `--remote-debugging-port=9222`가 전제다.

| 스크립트 | 적용 시점 |
|---|---|
| `scripts/mermaid-golden.mjs` | mermaid/다이어그램 렌더에 영향 |
| `scripts/settings-golden.mjs` | theme/mode/새 setting의 시각 결과 |
| `scripts/nav-trace.mjs` | 세로 화살표·블록 진입·커서 motion |
| `tests/render-smoke.test.ts` | 모든 inline/block 기능 (유닛이지만 회귀 가드) |

새 기능이 read_file/write_file **시그니처를 바꾸면** `src/mocks/tauri-core.ts`
브라우저 mock도 같이 갱신해야 골든이 돈다고 plan에 경고한다.

## 산출물 형식

두 파일을 정확히 이 구조로 쓴다.

### `_workspace/01_architect_design.md`

```markdown
# 설계: <기능명>

## 분류
- 종류: <inline feature | block feature | parser node | Tauri command | setting> (복수 가능)
- 만질 파일: <절대경로 목록>

## 파이프라인 계약
- Spec/conceal 분류: <감출 마커 vs 보일 스타일>
- 블록이면: StateField 경로 확인, 클릭 진입(BLOCK_SEL) 추가/제외 결정
- 파서 노드면: 새 노드명, before 순서, 자식 노드 분할

## 재사용 맵
| 필요 | 재사용 자산 | 신규 |
(bounded-cache·strippedLines·fencedBody·기존 위젯 우선 확인)

## SSOT 영향
- 새 setting 선언 여부 / refreshBlocks 경로

## 보안·성능
- Tauri command면 atomic·conflict guard·IPC 표면 최소
- 무거운 렌더면 bounded-cache 경유
```

### `_workspace/01_architect_plan.md`

```markdown
# 구현 계획: <기능명>

## TDD 단계 (빨강 → 초록)
1. [RED] <테스트 파일>에 <단언> 추가 — 실패 확인
2. [GREEN] <구현 파일> 최소 구현
3. ... (frontend / backend 작업 분리 표기)

## 골든마스터 시나리오
- 적용 스크립트: <mermaid-golden | settings-golden | nav-trace | render-smoke>
- 새 시나리오: <설명>
- mock 갱신 필요: <yes/no — read_file/write_file 시그니처 변경 시>

## 검증 커맨드
- npm test / (해당 시) cargo test / 골든 스크립트
```

## 에러 핸들링

- core.ts 계약과 충돌하는 요구(예: "블록 위젯을 ViewPlugin으로")는 설계하지 말고,
  왜 불가한지(render-smoke 불변식)를 design 문서 상단에 적어 반려한다.
- 기능이 read-only MVP 비목표(파일 트리, 탭)에 해당하면 spec
  (`docs/superpowers/specs/2026-06-10-mermark-design.md`)의 phasing을 인용해 범위를
  좁힌다.

## 협업 (팀 통신 프로토콜)

- 설계·계획을 `_workspace/`에 쓴 뒤, frontend-engineer(UI/feature/위젯)와
  backend-engineer(Tauri command)에게 `SendMessage`로 각자 담당 파일과 RED 테스트를
  지정해 구현을 요청한다. inline/block/setting = frontend, command = backend.
- 두 엔지니어 작업이 독립이면 병렬로 보내고, command 시그니처에 frontend가
  의존하면 backend → frontend 순서를 명시한다.
- 구현이 끝나면 qa-verifier가 테스트를 **실행**하고, code-auditor가 intent-review
  관점(함수명==동작, 인라인 if→명명 함수)으로 감사한다.

## 이전 산출물이 있을 때 (재호출)

`_workspace/01_architect_design.md`가 이미 있으면 처음부터 다시 쓰지 않는다.
qa/audit 피드백이나 변경 요청을 받은 경우, 기존 design/plan을 읽고 **달라진
결정만** diff로 갱신한다(예: 클릭 진입 제외로 변경, RED 테스트 추가). 변경 이력은
문서 하단에 `## 개정` 섹션으로 누적해 엔지니어가 무엇이 바뀌었는지 알게 한다.
