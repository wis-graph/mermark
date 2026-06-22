---
name: mermark-frontend
description: >-
  mermark의 CodeMirror 6 / TypeScript 프론트엔드 구현 플레이북. live-preview 파이프라인에
  새 마크다운 기능(InlineFeature·BlockFeature)을 추가하거나, 위젯(WidgetType)·설정(SSOT)·
  reveal 동작·vitest 테스트를 작성·수정할 때 사용한다. 트리거: "live preview에 X 추가",
  "InlineFeature/BlockFeature 구현", "위젯 렌더링/conceal/reveal 수정", "block 위젯이
  렌더-스모크 깨뜨림", "settings에 preference 추가", "decoration 테스트". feature-architect의
  설계 산출물(_workspace/NN_architect_*.md)이 이미 있을 때 진입한다 — 설계 없는 신규
  '기능 추가' 요청은 mermark-feature-design이 먼저다. frontend-engineer가 이 스킬로 src/ 를 구현한다. — Rust/Tauri 백엔드(commands.rs·cli.rs·invoke 시그니처)나 CDP
  golden-master 스크립트 작성은 이 스킬이 아니라 mermark-backend / mermark-verify 소관이다.
---

# mermark 프론트엔드 구현 플레이북

mermark는 "문서는 항상 raw 마크다운, decoration은 렌더링만 한다"는 모델 위에 선다. 커서가
닿는 줄은 conceal을 떨어뜨려 진짜 소스를 그 자리에서 편집한다(Obsidian reveal rule). 이
스킬은 그 파이프라인을 깨지 않으면서 기능을 추가하는 방법을 규정한다.

## 0. 먼저 읽어야 할 파일

구현 전 반드시 정독한다. 추상적 규칙이 아니라 이 파일들의 계약을 그대로 따른다.

- `src/markdown/live-preview/core.ts` — 파이프라인 본체. `Spec`, `revealed/selectionTouches`,
  `inlinePreview`(ViewPlugin), `blockPreview`(StateField), `pickBlockLanding`, `clickEntry`.
- `src/markdown/live-preview/index.ts` — feature 레지스트리(`INLINE_FEATURES`/`BLOCK_FEATURES`).
  새 feature는 여기 배열에 한 줄 추가해 등록한다.
- `src/markdown/live-preview/features/*.ts` — 기존 feature 예시. 새 기능은 이 모양을 복제한다.
- `src/markdown/table-widget.ts` — 위젯 레이어(WidgetType) 표준 예시.
- `src/settings/store.ts`, `src/settings/app.ts` — SSOT 설정.
- `tests/render-smoke.test.ts` — 전체 에디터를 마운트해 decoration 회귀를 막는 가드.

## 1. InlineFeature 인가 BlockFeature 인가

이 선택이 곧 "어느 CM 파이프라인을 쓰는가"를 결정한다. 잘못 고르면 렌더-스모크가 깨진다.

| 묻기 | InlineFeature | BlockFeature |
|------|---------------|--------------|
| 줄 *안의* 텍스트를 style/conceal 하나? (`**bold**`, `[[wikilink]]`, `$inline$`) | O | |
| 줄 전체를 다른 무엇으로 *대체* 렌더하나? (표, mermaid, display math, code box) | | O |
| 산출물 | conceal/mark/line-class decoration | 블록 위젯(WidgetType) replace |
| 파이프라인 | `inlinePreview` = **ViewPlugin** | `blockPreview` = **StateField** |

판별 기준: 결과가 "원본 텍스트를 가리고 그 자리에 DOM 위젯을 그린다"면 BlockFeature다. "원본
텍스트는 그대로 두되 색/굵기를 입히거나 마커만 숨긴다"면 InlineFeature다.

### 절대 규칙: 블록 위젯은 StateField에서만 나온다

`blockPreview`는 StateField로 구현되어 있고, `inlinePreview`는 ViewPlugin이다. **블록 위젯을
ViewPlugin에서 내보내면 안 된다.** CM은 ViewPlugin이 만든 block decoration을 신뢰하지 않아
런타임 에러를 던지고, `tests/render-smoke.test.ts`가 바로 이걸 잡는다. block decoration의
출처는 오직 StateField여야 한다는 게 이 코드베이스의 핵심 불변식이다. 새 블록 기능은 반드시
`BlockFeature`로 만들어 `BLOCK_FEATURES`에 등록한다 — ViewPlugin을 직접 짜지 않는다.

