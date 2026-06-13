# Intent Review — 2026-06-13

함수 의도(이름) vs 구현(동작) 검토. 대상: `src/**/*.ts` (테스트·목 제외).
탐지는 4개 영역 병렬 분석 + 분산의도 합성으로 수행.

## 요약

- **스캔**: 32개 파일, ~2,015줄, 60+ 명명 함수/메서드
- **후보**: 6건 (high 4 / medium 2 / low·skip 다수)
- **CQS 위반(사기꾼 ⭐)**: **0건** — 모든 Query가 부수효과 없음, 모든 Command가 void+명명. "값을 반환하면서 몰래 상태를 바꾸는" 함수 없음.
- **God 함수**: 1건 — `mermaid-widget.ts:91 applySvg` (~92줄, 위험 임계)
- **최대 이슈**: `applySvg` — 이름은 `host.innerHTML = svg`만 약속하지만 실제로는 SVG 정규화 + 높이 맞춤(+ 숨은 전역 쓰기) + 인터랙티브 뷰어(pan-zoom/resize/dblclick/wheel) 전체를 구성
- **결론**: 이 코드베이스는 네이밍 규율이 이례적으로 높다. 핵심 교차 관심사(reveal 규칙, conceal primitive, line-class dedup)는 이미 core에 단일화돼 있다. 남은 부채는 작은 DRY 위반 몇 개와 `applySvg` 분해뿐.

---

## 🔴 High Priority

### 1. `applySvg()` — ⭐⭐ — `src/markdown/mermaid-widget.ts:91`

**실제 책임**: SVG 주입 → mermaid 인라인 사이징 정규화(viewBox 종횡비 읽기) → rAF 지연 `setup` 정의·예약 → 높이 맞춤 + pan-zoom/ResizeObserver/dblclick/ctrl-wheel 전체 배선.

**문제**:
- 이름이 동작을 심하게 **과소 약속**한다. 독자는 `innerHTML` 대입을 기대하지만, 실제로는 인터랙티브 뷰어 + 이벤트 리스너 + ResizeObserver가 통째로 구성된다.
- 한 메서드에 ≥3개 관심사: (1) SVG 속성 정규화, (2) 높이 맞춤, (3) pan-zoom 인터랙션 배선.
- 중첩 클로저 `fitHeight`/`setup` 안에 또 핸들러 중첩 → 들여쓰기 ≥3단.
- `fitHeight` 클로저 내부에서 모듈 전역 `lastHeight`(line 116)를 **몰래** 쓴다 — 쿼리성 이름의 부수효과.
- `setup`(line 124)은 도메인 코어의 **맨 동사**(`setup`)이며 '레이아웃 대기 게이트'와 '뷰어 구성'이라는 두 추상화 레벨을 섞는다(SLAP 위반).

**추출 제안** (의미 변경 없는 분해):
```
applySvg = innerHTML 대입
         → normalizeMermaidSvg(el): aspect        // viewBox 종횡비 읽고 height/maxWidth 제거
         → whenLaidOut(host, cb)                   // clientWidth>0 까지 rAF 폴링 (≤120프레임)
            → fitHostHeight(host, aspect)          // 폭 기반 높이, lastHeight 기록을 명시적으로
            → initPanZoom(host, el, aspect)        // svg-pan-zoom + ResizeObserver + dblclick + wheel
```
분해 후 `applySvg`는 "innerHTML → normalize → whenLaidOut(fit; initPanZoom)"로 읽힌다. `setup`이라는 이름은 사라진다. **이 코드베이스에서 가장 가치 높은 리팩토링.**

### 2. 펜스 본문 추출 중복 — ⭐⭐⭐⭐ 이지만 추출가치 high — `features/code-block.ts:22` + `features/mermaid.ts:6`

