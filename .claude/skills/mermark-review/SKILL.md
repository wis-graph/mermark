---
name: mermark-review
description: >-
  mermark 변경분을 두 렌즈로 감사하는 리뷰 플레이북. intent-review(함수 이름 vs 실제 동작·CQS
  query순수/command void·God 함수·인라인 if에 숨은 도메인 규칙·분산된 의도)와 architecture-review(상태
  지도 SSOT/sink·이벤트 지도 한 이벤트 N해석·의존 방향 up-reach/순환)를 별점·severity로 등급화하고
  _workspace/04_audit_report.md를 docs/reviews/ 스타일로 쓴다. code-auditor 에이전트가 호출한다.
  트리거 — "감사해줘", "리뷰해줘", "intent-review 돌려줘", "architecture-review", "네이밍 점검",
  "SSOT 위반 확인", "분산된 의도 찾아줘", "함수명이 동작과 맞나", "최종 리뷰", "머지해도 되나". 단,
  테스트를 *실행*해 green/red를 확인하는 일(vitest·cargo·CDP golden)은 이 스킬이 아니라 mermark-verify다 —
  이 스킬은 코드를 읽고 구조를 진단할 뿐 테스트를 돌리지도 코드를 고치지도 않는다.
---

# mermark-review

mermark 변경분의 **마지막 관문**이다. feature-architect → (frontend ∥ backend) → qa-verifier 를 통과한 코드를 머지 직전 감사한다. 두 약속만 지킨다: **함수명 = 동작**, **상태는 흐른다(SSOT)**. 코드를 고치지 않고, 발견을 severity로 박제하고, 누가 무엇을 고칠지 지목한다.

이 코드베이스는 네이밍 규율이 이례적으로 높다(intent-review-2026-06-13: CQS 위반 0건, 분산 의도 5건은 이미 해소). 그래서 감사의 목표는 "전부 다시 뜯기"가 아니라 **이번 diff가 그 규율을 깼는지**다. 깨끗한 코드를 트집 잡지 말고, 새로 들어온 괴리만 잡는다.

## 먼저: 무엇을 감사하나 (이번 diff만)

코드베이스 전체를 재감사하지 않는다. `git diff`(또는 오케스트레이터가 준 변경 파일 목록)로 **변경된 함수·새 함수·변경이 건드린 경로**만 본다. 입력은 `_workspace/02_frontend_changes.md`·`02_backend_changes.md`(구현 요약), `01_architect_design.md`(설계 의도), `03_qa_report.md`(QA 결과)가 있으면 함께 읽어 구현이 설계와 어긋났는지 대조한다.

예외 하나: 변경이 **기존 분산 의도를 한 곳 더 늘렸으면**(세 번째 bounded-cache 복붙, 네 번째 펜스 본문 슬라이스) 그건 이번 diff의 책임이다 — 보고한다.

diff가 비었으면 추측으로 감사하지 말고 "감사 대상 변경분 없음 — diff/변경 목록 요청" 한 줄 쓰고 종료한다.

## 렌즈 1 — intent-review (함수명 vs 동작)

함수명은 약속이다. 이름이 약속하는 것보다 더 많은 일을 하거나(과소 약속), 값을 돌려주면서 몰래 상태를 바꾸면(CQS 위반) AI와 동료가 그 함수를 오해한다. 다음을 별점으로 등급화한다 — **별이 적을수록 위험**(⭐⭐ = 강한 추출 후보, ⭐⭐⭐⭐⭐ = 문제 없음).

### 1-1. CQS — query는 순수, command는 void

값을 **반환하는** 함수는 부수효과가 없어야 한다(query). 상태를 **바꾸는** 함수는 void여야 한다(command). 둘을 겸하면 "사기꾼 함수"다. mermark의 실제 사례:

