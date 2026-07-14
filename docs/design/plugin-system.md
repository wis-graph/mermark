# 설계: 확장 시스템 — 개인용 API 중앙화 (rev 2)

- 작성: feature-architect, 2026-07-14 (rev 2 — 같은 날 개정)
- 상태: 설계 문서 (구현 없음). 코드 근거는 전부 현 HEAD 기준 파일:라인.

---

## 개정 노트 (rev 2 — 무엇이 왜 바뀌었나)

**목표가 확정됐다: "내가 내 에디터를 확장한다" — 서드파티 생태계가 아니다.**
rev 1은 서드파티 공개(Phase 4)를 전제로 안정 경계·래핑·권한 모델·apiVersion
동결을 설계했다. 소비자가 소유자 본인뿐이라는 확정은 그 전제 비용 구조를
뒤집는다. rev 2의 변경:

1. **얇은 래핑(MdNode/MdWidget/InlineApi) 계층 삭제** — §2를 "CM6 네이티브
   노출 + 그 대가"로 재작성. rev 1 §2.3의 래핑 시그니처는 폐기. 판정 근거는
   §2.2. rev 1 §2.4의 실측표(19개 중 17개 표현 가능, link/list 탈출구 필요)는
   삭제 근거의 증거로 §2.3에 축약 보존.
2. **보안 집행 장치는 비목표로 강등, 사실은 보존** — manifest 권한 강제·설치
   승인 다이얼로그·apiVersion 동결·소프트 게이트는 목표 밖. 단 §6.1의 위협
   사실 4건은 **오케스트레이터가 코드로 재검증했고 전부 사실**이므로 문서에
   그대로 남긴다. 신뢰 모델을 "내 코드만 로드"로 재서술하고, 서드파티를 받는
   순간 필요해지는 것들을 §6.3 체크리스트로 박제.
