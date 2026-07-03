# Intent Review — 2026-07-03 (세션 홀리스틱 패스: M4 즐겨찾기 → M5 재구조화 → M6 폴리시 → M7 CJK 볼드)

함수 의도(이름) vs 구현(동작)의 괴리를 밀스톤 **횡단**으로 검토한다. 각 밀스톤은 이미
code-auditor가 개별 감사했으므로, 이 패스의 가치는 개별 지적이 아니라 **밀스톤을 가로지르며
자생한 분산된 의도**와 세션 전체의 네이밍 일관성이다. 대상: 세션 핵심 소스(즐겨찾기 서브시스템·
CJK 볼드·탐색기 통합점·main 배선·경로 유틸). 테스트·목·선언 모음 제외.

## 요약

- **스캔**: 8개 핵심 소스(`favorites/*`, `cjk-bold.ts`, `live-preview/index.ts`, `explorer-panel.ts`,
  `main.ts`, `recent-panel.ts`, `path.ts`, `shortcuts/actions.ts`) + CSS/설정 SSOT 대조, ~40 신규/변경 명명 함수.
- **후보**: 5건 (high 0 / medium 3 / low·skip 다수)
- **CQS 위반(사기꾼 ⭐)**: **0건** — 세션 전체를 통틀어 값을 반환하며 몰래 상태를 바꾸는 함수 없음.
  즐겨찾기 리스트 산술(`pushFavorite`/`removeFavorite`/`isFavorite`)은 전부 순수, main만 단일 writer,
  favoriteFoldersSetting은 단일 subscribe로 두 뷰(섹션 + 폴더행 별)에 fan-out. 06-13 감사의 "이례적으로
  높은 네이밍 규율"이 4개 밀스톤을 거치고도 유지됐다.
- **God 함수**: 0건 — `cjkBold.enter`(InlineFeature 계약), `blockPreview`(factory), `renderTree`/`makeEntry`
  (렌더 순차 빌더)는 전부 False Positive 필터 통과.
- **최대 이슈**: **경로-라벨 분산된 의도** — 좌측 생략 path DOM(`<bdi>`+rtl)과 `basename()`가 favorites/recent
  두 패널에 각각 복제. 지금은 정확히 2곳이지만 TS·CSS 양면 복제 + CSS 주석이 "패턴 복제"를 자인하고 있어,
  06-13이 "≤2 정당"으로 보류한 건이 **통합 임계에 도달**했다(새 모듈 `chrome/path-label.ts` 후보).
- **결론**: 네이밍 규율은 여전히 최상급이다. M5 재구조화(즐겨찾기를 4번째 aside → 탐색기 하위 섹션으로)는
  SSOT/sink 계약을 깨지 않고 오히려 응집시켰다. 남은 부채는 (a) 경로-라벨 2중 복제의 통합 시점 도래,
  (b) `basename`이 `dirOf`와 달리 공유되지 않는 비대칭, (c) CJK 플랭킹 재구현의 드리프트 트립와이어가
  런타임 가드에만 의존(테스트 미봉인) — 3건 모두 medium, 재작업 강제 아님.

---

## 🟡 Medium

### 1. 경로 좌측-생략 라벨의 분산된 의도 — ⭐⭐⭐⭐(개별 정직) 이나 추출가치 **medium-high**

**발견 위치 (TS)**:
- `src/favorites/favorites-panel.ts:127-130` — `span.favorites-path` + `bdi=createElement("bdi"); bdi.textContent=path`
- `src/recent/recent-panel.ts:110-113` — `span.recent-path` + 동일 `<bdi>` 구성

**발견 위치 (CSS, 완전 복제)**:
- `src/styles.css:1266-1272` `.favorites-path { direction:rtl; text-align:left; … } .favorites-path > bdi { direction:ltr; unicode-bidi:isolate; }`
- `src/styles.css:1307-1315` `.recent-path { … }` — 주석이 직접 `"M5 favorites-path 패턴 복제"`라 자인

**실제 책임**: "경로를 좌측에서 클립하되(뒤쪽 식별 세그먼트 보존), `<bdi>`로 세그먼트 LTR 순서는 유지"
라는 **하나의 UX 도메인 규칙**. 현재 이 규칙이 DOM 구성 5줄 × 2 + CSS 블록 × 2 로 네 군데 흩어져 있다.

**문제**:
- 06-13 감사는 이 패턴(및 `basename` twin)을 "≤2곳 = 정당"으로 보류했다. M6에서 recent가 이 패턴을
  **복제**하면서(커밋 `425942d` "recent left-truncation") 정확히 그 2번째 사본이 생겼고, CSS 주석이
  복제임을 명시한다. 판별 플로우차트상 "같은 로직이 2곳 이상 → 공유 유틸 추출"에 걸린다.
- 위험은 TS·CSS **양면**이라는 점이다. `<bdi>` 없이 rtl만 쓰면 세그먼트 순서가 깨지는데, 한쪽 사본만
  고치면 다른 패널이 조용히 틀어진다(일관성 붕괴). 세션에 즐겨찾기·최근이라는 두 리스트-패널이 생기며
  실제로 발생한 종류의 드리프트.
