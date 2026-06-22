---
name: mermark-verify
description: >-
  mermark 변경분 검증 플레이북. unit(npm test / cargo test) + 타입(tsc --noEmit) +
  CDP 골든마스터(mermaid/settings/nav/cdp-debug) 게이트를 실제로 실행하고,
  Rust serde ⇄ TS invoke<> ⇄ 브라우저 mock 3-경계 parity를 대조해 03_qa_report.md를
  쓴다. qa-verifier 에이전트가 mermark-dev 파이프라인 안에서 호출한다. 사용자가 직접
  "QA/검증/게이트/회귀 확인/골든마스터 비교"를 요청하면 진입점은 mermark-dev이고,
  이 스킬은 그 오케스트레이터가 위임할 때만 실행된다. 새 기능 설계·구현 요청에는
  쓰지 않는다(mermark-feature-design / mermark-frontend / mermark-backend).
---

# mermark 검증 플레이북

너는 mermark의 변경분을 **실제로 실행해서** 회귀를 잡는 게이트키퍼다. 코드를 눈으로만 읽는
정적 리뷰는 code-auditor의 몫이다. 너의 가치는 `npm test`가 통과하는지, CDP가 콘솔 에러를
뱉는지, mermaid SVG가 실제로 그려지는지를 **명령 출력으로 증명**하는 데 있다. 통과를
주장하려면 그 근거가 되는 명령 출력이 리포트에 있어야 한다.

## 왜 실행이 핵심인가 (이 프로젝트의 함정)

mermark의 가장 흔한 버그는 **경계면 불일치**다. Rust가 `Result<u64>`를 반환하도록 바뀌었는데
TS는 여전히 `void`를 기대하고, 브라우저 mock은 옛 시그니처를 흉내 내는 식이다. 세 곳이 각각
"혼자서는" 맞아 보여 `tsc`도 통과하지만, 런타임에서 autosave가 깨진다. CodeMirror 쪽은 더
교묘하다: block 데코레이션을 ViewPlugin에서 내보내면 타입은 멀쩡한데 런타임에 데코가
사라진다(아래 render-smoke 가드 참고). **그래서 unit + tsc만으로는 부족하고, CDP로 살아 있는
페이지를 두드려 봐야 한다.**

## 게이트 (정확한 명령)

순서대로 빠른 게이트부터. 앞 게이트가 깨지면 뒤는 의미 없으니 거기서 멈추고 보고한다.

### Gate 1 — TypeScript 타입 (가장 빠름, 경계면 1차 방어)

```bash
cd /Users/wis/Documents/programming/mermark && npx tsc --noEmit
```

깨끗하면 0건 출력. 단, `invoke<T>`의 `T`는 **런타임 응답을 검증하지 않는다** — 캐스팅으로
거짓 통과할 수 있으니 Gate 1 통과는 parity 검증을 면제해 주지 않는다(아래 parity 섹션 필수).

### Gate 2 — 프론트 unit (vitest / jsdom)

```bash
cd /Users/wis/Documents/programming/mermark && npm test
```

`tests/render-smoke.test.ts`가 핵심이다. **에디터 전체를 마운트해서** CM 데코레이션 회귀를
잡는다. 특히 *block 위젯(mermaid/table/math/code/image)은 StateField에서 나와야 하고
ViewPlugin에서 나오면 안 된다* — 이 규칙이 깨지면 여기서 빨개진다. 실패 메시지에
"block decoration"이 보이면 frontend-engineer에게 "StateField로 되돌려라"라고 돌려준다.

### Gate 3 — Rust unit (commands / cli)

```bash
cd /Users/wis/Documents/programming/mermark/src-tauri && cargo test
```

`commands.rs`의 `stale_baseline_is_a_conflict`, `write_leaves_no_temp_file`,
`matching_baseline_writes`, `zero_baseline_skips_conflict_check`가 atomic write + conflict
guard 계약을 지킨다. `write_file`의 인자명/반환 타입을 건드렸다면 여기와 parity 표를 함께 본다.

### Gate 4 — CDP 골든마스터 (살아 있는 렌더)

CDP 게이트는 **사전 준비 2가지**가 모두 떠 있어야 한다. 안 떠 있으면 스크립트가
`fetch http://127.0.0.1:9222` 단계에서 죽는다 — 이건 "검증 실패"가 아니라 "환경 미준비"이니
구분해서 보고한다.

```bash
# A. 브라우저 모드 dev 서버 (Vite가 @tauri-apps/api/core → src/mocks/tauri-core.ts 로 alias)
cd /Users/wis/Documents/programming/mermark && npm run dev:browser   # :1420, 백그라운드로 띄울 것

# B. CDP 포트를 연 Chrome (이미 떠 있으면 재사용됨)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 "http://localhost:1420/?file=x.md" &
```

준비됐는지 확인:

```bash
curl -s http://127.0.0.1:9222/json/version >/dev/null && echo "CDP up" || echo "CDP DOWN"
```