3. **Phase 4 삭제, 로드맵을 1'/2/3으로 재편** — Phase 3(로더)도 이번 구현
   스코프 밖(1'·2를 만져본 뒤 결정). §8 참조.
4. 실측 정정: 내장 feature 수는 19가 아니라 **20 (inline 15 + block 5)**
   (`src/markdown/live-preview/index.ts:31-49` — rev 1이 inline을 14로 오산).

구현 설계와 TDD 플랜은 `_workspace/01_architect_design.md` /
`_workspace/01_architect_plan.md`가 정본이다. 이 문서는 결정과 근거의 기록.

---

## 1. 현 확장점 전수 지도 (rev 1에서 유지 — 여전히 사실)

"런타임"은 *모듈 로드 이후에 등록해도 반영되는가*를 뜻한다.

| # | 확장점 | 위치 · 계약 | 등록 방식 |
|---|---|---|---|
| R1 | 설정 | `src/settings/registry.ts:28` `registerSetting<T>` | **런타임 ✅** — 유일. `ui.group: "플러그인"`이면 플러그인 패널에 자동 렌더(app.ts:412-413). unregister 없음 |
| R2 | 커맨드/단축키 | `src/shortcuts/registry.ts:35` `registerHandler` | **절반만 런타임 ⚠️** — handler 주입은 런타임이지만 카탈로그 `SHORTCUT_ACTIONS`(actions.ts:26)가 컴파일타임 const. `effectiveBinding`(registry.ts:42)·`findConflict`(:52)·`rebuildLookup`(:64)이 전부 이 배열을 순회 → **카탈로그에 없는 id는 handler를 등록해도 chord가 발화하지 않고 설정 UI에도 안 뜬다** |
| R3 | 마크다운 기능 | `live-preview/index.ts:31-49` `INLINE_FEATURES`(15)/`BLOCK_FEATURES`(5) | **컴파일타임 ❌** — 이중 잠금: 배열이 const + `blockPreview = buildBlockPreview(BLOCK_FEATURES)`(index.ts:57)가 모듈 로드 시 byNode 맵 확정(core.ts:307-314) |
| R4 | 테마 | `settings/theme-schema.ts` | 절반 — 값은 런타임(JSON), 프리셋 등록은 closed union(:8). **v1 범위 밖 유지** |
| R5 | parser 노드 | `markdown/parser.ts:296-303` `mermarkExtensions` const | 컴파일타임 ❌ — 개인용에선 **그냥 배열에 추가하면 된다**(소유자가 소스를 고치는 게 정상 경로). 런타임화 불요 |
| R6 | 에디터 확장 | `editor.ts:322-401` 하드코딩 목록, 주입구는 `opts.extraExtensions`(:253) | 컴파일타임 ❌ — v1 미개방(수요 시 재검토) |
| R7 | 자동완성 소스 | `editor.ts:354` override 하드코딩 | 컴파일타임 ❌ — v1 미개방 |
| R8 | Tauri command | `src-tauri/src/lib.rs` invoke_handler | 확장 대상 아님 — IPC 표면 최소화 원칙 유지 |

**결론(불변)**: 완전 런타임은 R1 하나. 이번 작업(Phase 1'+2)은 R2를 완전
런타임으로, R3를 런타임 레지스트리로 전환하고, R1·R2·R3를 단일 파사드
`src/api/`로 모은다.

---

## 2. API 표면 결정 — CM6 네이티브 노출 (래핑 삭제)

### 2.1 판정

**래핑 계층을 만들지 않는다.** 확장 코드는 기존 `InlineFeature`/`BlockFeature`
(`core.ts:135-143, 246-251`), `Spec`, `BlockSpec`, `WidgetType`을 그대로 쓴다.
이 API는 CodeMirror 6에 묶인다 — **소비자가 소유자 하나뿐이라 의도된
트레이드오프다.**

### 2.2 근거

1. **래핑의 유일한 내구 가치가 소멸했다.** 래핑이 사던 것은 "렌더 엔진
   교체(CM6→X) 시 서드파티 플러그인 생존"(rev 1 §7). 소비자가 본인이면 엔진
   교체 때 확장도 본인이 고친다 — 어댑터는 *가상의 사건*을 위해 *지금부터
   영구히* 내는 세금이 된다.
2. **인체공학 층은 이미 존재한다 — core.ts가 그것이다.** "매번 CM6
   Decoration/StateField를 다루는 고통"이라는 반론을 실측하면: feature 작성자가
   실제로 만지는 CM6 표면은 `Decoration.mark`/`Decoration.replace` 팩토리 호출
   2종, `SyntaxNode`의 `from/to/getChild`, 블록이면 `WidgetType` 서브클래스가
   전부다. StateField/ViewPlugin 배선, reveal rule, blockquote 벗기기, 펜스
   처리라는 *진짜* 고통은 이미 `InlineCtx`/`BlockCtx`(core.ts:123-133,
   238-244)가 전부 흡수한다. 즉 "얇은 헬퍼 + CM6 타입 경계"라는 중간안은
   **새로 만들 것이 아니라 이미 갖고 있는 것**이다.
3. **래핑은 비용을 내고 힘을 깎는다** (rev 1 §2.4 실측): 20개 중 `link`는
   커스텀 `view?: Extension`(features/link.ts — 유일), `list`는
   `foldedRanges(ctx.state)` 직접 호출(features/list.ts:31)이 필요해 래핑
   타입만으로 표현 불가 → 첫날부터 탈출구를 동봉해야 했다. 단일 소비자에게
   "래핑 + 탈출구"는 순수 의례다. 네이티브 노출은 이 2건이 그냥 표현된다.

### 2.3 그 대가 (정직하게)

- **CM6 메이저 업그레이드·데코 파이프라인 리팩터 = 내 확장 전부의 파괴적
  변경 가능성.** 수용한다. 완충재는 두 가지 뿐이고 그걸로 충분하다:
  (a) 확장이 만지는 표면이 애초에 얇다(§2.2-2), (b) 확장도 이 repo 안에서
  같은 vitest/tsc 게이트를 지나므로 파손이 컴파일/테스트에서 즉시 드러난다.
- **`@codemirror/*`·`@lezer/*` 패키지 import는 확장 코드에 허용된다** — 그게
  "네이티브"의 의미다. 파사드(§4)가 fence하는 것은 *mermark 내부 모듈*이지
  vendor 패키지가 아니다.
- rev 1 §2.4의 표현력 실측표는 폐기하되 결론만 남긴다: 현 계약은 내장 20개를
  전부 표현한다(당연 — 그 계약으로 짜여 있으니까). 이 계약이 곧 공개 표면이다.

### 2.4 안정성 등급 (개인용 재정의)

"stable/unstable" 구획과 apiVersion 동결(rev 1 §2.5, §7)은 폐기. 대신:

- **깨면 안 되는 계약** (테스트가 지킴): 블록 데코는 StateField에서만
  (render-smoke), reveal rule("edit 모드 + selection touch"만, read 모드 불변 —
  core.ts:52-55), 커맨드 id never-rename(actions.ts:17 — 사용자 오버라이드가
  id로 저장, app.ts:387-407), 설정 SSOT(defineSetting/registerSetting 경유),
  `BlockSpec.widget()` 순수(core.ts:229).
- **바꿔도 되는 것**: 그 외 전부 — 고치는 사람과 쓰는 사람이 같으니까.

---

## 3. 런타임 레지스트리 전환 경로 (R3) — rev 1 유지, 어댑터만 제거

잠금 지점 진단(rev 1 §3.1)과 전환 설계(§3.2)는 유효하다. 변경점: 레지스트리에
등록되는 타입이 Md* 래핑이 아니라 **raw `InlineFeature`/`BlockFeature` 그대로**다
(어댑터 없음).

- `feature-registry.ts` 신설: 등록/해제 + 변경 통지. 부팅 시 index.ts가 내장
  20개를 현 순서 그대로 시딩(순서 = 노드 공유 시 디스패치 순서).
- `blockPreview` 상수 → 팩토리 (index.ts:57 → 함수, editor.ts:335 호출로).
- 열린 에디터 반영: **featureCompartment + `reloadFeatures()`** — 기존
  mode/vim Compartment(editor.ts:280-281, reconfigure dispatch :291, :309)와
  동일 패턴. 문서를 건드리지 않으므로 커서/스크롤/fold/undo가 보존된다.
- 상세(파일별 변경, 커서 보존 논증, first-claim-wins 결정)는
  `_workspace/01_architect_design.md` §3.

---

## 4. 단일 파사드 — `src/api/`

rev 1의 "주입되는 MermarkAPI 객체"는 로더(Phase 3) 전제였다. 로더가 스코프
밖이므로 rev 2의 파사드는 **평범한 barrel 모듈**이다: 확장 코드(및 미래의
로더)가 mermark 내부를 만지는 유일한 import 지점.

- export: `registerInlineFeature`/`registerBlockFeature`(R3),
  `registerCommand`(R2 — 런타임화 후), `registerSetting`(R1), 그리고 타입/헬퍼
  재수출(`InlineFeature`, `BlockFeature`, `Spec`, `BlockSpec`, `hide`,
  `fencedInfo` 등).
- 내부 import 차단: repo에 ESLint가 없다(실측 — lint 설정/스크립트 부재).
  규칙 하나를 위해 ESLint를 도입하는 것은 콜드로드·의존성 원칙과 상충 →
  **grep 기반 vitest fence 테스트**로 집행한다(`npm test` 게이트에 포함).
  의존 방향: `api → registries` 단방향, `registries → api` 금지. 내장 기능은
  파사드를 지나지 않는다(내장이 자기 레지스트리를 직접 쓰는 건 정상).
- 개인 확장의 집: `src/extensions/` + `activateExtensions()` 진입점(main.ts
  boot에서 1회 호출). 이 디렉터리만 fence 테스트의 "api만 import" 규칙을
  받는다. 상세는 `_workspace/01_architect_design.md` §2.

### 4.1 SHORTCUT_ACTIONS 런타임화 (선행 필수)

rev 1 §4.2의 발견 그대로: 카탈로그가 const라 "절반만 런타임"(§1 R2). 전환 —
shipped 카탈로그(actions.ts)는 순수 데이터로 유지하고, registry.ts가
`allActions()`(shipped + 런타임 등록분) 질의를 갖고 `effectiveBinding`/
`findConflict`/`rebuildLookup`/설정 UI(controls.ts:396)가 전부 그 질의를
순회한다. 계약 보존: id never-rename, 오버라이드 id-키 저장(공짜 영속),
미등록 id의 잔존 오버라이드는 불활성(유령 발화 없음). 상세 설계와 충돌
강등 규칙(`demoteConflictingDefault`)은 `_workspace/01_architect_design.md` §4.

---

## 5. 로더 (Phase 3 — 이번 스코프 밖, 스케치만 보존)

1'·2를 실제로 만져본 뒤 결정한다. rev 1 §5의 조사 결과 중 그때 다시 쓸 것:

- 위치: 앱 스코프 `<app_config_dir>/plugins/<id>/` (vault 없음 — baseDir는
  문서마다 바뀜).
- 코드 실행: CSP `script-src 'self'`(tauri.conf.json)라 문자열 코드 실행 불가.
  후보는 `script-src blob:` + blob-URL 동적 import (unsafe-eval 기각, asset:
  기각 — assetProtocol scope `**`라 디스크 전체가 스크립트化). **CSP 변경은
  로더가 실릴 때만.**
- 신규 IPC는 read-only 2개(list/read) + `src/mocks/tauri-core.ts` 동기화 필수.
- 개인용에선 로더 없이도 산다: 확장을 `src/extensions/`에 넣고 번들에 포함
  (§4). 로더의 값어치는 "재빌드 없는 실험"뿐 — 그 값이 CSP 개방을 정당화하는지
  그때 판단.

---

## 6. 보안 — 신뢰 모델: "내 코드만 로드"

### 6.1 위협 사실 (보존 — 오케스트레이터가 코드로 재검증, 전부 사실)

이 절은 rev 2에서도 삭제하지 않는다. **남의 플러그인 코드를 하나라도 웹뷰에
넣는 순간, 아래에 의해 그것은 전권 위임이다:**

- **파사드 우회 가능**: `withGlobalTauri: false`(tauri.conf.json)여도
  **`window.__TAURI_INTERNALS__`는 웹뷰에 존재한다**(main.ts:723이 실제로
  존재를 검사해 사용). 같은 JS 컨텍스트의 코드는 이걸 직접 집어 invoke할 수
  있다 → **웹뷰 안의 어떤 권한 검사도 보안 경계가 아니다.**
- **파일 IPC 전권**: `write_file`은 `baseline: 0`이면 conflict guard를
  건너뛰고 임의 경로를 덮어쓴다(commands.rs — 0은 "no baseline";
  overwriteOnDisk가 정상 용례). `read_file`은 경로 제한이 없다.
- **`list_dir`은 `is_within_base` 펜스가 의도적으로 없다**(commands.rs:625 —
  탐색기의 `..` 상향 이동 때문) → 홈 전체 열람.
- **유출 경로**: `connect-src`는 잠겨 있지만 CSP `img-src ... https:`가 열려
  있어 이미지 GET의 쿼리스트링으로 데이터 유출이 가능하다.

### 6.2 rev 2 신뢰 모델

로드되는 확장 코드 = 이 repo 안에서 소유자가 쓰고 커밋한 코드뿐(§4
`src/extensions/`). 이것은 main.ts와 동일한 신뢰 등급이므로 **권한 모델이
성립할 대상 자체가 없다.** 따라서 manifest 권한 강제·설치 승인 다이얼로그·
restricted mode·소프트 invoke 게이트·apiVersion 동결은 전부 **비목표**.
기존 보안 자세(CSP 무변경, atomic write, conflict guard, IPC 표면 동결)는
이 작업에서 하나도 약화되지 않는다 — 신규 IPC 0, CSP 변경 0.

### 6.3 마음이 바뀌는 날의 체크리스트 (서드파티를 하나라도 받는 순간)

미래 조건으로 박제한다. 아래 전부가 *다시* 필요해진다:

1. §6.1을 사용자 고지로: "플러그인 활성화 = mermark가 여는 모든 파일에 대한
   전권 위임" 문장을 설치/활성화 UI에 그대로 노출.
2. manifest `permissions` 선언 + 파사드 소프트 게이트(성실한 플러그인의
   과실 방지용 — §6.1에 의해 보안 경계는 아님을 문서·UI에 명시).
3. `watch_file`/`unwatch_file`(단일 슬롯) · updater/process 계열 영구 비노출.
4. 전 플러그인 일괄 off 스위치(restricted mode).
5. apiVersion 동결 + 파괴적 변경 정책 — 공개 직전이 마지막 설계 수정 기회.
6. blob: CSP의 보안 등가성 재검토(backend-engineer + code-auditor 교차 검토).
7. 수동 폴더 설치만(마켓플레이스 없음)으로 공급망 위험을 사용자의 명시적
   파일 조작 뒤로.

---

## 7. 명명·id 규율 (rev 1 §7에서 존치하는 것)

- **커맨드 id never-rename**(actions.ts:17) — 런타임 등록 커맨드에도 동일
  적용(오버라이드가 id로 영속되므로). 확장 커맨드 id는 `ext.<name>.<action>`
  접두 관례(내장과 충돌 방지 — 강제 아닌 관례, 소비자가 본인이므로).
- 설정 key도 동일 관례: `mermark.ext.<name>.*`.
- apiVersion·deprecation 정책은 폐기(§2.4).

---

## 8. 로드맵 — 1'/2/3

| Phase | 내용 | 규모 | 위험 | 되돌리기 |
|---|---|---|---|---|
| **1'. API 중앙화 (슬림)** | `src/api/` barrel + fence 테스트, SHORTCUT_ACTIONS 런타임화(§4.1), `src/extensions/` 진입점. **래핑·어댑터·파일럿 이관 없음** | 신규 3 + 수정 3 | 낮음 — additive, 동작 무변경 | api/·extensions/ 삭제 + registry 원복 |
| **2. 런타임 feature 레지스트리** | feature-registry.ts, blockPreview 팩토리화, featureCompartment + `reloadFeatures()`, main.ts sink, 내장 20개 시딩 | 신규 1 + 수정 3 | 중간 — StateField 교체 전이가 신규 경로 (RED 선행: 등록→reload→위젯 출현+커서 보존) | blockPreview 상수 원복, Compartment 제거 |
| **3. 로더 (보류)** | §5 스케치. 1'·2 사용 경험 후 결정 | — | 높음 (CSP 개방) | — |

1'과 2는 서로 독립적으로 머지 가치가 있다(1' = 커맨드 해금 + import 규율,
2 = feature 해금). 이번 구현 = 1' + 2.

## 열린 질문 (보류 유지)

1. 테마 프리셋 개방(R4) — 파급(closed union, nextPreset 순환)이 커서 범위 밖.
2. 확장 CSS 주입 규칙(테마 SSOT와의 충돌) — Phase 3에서.
3. R6/R7(에디터 확장·자동완성 소스) 파사드 개방 — 실수요 확인 후.