## 2. InlineFeature 작성

`InlineCtx`가 수집/dedup/reveal을 대신 처리하므로 feature는 decoration만 emit한다.
`enter`가 `false`를 반환하면 그 노드의 자식으로 내려가지 않는다(`tree.iterate` 계약).

```ts
// features/highlight.ts — ==mark== 를 .cm-highlight 로 칠하고 == 마커는 숨긴다
import { Decoration } from "@codemirror/view";
import { hide, type InlineFeature } from "../core";

export const highlight: InlineFeature = {
  nodes: ["Highlight", "HighlightMark"],     // Lezer 노드 이름. parser.ts가 정의
  enter(node, ctx) {
    if (node.name === "Highlight") {
      ctx.push({ from: node.from, to: node.to,
                 deco: Decoration.mark({ class: "cm-highlight" }), conceal: false });
      return;                                 // 자식으로 내려가 마커를 conceal
    }
    if (node.to > node.from)                  // HighlightMark(==) → 숨김
      ctx.push({ from: node.from, to: node.to, deco: hide, conceal: true });
  },
};
```

핵심: **`conceal: true`인 spec은 reveal 대상**이다. core가 `revealed(state, from, to)`이면
자동으로 떨어뜨려 커서가 그 줄에 있을 때 raw 소스(`==mark==`)가 드러난다. style만 입히는
spec은 `conceal: false`로 둬 항상 보이게 한다. reveal 로직을 feature 안에서 직접 짜지 않는다 —
core가 SSOT다.

줄 전체에 클래스를 붙일 땐 `ctx.line(lineFrom, "cm-...")`, 여러 줄을 순회할 땐
`ctx.eachLine(from, to, fn)`을 쓴다(둘 다 dedup됨).

## 3. BlockFeature 작성

`match`는 노드가 이 블록이면 `BlockSpec`을, 아니면 `null`을 반환하는 순수 쿼리다.
`widget()`은 fresh 위젯을 만드는 thunk다 — 선택만 바뀌어도 다시 호출될 수 있으므로
부수효과를 넣지 않는다.

```ts
// features/callout.ts — 가상의 블록 콜아웃
import { type BlockFeature } from "../core";
import { CalloutWidget } from "../../callout-widget";

export const callout: BlockFeature = {
  nodes: ["Blockquote"],                      // 후보 노드
  match(node, ctx) {
    const lines = ctx.strippedLines(node.from, node.to);   // blockquote 마커 제거됨
    if (!lines[0]?.startsWith("[!")) return null;          // 콜아웃 아니면 패스
    const src = lines.join("\n");
    return { kind: "callout", from: node.from, to: node.to, src,
             widget: () => new CalloutWidget(src) };
  },
};
```

`BlockCtx` 헬퍼를 활용한다: `strippedLines`(blockquote 마커 제거), `fencedBody`(펜스
` ```lang ` 와 닫는 ` ``` ` 제거 — mermaid/code-block가 공유하는 단일 정의). 펜스 종류 판별은
`fencedInfo(state, node)`로 lang 문자열을 얻어 비교한다(`mermaid` 등).

등록은 `index.ts`의 `BLOCK_FEATURES` 배열에 추가:

```ts
const BLOCK_FEATURES: BlockFeature[] = [mermaid, codeBlock, table, blockMath, callout];
```

블록의 `from/to`가 정확해야 `pickBlockLanding`(화살표 수직 진입)과 `clickEntry`(클릭 진입)가
올바른 줄에 커서를 떨어뜨려 reveal을 작동시킨다. 진입 동작을 feature에서 따로 짜지 않는다 —
core가 `.cm-table, .cm-math-block` 같은 셀렉터로 일괄 처리한다. 클릭 진입을 원하면 위젯
루트에 그 클래스를 붙이고 `BLOCK_SEL`(core.ts)에 셀렉터를 추가한다. mermaid는 클릭이
pan/zoom이라 의도적으로 제외돼 있다 — 진입은 화살표로만.

