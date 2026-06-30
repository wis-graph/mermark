---
name: mermark-dev
description: >-
  mermark(Tauri 2 + CodeMirror 6 + TS Markdown·Mermaid 에디터)의 기능 추가·버그픽스·리팩토링
  전체를 조율하는 오케스트레이터. feature-architect → (frontend-engineer ∥ backend-engineer)
  → qa-verifier → code-auditor 파이프라인의 단일 진입점. "mermark에 ~기능 추가해줘",
  "이 버그 고쳐줘", "라이브프리뷰 ~ 리팩토링", "inline/block feature 새로 만들어줘",
  "Tauri command 바꾸고 프론트까지 맞춰줘", "footnote/tooltip/위젯 추가", "설정(SSOT) 항목 추가",
  "mermaid/math/table/image 위젯 손봐줘" 같은 mermark 개발 작업이면 무조건 이 스킬로 진입한다.
  후속 작업도 전부 이 스킬: "방금 거 수정", "~만 다시 돌려", "설계만 보강", "테스트만 재실행",
  "감사 지적 반영", "이전 결과 기반으로 이어서", "frontend 파트만 다시", "재실행", "보완".
  단, 코드를 실제로 바꾸지 않는 순수 질문·설명·조회('~가 뭐였지', '~는 어떻게 동작해', 'CSP/설정 값 알려줘', 코드 읽고 답만)와 mermark 무관 작업은 이 스킬이 아니다 — 파일을 실제로 수정하는 개발 작업에만 진입한다.
---

# mermark-dev — 개발 파이프라인 오케스트레이터

mermark의 기능/버그픽스/리팩토링 요청 하나를 받아, 설계 → 구현(프론트·백 병렬) → 검증 → 감사의 4단계 파이프라인으로 끝까지 굴린다. 이 스킬은 직접 코드를 쓰지 않는다 — **에이전트 팀을 구성·조율하고, 산출물을 파일로 인수인계하며, 게이트를 통과시키는 것**이 일이다.

mermark은 콜드 로드 속도·플러그인 확장성·경계면 정합성(Rust command shape ↔ TS invoke 타입 ↔ browser mock)을 1급 제약으로 둔다. 그래서 구현을 한 명에게 몰아주지 않고, 분기 결정(architect)과 검증(verifier)을 별도 역할로 분리한다. 이 순서를 어기면 "설계 없이 짠 코드"나 "검증 없이 머지한 회귀"가 새는데, 이 스킬의 존재 이유가 그 누수를 막는 것이다.

## 실행 모드: 에이전트 팀 (기본)

**기본은 에이전트 팀 모드다.** 런타임에 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`이 켜져 있어야 `TeamCreate`/`TaskCreate`/`SendMessage`를 쓸 수 있다. 플래그가 꺼져 있으면 **서브 에이전트 폴백**(아래)으로 자동 전환한다.

오케스트레이션 시작 시 사용자에게 한 줄로 명시한다: "에이전트 팀 모드로 실행합니다(플래그 미설정 시 서브 에이전트 폴백)." 모든 Agent/팀원 스폰은 예외 없이 `model: opus`로 띄운다 — 분기 결정·교차 검증·감사는 추론 비용이 높은 작업이라 다운그레이드하면 품질이 무너진다.

## 에이전트 구성

| 팀원 | 에이전트 타입 | 스킬 | 역할 | 출력 |
|------|-------------|------|------|------|
| feature-architect | custom (`.claude/agents/feature-architect.md`) | mermark-feature-design | 요청 → 아키텍처 분기 + TDD 플랜 + Golden Master 시나리오 | `_workspace/01_architect_design.md`, `_workspace/01_architect_plan.md` |
| frontend-engineer | custom | mermark-frontend | CodeMirror/live-preview/위젯/설정 TS 구현 | `_workspace/02_frontend_changes.md` |
| backend-engineer | custom | mermark-backend | Rust/Tauri command·CSP·capabilities + browser mock 동기화 | `_workspace/02_backend_changes.md` |
| qa-verifier | **general-purpose** | mermark-verify | 테스트를 실제 RUN(증분) + 경계면 교차 검증 | `_workspace/03_qa_report.md` |
| code-auditor | custom | mermark-review | intent-review·CQS·SSOT·보안 자세 감사 | `_workspace/04_audit_report.md` |

> qa-verifier만 `general-purpose` 타입인 이유: 검증은 `npm test`·`cargo test`·CDP 골든마스터를 **실제로 실행**해야 한다. read-only 탐색(Explore) 타입은 명령을 못 돌려 게이트 역할을 못 한다.

## 파이프라인 순서 (의존성)

```
feature-architect
      │  (01_architect_design.md + 01_architect_plan.md)
      ├──────────────┬──────────────┐  ← fan-out (병렬)
      ▼              ▼