**문제**: "펜스 본문이란 무엇인가"(여는 ` ```lang ` 줄 + 닫는 ` ``` ` 줄을 떼어낸 나머지)라는 도메인 규칙이 두 파일에 **바이트 단위로 동일**하게 인라인됨:
```ts
lines.slice(1, lines[lines.length - 1]?.trim().startsWith("```") ? -1 : undefined)
```
한쪽에 엣지케이스 수정(`~~~` 펜스, 들여쓴 펜스, 끝 개행 없음 등)을 가하면 다른 쪽은 조용히 옛 로직으로 남아 **mermaid와 일반 코드블럭이 "본문"의 정의에서 어긋난다**.

**추출 제안**: `BlockCtx`(core.ts)에 `fencedBody(node): string[]` 메서드 추가. 두 feature가 `ctx.fencedBody(node)` 호출. 펜스 본문의 단일 정의. (blockMath는 `$$` 정규식으로 별도 처리 → 이 중복에 포함 안 됨.)

### 3. 바운드 렌더 캐시 중복 — 추출가치 high — `mermaid-widget.ts:22` + `math-widget.ts:14`

**문제**: `Map + CACHE_MAX + cachePut(가장 오래된 키 evict)` 삼종 세트가 두 위젯에 복붙됨 (mermaid: 소스키, max 50 / katex: 'D'|'I'+tex, max 200). 한쪽 eviction 정책을 바꾸면(예: LRU-on-get) 다른 쪽은 insertion-order로 남아 드리프트. 세 번째 무거운 렌더러가 생기면 세 번째 복사본이 붙는다.

**추출 제안**: `src/markdown/bounded-cache.ts` 신설 — `boundedCache<K,V>(max): { get, put }` (insertion-order FIFO). mermaid는 `boundedCache(50)`, math는 `boundedCache(200)`.

### 4. `setup()` 클로저 — ⭐⭐ — `src/markdown/mermaid-widget.ts:124`

(1번 `applySvg` 분해의 일부) 맨 동사 `setup`이 '레이아웃 대기 게이트(width>0까지 rAF 폴링)'와 'pan-zoom 뷰어 구성'을 한 클로저에 융합. `whenLaidOut(host, fn)`(라이프사이클 게이트) + `initPanZoom(host, el, aspect)`(뷰어)로 분리하면 `setup`이라는 이름 자체가 사라진다.

---

## 🟡 Medium / 🟢 Low

| 파일:라인 | 함수 | 별점 | 실제 책임 | 가치 |
|---|---|:--:|---|:--:|
| `mermaid-widget.ts:110` | `fitHeight` | ⭐⭐⭐ | 폭 기반 높이 계산·적용·`lastHeight` 전역 기록 | medium |
| `table-widget.ts:26` | `toDOM` | ⭐⭐⭐ | 테이블 파싱+빌드+클릭배선 한 메서드(~50줄); thead/tbody 셀빌드 루프 중복 | medium |
| `mermaid-widget.ts:22` | `cachePut` | ⭐⭐⭐⭐ | 이름은 'put'이나 조용히 evict(관용적 범위) | low |
| `core.ts:363` | `moveOrEnter` | ⭐⭐⭐⭐ | 접속사명(Or)이나 진짜 두-결과 모션 핸들러; CM 키맵 boundary | low |
| `core.ts:142` | `build` | ⭐⭐⭐⭐ | collect+dedupe+reveal-filter+line-class를 한 본문에 | low |
| `main.ts:52` | `boot` | ⭐⭐⭐⭐ | 엔트리포인트(~61줄); IO+DOM+배선 혼재 | low |
| `editor.ts:67` | `mountEditor` | ⭐⭐⭐⭐ | 마운트/배선 엔트리(~61줄); 응집적 | low |

- `fitHeight`: 쿼리성 이름인데 `lastHeight`를 기록(다음 위젯 reserve용). `applySvg` 분해 시 `fitHostHeight`로 승격하고 기록을 호출부에서 명시.
- `table-widget.toDOM`: `buildRow(cells, tag, aligns)` 추출로 thead(48-54)/tbody(62-68) 중복 제거.
- `moveOrEnter`: CM run-handler로서 방어 가능. 더 날카롭게는 `revealBlockOnVerticalMove`.

> **False Positive로 제외한 것**: 모든 위젯의 `toDOM`/`eq`/`ignoreEvent`/`destroy`(CM 라이프사이클 관례), feature의 `enter`/`match`(InlineFeature/BlockFeature 계약 멤버명 = 프레임워크 boundary), parser의 Lezer `parse` 규칙, 선언 모음(`STYLE`/`NO_BLOCKS_INSIDE`/`markdownFolding`), factory(공유 클로저 상태: `inlinePreview`/`blockPreview`/`controller`). `blockPreview`(~134줄)는 God 함수가 **아니다** — 공유 클로저 상태를 가진 CM 확장 팩토리이며 각 관심사가 명명된 중첩 함수(`computeSpecs`/`buildDeco`/`moveOrEnter`)로 분리돼 있다.

---

## 패턴 분석

### 분산된 의도 (Scattered Intent) — 5건

1. **바운드 FIFO 렌더 캐시** — `mermaid-widget.ts:20-28` + `math-widget.ts:12-20`. (위 High #3) — 위험 medium
2. **클릭→소스 reveal 핸들러** — `core.ts:399-411`(중앙 `clickEntry`, capture) + `table-widget.ts:29-32` + `math-widget.ts:50-54`(위젯별). **중앙 `clickEntry`가 이미 `.cm-table`/`.cm-math-block`을 처리** → 위젯별 핸들러는 대체로 **중복(이중 배선)**. 위험 medium.
3. **펜스 본문 추출** — `code-block.ts:26-29` + `mermaid.ts:8-9`. (위 High #2) — 위험 **high**
4. **mermaid 테마명 매핑** — `mermaid-widget.ts:11-12`(loadMermaid) + `:43-45`(refreshMermaidTheme). `light?'default':'dark'` + `initialize` 옵션 객체가 두 곳. `initMermaid(m)` / `mermaidInitOptions()`로 통합. 위험 low/medium.
5. **reserve-last-height** — `mermaid-widget.ts:54`(전역) / `:73`(읽기·reserve) / `:115-116`(쓰기·clear). 생산자와 소비자가 다른 메서드에 흩어짐. `applySvg` 분해와 함께 `fitHostHeight`에서 기록을 명시. 위험 medium.

### 표면적 중복 (복붙)

- 펜스 슬라이스 식(동일), 바운드 캐시 삼종(동일), 클릭→소스 mousedown(3곳), mermaid `initialize` 옵션(2곳), 테이블 th/td 셀빌드 루프(파일 내), `image.ts` resolve 2함수의 prefix 재검사(무시 가능).

### 새 모듈 후보

- `src/markdown/bounded-cache.ts` — `boundedCache<K,V>(max)`
- `BlockCtx.fencedBody(node)` (core.ts) — 펜스 본문 단일 정의
- `applySvg` 분해 → `src/markdown/mermaid-view.ts`: `normalizeMermaidSvg`/`fitHostHeight`/`whenLaidOut`/`initPanZoom`
- (선택) `revealSourceOnClick(view, el)` 또는 그냥 `clickEntry`에 일임

### 검증된 비-문제 (Dual-Implementation 의심 해소)

- `src/markdown/{hr,footnote,image,checkbox,bullet,...}.ts` ↔ `live-preview/features/{...}.ts`는 **경쟁 렌더 경로가 아니다**. grep 검증: Decoration/ViewPlugin/StateField를 생산하는 모듈은 **오직** `live-preview/core.ts` + `features/*`. 구 파일들은 순수 `WidgetType` 클래스(위젯 레이어)로, 각자 대응 feature가 import해 쓴다. **단일 파이프라인 + 공유 위젯 레이어** — 죽은 코드 없음.
- `parser.ts`는 Lezer **노드만** 정의(위젯/데코 0개). 렌더는 live-preview 단일 경로. 두 번째 경로 없음.

---

## 아키텍처 제안

1. **클릭→소스 reveal을 `core.ts:clickEntry` 단일화** 하고 `table-widget.ts:29-32` + `math-widget.ts:50-54` 위젯별 핸들러 제거. `clickEntry`가 이미 `.cm-table`/`.cm-math-block`을 capture-phase로 덮으므로 위젯 핸들러는 중복 이중배선. (mermaid가 이미 따르는 패턴.)
2. **세 개의 작은 교차 도메인 primitive**(`boundedCache`, `fencedBody`, mermaid `initialize` 옵션)를 공유 헬퍼로 승격. 코드베이스는 나머지 교차 규칙(reveal/selectionTouches, 공유 `hide` Decoration, `ctx.line` dedup)을 이미 잘 단일화했고 이 셋만 낙오.
3. **`applySvg` 분해**(High #1)가 단일 최고가치 작업.

---

## 다음 단계 권장

이번 검토에서 **분산된 의도 5건**이 발견되었다 (임계 ≥3 초과). 이 중 클릭→소스 이중배선과 reserve-height 분산은 함수 단위를 넘어선 **관계/경로 설계** 성격을 띤다.

→ **`/architecture-review`** 실행을 권장한다. *(이미 같은 세션에서 호출됨 → `architecture-review-2026-06-13.md` 참조.)*

함수 단위 추출(High #1~4)은 architecture-review의 경로 재설계와 독립적으로 진행 가능하다. 단, `applySvg` 분해는 **테스트 없는 리팩토링 금지** 원칙에 따라 Golden Master(현재 mermaid 렌더 출력 스냅샷) 확보 후 진행할 것.
