# Intent Review — 2026-10-18 · 파트 A (markdown / document / text / editor.ts)

> 범위: `src/markdown/**`, `src/document/**`, `src/text/**`, `src/editor.ts` — 비테스트 소스만(mocks·`*.generated.ts`·material-icons 제외).
> 병렬 파트: B(chrome/sidebar/workspace/extensions) · C(settings/main.ts/api/shortcuts/update/기타 루트) · D(src-tauri/src).
> 방법: `quick-check.sh` 1차 스캔 → 77개 파일 전부 직접 읽고 판정 → 이전 리뷰(06-13, 07-03) 지적 해소 여부 대조.
> 코드는 수정하지 않았다(진단·권고만).

## 요약

- **스캔**: 77개 파일, ~9,900줄, 명명 함수·메서드 약 480개
- **quick-check 플래그**: 🔴 8건(`session.ts:143` 677줄, `core.ts:338` 140줄, `wikilink.ts:107` 127줄, `recovery-modal.ts:35` 102줄, `path-prompt.ts:53` 101줄, `image.ts:173` 97줄, `conflict-modal.ts:77` 86줄, …) · 🟡 4건 · 🔵 3건. 이 중 `createDocumentSession`·`blockPreview`·`openRecoveryModal`·`createOpenPathPrompt`·`openConflictModal`은 **Factory·렌더 순차 호출이라 False Positive**다(공유 클로저 상태가 있다). 길이 자체보다 그 안에 인라인으로 박힌 도메인 규칙을 문제로 봤다.
- **후보**: 33건 (high 12 / medium 14 / low 7)
- **CQS 위반(사기꾼 ⭐)**: 1건. `conflict-recovery.ts:55 detect`는 이름이 조회처럼 읽히지만 레코드를 기록하고 반환한다.
- **최대 이슈**: **충돌 정책 설정이 실제로는 아무 일도 하지 않는다.** `editor.ts:460 setConflictPolicy(_p) {}`는 빈 sink이고 `shouldOverwriteOnConflict`(:49)는 테스트에서만 호출된다. 그런데도 설정 패널은 "덮어쓰기" 토글을 보여 주고, `editor.ts`의 doc 주석 세 곳(:98-101, :153-155, :360)은 이 정책이 적용된다고 말한다. 이름과 주석이 한 약속을 구현이 지키지 않는다.
- **결론**: 함수 하나하나의 네이밍 규율은 여전히 높다. 06-13 지적 대부분과 07-03 지적 전부가 해소됐다. 남은 부채는 **분산된 의도**로 옮겨 갔다. 원격 볼트·SSH·경로 포함/결합·이스케이프 판정·Promise 메모 캐시·헤딩 SSOT가 각각 2~6곳에 따로 구현돼 있고, 그중 3건(이스케이프·경로 포함·모달 Esc)은 **실제 동작이 이미 서로 어긋났다**.

---

## 이전 리뷰 지적 해소 현황

| 출처 | 지적 | 상태 | 근거 |
|---|---|:--:|---|
| 06-13 High#1 | `applySvg` God 함수 | ✅ 대부분 해소 | `attachPanZoom` 추출, `recordRenderedHeight`(mermaid-widget.ts:324) 명명, `setup`/`fitHeight` 제거. 남은 것: 이름이 실제 동작보다 덜 약속함(전체화면 버튼 생성·이벤트 발행, low) |
| 06-13 High#2 | 펜스 본문 추출 중복 | ✅ 해소 | `core.ts:120 dropFences` + `BlockCtx.fencedBody`. **새 잔여**: ```` ``` ````만 인식하고 `~~~`는 인식하지 못함(아래 M) |
| 06-13 High#3 | 바운드 캐시 복붙 | ✅ 해소 | `bounded-cache.ts`. image·remote-image도 사용 |
| 06-13 High#4 | `setup()` 클로저 | ✅ 해소 | 제거됨 |
| 06-13 Med | `fitHeight` 전역 쓰기 | ✅ 해소 | `recordRenderedHeight`가 명시적 command가 됨 |
| 06-13 Med | `table-widget.toDOM` thead/tbody 루프 중복 | ❌ 미해소 | table-widget.ts:92-104 ↔ :112-119 |
| 06-13 분산#2 | 클릭→소스 이중 배선 | ✅ 해소 | table/math/frontmatter 위젯 핸들러 제거, `core.ts:447 clickEntry` 하나로 통합 |
| 06-13 분산#4 | mermaid `initialize` 옵션 2곳 | ❌ 미해소 | mermaid-widget.ts:121-126 ↔ :166-171 |
| 06-13 분산#5 | reserve-last-height 분산 | ✅ 해소 | `recordRenderedHeight` |
| 07-03 #1 | 경로 좌측 생략 라벨 | ✅ 해소(범위 밖) | `src/chrome/path-label.ts` 있음. 소비처 확인은 파트 B |
| 07-03 #2 | `basename` twin | ✅ 해소 | `document/path.ts:12`. 남은 것: `wikilink.ts:19` `split("/").pop()`, `file-host.ts:177 remoteParentAndName`이 여전히 인라인 |
| 07-03 #3 | CJK 플랭킹 트립와이어 | ✅ 해소 | `standardEmphasisFlank` export(cjk-emphasis.ts:113) + `tests/cjk-emphasis.test.ts` |