- 각 함수 자체는 정직하다(⭐⭐⭐⭐) — 이건 함수 괴리가 아니라 **아키텍처 차원의 중복**이다.

**추출 제안** (의미 변경 없음):
```
new: src/chrome/path-label.ts
  export function truncatedPathLabel(path: string): HTMLElement
    // <span class="truncate-left"><bdi>path</bdi></span> 반환 — DOM 규칙 단일화
  export function basename(path: string): string   // 아래 #2와 합류

styles.css: .favorites-path / .recent-path → 단일 .truncate-left (+ > bdi) 로 통합
```
favorites-panel·recent-panel은 `dir.append(truncatedPathLabel(path))` 한 줄로 축약. 통합 후 좌측-생략
규칙(rtl+bdi)은 TS 1곳·CSS 1곳에만 존재. **이 세션에서 통합 가치가 가장 높은 건.**

### 2. `basename()` twin — `dirOf`와의 공유 비대칭 — ⭐⭐⭐⭐ / 추출가치 medium

**발견 위치**:
- `src/favorites/favorites-panel.ts:83` · `src/recent/recent-panel.ts:66` — 바이트 동일한 private `basename`
- 대조: `src/path.ts:3` `dirOf`는 **이미 공유 export**

**문제**: 경로에서 "디렉터리 부분"(`dirOf`)은 `path.ts`에 단일화돼 있는데, 그 자연스러운 형제인
"파일명 부분"(`basename`)만 두 패널에 private로 복제돼 있다. 두 함수는 동일한 `Math.max(lastIndexOf("/"),
lastIndexOf("\\"))` 세퍼레이터 규칙을 공유하므로, 세퍼레이터 처리가 바뀌면 `dirOf`와 두 `basename`이
서로 어긋날 수 있다. favorites-panel 주석 스스로 "recent-panel's identical helper … a shared export isn't
worth the coupling"이라 방어하지만, 그 방어는 recent가 복제되기 전(1곳)에 쓰인 것이고 이제 2곳 + `dirOf`와의
비대칭까지 겹쳤다.

**추출 제안**: `basename`을 `path.ts`로 올려 `dirOf`의 형제로 배치(또는 #1의 `chrome/path-label.ts`에
`truncatedPathLabel`과 동거). 세퍼레이터 규칙이 `dirOf`/`basename` 한 파일에서 함께 관리됨. 매개변수 1개,
순수 함수 — 안전.

### 3. CJK 플랭킹 재구현의 드리프트 트립와이어가 테스트로 봉인되지 않음 — ⭐⭐⭐⭐ / 추출가치 medium

**위치**: `src/markdown/live-preview/features/cjk-bold.ts:74-95` (`computeFlank`/`standardBoldFlank`/`classifyBoldFlank`)

**실제 책임**: `@lezer/markdown`의 비공개 `DefaultInline.Emphasis` 플랭킹 공식(index.js ~1451-1464)을
`**` 고정 delimiter에 대해 **재구현**. `standardBoldFlank`은 "파서가 이미 처리한 쌍"을 판별하는 기준선,
`classifyBoldFlank`은 CJK를 구두점처럼 취급한 완화판. `findCjkBoldRuns`는 `!std && relaxed` 인 쌍만 반환.

**문제** (분산된 의도 — 라이브러리 경계 횡단):
- 같은 플랭킹 규칙이 이제 두 곳(upstream 라이브러리 + 이 파일)에 산다. upstream이 규칙을 바꾸면
  `standardBoldFlank`이 드리프트한다.
- 방어가 **비대칭**이다. "파서가 이미 StrongEmphasis로 만든 쌍" 방향은 런타임 `alreadyStyled`
  (syntax-tree 조회, line 184)가 이중으로 막는다. 하지만 "`standardBoldFlank`이 std=true라 판정했는데
  실제 lezer는 StrongEmphasis를 안 만든 경우"(정당한 CJK 구제를 놓침) 방향은 **어떤 테스트도 봉인하지 않는다**.
  `tests/cjk-bold.test.ts`는 `baseParser`+`GFM`을 이미 import하지만 `alreadyStyled` 검증에만 쓰고,
  `standardBoldFlank` ↔ 실제 lezer 합치 매트릭스는 없다 — 트립와이어가 절반만 지어졌다.

**제안** (코드 수정 아님, 테스트 추가 권고): (before,after) 이웃 문자 클래스 매트릭스를 실제 `baseParser.parse`
(StrongEmphasis 유무)와 `standardBoldFlank` 양쪽에 통과시켜 **합치**를 단언하는 드리프트 트립와이어 1개 추가.
암묵적 런타임 가드를 명시적 회귀 가드로 승격. 재구현 자체는 정당(설계 §1: 파서 오버라이드 구조적 불가) —
문제는 방어의 명시성뿐이라 medium.

---

## 🟢 Low / 관찰