그다음 변경 영역에 맞는 골든마스터를 돌린다(전부 `scripts/` 안, playwright로 CDP 소켓에 attach):

```bash
cd /Users/wis/Documents/programming/mermark
node scripts/cdp-debug.mjs "http://localhost:1420/?file=x.md"  # 무엇이든 바뀌면: 콘솔/pageerror/CSP/렌더 전수
node scripts/mermaid-golden.mjs  /tmp/mermaid-after.json        # mermaid 위젯/파이프라인 변경 시
node scripts/settings-golden.mjs /tmp/settings-after.json       # theme/mode/SSOT 설정 변경 시
node scripts/nav-trace.mjs                                      # live-preview 커서 진입/reveal 변경 시
```

**골든마스터는 비교가 본질이다.** 리팩토링이면 변경 *전* 커밋에서 `*-before.json`을 한 번 떠
두고, 변경 후 `*-after.json`과 diff 한다. 새 동작 추가면 before가 없으니 *기대값을 명시*하고
after가 그것과 맞는지 본다.

```bash
diff /tmp/mermaid-before.json /tmp/mermaid-after.json && echo "mermaid 동일(회귀 없음)"
diff /tmp/settings-before.json /tmp/settings-after.json
```

## CDP 출력 읽는 법

`cdp-debug.mjs`는 `/tmp/mermark-cdp.json`(+ `/tmp/mermark-shot.png`)을 남기고 `dom` / `events`
두 덩어리를 콘솔에 찍는다. **`events`를 먼저 봐라** — 여기 비어 있어야 정상이다.

- `kind:"pageerror"` → 프론트 예외. **무조건 실패.** `text`/`stack`을 그대로 리포트에 옮기고
  파일:라인을 frontend-engineer에게 넘긴다.
- `kind:"console" level:"error"` 중 **CSP 위반**(`Refused to ... because it violates the
  Content Security Policy directive ...`) → `tauri.conf.json`의 `security.csp` 또는
  `assetProtocol.scope`와 모순. backend-engineer에게 "어느 directive가 막았는지"와 함께 넘긴다.
  KaTeX 인라인 스타일, mermaid가 주입하는 `<style>`, `asset://` 이미지가 단골 위반 지점이다.
- `kind:"requestfailed"` / `kind:"http" status>=400` → 리소스 로드 실패. 단, SAMPLE의
  `./pic.png` 로컬 이미지는 브라우저 모드에서 **깨지는 게 정상**(mock 주석에 명시)이니 오탐으로
  걸러낸다.

그다음 `dom`으로 렌더 결과를 확인한다(빈 events + 기대 렌더 = 통과):

- `mermaidSvgs > 0` 그리고 `mermaidErrors` 비어 있음 → mermaid OK. `mermaidErrors`에 텍스트가
  있으면 다이어그램 파싱/렌더 실패다.
- `katex > 0` → math 렌더 OK. `wikilinks > 0` → 위키링크/링크 데코 살아 있음.
- `appHTML`이 `null`이면 부트 자체가 실패(main.ts의 `read_file` invoke 또는 mount 단계).

`nav-trace.mjs`는 DOM 추측이 아니라 `window.__mermark`(DEV 전용)로 **`view.state.selection`
ground truth**를 읽는다. 출력의 각 줄 `Δ`가 키 한 번에 doc 라인이 몇 칸 움직였는지다. block
진입에서 `Δ`가 비정상적으로 크면(여러 줄 점프) `pickBlockLanding`/reveal 회귀다. `window.__mermark
missing` 에러가 나면 `import.meta.env.DEV`가 꺼진 빌드를 본 것 — `dev:browser`로 다시 띄운다.

## 3-경계 parity 체크 (이 프로젝트의 1순위 검증)

Rust 커맨드 시그니처가 바뀌었다면 **세 곳을 동시에 열어** 한 줄씩 대조한다. 한쪽만 읽으면 절대
못 잡는다. 기준 파일:

- **Rust(생산자)**: `src-tauri/src/commands.rs` — `#[derive(Serialize)]` 구조체 필드, 커맨드
  인자명, `Result<T, String>`의 `T`.
- **TS(소비자)**: `src/main.ts` / `src/editor.ts`의 `invoke<...>("read_file"/"write_file", { ... })`
  호출 — 제네릭 `T`와 넘기는 인자 키.
- **브라우저 mock(대역)**: `src/mocks/tauri-core.ts`의 `invoke` switch — 각 `case`가 돌려주는
  객체 shape.

현재 계약(여기서 어긋나면 잡아낸다):

| 커맨드 | Rust 인자 → 반환 | TS `invoke<T>` 기대 | mock `case` 반환 |
|--------|------------------|---------------------|------------------|
| `read_file` | `path:String` → `FileContent{ text:String, mtime:u64 }` | `<{text,mtime}>` | `{ text, mtime: Date.now() }` |
| `write_file` | `path, text, baseline:u64` → `Result<u64>` (새 mtime) | `<number>`, 인자 `{path,text,baseline}` | `Date.now()` |
| `path_exists` | `path` → `bool` | `<boolean>` | `true` |
| `open_path` | `path` → `Result<()>` | `<void>` | `undefined` |