frontend-engineer  backend-engineer
 (02_frontend_*)    (02_backend_*)
      └──────┬───────┘
             ▼
        qa-verifier  ← 증분: 각 엔지니어가 모듈 끝낼 때마다 즉시 호출
        (03_qa_report.md)
             ▼
        code-auditor
        (04_audit_report.md)
```

- frontend/backend는 **병렬**이지만 둘 다 `01_architect_*`에 의존한다.
- 백엔드 command 시그니처가 바뀌면 프론트는 `src/mocks/tauri-core.ts`와 `invoke<>()` 타입을 **같은 변경 묶음**에서 맞춰야 한다 — fan-out이라도 이 경계면은 두 엔지니어가 `SendMessage`로 합의한다.
- qa-verifier는 끝에 한 번이 아니라 **증분**으로 돈다(엔지니어가 모듈 하나 끝낼 때마다). 회귀를 일찍 잡을수록 싸다.

## 데이터 계약

**파일 기반 인수인계** — 모든 산출물은 작업 디렉토리 기준 `/Users/wis/Documents/programming/mermark/_workspace/`에 `{NN}_{agent}_{artifact}.md` 형식으로 떨군다:

- `01_architect_design.md`, `01_architect_plan.md` — 설계 + TDD/골든마스터 플랜
- `02_frontend_changes.md`, `02_backend_changes.md` — 변경 요약 + 영향 파일 + 경계면 메모
- `03_qa_report.md` — 실행한 명령·결과·교차 검증·합격/불합격
- `04_audit_report.md` — intent-review/CQS/SSOT/보안 지적 + 권고

**태스크 기반 상태** — 팀 모드에서는 `TaskCreate`로 의존성과 진행 상태를 추적한다(`depends_on`으로 fan-out/fan-in 표현). 최종 코드는 리포지토리에 직접 랜딩하고, `_workspace/`는 **삭제하지 않는다**(사후 감사 추적용).

## 워크플로우

### Phase 0: 컨텍스트 확인 (후속 작업 분기)

`/Users/wis/Documents/programming/mermark/_workspace/` 존재 여부로 실행 모드를 가른다:

- **`_workspace/` 미존재** → 초기 실행. Phase 1로.
- **존재 + 부분 수정 요청**(예: "frontend만 다시", "설계만 보강", "감사 지적 반영") → **부분 재실행**. 해당 에이전트만 재호출하고, 그 에이전트의 이전 산출물 경로를 프롬프트에 넣어 "기존 결과를 읽고 피드백을 반영해 덮어쓰라"고 지시. 다른 산출물은 보존.
- **존재 + 새 기능/새 입력** → **새 실행**. 기존 `_workspace/`를 `_workspace_prev/`(충돌 시 `_workspace_{YYYYMMDD_HHMMSS}/`)로 이동한 뒤 새 `_workspace/`로 Phase 1.

부분 재실행 시 다운스트림 무효화 규칙: architect가 바뀌면 frontend·backend·qa·audit를 다시, frontend/backend가 바뀌면 qa·audit를 다시 돌린다. 설계가 그대로면 재설계하지 않는다.

### Phase 1: 준비

1. 요청 분석 — 무엇을 만들/고칠지, 프론트·백 어느 경계에 걸치는지 1차 가늠(확정은 architect 몫).
2. `_workspace/` 생성(또는 새 실행이면 기존 것 보관 이동 직후 재생성).
3. 원본 요청을 `_workspace/00_request.md`로 저장.

### Phase 2: 설계 (feature-architect 단독)

feature-architect를 호출(team: `TaskCreate` assignee, 폴백: `Agent` `subagent_type: feature-architect`, `model: opus`). 입력은 `_workspace/00_request.md`. 산출:

- `_workspace/01_architect_design.md` — inline/block feature·parser 노드·Tauri command·SSOT 설정 영향의 분기 결정.
- `_workspace/01_architect_plan.md` — TDD 플랜 + Golden Master 시나리오(어떤 `scripts/*.mjs`로 무엇을 잠그는지).

설계가 "백엔드 불필요"로 판정하면 backend-engineer는 띄우지 않는다(불필요한 IPC 표면 금지 원칙).

### Phase 3: 구현 (frontend-engineer ∥ backend-engineer, fan-out)

**실행 방식:** 팀 모드면 두 작업을 `TaskCreate`로 등록(둘 다 `depends_on: [설계 작업]`)하고 팀원이 자체 claim. 폴백이면 단일 메시지에서 `Agent` 두 개를 `run_in_background: true`로 동시 호출.

- frontend-engineer ← `01_architect_*` → `_workspace/02_frontend_changes.md`
- backend-engineer ← `01_architect_*` → `_workspace/02_backend_changes.md`

**경계면 통신 규칙:** backend-engineer가 command 시그니처를 바꾸면 즉시 frontend-engineer에게 `SendMessage`로 새 shape를 통지 → frontend가 `src/mocks/tauri-core.ts` + `invoke<>()` 타입을 맞춘다. browser mock은 read_file/write_file 시그니처가 바뀔 때 **반드시** 갱신한다(골든마스터가 mock으로 도니까).

### Phase 4: 검증 (qa-verifier, 증분)

각 엔지니어가 모듈을 끝낼 때마다 qa-verifier를 호출한다(끝에 몰아서 X). `general-purpose` 타입으로 실제 명령 실행:

- `npm test`(vitest, render-smoke 포함), `cargo test`(src-tauri), `npx tsc --noEmit`.
- 변경이 관측 가능 동작에 닿으면 CDP 골든마스터(`scripts/{mermaid-golden,settings-golden,nav-trace}.mjs`, 전제: `npm run dev:browser` + Chrome `:9222`) before/after 동일성.
- 핵심 교차 검증: Rust command shape ↔ TS invoke 타입 ↔ browser mock 3자 정합.

결과는 `_workspace/03_qa_report.md`. **불합격이면 해당 엔지니어에게 리포트 경로와 함께 SendMessage로 반려** → 수정 → 재검증. 합격해야 Phase 5로.

### Phase 5: 감사 (code-auditor)

code-auditor를 호출(입력: 변경 파일 + `02_*` + `03_qa_report.md`). intent-review(함수명==동작), CQS(쿼리 순수·커맨드 void), SSOT(설정은 `defineSetting`, 손수 fan-out 금지), 보안 자세(CSP·asset scope·atomic write·conflict guard·불필요 IPC 금지)를 점검해 `_workspace/04_audit_report.md`. 막힘(blocker) 지적이 있으면 해당 엔지니어에게 반려하고 Phase 3~5 루프.

### Phase 6: 정리

1. 팀 모드면 팀원 종료(`SendMessage`) 후 팀 정리(`TeamDelete`).
2. `_workspace/` 보존(감사 추적용 — 삭제 금지).
3. **`docs/FEATURES.md`(기능 계층 문서) 갱신** — 이번 작업이 사용자 관측 기능을 추가/변경/제거했으면 해당 계층(L1~L5)에 항목을 반영한다. 순수 내부 리팩토링·버그픽스로 기능 표면이 안 바뀌면 생략. 최종 갱신 날짜도 같이 수정. 기능 커밋과 같은 묶음에 넣는다.
4. 사용자에게 요약 보고: 무엇을 바꿨는지, 통과한 게이트, `04_audit_report.md`의 남은 권고(대기 리스트), FEATURES.md 갱신 여부.

## 에러 핸들링

| 상황 | 전략 |
|------|------|
| 에이전트 1개 실패/중지 | **1회 재시도**. 재실패 시 누락을 명시하고 진행(게이트는 못 건너뜀 — qa/audit 실패는 진행 불가, 기록만 가능한 architect/engineer 보조 산출물은 누락 표기 후 진행). |
| qa-verifier 불합격 | 진행 차단. 엔지니어에게 반려 → 수정 → 재검증 루프. |
| 경계면 충돌(command shape ↔ mock 불일치) | qa가 잡으면 backend·frontend 모두에게 `SendMessage`로 동시 통지, 같은 라운드에서 양쪽 수정. |
| 에이전트 간 데이터 충돌 | 삭제하지 않고 **출처(provenance) 병기** 후 보존. architect 판정을 우선 권위로 둔다. |
| 팀 플래그 미설정 | 서브 에이전트 폴백으로 자동 전환(`Agent` + `run_in_background`). 사용자에게 한 줄 통지. |
| 타임아웃 | 현재까지 수집된 부분 결과로 진행하되, 미완료 게이트는 "미검증"으로 명시. |

## 테스트 시나리오

### 정상 흐름 — "footnote-tooltip 기능 추가"

1. 사용자: "각주 위에 마우스 올리면 내용 보이는 footnote-tooltip 추가해줘". Phase 0: `_workspace/` 미존재 → 초기 실행.
2. Phase 2: feature-architect가 **inline feature**(InlineFeature 레지스트리, ViewPlugin 경로)로 분기, parser 노드 불필요·Tauri command 불필요·SSOT 무관으로 판정. `01_architect_design.md` + `01_architect_plan.md`(render-smoke + 새 unit 테스트 시나리오) 산출.
3. Phase 3: 백엔드 불필요 → frontend-engineer만 띄움. `02_frontend_changes.md`(새 feature 모듈 + 위젯 hover 처리).
4. Phase 4: qa-verifier가 `npm test`(render-smoke 포함) + `tsc --noEmit` RUN → `03_qa_report.md` 합격.
5. Phase 5: code-auditor가 intent-review/SSOT 점검 → blocker 없음, 권고만 → `04_audit_report.md`.
6. 결과: 코드 리포지토리 랜딩, `_workspace/` 보존, 요약 보고.

### 에러 흐름 — 경계면 정합 실패

1. 사용자: "write_file에 dry-run 플래그 추가하고 프론트도 맞춰줘". architect가 frontend ∥ backend 둘 다 필요로 판정.
2. Phase 3: backend-engineer가 `write_file` 시그니처를 바꿨는데 frontend-engineer가 `src/mocks/tauri-core.ts`를 안 고침(SendMessage 누락).
3. Phase 4: qa-verifier가 settings-golden 골든마스터 RUN → mock이 새 인자를 모름 → before/after 불일치 + 콘솔 에러. `03_qa_report.md`에 **불합격(경계면 mock 미동기화)** 기록.
4. 오케스트레이터가 backend·frontend 모두에게 리포트 경로와 함께 `SendMessage`로 반려 → frontend가 mock + invoke 타입 동기화.
5. qa-verifier 재검증 → IDENTICAL, errors []. 합격 후 Phase 5 진행.
6. 1회 재시도에도 골든마스터가 계속 깨지면 누락 명시 후 사용자에게 보고, audit는 "검증 미통과 상태" 명기.