`fitHeight`(mermaid-widget.ts:110)는 폭 기반 높이를 *계산해 반환할 듯한* 쿼리성 이름인데, 클로저 안에서 모듈 전역 `lastHeight`를 **몰래 쓴다**. 다음 위젯이 reserve할 높이를 남기는 명령인데 이름이 그걸 숨긴다. 이번 diff에 이런 게 새로 들어왔는지 본다 — `get*`/`compute*`/`is*`로 시작하는데 `localStorage.setItem`·`dataset.x =`·전역 변수 대입·`view.dispatch`가 안에 있으면 🔴/🟡.

### 1-2. 과소 약속 (이름이 동작보다 작다)

`applySvg`(mermaid-widget.ts:91)가 교과서다. 이름은 `host.innerHTML = svg` 하나만 약속하지만 실제로는 SVG 정규화 + 높이 맞춤 + pan-zoom/ResizeObserver/dblclick/wheel **인터랙티브 뷰어 전체**를 배선한다(~92줄, ≥3 관심사 = God 함수). 독자는 대입을 기대하다 뷰어 한 채를 만난다.

판별: 함수명을 소리 내 읽고 "이것만 하나?"를 묻는다. 본문이 이름의 동사 범위를 넘으면 추출 후보다. 추출 제안은 **의미 변경 없는 분해**로 쓴다:
```
applySvg = innerHTML 대입
         → normalizeMermaidSvg(el): aspect   // viewBox 종횡비 읽고 height/maxWidth 제거
         → whenLaidOut(host, cb)             // clientWidth>0 까지 rAF 폴링
            → fitHostHeight(host, aspect)    // 폭 기반 높이, lastHeight 기록을 명시적으로
            → initPanZoom(host, el, aspect)  // svg-pan-zoom + ResizeObserver + dblclick + wheel
```

### 1-3. 인라인 if에 숨은 도메인 규칙

> "이 코드를 주석으로 설명해야 한다면, 함수로 추출하라."

버그 수정이 인라인 `if`로 들어오면 자문한다: **"이 수정이 도메인 규칙인가?"** YES면 명명 함수로 분리됐어야 한다 — 주석은 사라지지만 함수명은 약속으로 남아 재발을 막는다. 예: `write_file`의 mtime 비교가 인라인 `if baseline != current`로 흩어지면 `detectConflict(baseline, current)` 같은 이름을 가져야 한다. diff의 새 인라인 조건이 "왜 이 조건인가"를 주석으로 설명하고 있으면 추출 후보로 표시한다.

### 1-4. God 함수 임계

≥80줄 **또는** 관심사 ≥3이면 후보. 단 줄 수만으로 단정하지 않는다 — `blockPreview`(~134줄)는 God 함수가 **아니다**. 공유 클로저 상태를 가진 CM 확장 팩토리이고 각 관심사가 명명된 중첩 함수(`computeSpecs`/`buildDeco`/`moveOrEnter`)로 이미 분리돼 있다. 임계는 "한 본문에 분리 안 된 관심사가 ≥3"일 때만 걸린다.

### 1-5. False Positive — 오탐하지 말 것

다음은 이름과 동작이 어긋나 보여도 **프레임워크 경계**라 문제 아님:
- CM 라이프사이클 관례: `toDOM`/`eq`/`updateDOM`/`ignoreEvent`/`destroy`
- InlineFeature/BlockFeature 계약 멤버: `enter`/`match` (레지스트리가 부르는 이름 = 플러그인 경계)
- Lezer `parse` 규칙, 선언 모음(`STYLE`/`NO_BLOCKS_INSIDE`)
- 공유 클로저 상태를 가진 CM 확장 팩토리(`inlinePreview`/`blockPreview`/`controller`)
- `moveOrEnter`(core.ts) — 접속사명이지만 CM run-handler boundary(진짜 두-결과 모션). 방어 가능, 올려도 🟢.

엔트리포인트(`boot`/`mountEditor` ~61줄)는 응집적 마운트/배선이라 God으로 올리지 않는다 — 단, *새 IO/도메인 로직*이 거기 끼어들면 본다.

## 렌즈 2 — architecture-review (관계)