---

## 🔴 High Priority

### 1. `setConflictPolicy()` / `shouldOverwriteOnConflict()` — ⭐⭐ — `src/editor.ts:460`, `:49`
**실제 책임**: 아무것도 하지 않는다. 빈 sink이고, 규칙 함수는 테스트에서만 호출된다.
**문제**: `conflictPolicySetting`(settings/app.ts:336, 주석 "sink deferred")이 UI에 "중단/덮어쓰기" 토글로 노출돼 있고, main.ts:1457이 매번 구독해서 이 빈 메서드를 호출한다. editor.ts의 doc 주석(:98 "Live conflict-policy sink", :153 "`overwrite` clobbers the external change immediately", :360)은 이 동작이 있다고 약속하지만, `makeAutosave.save`(:156)의 catch는 정책을 읽지 않는다. 함수명 + 주석 + UI 세 겹의 약속이 구현과 어긋난다. 아래 둘 중 하나로 정리하는 것이 안전하다.
**추출 제안**:
```
// 옵션 A — 약속을 지킨다
makeAutosave(..., getPolicy: () => ConflictPolicy)
save().catch(CONFLICT) → shouldOverwriteOnConflict(getPolicy()) ? overwriteOnDisk(text) : enterConflict(msg)
// 옵션 B — 약속을 철회한다
설정 ui 숨김 + setConflictPolicy/doc 주석 삭제 + "deferred" 상태를 한 곳에 명시
```

### 2. `makeAutosave()` 내부 상태 전이 인라인 중복 — ⭐⭐⭐ — `src/editor.ts:113` (~220줄 factory)
**실제 책임**: 디바운스 저장 + 충돌/복구/읽기 전용 상태 기계.
**문제**: Factory이므로 길이는 FP다. 다만 **이름 없는 상태 전이가 여러 번 복사돼 있다.**
- "복구(suspended) 상태 진입" `suspended=true; conflicted=true; pending=text; onStatus("recovery",…)` ×4 (:174-178, :247-250, :265-270, :290-293)
- 기준 mtime 갱신 `if (typeof mtime === "number" && mtime > 0) baseline = mtime` ×3 (:141, :164, :240)
- 충돌 오류 판정 `String(err).startsWith("CONFLICT")` ×2 (:170, :245)
- 읽기 전용 가드 `if (readOnly) { onStatus("error", REMOTE_READONLY_MESSAGE); … }` ×7
- `REMOTE_READONLY_MESSAGE`(:43)는 `document-vault.ts:52 REMOTE_VAULT_READONLY_MESSAGE`와 **문자열이 같은 별도 상수**다. document-vault.ts는 스스로 "one string, reused verbatim"이라고 선언하고 있다.

**추출 제안**:
```
const enterRecovery = (text, detail) => { suspended = conflicted = true; pending = text; onStatus("recovery", detail); };
const adoptBaseline = (mtime: unknown) => { if (typeof mtime === "number" && mtime > 0) baseline = mtime; };
const isConflictError = (err) => String(err).startsWith("CONFLICT");   // document/ 쪽 오류 분류 모듈 후보
const refuseReadOnly = () => readOnly && (onStatus("error", REMOTE_VAULT_READONLY_MESSAGE), true);
```
영향 범위: editor.ts 하나. `tests/editor-autosave.test.ts`가 회귀를 막아 준다.

### 3. 모달 셸(포커스 트랩·inert·포커스 복원·Esc/백드롭) 분산 — 이미 어긋남 — `recovery-modal.ts:20,35-73,116-131` · `conflict-modal.ts:54-72,121-158` (+ 파트 C `settings/panel/modal.ts:229`)
**실제 책임**: "에디터 위에 뜨는 모달" 공통 규칙.
**문제**: `trapFocus`가 두 파일에 따로 있고 반환형도 다르다(void ↔ boolean). `.editor-host` inert 설정·해제와 `previousFocus` 복원도 각각 복사돼 있다. **Esc 처리는 이미 어긋났다.** conflict는 `stopImmediatePropagation()`(:145)을 호출하고 recovery는 호출하지 않는다. 그래서 recovery 모달이 열린 상태에서 Esc를 누르면 전역 단축키 디스패처에도 이벤트가 전달될 수 있다. conflict-modal의 주석(:9)은 "mirrors settings/panel/modal.ts"라고 스스로 복제임을 밝힌다.
**추출 제안**: `document/modal-shell.ts` → `mountModal({ label, onDismiss }): { modal, close }`. 백드롭 생성, inert 설정·해제, trapFocus, Esc·백드롭 해제, 포커스 복원을 한 곳에 둔다. 세 모달은 내용만 채운다.

### 4. "경로가 루트 안에 있는가" 3중 구현 — 의미가 서로 다름 — `path.ts:30 isPathWithin` · `local-doc-link.ts:212 isPathInsideRoot` · `image-search-root.ts:22 rootOwns`
**문제**: 이름은 같은 질문을 던지는데 답이 다르다.