## 4. 위젯 레이어 vs feature 레이어 — 분리 유지

두 레이어를 섞지 않는다. 책임이 다르다.

- **위젯 레이어** (`src/markdown/*-widget.ts`): `WidgetType` 서브클래스. `toDOM()`으로 DOM을
  만들고 `eq()`로 CM의 재생성을 제어한다. 마크다운 파이프라인을 *모른다* — source 문자열만 받는다.
- **feature 레이어** (`live-preview/features/*.ts`): Lezer 노드를 위젯에 매핑한다. 어느 노드가
  이 위젯이 되는지, source를 어떻게 잘라낼지만 안다.

`eq()`는 반드시 정확히 구현한다. 같다고 보고하면 CM이 DOM을 재사용하고, 다르면 재렌더한다.
source가 같으면 `true`인 게 기본이지만, 외부 상태(테마 등)에 의존하면 그 버전도 비교에
포함한다. mermaid가 표준 예시다:

```ts
export class MermaidWidget extends WidgetType {
  readonly version = themeVersion;            // 생성 시점의 테마 버전을 캡처
  constructor(readonly code: string) { super(); }
  eq(o: MermaidWidget) {
    return o.code === this.code && o.version === this.version;  // 둘 다 같아야 재사용
  }
}
```

테마가 바뀌면 `themeVersion`을 올려 `eq()`가 거짓이 되게 하고, `core`의 `refreshBlocks`
effect를 dispatch해 문서 변경 없이도 블록을 재빌드시킨다. 위젯이 이벤트를 직접 먹어야 하면
`ignoreEvent()`를 정의한다(표는 `true` 반환 — 클릭 진입은 core가 처리).

## 5. 무거운 렌더는 bounded-cache로

mermaid SVG, KaTeX HTML처럼 비싼 렌더는 `boundedCache(max)`(`bounded-cache.ts`)로 source
키에 캐싱한다. reveal/unreveal 사이클과 스크롤이 렌더러를 다시 돌리지 않게 하되, 캐시가 무한히
자라지 않도록 FIFO 축출한다.

```ts
import { boundedCache } from "./bounded-cache";
const svgCache = boundedCache<string, string>(50);   // source → 렌더 결과
// toDOM(): const hit = svgCache.get(this.code); if (hit) { ... } else { render → svgCache.put(...) }
```

source가 캐시 키이므로 source가 바뀌면 자연히 새 렌더가 된다. 테마처럼 source 밖 입력으로
무효화해야 하면 `svgCache.clear()`를 호출한다(mermaid의 `refreshMermaidTheme` 참고). 빠른
콜드 로드가 일급 제약이므로, 1MB+ 라이브러리(mermaid)는 첫 렌더 때 `import()`로 지연
로드한다 — 부팅 경로에 끌어들이지 않는다.

## 6. 설정은 SSOT — 절대 fan-out 하지 않는다

새 preference가 필요하면 `defineSetting`으로 **한 곳에서 한 번** 선언하고
(`src/settings/app.ts`), 그 값을 쓰는 곳들은 *구독*한다. preference를 손으로 여러 곳에
복사하거나 별도 전역 변수로 흘리지 않는다 — 그게 이 코드베이스가 금지하는 fan-out이다.

```ts
// settings/app.ts — 선언은 여기 한 줄
export const fontSizeSetting = defineSetting<number>({
  key: "mermark.fontSize",
  default: 14,
  parse: (raw) => { const n = Number(raw); return Number.isFinite(n) ? n : null; },
});
```

```ts
// 소비 측(main.ts 등) — get/set이 아니라 구독
fontSizeSetting.bind((px) => applyFontSize(px));   // 지금 값 적용 + 변경 시 재적용
// 쓰기는 한 곳에서: fontSizeSetting.set(16);
```

`bind`는 현재 값을 즉시 적용한 뒤 변경마다 호출한다(sink 초기화에 적합). `subscribe`는 변경
시에만 호출한다. `set`은 값이 같으면 no-op이고, 바뀌면 localStorage에 쓰고 listener에 통지한다.
mermaid 같은 블록 위젯이 설정에 반응해야 하면, 구독 콜백에서 캐시를 비우고 `refreshBlocks`를
dispatch한다 — 위젯이 설정을 직접 읽게 하지 않는다.