함수가 아니라 **관계**를 본다. 한 라운드에 architecture 패턴은 **하나만** 제안한다(SSOT / Command / Event Emission). 증상이 겹치면 영향 범위가 가장 큰 하나를 고르고 나머지는 "대기 리스트"로. 중복이 ≤2곳이고 동기화 버그 이력이 없으면 패턴을 제안하지 않는다(YAGNI 가드).

### 2-1. 상태 지도 — SSOT 우회

같은 정체성의 값이 ≥2곳에서 **각자 동기화**되면 상태 중복이다. mermark는 설정(preference)을 `defineSetting`(settings/store.ts) SSOT로 잡았고 sink가 **구독**한다(themeSetting/modeSetting in settings/app.ts). 이번 diff가 새 설정을 추가했는데 `defineSetting`을 거치지 않고 **hand-fan-out**(localStorage 키 직접 쓰기 + dataset 직접 쓰기 + CSS-var + 상태바 라벨을 손으로 배선)했으면 🔴. theme는 과거 이 fan-out으로 동기화 버그 이력(전환 시 레이아웃 깨짐·mermaid invisible)이 있다 — SSOT 우회는 그 재발이다.

판별표(변경분만 채운다):

| 값의 정체성 | writer | sink(구독) | 평가 |
|---|---|---|---|
| 새 설정 X | defineSetting 1곳? | sink가 구독? | hand-fan-out이면 🔴 |

### 2-2. 이벤트 지도 — 한 이벤트, N 해석

같은 이벤트가 여러 핸들러에서 제각각 해석되면 명령 분산이다. mermark 기준선: **클릭→소스 reveal**은 `core.ts:clickEntry`가 capture-phase로 `.cm-table`/`.cm-math-block`을 이미 덮는다. 위젯별 mousedown(table-widget/math-widget)을 또 다는 건 **이중 배선**이다. 이번 diff가 새 위젯에 또 클릭 핸들러를 달았으면 "clickEntry에 일임" 제안. 반대로 Mod-e(모드 토글)가 CM 키맵 + window 폴백 2곳에 등록된 건 **둘 다 `controller.toggleMode` 1곳에 위임** → 해석 통일 → 문제 아님(포커스 견고성용 이중 등록).

### 2-3. 의존 방향 — up-reach / 순환

레이어는 단방향이어야 한다: `main.ts → editor.ts → live-preview → core.ts → features/* → widgets/*`. 문제 신호:
- **엔트리포인트가 도메인 지식 보유**: `main.ts`가 "테마 바뀌면 mermaid 재bake" 같은 규칙을 알고 위젯 내부 함수를 직접 호출(과거 `refreshMermaidTheme` 직접 호출). 그런 호출이 늘면 main이 sink 목록을 손으로 관리하게 된다 → "mermaid가 설정을 구독"으로 전환 제안.
- **위젯이 전역 DOM을 위로 당겨 읽기(up-reach)**: 위젯이 `document.documentElement.dataset.theme`를 직접 읽음. push(main 재렌더) + pull(직접 읽기) **이중 채널**.
- **순환 의존 / 직접 내부 접근 ≥3건**: 발견 시 🔴.

### 2-4. mermark 1급 제약 (깨면 🔴)

- **빠른 cold-load**: 무거운 상태/리액티브 라이브러리 도입 금지. 설정 스토어는 plain 모듈 + 콜백 수준.
- **block 위젯은 반드시 StateField**, inline 데코만 ViewPlugin. block 데코가 ViewPlugin에서 나오면 render-smoke 회귀 가드가 깨진다 → 🔴.
- **보안 자세**: CSP, asset-protocol scope, atomic fs write(temp+rename), conflict guard, 불필요한 IPC 표면 없음. backend 변경이 이걸 무너뜨리면 🔴.
- **mock 동기화**: `read_file`/`write_file` 시그니처가 바뀌었는데 `src/mocks/tauri-core.ts`가 함께 갱신 안 됐으면 보고 — golden-master CDP 하니스가 조용히 깨진다.

## severity 등급