| 파일:라인 | 함수 | 별점 | 실제 책임 | 가치 |
|-----------|------|------|-----------|------|
| `favorite-folders.ts:25` | `pushFavorite` | ⭐⭐⭐⭐ | 명령형 동사(push)지만 순수 query(새 배열 반환, 무변경). `pushRecent` twin과 일관 | low (관례 확립) |
| `main.ts:710` | `flashStatus` | ⭐⭐⭐⭐ | command void. 겹침-버스트 baseline capture-once 규칙 내장(~10줄) — `tests/flash-status.test.ts`가 이미 봉인 | low |
| `explorer-panel.ts:567` | `findStarButton` | ⭐⭐⭐⭐⭐ | find*=요소반환 순수 query. 주석이 "왜 is\*가 아닌지" 명시 | skip |
| `explorer-panel.ts:547` | `revealFavorites` | ⭐⭐⭐⭐⭐ | command void. id는 legacy `favorites.toggle`지만 함수명은 실제 동작(reveal)에 정직 | skip |
| `cjk-bold.ts:130` | `findCjkBoldRuns` | ⭐⭐⭐⭐⭐ | 순수 query. "CJK 완화로만 성립하는 쌍만 반환"을 이름+주석이 약속 | skip |
| `main.ts:305` | `toggleFavorite` | ⭐⭐⭐⭐⭐ | command void, 단일 writer. star 클릭+Space 공통 경로 | skip |

**⭐ CQS 위반: 0건.** `push*` 계열이 명령형 이름을 쓰지만 값을 반환하는 순수 함수인 건 이 코드베이스의
확립된 리스트-산술 관례(문서화·테스트됨)이며, 쿼리가 상태를 **변경**하는 진짜 CQS 위반과는 반대 방향의
무해한 사례다. 별점 ⭐/⭐⭐로 올리지 않는다.

---

## 패턴 분석

### 분산된 의도 (Scattered Intent)
1. **경로 좌측-생략 라벨** (#1) — favorites/recent 패널 TS 2곳 + CSS 2블록. **통합 임계 도달.** → `truncatedPathLabel`.
2. **`basename` twin + `dirOf` 비대칭** (#2) — 세퍼레이터 규칙이 3곳(`dirOf` 1 + `basename` 2)에 분산. → `path.ts`로 승격.
3. **CJK 플랭킹 공식** (#3) — 라이브러리 경계 횡단 재구현, 드리프트 방어가 런타임 편향. → 트립와이어 테스트.

### 표면적 중복
- 사이드바 셸(explorer/recent/outline: aside + toggle 버튼 + 상호배타 + `renderSidebarButton`) — **이미
  잘 factored됨**: 공유부(`renderSidebarButton`)는 추출 완료, 상호배타는 main의 `closeOtherSidebars` 단일 locus.
  각 패널의 콘텐츠·라이프사이클이 진짜로 달라 셸 이상의 통합은 과대설계(YAGNI). **비-문제로 분류.**

### 새 모듈 후보
- **`src/chrome/path-label.ts`** — `truncatedPathLabel(path): HTMLElement` + `basename(path): string`.
  #1·#2를 한 모듈로 흡수(둘 다 "패널에서 경로를 사람이 읽게 만드는" 같은 관심사). favorites·recent 두
  패널이 유일 소비자 → 응집 높고 결합 낮음.

---

## 아키텍처 제안

1. **SSOT/sink는 건드리지 말 것.** M5의 `favoriteFoldersSetting.subscribe → {section.refresh, explorer.refreshFavoriteStars}`
   단일 관측점 fan-out은 교과서적이다. 두 뷰가 한 설정을 보되 writer는 main 하나 — 이 구조를 유지한 채
   위 3건은 순전히 **표현 계층(DOM/CSS 라벨)과 테스트 봉인**의 통합이라 SSOT 위험 없음.
2. **통합은 표시-전용 유틸에 한정.** `truncatedPathLabel`/`basename`은 순수·부수효과 없음 → 골든마스터
   불필요, 기존 `tests/favorites-panel.test.ts`·`recent-panel.test.ts`가 회귀 가드.
3. 우선순위: #1(양면 복제, 가장 위험) → #2(같은 모듈로 흡수 가능) → #3(테스트 추가, 저위험).

---

## 다음 단계 권장

이번 검토의 분산된 의도는 **3건**이지만, 그중 2건(#1·#2)은 동일한 표시-계층 통합으로 수렴하고 1건(#3)은
테스트 봉인 문제다. 상태/이벤트 **경로** 설계에는 결함이 없다(SSOT·단일 writer·단일 sink 관측점 모두 건재).
따라서 full `/architecture-review` 라운드는 **불필요** — 함수/모듈 단위 통합으로 충분하다.

→ 조치는 frontend-engineer의 소규모 리팩토링 3건(재작업 강제 아님, 진단·권고). 머지 차단 이슈(🔴) 없음.

**저장 위치**: `docs/reviews/intent-review-2026-07-03.md`