| 함수 | 같은 경로 | `\` 구분자 | `""` 루트 |
|---|---|---|---|
| `isPathWithin` | true | 지원 | true(원격 와이어 루트) |
| `isPathInsideRoot` | **false** | 미지원 | `"/"` 접두사 |
| `rootOwns` | true | 미지원 | — |

path.ts:27 주석은 "the two callers must never drift on what 'within' means"라고 하지만 세 번째, 네 번째 구현이 존재한다. 보안 경계(볼트 탈출 차단, local-doc-link)와 표시 경계(탐색기, 이미지 검색)가 서로 다른 규칙으로 판정하고 있다.
**추출 제안**: `document/path.ts`에 `isPathWithin(path, root)`(같은 경로 포함)과 `isStrictlyInside(path, root)`(같은 경로 제외) 두 함수를 같은 구분자 규칙으로 둔다. `rootOwns`는 삭제하고 `isPathWithin`을 쓴다.

### 5. baseDir + 대상 경로 결합(원격 와이어 루트 `""` 특례) 분산 — `wikilink.ts:32-45` · `image.ts:40-41` · `attach-image.ts:267` · `path.ts:311 resolveOpenPath` · `local-doc-link.ts:260`
**문제**: "vault-relative 대상을 baseDir 뒤에 붙인다. 끝 `/`는 정리하고, baseDir이 `""`(REMOTE_VAULT_WIRE_ROOT)이면 접두사를 붙이지 않는다"는 규칙이 다섯 곳에 각각 있다. wikilink와 image는 같은 버그(원격 루트에서 앞에 `/`가 붙는 문제)를 **각자 따로 고친 흔적**(긴 주석 2개)을 갖고 있다. `attach-image.ts:267`과 `resolveOpenPath`는 `""` 특례가 없고, `local-doc-link.ts:260`은 끝 `/` 정리가 없다.
**추출 제안**: `document/path.ts`에 `joinUnderBase(baseDir: string, rel: string): string`을 두고 다섯 곳이 이 함수를 쓰게 한다(인자 2개, 순수 함수).

### 6. "이 문자가 이스케이프됐는가" — 구현 3개, 동작 불일치 — `inline-render.ts:29,70,178,190` vs `table-widget.ts:18,42` · `cjk-emphasis.ts:128`
**문제**: table-widget과 cjk-emphasis는 **백슬래시 개수의 짝홀**로 판정한다(`\\*`는 이스케이프되지 않음). inline-render는 `text[i-1] === "\\"` **한 글자만 본다**(`\\*`도 이스케이프로 처리함). 같은 표 셀 문자열을 table-widget이 나눈 다음 inline-render가 렌더하므로, 한 문자열이 서로 다른 이스케이프 규칙을 두 번 거친다.
**추출 제안**: `markdown/escape.ts` → `isEscapedAt(text, i): boolean`(짝홀 규칙). 네 지점이 이 함수를 쓰게 한다. 먼저 `\\*bold*`류 Golden Master를 만들어 둘 것.

### 7. "Promise 메모 + 실패·빈 결과 시 제거" 캐시 5벌 — `file-host.ts:87-96`, `:210-223` · `remote-image.ts:43-50`, `:91-97` · `image.ts:229-246` (+ 파트 B `workspace-sidebar.ts badgeProbes`)
**문제**: `get → miss면 생성 → put → reject(또는 null)면 delete` 패턴이 다섯 번 따로 작성됐다. 제거 조건은 셋으로 갈린다. reject일 때만 지우는 곳(ssh·listing·readRemoteImage), null 결과도 지우는 곳(embed·searchCache), TTL을 쓰는 곳(listing 8s)이다. file-host.ts:63 주석은 "same shape as … listingCache … and workspace-sidebar.ts's badgeProbes"라고 직접 인정한다.
**추출 제안**: `bounded-cache.ts`에 `memoPromise(cache, key, make, { evictIf?: (v) => boolean })`를 추가한다. 실패 시 제거는 기본값, 빈 결과 제거는 옵션으로 둔다.

### 8. "무엇이 헤딩이고 레벨은 몇인가" SSOT 부재 — `core.ts:260-264` · `heading.ts:5-14` · `outline.ts:18-27` · `cjk-emphasis.ts:339-349` · **`fold.ts:6`(텍스트 정규식)**
**문제**: ATX1..6·Setext1..2 노드 이름 목록이 4벌이다. 게다가 `fold.ts`는 구문 트리가 아니라 `/^(#{1,6})\s/` 텍스트 정규식으로 헤딩을 판정한다. 그래서 ```` ```bash ```` 블록 안의 `# 주석` 줄이 접기 대상이 되고, Setext 헤딩은 접히지 않는다. outline.ts:159는 "tree-based guarantee that a `# fake` heading inside a fenced code block is never a candidate"를 약속하는데, 같은 문서에서 fold만 이 보장을 지키지 않는다.
**추출 제안**: `markdown/heading-nodes.ts` → `HEADING_LEVEL: Record<nodeName, 1..6>` + `headingLevelAt(state, lineFrom): number | null`(트리 기반). fold의 `headingRange`가 이 함수를 쓰게 한다.

### 9. 위키링크 대상 종류 분류가 두 파일에 나뉘어 있음 — `WikilinkWidget.toDOM()` ⭐⭐⭐ `wikilink.ts:107`(127줄) + `features/wikilink.ts:34-46`(5단 삼항)
**실제 책임**: 외부 URL / 같은 문서 헤딩 / 경로 없음 / 파일(존재 확인 → 열기·생성·외부 앱) 4갈래 렌더 + 클릭 정책 + IPC(`create_markdown_file`).
**문제**: "이 위키링크는 어떤 종류인가"가 feature에서는 삼항 체인과 생성자 인자 조합(`(alias,"",null,url)` / `(alias,"",anchor)` / `(alias,path)`)으로 표현되고, widget에서는 같은 분류를 `if` 4단으로 다시 판정한다. 렌더·클릭·IPC가 한 메서드에 섞여 있다(SLAP 위반).
**추출 제안**:
```
type WikilinkTarget = { kind: "external"; url } | { kind: "heading"; anchor } | { kind: "self" } | { kind: "file"; path };
classifyWikilinkTarget(target, baseDir, currentFile): WikilinkTarget   // feature에서 한 번
WikilinkWidget(alias, target) → toDOM = RENDERERS[target.kind](a, view, target)   // dispatch table
```

### 10. SSH 호스트 판정 `startsWith("ssh://")` 분산 — `file-host.ts:89`, `:146` · `remote-host-field.ts:90`, `:128` (+ 파트 B `remote-vault-dialog.ts:174`, `workspace-sidebar.ts:564`)
**문제**: "이 원격 호스트는 SSH 터널 대상인가"라는 도메인 규칙이 운영 코드 6곳(mock 3곳 별도)에 문자열 리터럴로 들어 있다. 대소문자(`SSH://`)나 공백 처리를 바꾸려면 6곳을 함께 고쳐야 한다.
**추출 제안**: `document/remote-host-field.ts`(의존성 없는 모듈)에 `isSshHost(host): boolean`, `SSH_HOST_PREFIX`를 둔다.

### 11. 오류 객체 → 메시지 문자열 정규화 분산 — 파트 A: `file-host.ts:56`, `:123` · `remote-image.ts:69` · `attach-image.ts:154`(로컬 명명 함수) · `session.ts:163-164` (저장소 전체 25곳)
**문제**: `e instanceof Error ? e.message : String(e)`가 저장소 전체 25곳에 인라인으로 있다. attach-image.ts만 `rejectionMessage`로 이름을 붙였고, 그것도 파일 private이다. 같은 오류가 화면마다 다른 문자열로 나올 위험이 있고, 오류 prefix 분류(`REMOTE:*`, `CONFLICT`, `ATTACH_*`, `SSH_TUNNEL_MISMATCH`)가 모두 이 정규화 결과 위에서 동작한다.
**추출 제안**: `src/errors.ts`(루트, 파트 C와 합의) → `errorMessage(e: unknown): string` 하나.

### 12. 원격 볼트 거부 문구 분산 — `editor.ts:43` · `document-vault.ts:52` · `local-doc-link.ts:58` · `remote-unsupported-message.ts:36,40`
**문제**: "원격 볼트는 읽기 전용입니다"가 2개 상수로 중복돼 있다(#2). "원격 볼트에서는 지원하지 않습니다"(local-doc-link)와 "원격 볼트에서는 아직 지원하지 않습니다"(remote-unsupported)는 **같은 사실에 대해 '아직'이 들어간 문구와 빠진 문구**로 갈렸다. remote-unsupported-message.ts:33은 '아직'을 의도적으로 구분해 쓴다고 밝히지만, local-doc-link의 거부는 구조적 한계(설계 결정)이므로 그 기준으로 보면 '아직'이 없는 쪽이 맞다. 문구 결정이 두 모듈에 나뉘어 있다.
**추출 제안**: `document/remote-messages.ts`에 원격 거부 문구를 모으고(`READONLY`, `UNSUPPORTED_STRUCTURAL`, `UNSUPPORTED_YET`, `sqlite`), editor.ts의 중복 상수는 삭제한다.

---

## 🟡 Medium

| 파일:라인 | 함수 | 별점 | 실제 책임 (1줄) | 가치 |
|---|---|:--:|---|:--:|
| `conflict/conflict-recovery.ts:55` | `detect` | ⭐ | 이름은 "탐지(조회)"인데 레코드를 Map에 **기록**하고 반환한다. main.ts:1376은 반환값을 버리고 command로만 쓴다 → `recordConflict`/`open` | medium |
| `session.ts:408` | `openInWindow` | ⭐⭐ | 마운트 + 탭 열기 + routedVault 설정 + 최근 문서 기록 + 내비 기록 + 세션 복원(:478-500) + 스냅샷 알림 + dev 노출. 이름에 없는 부수효과 4개. `restoreSessionState`(saveSessionState와 짝) + `recordDocumentOpened(file, vault)` 추출 | medium |
| `session.ts:609-610` | `openFromPanel` | ⭐⭐⭐ | `panelVault?.persistenceKind !== "remote"`를 인라인으로 다시 판정한다. document-vault.ts:41이 금지한 "ad hoc persistenceKind 판정"을 직접 위반. `isRemoteVault` 사용 | medium |
| `image.ts:173` | `ImageWidget.toDOM` | ⭐⭐⭐ | 원격 로드 + 로컬 재탐색(onerror, 정책·보고·캐시) + 뷰어 클릭(97줄). `rediscoverLocalImage(img, …)` 추출 | medium |
| `footnote-nav.ts:57` ↔ `footnote-hover.ts:63` | `labelAtRef` ≡ `labelAtChip` | ⭐⭐⭐⭐ | 바이트 단위로 같은 각주 라벨 파서 2벌. 정의 판정도 정규식(`isDefinitionLine` :24)과 feature(`footnote.ts:9`, `:` 한 글자 비교) 2벌 | medium |
| `parser.ts:154` ↔ `frontmatter-widget.ts:9` | `isFrontmatterClose` ≡ `isFenceLine` | ⭐⭐⭐⭐ | 같은 "프론트매터 펜스" 규칙이 파서와 렌더러에 따로 있음 | medium |
| `checkbox.ts:19` · `list.ts:20` · `task.ts:8` | (인라인) | — | 작업 마커 모양 `[ xX]` 정규식 3벌(`/x/i`는 다른 문자도 허용) | medium |
| `wikilink.ts:28,30-31,50` · `embed.ts:27` | `wikilinkPath`/`isImageTarget`/`isVideoTarget` | ⭐⭐⭐⭐ | 대상의 파일 부분 `split("#")[0].trim()` ×3, "확장자 있음" 정규식 ×2(같은 함수 안), `.md` 기본 확장자 | medium |
| `mermaid-widget.ts:116-130` ↔ `:160-174` | `loadMermaid`/`refreshMermaidTheme` | ⭐⭐⭐⭐ | `initialize` 옵션 2벌(06-13 미해소) + :119는 앱 테마를 DOM에서 읽는데 :157 주석은 "passed in rather than pulled from the DOM"이라고 함 → `initMermaid(m, theme)` | medium |
| `wikilink-complete.ts:38` | `detectWikilinkContext` | ⭐⭐⭐⭐ | export됐지만 운영 경로(:132)는 `matchBefore`+`slice(2)`로 같은 일을 다시 함 → 테스트만 검증하는 쌍둥이 | medium |
| `core.ts:120` | `dropFences` | ⭐⭐⭐ | "펜스 본문의 유일한 정의"를 자처하지만 닫는 줄을 ```` ``` ````로만 판정함. lezer FencedCode가 받는 `~~~mermaid`는 닫는 `~~~`가 본문에 섞여 렌더러로 넘어감 | medium |
| `path.ts:223` | `breadcrumbSegments` | ⭐⭐⭐⭐ | 드라이브 판정을 `windowsPathPrefix` 대신 `/^[A-Za-z]:/`로 다시 작성함. UNC(`\\srv\share\x`)는 `startsWith(sep)` 분기로 떨어져 루트 노드가 `\`가 됨 | medium |
| `open-external.ts:23` · `local-doc-link.ts:279` · `wikilink.ts:186,200,214,219` | `markFailure`/`markLocalLinkFailure`/(인라인) | ⭐⭐⭐⭐ | "실패한 링크 표시 = class + title" 3벌. wikilink 쪽은 영어(`Failed to …`)와 한국어 문구가 섞여 있음 | medium |
| `table-widget.ts:92-119` | `TableWidget.toDOM` | ⭐⭐⭐ | th/td 셀 빌드 루프 중복(06-13 미해소) → `buildCell(tag, text, align)` | medium |

## 🟢 Low

| 파일:라인 | 함수 | 별점 | 실제 책임 | 가치 |
|---|---|:--:|---|:--:|
| `footnote-hover.ts:71` | `placeAbove` | ⭐⭐⭐ | 기본은 **아래**에 배치하고, 넘칠 때만 위로 뒤집는다 → `placeNearChip` | low |
| `wikilink-complete.ts:83` | `loadTargetsOnce` | ⭐⭐⭐ | "Once"가 아니라 5초 TTL과 단일 슬롯 캐시 → `loadTargetsCached` | low |
| `core.ts:155-162` ↔ `:339-346` | (byNode 인덱스) | — | feature→노드 색인 빌드 2벌 → `indexByNode(features)` | low |
| `core.ts:384` ↔ `fenced-markdown-block.ts:220` | (2단 StateField) | — | 구조 재계산(doc/tree) vs 데코 재빌드(selection/mode) 갱신 조건 2벌. 주석이 "same split"이라고 인정 | low |
| `list-line.ts:18` · `list-indent.ts:26` · `fold.ts:31` · `heading.ts:45` · `cjk-emphasis.ts:333` · `quote-copy.ts:32` | (조상 노드 순회) | — | `for (n=…; n; n=n.parent) if (NAMES.has(n.name))` 6벌 → `hasAncestor(node, names)` | low |
| `open-file/path-prompt.ts:47` | `create` | — | `chrome/dom.ts:5 el`과 바이트 단위로 같음 | low |
| `remote-host-field.ts:131` ↔ `:137` | (문구) | — | 같은 안내 문장 2번 하드코딩 | low |

> **False Positive로 제외한 것**: `createDocumentSession`(677줄 클로저 factory, 상태 셀 공유), `blockPreview`·`inlinePreview`(CM 확장 factory), `openRecoveryModal`·`openConflictModal`·`createOpenPathPrompt`(DOM 빌더 + 공유 클로저), `mountEditor`(대부분 extension 선언 목록 + 주석), `attachImageToVault`(응집된 순차 트랜잭션), `parser.ts` Lezer `parse`/`composite`(프레임워크 계약), 모든 `toDOM`/`eq`/`ignoreEvent`/`enter`/`match`(CM·feature 계약 멤버명), `recovery-contract.ts`·`callout-types.ts`·`fence-types.ts`·`find.ts KOREAN_SEARCH_PHRASES`(선언 모음), `cjk-emphasis.ts`(긴 주석이 붙은 순수 함수 묶음, 각 함수는 ⭐⭐⭐⭐⭐).

---

## 패턴 분석

### 분산된 의도 (Scattered Intent) — 17건

| # | 도메인 규칙 | 위치 | 통합 제안 | 드리프트 |
|---|---|---|---|---|
| 1 | 경로 포함(within) | path.ts:30 · local-doc-link.ts:212 · image-search-root.ts:22 | `isPathWithin`/`isStrictlyInside` @ document/path.ts | **이미 어긋남** |
| 2 | baseDir 결합(+원격 `""`) | wikilink.ts:32 · image.ts:40 · attach-image.ts:267 · path.ts:311 · local-doc-link.ts:260 | `joinUnderBase` @ document/path.ts | **이미 어긋남**(`""` 특례 2/5) |
| 3 | 이스케이프 판정 | inline-render.ts:29,70,178,190 · table-widget.ts:18,42 · cjk-emphasis.ts:128 | `isEscapedAt` @ markdown/escape.ts | **이미 어긋남** |
| 4 | 모달 셸 | recovery-modal.ts · conflict-modal.ts · (C) settings/panel/modal.ts | `mountModal` | **이미 어긋남**(Esc 전파) |
| 5 | Promise 메모 + 실패 시 제거 | file-host.ts:87,210 · remote-image.ts:43,91 · image.ts:229 · (B) badgeProbes | `memoPromise` @ bounded-cache.ts | 제거 조건 3종 |
| 6 | 헤딩 노드·레벨 | core.ts:260 · heading.ts:5 · outline.ts:18 · cjk-emphasis.ts:339 · fold.ts:6 | `HEADING_LEVEL` + `headingLevelAt` | **이미 어긋남**(fold) |
| 7 | SSH 호스트 | file-host.ts:89,146 · remote-host-field.ts:90,128 · (B) 2곳 | `isSshHost` | — |
| 8 | 오류 메시지 정규화 | 파트 A 5곳 / 전체 25곳 | `errorMessage` | — |
| 9 | 원격 거부 문구 | editor.ts:43 · document-vault.ts:52 · local-doc-link.ts:58 · remote-unsupported-message.ts:36,40 | `document/remote-messages.ts` | 문구 어긋남('아직') |
| 10 | 위키링크 대상 종류 | features/wikilink.ts:34 · wikilink.ts:121-168 | `classifyWikilinkTarget` + dispatch table | — |
| 11 | 각주 라벨·정의 | footnote-nav.ts:24,57,63 · footnote-hover.ts:30,63 · features/footnote.ts:9,23 | `footnote-syntax.ts` | — |
| 12 | 프론트매터 펜스 | parser.ts:154 · frontmatter-widget.ts:9 | parser 쪽 export | — |
| 13 | 작업 마커 | checkbox.ts:19 · list.ts:20 · task.ts:8 | `TASK_MARKER_RE`/`isCheckedMarker` | 미세(`/x/i`) |
| 14 | 대상의 파일 부분·확장자 | wikilink.ts:28,30,31,50 · embed.ts:27 | `targetFilePart`/`hasExtension` | — |
| 15 | URL 스킴 분류 | open-external.ts:4 · autolink.ts:12 · paste-link.ts:10 · image.ts:23 · inline-render.ts:81 | autolink 스킴 목록을 `isExternalUrl`에서 파생(나머지는 의도가 다름) | — |
| 16 | 실패 표시(class+title) | open-external.ts:23 · local-doc-link.ts:279 · wikilink.ts 4곳 | `markLinkFailure(el, kind, msg)` | 문구 언어 혼재 |
| 17 | mermaid init 옵션·앱 테마 판정 | mermaid-widget.ts:119,121,166 | `initMermaid(m, theme)` | — |

### 표면적 중복(복붙)
`labelAtRef`≡`labelAtChip`, `isFrontmatterClose`≡`isFenceLine`, `create`≡`chrome/dom.ts el`, `trapFocus`×2, `REMOTE_READONLY_MESSAGE`≡`REMOTE_VAULT_READONLY_MESSAGE`, conflict-recovery의 조회+throw 3벌(:81-92, 이미 `resolve` 안에도 있음), recovery-modal의 preserved/catch 분기(:98-101 ↔ :103-106).

### 새 모듈 후보
- **`src/document/path.ts` 확장**: `joinUnderBase`, `isStrictlyInside`, `windowsDrivePrefix` 재사용(#1·#2, breadcrumb). 경로 규칙을 이 파일 하나에 모은다.
- **`src/document/remote-messages.ts`** + `isSshHost`: 원격 판정·문구를 한 곳에(#7·#9).
- **`src/document/modal-shell.ts`**: `mountModal`(#4).
- **`src/markdown/escape.ts`**, **`src/markdown/heading-nodes.ts`**, **`src/markdown/footnote-syntax.ts`**: 구문 규칙 SSOT(#3·#6·#11).
- **`bounded-cache.ts` + `memoPromise`**(#5).

---

## 아키텍처 제안

1. **보안·정합에 걸린 3건부터**: 경로 포함(#1, 볼트 탈출 경계)·baseDir 결합(#2, 원격 루트 404)·이스케이프(#3, 표 셀 렌더 불일치). 셋 다 이미 어긋났고 순수 함수라 Golden Master 비용이 낮다.
2. **충돌 정책은 약속을 지키든 철회하든 결정이 먼저**(High#1). 이건 리팩토링이 아니라 제품 결정이다. 다만 지금 상태(UI 노출 + 빈 sink + doc 주석의 약속)는 어떤 경우에도 유지하면 안 된다.
3. **`document/`를 원격 볼트 규칙의 단일 진입점으로**: `isRemoteVault` 패턴이 이미 잘 정착했다. 같은 방식으로 SSH 판정·원격 문구·오류 분류를 document/로 끌어오면 파트 B·C의 분산 위치도 함께 흡수된다(교차 단서 참조).

---

## 다음 단계 권장

이번 검토에서 **분산된 의도가 17건** 발견됐고(임계 ≥3), 그중 4건은 구현이 이미 서로 어긋났다. 함수 단위를 넘어 **원격 볼트·경로·오류 분류의 경로 설계** 문제일 가능성이 높다.

→ 합본 단계에서 파트 B·C·D의 교차 단서와 대조한 다음 **`/architecture-review`** 실행을 권장한다.
→ 리팩토링은 "테스트 없는 리팩토링 금지" 원칙에 따라, #3(이스케이프)·#6(fold)은 Golden Master를 먼저 확보한 뒤 진행할 것.

---

## 교차 영역 단서 (합본용)

이 파트에서 인라인으로 본 도메인 규칙을 파일:라인과 함께 나열한다. 다른 파트의 같은 규칙과 대조하는 데 쓴다.

1. **확장자 정규화·분류**
   - `wikilink.ts:19` `isEditableTextFile(path.split("/").pop())`, `:30-31` "확장자 있음" 정규식 + `.md` 기본값, `:50` 이미지 확장자 목록(png|jpe?g|gif|webp|svg|avif|bmp)
   - `embed.ts:27` 비디오 확장자 목록
   - `local-doc-link.ts:177,271` `isEditableTextFile(basename(...))`
   - `remote-unsupported-message.ts:21` SQLITE 확장자 Set + `extensionOf`(sidebar/explorer/file-icons)
   - `types.ts:53` LinkTarget.kind("markdown"|"image")는 Rust `classify_link_target`가 SSOT
2. **원격 볼트 판정**
   - `document-vault.ts:44` `isRemoteVault`(SSOT), `:65` `rowHasLocalPath`
   - `file-watch.ts:76` `shouldWatchDocument`, `editor.ts:401`, `file-host.ts:290` switch, `image.ts:191,221`, `wikilink.ts:199`
   - **인라인 재판정**: `session.ts:609-610`(`persistenceKind` 직접 비교 + `"global"`)
   - **판정 누락 의심**: `embed.ts:81` VideoWidget이 `resolveImageUrl`→`convertFileSrc`를 쓰므로 원격 볼트의 동영상 임베드는 로컬 asset URL로 바뀐다(image가 고친 버그와 같은 형태)
   - local-only를 명시한 곳: `wikilink-complete.ts:84-93`, `local-doc-link.ts:224-233`, `editor.ts:273-281`
3. **SSH 호스트 판정**: `file-host.ts:89,146` · `remote-host-field.ts:90,128`
4. **원격·읽기 전용 문구**: `editor.ts:43` · `document-vault.ts:52` · `local-doc-link.ts:58` · `remote-unsupported-message.ts:36,40` · `wikilink.ts:201`
5. **경로 구분자·basename·dirname**
   - `path.ts:3,12` dirOf/basename(`/`·`\` 지원)
   - `file-host.ts:177` `remoteParentAndName`(`/`만 지원, 의도적인지 불명)
   - `wikilink.ts:19` `split("/").pop()`
   - `path.ts:87` `detectSeparator`
6. **Windows 드라이브·UNC·절대경로 판정**
   - 드라이브: `path.ts:41` DRIVE_PREFIX, `:223` `/^[A-Za-z]:/`, `:258` isAbsoluteLike, `:276` isResolvedAbsolutePath · `local-doc-link.ts:123` hasWindowsDrivePrefix
   - UNC: `path.ts:40` · `local-doc-link.ts:129`
   - 루트 경로: `local-doc-link.ts:136`
7. **경로 포함(within/inside)**: `path.ts:30` isPathWithin · `local-doc-link.ts:212` isPathInsideRoot · `image-search-root.ts:22` rootOwns(+`:38` owningVaultRoot의 deepest-wins)
8. **경로 정규화·vault-relative 변환(REMOTE_VAULT_WIRE_ROOT `""`)**
   - `path.ts:107` normalizePath(↔ Rust `fs/paths.rs normalize_path` 쌍둥이 계약)
   - `wikilink.ts:32-45` · `image.ts:31-41` · `remote-image.ts:114-117`(`""`를 유효 루트로 처리) · `attach-image.ts:267` · `path.ts:303-311` resolveOpenPath · `local-doc-link.ts:260`
   - `session.ts:438` baseDirForOpenedDocument(main 주입)
9. **hidden 판정**: 이 파트에는 dotfile 판정이 **없다**. `showHidden` 인자 전달만 있음(`file-host.ts:22-23,34-35,211-216`). 원격 `pathExists`/`directoryExists`는 `listDir(…, true)`로 숨김 포함(`file-host.ts:260,268`). 실제 hidden 규칙은 파트 B·D에서 확인할 것.
10. **오류 문구 매핑·오류 prefix 분류**
    - prefix 분류: `file-host.ts:55-60` `REMOTE:AuthExpired`/`SharingOff`, `:122` `SSH_TUNNEL_MISMATCH` · `editor.ts:170,245` `CONFLICT` · `attach-image.ts:103-121` `ATTACH_*`/`ROLLBACK_*` → 한국어 표
    - `share-port-rules.ts:37` SHARE_PORT_RANGE_MESSAGE(settings/remote-share-port.ts와 공유)
    - 오류 → 문자열: `file-host.ts:56,123` · `remote-image.ts:69` · `attach-image.ts:154` · `session.ts:163-164`
    - 그대로 노출: `path-prompt.ts:140` "열 수 없음: ${String(err)}" · `open-external.ts:43,49` · `wikilink.ts:187,215`(영어)
    - `editor.ts:178` onStatus("recovery") 직후 onStatus("error") 이중 보고
11. **캐시·eviction 패턴**
    - FIFO: `bounded-cache.ts:21` + 사용처 `mermaid-widget.ts:134`(50) · `math-widget.ts:13`(200) · `image.ts:132`(64, null이면 제거 :244) · `remote-image.ts:31`(reject면 제거 :48), `:77`(null·reject면 제거 :96)
    - Map 메모: `file-host.ts:87` sshTunnelReady(reject면 제거), `:210` listingCache(TTL 8s + reject면 제거), `:312` remoteHostCache(무제한)
    - TTL 단일 슬롯: `wikilink-complete.ts:75-97`(5s)
    - 그 밖: `fenced-markdown-block.ts:145` CORNER_DECO_CACHE(무제한) · 중복 경고 억제 Set(무제한) `image.ts:99`, `remote-image.ts:53`
    - 테스트 리셋 seam: `file-host.ts:349` · `image.ts:105,140` · `remote-image.ts:143,149` · `wikilink-complete.ts:102`
12. **모달 셸**: `recovery-modal.ts:20-33,64,70,116-131` · `conflict-modal.ts:54-72,121-158`(↔ C `settings/panel/modal.ts:229`)
13. **클릭 제스처 규칙(일반 좌클릭 / Alt=소스 편집 / ⌘·Ctrl)**
    - `inline-render.ts:109` isPlainLeftClick(명명) ↔ `features/link.ts:70` 인라인
    - Alt: `wikilink.ts:83,130,145` · `image.ts:260` · `footnote-nav.ts:170`
    - ⌘·Ctrl: `footnote-hover.ts:22` isPreviewModifier(주석이 main.ts:347,360 규약을 가리킴)
14. **앱 테마 판정**: `mermaid-widget.ts:119` `document.documentElement.dataset.theme === "light"`(sink 주입 원칙의 예외)
15. **DOM 헬퍼 중복**: `open-file/path-prompt.ts:47` ≡ `chrome/dom.ts:5 el`
16. **늦게 연결되는 핸들러 슬롯(plain-module slot)**: `document-open.ts:19` · `image-open.ts:9` · `image-search-root.ts:81`(main.ts가 연결)
17. **`.editor-host` 셀렉터 직접 조회**: `recovery-modal.ts:64,70` · `conflict-modal.ts:121`(session.ts는 `host`를 주입받는데 모달은 전역 쿼리)
18. **TS↔Rust 미러 계약(파트 D 대조용)**
    - `path.ts:107` ↔ `fs/paths.rs normalize_path` · `path.ts:262-277` ↔ `expand_home` 리터럴 폴백
    - `image-search-root.ts:15` VAULT_IMAGE_SCAN_DEPTH ↔ `image_resolve.rs MAX_IMAGE_SCAN_DEPTH`
    - `share-port-rules.ts:30,46` ↔ `remote_client.rs SSH_TUNNEL_LOCAL_PORT`·`remote_share.rs validate_share_port`
    - `remote-host-field.ts:89,114` ↔ `parse_ssh_suffix`·`base_url`
    - `types.ts` ↔ serde 구조체(DirEntry/FileHit/DriveEntry/LinkTarget)
    - `attach-image.ts:34-49,103` ↔ `attachments.rs`
    - `file-host.ts:55,122` ↔ `remote_client.rs` 오류 태그
    - `file-watch.ts:15-27` ↔ `file-changed`/`file-unavailable` 이벤트 payload