- 🔴 **High (차단)**: SSOT 우회 hand-fan-out, block 데코가 ViewPlugin, 보안 자세 붕괴, mock 미동기화, CQS 위반(반환하며 몰래 상태 변경), ⭐⭐ 과소약속 God 함수.
- 🟡 **Medium**: ⭐⭐⭐ 괴리, 추출가치 있는 중복(2곳), 응집 낮은 ~50줄 함수.
- 🟢 **Low**: ⭐⭐⭐⭐ 방어 가능한 괴리, 관용적 범위(`cachePut`의 조용한 evict), 엔트리포인트 응집.

모호하면 차단보다 **보고**를 택한다 — 별 4개 이상 방어 가능한 괴리는 🔴로 올리지 않고 🟢 "가치 low"로 기록한다.

## 보고서 — `_workspace/04_audit_report.md`

`docs/reviews/`의 기존 스타일(파일:라인, 별점, 실제 책임, 추출 제안)을 미러링한다. 다음 골격을 정확히 따른다:

```markdown
# Code Audit — {feature/branch} — YYYY-MM-DD

## 요약
- 감사 대상: {변경 파일 수, 함수 수}
- intent-review: 후보 {N}건 (high {n} / medium / low)
- CQS 위반: {N}건
- architecture: 권장 패턴 {SSOT / Command / Event Emission / 없음}
- 차단 이슈(🔴): {N}건 — {머지 가능 여부}

## 🔴 High Priority
### 1. `함수명()` — ⭐⭐ — `경로:라인`
**실제 책임**: …
**문제**: 이름이 약속하는 것 vs 실제 동작의 괴리 / CQS 위반 / SSOT 우회
**추출/재설계 제안**: (의미 변경 없는 분해 또는 sink 구독 전환)
**담당**: frontend-engineer | backend-engineer

## 🟡 Medium / 🟢 Low
| 파일:라인 | 함수 | 별점 | 실제 책임 | 가치 |

## 분산된 의도 (Scattered Intent)
(같은 의도가 ≥2곳 — 위험도 + 통합 제안)

## 상태/이벤트/의존 지도 (변경분만)
(SSOT 우회·명령 분산·하향 관통·순환 — 문제 있는 관계만 발췌)

## 검증된 비-문제 (False Positive 제외)
(오탐으로 분류한 것 — CM 관례, 프레임워크 계약 멤버 등)

## 판정
- 머지 가능: Yes / No(🔴 선결)
- 재작업 필요 시: 담당 에이전트 + 요청 내용
```

## 감사 후 행동

- **🔴 차단 발견** → 해당 담당(frontend/backend-engineer)에게 재작업 요청(파일:라인 + 괴리 + 추출 제안 + 보고서 경로). 재작업은 *수행하지 않는다* — 검증은 다시 qa-verifier가 받는다.
- **🔴 0건** → 오케스트레이터에 "감사 통과, 머지 가능. 보고서: 04_audit_report.md".
- **분산된 의도 ≥3건** → 보고서 architecture 섹션에 방향 제안을 포함하고 "architecture-review 라운드 권고" 신호.
- **architecture 증상이 ≥2 패턴**이면 하나만 선택, 나머지는 대기 리스트로. 한 보고서에 복수 패턴 혼합 제안 금지.

## 재감사 (재호출 지침)

`04_audit_report.md`가 이미 있으면(= 재작업 후 재감사):

1. 기존 보고서에서 **이전 🔴 목록**을 회수한다.
2. 새 diff에서 항목별로 대조: 해소 = "✅ 해소 확인", 미해소 = "⚠️ 여전히 차단"(파일:라인 기준).
3. 재작업이 **새 괴리**를 만들었는지 본다(추출하다 CQS 깨짐, sink 구독 누락).
4. 보고서 상단에 "## 재감사 (회차 N)" 섹션 + 이전 이슈 체크리스트를 먼저 보이고 덮어쓴다.
5. **교착 방지**: 같은 🔴가 3회차까지 미해소면 차단 유지하되 오케스트레이터에 "교착 — 설계 재검토 또는 사용자 판단 필요" 신호.