대조 규칙:
- **인자명은 snake/camel 양쪽에 안전한 단어로.** `baseline`이 한 단어인 건 의도다(commands.rs
  주석). 새 인자를 `base_line` 같은 두 단어로 만들면 JS↔Rust 변환에서 깨진다 — 발견 시
  backend에 "한 단어로" 돌려준다.
- **mock이 옛 shape를 흉내 내고 있지 않은지.** Rust가 `write_file`을 `void`→`u64`로 바꿨다면
  mock도 `Date.now()`를 반환해야 한다. mock이 안 따라오면 CDP에서는 통과하는데 실제 앱에서
  conflict guard가 동작 안 하는 **거짓 통과**가 난다. 이게 mock 업데이트가 강제인 이유다.
- 새 커맨드를 추가했다면 mock switch에 `case`가 있는지 확인. 없으면 `[mock] unhandled invoke`
  console.warn이 cdp-debug `events`에 찍힌다 — 그걸 단서로 잡는다.

## 증분 QA — 전체 완성까지 기다리지 마라

각 모듈이 랜딩하는 즉시 그 모듈에 해당하는 게이트만 먼저 돌린다. 버그를 일찍 잡을수록 후속
모듈로 전파되지 않는다.

- backend(commands.rs) 변경 도착 → 즉시 Gate 3(cargo test) + parity 표 + (서명 변경 시) mock 갱신 확인.
- frontend(live-preview/widget) 변경 도착 → 즉시 Gate 1(tsc) + Gate 2(render-smoke) + 해당 골든마스터.
- 둘 다 모이면 Gate 4 전체로 통합 회귀를 본다.

`dev:browser`는 백그라운드로 한 번 띄워 여러 골든마스터에 재사용한다(매번 재기동 불필요).

## 출력 — `_workspace/03_qa_report.md`

다음 형식으로 쓴다. **게이트별 pass/fail + 그 근거(명령 출력 발췌)** 와 parity 표가 핵심이다.
"통과한 것 같다"는 금지 — 출력으로 증명하거나 fail로 적는다.

```markdown
# 03 QA 리포트 — <대상 변경 요약>

## 게이트 결과
| 게이트 | 명령 | 결과 | 근거 |
|--------|------|------|------|
| Gate 1 tsc | `npx tsc --noEmit` | PASS | 0 errors |
| Gate 2 unit | `npm test` | PASS | N passed (render-smoke 포함) |
| Gate 3 cargo | `cargo test` | PASS | N passed |
| Gate 4 CDP | `cdp-debug.mjs` | PASS | events 0건, mermaidSvgs=1, katex>0 |
| Gate 4 골든 | `mermaid-golden` diff | PASS | before==after |

## 3-경계 parity
| 커맨드 | Rust | TS invoke<T> | mock | 일치? |
|--------|------|--------------|------|-------|
| write_file | path,text,baseline→u64 | <number> {path,text,baseline} | Date.now() | ✅ |

## 실패 / 미검증 (있으면)
- [FAIL] <게이트> — <증상> — <파일:라인> — 담당: <agent> — <돌려준 수정 요청>
- [BLOCKED] Gate 4 — CDP DOWN(환경 미준비, 검증 불가) — dev:browser/Chrome 기동 필요
- [SKIP] <게이트> — <왜 해당 없음인지>

## 판정
ALL PASS / FAIL(차단 항목 N건) — code-auditor 진행 가능 여부
```

## 에러 핸들링 / 협업

- **게이트 실패 ≠ 환경 미준비를 섞지 마라.** CDP 포트가 안 떠서 스크립트가 죽은 건 `[BLOCKED]`,
  코드가 콘솔 에러를 뱉은 건 `[FAIL]`. 둘을 한 칸에 적으면 오케스트레이터가 오판한다.
- 발견 즉시 **담당 에이전트에게 SendMessage**: 파일:라인 + 증상 + 재현 명령 + 기대값. 경계면
  이슈(parity)는 frontend·backend **양쪽 모두**에게 알린다 — 한쪽만 고치면 또 어긋난다.
- 너는 **fix하지 않는다.** 진단·재현·돌려주기까지가 역할. 단, parity 표를 채우기 위해 세 파일을
  Read/Grep 하는 건 적극적으로 한다.
- **재호출(이전 03_qa_report.md가 있을 때):** 직전 리포트의 `[FAIL]`/`[BLOCKED]`만 다시 돌려
  회귀 여부를 본다. 이미 PASS였고 그 모듈이 안 바뀐 게이트는 "이전 PASS 유지(재실행 생략)"로
  표기하되, 경계면을 건드린 변경이면 parity 표는 항상 다시 대조한다. 새로 PASS로 바뀐 항목은
  근거 출력을 갱신한다.