## 7. 이름 == 동작 (명명 규율)

이 코드베이스는 함수명이 약속이다. 인라인 `if`가 도메인 규칙을 담으면 명명 함수로 뽑는다.
core의 `selectionTouches`, `revealed`, `pickBlockLanding`, `fencedInfo`, `dropFences`가 본보기다 —
각자 한 가지 규칙을 이름으로 약속하고 그것만 한다. 쿼리는 순수(반환값만, 부수효과 없음),
커맨드는 void(CQS). 버그를 고친 뒤 "이게 도메인 규칙인가?"를 자문하고, 그렇다면 인라인 수정
대신 명명 함수로 분리해 재발을 막는다.

## 8. vitest로 검증 — decoration을 직접 단언한다

테스트는 `tests/`에 둔다. 패턴은 **에디터를 실제로 마운트하고 contentDOM을 단언**하는 것이다
(`render-smoke.test.ts`가 모범). reveal/conceal은 selection을 dispatch한 뒤 `measure()`를
강제 호출하고 텍스트/셀렉터를 확인한다.

```ts
import { mountEditor } from "../src/editor";

// Tauri invoke는 실제 계약대로 stub: read_file→{text,mtime}, write_file→mtime
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) =>
    cmd === "read_file" ? Promise.resolve({ text: "", mtime: 1 })
      : cmd === "write_file" ? Promise.resolve(1) : Promise.resolve(false)),
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));

it("conceals then reveals on the cursor line", () => {
  const doc = "intro\n\nsee ==mark== here";
  const { view } = mountEditor(host, doc, "/tmp", "/tmp/doc.md", { initialMode: "edit" });
  view.dispatch({ selection: { anchor: 0 } });
  (view as unknown as { measure(): void }).measure();
  expect(view.contentDOM.textContent).not.toContain("==mark==");  // 숨김
  view.dispatch({ selection: { anchor: doc.indexOf("==") + 2 } }); // 그 줄로 진입
  (view as unknown as { measure(): void }).measure();
  expect(view.contentDOM.textContent).toContain("==mark==");      // reveal
  view.destroy();
});
```

새 기능은 최소 (a) 마운트가 throw하지 않음, (b) conceal 상태 단언, (c) 커서 진입 시 reveal
단언 — 세 가지를 덮는다. 블록 위젯이면 위젯 DOM 셀렉터(`.cm-table` 등) 존재도 단언해 StateField
경로가 살아있음을 보장한다. 순수 함수(`pickBlockLanding`)는 head/specs를 직접 먹여 layout 없이
단위 테스트한다(`live-preview-motion.test.ts` 참고).

## 9. 입력·출력 프로토콜

- **입력**: `_workspace/NN_architect_design.md`, `_workspace/NN_architect_plan.md`(feature-architect 산출물).
- **출력**: 실제 코드는 `src/` 에 직접 작성. 변경 요약은 `_workspace/NN_frontend_changes.md`에
  남긴다 — 만진 파일, 추가한 feature/위젯, 새 설정, 추가한 테스트, 남은 위험을 적는다.
- **invoke 시그니처를 바꿨다면** 반드시 `src/mocks/tauri-core.ts`(브라우저 mock)도 갱신한다 —
  안 그러면 CDP golden-master가 깨진다. 다만 백엔드(commands.rs) 자체 수정은 mermark-backend 소관.

## 10. 재호출 시 행동

`_workspace/NN_frontend_changes.md`가 이미 있으면 처음부터 다시 만들지 않는다. 기존 변경을 읽고
qa-verifier(`NN_qa_report.md`)나 code-auditor(`NN_audit_report.md`)의 지적만 반영해 diff를
좁힌다. 수정 후 changes 파일을 갱신하고, decoration 회귀가 의심되면 관련 테스트를 보강한다.
StateField/ViewPlugin 규칙이나 SSOT 위반이 지적됐다면 그 불변식부터 복구한다.
