# Intent Review — 2026-10-18 · 파트 B (chrome / sidebar / workspace / extensions)

함수 이름(의도)과 구현(동작)이 어긋나는 곳을 검토했다. 범위는 `src/chrome/**`, `src/sidebar/**`, `src/workspace/**`, `src/extensions/**`의 비테스트 소스다. mocks, `*.generated.ts`, `material-icons/`는 제외했다.
방법은 `~/.claude/skills/intent-review/SKILL.md`를 따랐다. 1차로 `quick-check.sh`를 돌려 후보를 좁히고, 66개 파일 전부를 직접 읽어 판정했다. 코드는 수정하지 않았다.

## 요약

- **스캔 범위**: 66개 파일(~12,800줄), 명명 함수와 클로저 약 500개
- **1차 스캔 플래그**: 🔴 80줄 이상 17건, 🟡 50~79줄 9건, 🔵 섹션 구분 3개 이상 1건(epub-parse.ts)
- **후보**: 31건. high 9 / medium 13 / low 9. 이와 별도로 skip(False Positive) 7건
- **CQS 위반(⭐)**: 1건. `routeCliFile`/`routeCanonicalPath`와 이를 감싸는 `routeDocumentPath`는 값을 반환하는 Query 모양이다. 그런데 내부에서 `store.selectVault`를 호출해 상태를 바꾼다. 영속 저장, notify, 사이드바 재렌더까지 일어난다.
- **God 함수**: 3건. 공유 클로저가 있어도 그 결합이 실제로 성립하지 않는 경우만 셌다.
  - `createWorkspaceSidebar`의 `render`/`renderGroup`
  - `openEpubViewerAt`의 패키지 로드 구간
  - `openPdfViewerFromBytes`의 pdf.js 부트 구간
- **최대 이슈**: 뷰어 9종이 같은 수명주기 규칙을 각자 복제하고 있다. 해당 규칙은 로딩 상태 표시, 오류 문구, 핸들, late-result 가드, near-viewport 관찰, 페이지 폭 동기화(lockstep), iframe 줌이다. 주석이 "SAME"이나 "lockstep"을 약속하는 곳 중 실제로 갈라진 곳이 이미 3군데 있다(H2, H3, H8).
- **결론**: 이름 하나하나의 정직성은 06-13과 07-03 리뷰의 수준이 유지됐다. ⭐⭐⭐⭐ 이상이 대다수다. 부채는 함수 단위보다 **모듈을 가로질러 분산된 규칙**에 몰려 있다. api-fence(extensions → `../../api`만 허용)가 공유 헬퍼를 막다 보니 생긴 "의도적 로컬 복사"도 여기에 포함된다.

### 이전 리뷰 지적의 해소 여부

| 리뷰 | 항목 | 상태 |
|---|---|---|
| 06-13 | applySvg, fencedBody, boundedCache 등 전 항목 | **해당 없음**. 모두 `src/markdown/**`라서 파트 A 범위다 |
| 07-03 #1 | 경로 좌측 생략 라벨이 favorites/recent에 이중 복제 | ✅ **해소**. `chrome/path-label.ts:20 truncatedPathLabel`로 통합했고 recent-panel.ts:113, workspace-sidebar.ts:416에서 쓴다. ⚠️ **일부 남음**: `chrome/welcome/welcome-pane.ts:100-103`이 세 번째 소비자인데, 자체 `.welcome-path`(오른쪽 잘림)를 쓴다. 공용 라벨은 쓰지 않는다 |
| 07-03 #2 | `basename` 쌍둥이와 `dirOf` 비대칭 | ✅ **해소**. `document/path.ts:12`에서 `dirOf` 바로 옆으로 옮겼다. ⚠️ **새 사본 발생**: 구분자 규칙의 로컬 복사가 4곳 새로 생겼다(H9 참조) |
| 07-03 #3 | CJK 플랭킹 트립와이어 | **해당 없음** (파트 A) |
| 07-03 Low | findStarButton, revealFavorites, toggleFavorite, pushFavorite | **소멸**. 즐겨찾기 서브시스템이 퇴역했고 지금은 `workspace/favorite-vault-migration.ts`(마이그레이션 전용)만 남았다. `pushRecent`(recent-docs.ts:32)는 ⭐⭐⭐⭐로 관례를 유지한다 |
| 07-03 비-문제 | 사이드바 셸(open/close/토글) 중복 | **재평가 필요**. 사본이 3개에서 5개로 늘었다(search, workspace 추가). workspace-sidebar.ts:341은 명명된 `open()` 없이 열기를 인라인으로 처리해 열기 경로가 갈라졌다. low에서 medium 쪽으로 관찰이 필요하다 |

---

## 🔴 High Priority

### 1. 뷰어 "로딩 상태 → 본문 또는 오류" 수명주기 규칙이 9벌로 분산됨 — 각 함수 ⭐⭐⭐⭐, 추출가치 high

**발견 위치**:
- 로딩 상태와 오류 교체
  - `hwp-viewer.ts:210-212/281-283`, `epub-viewer.ts:312-314/573-576`, `sqlite-viewer.ts:256 showStatus`/`420-422/435-436`
  - `excel-viewer/index.ts:503-505/534-537`, `docx-viewer/index.ts:143-145/210-214`, `pdf-viewer/index.ts:1191-1193/1362-1365`
  - `html-viewer/index.ts:247 showOpenError`/`447-449`, `code-viewer/index.ts:168 showStatus`/`227-229`
- `{ close: () => shell.close(), onClose: (cb) => shell.onTeardown(cb) }` 핸들: 9곳(hwp:288, sqlite:441, epub:581, image:435, docx:238, code:293, html:461, excel:542, pdf:1370)
- `err instanceof Error ? … : String(err)`: 범위 안에서만 20곳

**실제 책임**: 뷰어 셸을 띄우는 순간부터 비동기 로드가 끝날 때까지의 상태 전이 규칙이다. 로딩 문구 → 본문 클래스로 교체, 또는 `-status` 클래스에 "문서를 열 수 없습니다: …"를 표시한다. 닫힌 뒤 도착한 늦은 결과는 무시한다.

**문제**:
- `sqlite-viewer.ts:253`의 주석이 "the same idiom hwp/excel/pdf-viewer all use"라고 **스스로 분산을 인정**한다.
- 이미 갈라졌다.
  - 오류 형식: pdf만 `${err.name}: ${err.message}`(964, 1365)를 쓴다. epub은 접두사 없이 원문을 내보낸다(576). 나머지는 "문서를 열 수 없습니다:" 접두사를 붙인다.
  - `closed` 가드: docx, epub, code, image에만 있다. hwp, excel, pdf, sqlite, html에는 없어서, 닫힌 뒤 도착한 오류가 분리된 노드에 쓰인다.
- 새 뷰어를 추가하면 이 규칙의 열 번째 사본이 생긴다.

**추출 제안** (`chrome/viewer/shell.ts`에 두고 api facade로 재노출):
```ts
// before (각 뷰어마다)
content.className = "x-viewer-status"; content.textContent = "문서 불러오는 중…";
…catch((err) => { content.replaceChildren(); content.className = "x-viewer-status";
  content.textContent = `문서를 열 수 없습니다: ${err instanceof Error ? err.message : String(err)}`; });
return { close: () => shell.close(), onClose: (cb) => shell.onTeardown(cb) };

// after
const content = viewerStatusContent(paneClass, "문서 불러오는 중…");
…catch((err) => showViewerError(content, paneClass, err));   // 접두사·err→text 단일 규칙
return viewerHandleOf(shell);
```
매개변수는 최대 3개다. `errorText(err)`도 같은 모듈에 둔다. 이렇게 하면 교차 단서 5번(오류 문구)의 절반을 흡수한다.

### 2. near-viewport 지연 관찰과 페이지 폭 "lockstep"이 hwp/epub/pdf에 3중 복제됨 — 추출가치 high

**발견 위치**:
- 관찰기: `hwp-viewer.ts:116 observePages`, `epub-viewer.ts:204 observeChapters`, `pdf-viewer/index.ts:296 observePages`. 셋 다 `IntersectionObserver`에 `rootMargin: "200% 0px"`를 쓰고, jsdom용으로 즉시 실행하는 폴백을 둔다.
- 폭 규칙: `hwp-viewer.ts:43,61,71`(`HWP_PAGE_WIDTH_FRACTION`, 600 폴백)과 `pdf-viewer/index.ts:131,139-140`(`PDF_PAGE_WIDTH_FRACTION`, 리터럴 600). 두 주석 모두 "change this and the other one together"라고 적혀 있다.
- 3-set 가드: `hwp-viewer.ts:104 shouldRenderPage`, `pdf:261 shouldRenderPage`, `pdf:275 shouldBuildTextLayer`(본문이 바이트 단위로 같다), `pdf:750 needsSharpening`(형태가 같다)

**문제**:
- `hwp-pages.ts:47 isNearViewport`(⭐⭐⭐)는 이름으로 "가까운가"를 약속한다. 실제로는 `entry.isIntersecting`만 반환한다. **가까움을 정하는 진짜 규칙은 리터럴 `"200% 0px"` 세 벌에 흩어져 있다.**
- 폭 동기화는 주석으로만 강제된다. 한쪽만 바꾸면 두 문서 뷰어의 페이지 폭이 조용히 어긋난다.

**추출 제안**: `chrome/viewer/page-band.ts`를 새로 만들고, pdf가 쓸 수 있게 api로 재노출한다.
```ts
export const NEAR_VIEWPORT_MARGIN = "200% 0px";
export function observeNearViewport(root, els, onChange: (el, inBand) => void): { disconnect(): void }
export const PAGE_WIDTH_FRACTION = 1;
export function pageFitWidth(column: HTMLElement): number   // (clientWidth || 600) * FRACTION
export function isUntracked(page, ...sets: ReadonlySet<number>[]): boolean
```

### 3. iframe 줌 변환 규칙이 둘로 나뉨: epub이 html의 identity 빠른 경로를 빠뜨림 — 추출가치 high (실기 확인 필요)

**위치**: `html-viewer/index.ts:179 isIdentityZoom` 및 `:208 applyHtmlZoom`, `chrome/viewer/epub-viewer.ts:140 applyEpubZoom`

**문제**:
- `applyEpubZoom`의 주석은 "Apply the **SAME** parent-side zoom transform html-viewer's `applyHtmlZoom` uses"라고 약속한다. 그런데 html 쪽에 0.17.1 T3로 들어간 **scale ≈ 1일 때 인라인 transform을 제거하는 규칙**이 epub에는 없다. epub iframe은 기본 줌(1.0)에서도 항상 `transform: scale(1)`을 단다.
- html이 그 규칙을 넣은 이유는 "transform이 걸린 iframe은 WKWebView의 컴포지터 빠른 스크롤 경로에서 빠진다"는 것이었다. epub도 영향을 받는지는 미검증이다. epub은 부모가 스크롤 주체라서 영향이 다를 수 있다. 다만 **같다고 약속한 두 구현이 실제로는 다르다**는 사실 자체가 결함이다.

**추출 제안**: `applyIframeZoom(iframe, scale, { fitHeight: boolean })`을 하나로 만들어 api로 노출한다. html은 `fitHeight: true`, epub은 `false`로 쓴다. 의도된 차이(height)만 매개변수로 남긴다.

### 4. "lastSelectedPermanentVaultId는 영구 볼트여야 한다"와 현재 볼트 대체 규칙이 4곳에 분산됨 (1곳은 계약 위반) — `workspace-state.ts`

**위치**: `readState` 125-132, `selectVault` 221-226, `commit` 261-268, `unregisterVault` 241-242

**문제**:
- `commit` 주석은 "must not launder a remote id into it"이라고 계약을 명시한다. 그런데 `unregisterVault:241`은 `remaining[remaining.length - 1]`(원격 볼트 id일 수 있다)을 그대로 `lastSelectedPermanentVaultId`에 넣는다. `commit`은 **저장본만** 정제하고 `this.state`는 그대로 두므로, 다시 로드하기 전까지 메모리 상태가 계약을 위반한다.
- 현재 볼트를 무엇으로 대체할지도 세 곳이 서로 다르다.
  - readState: `lastSelectedPermanent ?? GLOBAL`
  - commit: `lastSelectedPermanent(영구만) → 마지막 vaultId → null`
  - unregister: `remaining 마지막(원격 포함) ?? GLOBAL`

**추출 제안**:
```ts
function lastSelectedPermanentAfter(workspace, permanentIds, removedId?): string | null
function fallbackCurrentVaultId(workspace, persistedIds, permanentIds): string
```
네 지점이 모두 이 두 함수를 호출하게 한다. 그 전에 "영구 볼트 A를 제거하고 원격 볼트 B가 남은 상태"의 메모리 상태 테스트를 먼저 봉인한다(테스트 없는 리팩토링 금지).

### 5. `routeCliFile()` / `routeDocumentPath()` — ⭐ 사기꾼 — `workspace/cli-routing.ts:31,36`, `workspace/vault-selection.ts:39`

**실제 책임**: 경로를 소유한 볼트를 해석해 `CliRoute`/`Vault`로 반환한다. 동시에 `store.selectVault()`로 워크스페이스의 현재 볼트를 바꾸며, 이 변경은 localStorage 저장과 notify를 거쳐 사이드바 재렌더까지 이어진다. `routeDocumentPath`는 모듈 셀 `routedVault`도 고쳐 쓴다.

**문제**:
- 호출부는 이 함수를 순수 해석기처럼 쓴다. `main.ts:695 const targetVault = routeCliFile(workspaceStore, path).vault`.
- 이 부작용을 경고하는 주석이 두 군데나 있다(`cli-routing.ts:17` "unlike routeCliFile…: it never calls store.selectVault", `recent-vault-migration.ts:44-50`). 이름과 동작이 어긋났다는 증거다. 순수 버전 `permanentVaultForPath`가 이미 있는데도, 반환과 선택이 한 이름 아래 섞여 있다.
- 덤으로 `routeCliFile`과 `routeCanonicalPath`가 각각 `canonicalRootPath`를 불러 이중 정규화한다(32, 37).

**추출 제안**:
```ts
export const resolveCliRoute = (state, path): CliRoute      // 순수: permanentVaultForPath ?? global
export const selectRoute = (store, route): Vault            // 명령: store.selectVault
// routeCliFile = selectRoute(store, resolveCliRoute(store.get(), canonicalRootPath(raw)))
```
`routeDocumentPath`는 `selectDocumentVault`처럼 명령임이 드러나는 이름으로 바꾼다. 영향 범위: main.ts의 호출부 3곳(187, 695, 878 주변)과 vault-selection.

### 6. 탐색기/검색 패널의 "열 수 있는가 / 북마크 가능한가" 게이트가 분산되고 갈라짐 — 추출가치 high

**위치**:
- `isOpenableEntry`
  - `explorer-panel.ts:303`: `isEditableTextFile || (!!onOpenWithViewer && !!canOpenWithViewer?.(name))`
  - `search-panel.ts:129`: `isEditableTextFile || !!canOpenWithViewer?.(name)`. `onOpenWithViewer` 조건이 없다.
  - `search-panel.ts:75-79`의 문서 주석은 "same closure main shares with explorer so the two panels can **never disagree**"라고 약속한다. 실제 식은 이미 다르다.
- 볼트 북마크 게이트
  - `explorer-panel.ts:602 makeEntry`(`onToggleVault && isVaultRegistered && (canBookmarkFolders?.() ?? true)`)
  - `:1110 toggleFocusedVault`(부정형 재구현)
  - `:1110`의 주석은 이 두 사본이 갈라진 탓에 원격 볼트에서 로컬 폴더가 등록된 **I2 버그**가 났었다고 기록한다.

**추출 제안**: 팩토리 상단에 `const canToggleVault = (): boolean => !!onToggleVault && (canBookmarkFolders?.() ?? true);`를 두고 두 곳 모두 이를 호출한다. `isOpenableEntry(name, deps)`는 `file-icons.ts` 옆으로 올려 두 패널이 같은 함수를 쓰게 한다. 매개변수는 2개다.

### 7. `createWorkspaceSidebar` → `render`/`renderGroup` — ⭐⭐⭐ God 함수 — `workspace/workspace-sidebar.ts:357-594`

**Factory 예외 판정: 불성립.** 팩토리 클로저가 공유하는 것은 `aside`, `list`, `errorEl`, `remoteDialog`, `showError`뿐이다. `render`는 매번 처음부터 다시 계산하고, 행/탭 빌더는 지역값(`vault`, `tabs`, `rows`, `rowEls`)만 읽는다. 결과적으로 `renderGroup` 하나가 약 200줄이고, render > group > row > tab > 클로저로 4단 중첩된다.

**숨은 도메인 규칙** (각각 명명 함수로 뽑을 대상):
- `:440` 탭 표시명에서 확장자 제거 → `tabDisplayName(base)`. 확장자 규칙이 여기서도 분산된다(H9).
- `:202-204 folderPrefixFor`가 `dir.startsWith(vaultRoot)`와 `split(/[\\/]/)`로 포함 관계를 판정한다. `document/path.ts:15 isPathWithin`의 주석이 **"a bare startsWith(ancestor) would wrongly match a sibling"이라고 금지한 바로 그 방식**이다. 예: 루트 `/a/b`에 대해 `/a/bc/x.md`가 접두사 "c/"를 얻는다. 같은 파일 260행은 정작 `isPathWithin`을 쓴다.
- `:564-574` "호스트의 마지막 볼트를 해제하면 SSH 터널을 해제하고 메모를 축출한다"는 규칙이 클릭 핸들러 안에 인라인되어 있다 → `releaseSshTunnelIfUnused(host)`. `startsWith("ssh://")` 판정은 `remote-vault-dialog.ts:174`, `document/file-host.ts:89,146`, `document/remote-host-field.ts:128`에도 있다.
- `:358` 현재 워크스페이스 조회는 같은 식의 다섯 번째 사본이다(medium 표 참조).
- `:418` 빈 `VaultTabs` 리터럴은 여섯 번째 사본이다.

**추출 제안**:
- `renderVaultRow(vault, level, ctx)`와 `renderVaultTab(tab, vault, sortedTabs, ctx)`로 나눈다.
- `ctx = { workspace, rows, rowEls, showError, onSelectTab, onCloseTab }`는 객체 파라미터로 넘긴다.
- 위의 규칙 세 가지는 순수 함수로 뺀다.

### 8. pdf 맞춤 폭 뷰포트 계산의 "단일 출처" 약속이 깨짐 — `pdf-viewer/index.ts:830-839` 대 `:1097-1100`

**문제**:
- `rasterPageCanvas`의 문서 주석은 "the ONE place that math lives rather than two near-duplicate copies free to drift apart"라고 약속한다.
- 그런데 `renderTextLayer`가 `getViewport({scale:1})` → `fitWidthScale(…, pageTargetWidth(pagesEl), zoomFactor)` → `getViewport({scale})` 세 줄을 그대로 재구현한다.
- 둘이 어긋나면 텍스트 레이어가 캔버스와 틀어진다. 선택과 검색 오프셋이 바로 그런 증상이다. 두 주석이 직접 경고한 실패 모드다.

**추출 제안**: `fitViewport(pdfPage, pagesEl, zoomFactor): { viewport, scale }`를 만들어 `rasterPageCanvas`와 `renderTextLayer`가 함께 호출하게 한다. 같은 자리에서 `renderPdfPage`의 미사용 매개변수 `_pdfjs`(917)도 제거한다. 이 매개변수는 "같은 인자 모양을 맞추려고" 남겨 둔 것이다(medium 표 참조).

### 9. 확장자와 경로 구분자 파싱이 api-fence 뒤에서 로컬 복사로 증식함 — 추출가치 high

**발견 위치**:
- 확장자
  - SSOT: `sidebar/explorer/file-icons.ts:19 extensionOf(name)`
  - 복제: `extensions/code-viewer/language-map.ts:109 extensionOfPath`(디렉터리를 떼는 부분이 추가된 변형), `:126` 정규화 `toLowerCase().replace(/^\./,"")`, `sidebar/explorer/material-icon-glyph.ts:54-55`(같은 점 규칙을 인라인), `extensions/excel-viewer/decode-input.ts:14`(`/\.csv$/i`), `workspace/workspace-sidebar.ts:440`(확장자 제거)
- 구분자
  - SSOT: `document/path.ts:3-15`
  - 복제: `extensions/html-viewer/index.ts:158 parentDir`, `:168 fileName`, `code-viewer/language-map.ts:110`, `workspace/workspace-state.ts:177,180`(기본 표시명을 `split(/[\\/]/)…slice(-1)` 두 번), `workspace-sidebar.ts:203-204`

**문제**:
- `extensionOf`는 **파일명**을, `extensionOfPath`는 **경로**를 받는다. `extensionOf`에 경로를 넣으면 점이 들어 있는 디렉터리 이름에서 잘못 파싱한다. 지금 호출부는 모두 basename을 넘기지만 계약이 타입으로 강제되지 않는다.
- 사본 대부분은 "api-fence 때문에 import할 수 없다"는 주석으로 정당화된다. 그런데 이것은 facade에 재노출하면 풀리는 문제다. 같은 facade가 `looksNumeric`, `readRemoteFileBytes`는 이미 재노출하고 있다.

**추출 제안**: `api/index.ts`에 `extensionOf`, `basename`, `dirOf`를 순수 함수 재노출로 추가한다(상태를 노출하지 않으므로 fence의 취지와 충돌하지 않는다). 이후 로컬 사본 6개를 지운다. 이 항목은 경로 계약과 맞물리므로 파트 A/C와 교차 확인이 필요하다.

---

## 🟡 Medium / 🟢 Low

| 파일:라인 | 함수 | 별점 | 실제 책임 (1줄) | 가치 |
|---|---|:--:|---|:--:|
| `chrome/viewer/epub-viewer.ts:311` | `openEpubViewerAt` (~272줄) | ⭐⭐⭐ | arm→container→OPF→DRM→toc 로드, 위치 복원 상태 기계, 높이 동기화. **Factory 부분 성립**: 복원 기계는 클로저 셀을 공유하므로 유지한다. 패키지 로드(429-463)는 `closed`만 읽으므로 `loadEpubPackage(locator)`로 분리할 수 있다 | medium |
| `extensions/pdf-viewer/index.ts:1188` | `openPdfViewerFromBytes` (~184줄) | ⭐⭐⭐ | **Factory 부분 성립**: 스케줄러 배선은 `rawState`/`inBand`를 공유한다. blob 워커와 getDocument 옵션(1241-1276)은 `bootPdfDocument(bytes, pdfjs)`로 분리할 수 있다. 1179-1183에 낡은 문서 주석이 이중으로 쌓여 있다 | medium |
| `extensions/pdf-viewer/index.ts:913,643` | `renderPdfPage`(8개 인자, `_pdfjs` 미사용), `reconcile`(7개 인자) | ⭐⭐⭐ | 서명이 쓰지 않는 의존성을 약속한다. 인자 4개 이상이면 구조 재설계 신호다 | medium |
| `chrome/viewer/sqlite-viewer.ts:270,373` | `mountTableSession`(7개 인자), `renderDatabase`(6개 인자) | ⭐⭐⭐ | 테이블 한 개의 세션 상태를 인자로 줄줄이 넘긴다 → `TableSessionCtx` | medium |
| `sidebar/explorer/explorer-panel.ts:274` | `createExplorerPanel` (~968줄, 핸들러 20개) | ⭐⭐⭐ | **Factory 대부분 성립**(renderTree, focusOwed, renderGeneration, currentRoot 공유). 예외적으로 분리 가능한 것: 리스팅 캐시(`readChildren`와 맵 3개, 342-344/520-539) → `createListingCache(listDir)`, treeitem 뼈대 5줄 3중 복제(581-586, 625-630, 830-834) → `makeTreeItem(cls, level)`, 로빙 포커스(424-466) | medium |
| `extensions/excel-viewer/index.ts:463-486` 대 `sqlite-viewer.ts:217,246` | 탭 스트립 생성과 활성 표시 | ⭐⭐⭐⭐ | sqlite는 명명 함수, excel은 인라인으로 같은 tablist 규칙을 구현한다. 로빙 탭은 workspace-sidebar.ts:457에 세 번째 구현이 있다 | medium |
| `workspace/vault-tabs.ts:40,85` 대 `vault-routing.ts:58` | `VaultTabStore.get/commit`, `tabScopeForVault` | ⭐⭐⭐⭐ | "글로벌 볼트의 탭은 세션 한정"이라는 규칙이 두 모듈에 있다. commit은 `GLOBAL_VAULT_ID ‖ scope==="session"`으로 이중 판정한다 | medium |
| `workspace/vault-routing.ts:10,81` | `shouldPreserveGlobalExplorerRoot`, `routingTrustsCurrentVault` | ⭐⭐⭐⭐ | 같은 파일 14-22행이 선언한 "종류 분기는 전부 switch+assertNever" 정책을 우회하는 `===`/`‖` 판정이다 | medium |
| `cli-routing.ts:52`, `vault-routing.ts:137`, `favorite-vault-migration.ts:142,162` | (인라인) | — | `error instanceof Error ‖ typeof error === "string"`(Tauri invoke 거절 분류)이 4벌 → `isInvokeRejection(e)` | medium |
| `cli-routing.ts:12`, `vault-selection.ts:33`, `workspace-state.ts:247`, `workspace-sidebar.ts:358`, `favorite-vault-migration.ts:132` | 현재 워크스페이스 조회 | — | 같은 `find(workspaceId === currentWorkspaceId)` 식이 5벌 → `currentWorkspaceOf(state)` 공개 | medium |
| `sqlite-viewer.ts:95`, `search-panel.ts:167/278`, `explorer-panel.ts:352/822` 및 `:344/530` | 늦은 비동기 결과 가드 | ⭐⭐⭐⭐ | "늦게 도착한 결과는 버린다"는 세대 카운터 패턴이 4번 구현됐다. docx, epub, code, image의 `closed` 플래그도 같은 계열이다 | medium |
| `sidebar/{outline,recent,search}`, `explorer`, `workspace-sidebar.ts:341` | 셸 open/close/토글 | ⭐⭐⭐⭐ | 07-03에서 비-문제로 판정했지만 사본이 5개로 늘었다. workspace만 명명된 `open()` 없이 인라인으로 연다 | medium |
| `extensions/*/index.ts` 5곳 | `ensureStyleInjected` | ⭐⭐⭐⭐ | CSS 리터럴 길이는 FP다. 다만 "id로 한 번만 주입"하는 보일러플레이트가 5벌이다 → api `injectStyleOnce(id, css)` | medium |
| `chrome/welcome/welcome-pane.ts:46,91-108` | `createWelcomePane` (81줄) | ⭐⭐⭐⭐ | 최근 문서 행을 recent-panel과 따로 렌더하면서 path-label 규칙을 쓰지 않는다(07-03 #1 잔여) | low |
| `chrome/viewer/image-viewer.ts:220` | `openImageViewerFrom` (~224줄) | ⭐⭐⭐⭐ | **Factory 성립**(pz와 refreshPanIndicators 공유). 키맵(375-411)만 순수 함수 `panDeltaForKey(key, stageH)`로 뺄 여지가 있다 | low |
| `chrome/viewer/image-viewer.ts:307` | `remoteImageFailureCaption(undefined)` | ⭐⭐⭐ | 기본 문구를 얻으려고 오류 매퍼에 undefined를 넘긴다 → 상수로 분리 | low |
| `chrome/viewer/registry.ts:148` | `listViewers` | ⭐⭐⭐ | 문서는 "live array reference is avoided"라고 하지만 살아 있는 배열을 그대로 반환한다(readonly는 타입뿐) | low |
| `chrome/title-bar.ts:130,196,259` | `isTauriRuntime`, platform 기본값 | ⭐⭐⭐⭐ | `main.ts:1421`은 같은 판정을 아직 인라인으로 한다. `isMac() ? "mac":"other"`가 2벌이다 | low |
| `chrome/breadcrumb.ts:53` | `render` (60줄) | ⭐⭐⭐⭐ | 57-59행에서 remove 직후 같은 값을 set한다(무의미한 재설정) | low |
| DOM 헬퍼 `create`/`el` | 10벌 | — | breadcrumb:43, welcome:14, context-menu:59, toggle:23, explorer:250, recent:66, outline:70, search:85, remote-vault-dialog:45, workspace-sidebar:163. `chrome/dom.ts:5 el`이 이미 export되어 있다 | low |
| `explorer-panel.ts:81-83,164-166`, `outline-panel.ts:13-15`, `recent-panel.ts:15-18`, `epub-parse.ts:349` | 문서 주석 부패 | — | 문장이 중복되거나 잘렸고, `closeOtherSidebars`가 main에 있다는 낡은 주석이 남아 있다(지금은 `sidebar/registry.ts:106`). epub-parse 349는 "docx's epubOpenErrorMessage" 오타 | low |
| `workspace/remote-vault-dialog.ts:23` | `deviceLabel` | ⭐⭐⭐⭐ | 쿼리 이름인데 처음 호출할 때 저장한다. 지연 초기화이므로 CQS 허용 범위다 | low |

> **False Positive로 제외**:
> - `ensureStyleInjected`의 길이: CSS 선언 리터럴이다.
> - `epub-parse.ts`의 섹션 구분 14개: 모듈 수준의 순수 함수를 구획한 것이다.
> - `LANGUAGE_BY_EXTENSION`과 `pdfjs-types.ts`: 선언 모음이다.
> - `openContextMenu`(125줄): focusIndex, closed, menu를 공유하는 팩토리다.
> - `createSearchPanel`, `createOutlinePanel`, `createRecentPanel`, `createRemoteVaultDialog`, `makeUpdateButton`, `openViewerShell`: 공유 클로저로 결합된 팩토리다.
> - sqlite `build*`, title-bar `createWindowControls`: 렌더링 순차 호출이다.

---

## 패턴 분석

### 분산된 의도 (Scattered Intent) — 11건

1. **뷰어 수명주기**(H1): 9벌. 오류 형식과 `closed` 가드가 이미 갈라졌다.
2. **near-viewport와 페이지 폭 lockstep**(H2): 3벌. `"200% 0px"`와 600 리터럴이 반복되고, 동기화는 주석으로만 강제된다.
3. **iframe 줌 변환**(H3): 2벌이다. "SAME"이라고 약속했지만 identity 경로가 갈라졌다.
4. **영구 볼트 선택과 대체 규칙**(H4): 4벌이고 1곳이 계약을 위반한다.
5. **열 수 있는가 / 북마크 가능한가 게이트**(H6): 2+2벌이다. 주석은 "never disagree"를 약속하지만 식이 다르다.
6. **경로 포함 관계**: `isPathWithin`(SSOT)과 `folderPrefixFor`의 `startsWith`(H7)가 공존한다.
7. **pdf 맞춤 뷰포트**(H8): 2벌이다. "ONE place"라는 약속과 다르다.
8. **확장자와 구분자 파싱**(H9): 확장자 6벌, 구분자 6벌.
9. **오류 → 문구 매핑**: `errorMessage`/"알 수 없는 오류"가 explorer:508, search:288, docx:130, epub-parse:359에 흩어져 있다. 원격 크기 초과 분기는 `file-bytes.ts:79`와 `epub-viewer.ts:236`에 중복된다.
10. **늦은 비동기 결과 가드**: 4종의 세대 카운터와 4종의 `closed` 플래그.
11. **SSH 호스트 판정 `startsWith("ssh://")`**: 범위 안 2곳과 document/ 2곳 → `isSshHost(host)`.

### 표면적 중복 (복붙)
- `{close, onClose}` 핸들 9벌, `ensureStyleInjected` 5벌, `create`/`el` 10벌, 빈 `VaultTabs` 리터럴 6벌(vault-tabs.ts:40,42,45,47,50과 workspace-sidebar.ts:418)
- treeitem 뼈대 3벌(explorer), `shouldRenderPage`와 `shouldBuildTextLayer`의 본문이 동일(pdf)

### 새 모듈 후보
- `chrome/viewer/viewer-lifecycle.ts`(또는 shell.ts 확장): `viewerStatusContent`, `showViewerError`, `errorText`, `viewerHandleOf` (H1)
- `chrome/viewer/page-band.ts`: `observeNearViewport`, `NEAR_VIEWPORT_MARGIN`, `pageFitWidth`, `isUntracked` (H2)
- `api/index.ts` 순수 재노출: `extensionOf`, `basename`, `dirOf`, `applyIframeZoom`, `injectStyleOnce` (H3, H9)
- `workspace/workspace-state.ts` 공개 헬퍼: `currentWorkspaceOf`, `lastSelectedPermanentAfter`, `fallbackCurrentVaultId` (H4)

## 아키텍처 제안

1. **api-fence의 "순수 함수 재노출" 정책을 명문화한다.** 지금 fence는 상태가 있는 레지스트리만 노출하고, 순수 헬퍼는 "로컬 복사"를 사실상 강요한다. 그 결과가 H2, H3, H9의 분산이다. 상태 없는 순수 함수는 facade로 재노출해도 경계 계약을 해치지 않는다. 이미 `looksNumeric`이라는 선례가 있다.
2. **뷰어 수명주기를 셸이 소유하게 한다.** 셸은 줌의 단일 작성자다. 같은 원리로 로딩 상태, 오류 문구, 핸들, 늦은 결과 가드의 단일 작성자도 셸이 맡아야 한다. 새 뷰어를 추가하는 비용과 "열 번째 사본" 위험이 함께 사라진다.
3. **볼트 라우팅의 해석(Query)과 선택(Command)을 분리한다**(H5). `permanentVaultForPath`라는 순수 해석기가 이미 있다. `route*` 계열을 "해석 후 선택"으로 합성하면 CQS 위반이 해소된다. 마이그레이션 코드가 매번 경고 주석을 달 필요도 없어진다.

## 다음 단계 권장

이번 검토에서 분산된 의도가 **11건** 발견됐다(임계값 3 이상). 특히 H1~H3, H9는 함수 단위 문제가 아니다. **api-fence와 뷰어 셸의 책임 경계**, 즉 데이터와 의존 경로를 어떻게 설계했는가의 문제다.

→ **`/architecture-review`** 실행을 권장한다. 대상은 (a) 뷰어 셸과 extensions 사이의 경계, (b) workspace의 해석/선택 경로다.
H4(메모리 상태 계약 위반)와 H8(pdf 뷰포트 중복)은 경로 재설계와 무관하게 바로 고칠 수 있다. 단, 테스트를 먼저 봉인한다.

---

## 교차 영역 단서 (이 파트에서 인라인으로 본 도메인 규칙)

1. **확장자 정규화**
   - `sidebar/explorer/file-icons.ts:19`(SSOT `extensionOf`), `:57` `EDITABLE_TEXT_EXTENSIONS`(Rust `is_editor_text_ext`와 손으로 동기화), `:65` `isEditableTextFile`
   - `chrome/extension-format.ts:5` `isCanonicalExtension`
   - `extensions/code-viewer/language-map.ts:109` `extensionOfPath`, `:126` 정규화
   - `sidebar/explorer/material-icon-glyph.ts:54-55`, `extensions/excel-viewer/decode-input.ts:14`, `workspace/workspace-sidebar.ts:435-440`
   - 외부 호출부: `main.ts:583,843`, `document/remote-unsupported-message.ts:31`
2. **원격 볼트 판정과 원격 게이팅**
   - `chrome/viewer/registry.ts:94` `viewerSupportsRemote`, `workspace/workspace-state.ts:68` `anyVaultStillUsesHost`, `:161` `isPersistedVaultKind`
   - `workspace/vault-routing.ts:35` `isVaultRootLocked`, `:58` `tabScopeForVault`, `:81` `routingTrustsCurrentVault`, `:108` `standardLinkRejectionFor`(→ `document/document-vault` `isRemoteVault`)
   - `sidebar/explorer/explorer-panel.ts:602,1110` `canBookmarkFolders`, `:1118,1132` `hasLocalPath`/`NO_LOCAL_PATH_REASON`
   - `workspace/workspace-sidebar.ts:160,370,524`
   - `chrome/mode-toggle.ts:19`(원격 읽기 전용 라벨)
   - SSH 판정: `workspace-sidebar.ts:564`, `remote-vault-dialog.ts:174`(+ `document/file-host.ts:89,146`, `document/remote-host-field.ts:128`)
3. **경로 정규화 / vault-relative 변환 / 포함 관계**
   - SSOT: `document/path.ts:28` `isPathWithin`. 이와 다른 방식: `workspace/workspace-sidebar.ts:198-208` `folderPrefixFor`(startsWith)
   - 포함 판정을 쓰는 곳: `workspace/cli-routing.ts:27`, `workspace-sidebar.ts:260`, `explorer-panel.ts:506` `showsFolderOf`, `:1057`(루트 잠금 normalize 비교), `:655` `upTarget`(`${root}/..`)
   - 정규화: `workspace/workspace-state.ts:57-58`(`canonicalRootPath`/`canonicalPath` 별칭), `:106`; `cli-routing.ts:32,37`(이중 정규화); `favorite-vault-migration.ts:150,153,174`; `recent-vault-migration.ts:55`
   - 표시명과 구분자: `workspace-state.ts:177,180`, `extensions/html-viewer/index.ts:158,168`, `html-viewer/prepare-html.ts:84` `isRelativeAssetUrl`, `:98` `joinDirAndRelative`
   - zip 엔트리: `chrome/viewer/epub-parse.ts:52` `entryDir`, `:61` `normalizeDir`, `:226` `resolveEntryHref`
   - 기타: `sidebar/search/fuzzy.ts:67` `basenameStart`, `chrome/viewer/image-viewer.ts:34,54,72`, `epub-viewer.ts:253` `captionPathOf`
   - 원격 루트: `workspace-state.ts:19` `REMOTE_VAULT_WIRE_ROOT`
4. **hidden 판정**
   - 숨김 파일 정책은 main의 클로저에 있다(`explorer-panel.ts:134-136`, `:1087` `refreshListing`; `search-panel.ts:58`)
   - `aside.hidden` SSOT: `sidebar/registry.ts:112` `visibleAside`, `chrome/title-bar.ts:273` `rehomeLeftCommandGroup`
   - 볼트 행 숨김: `workspace-sidebar.ts:226` `isHiddenByCollapsedAncestor`, `:241`, `vault-collapse.ts:7`
   - 뷰어 지표: `image-viewer.ts:177`
5. **오류 문구 매핑**
   - 원격 크기 초과: `chrome/viewer/file-bytes.ts:67,79,126`, `epub-viewer.ts:235` `armErrorMessage`(크기 분기 중복), `image-viewer.ts:186`
   - 오류 테이블: `epub-parse.ts:354-367`, `extensions/docx-viewer/index.ts:115`
   - 인라인 문구: `hwp-viewer.ts:168,283`, `sqlite-viewer.ts:287,308,352,436`, `pdf-viewer/index.ts:964,1251,1365`(`name: message` 형식), `excel:537`, `html:247`, `code:283`
   - "알 수 없는 오류": `explorer-panel.ts:508`, `search-panel.ts:279,288`
   - 원격 연결과 페어링: `remote-vault-dialog.ts:65` `pairingErrorMessage`, `workspace-sidebar.ts:349` `showError`, `add-remote-vault.ts:19` `badgeFor`, `workspace-sidebar.ts:94` `remoteRecoveryAction`
   - invoke 거절 분류: `cli-routing.ts:52`, `vault-routing.ts:137`, `favorite-vault-migration.ts:142,162`
6. **메뉴/버튼 비활성 규칙**
   - 메뉴 프리미티브: `chrome/context-menu.ts:105-107`(disabled+reason), `:128` `focusFirstEnabled`
   - 파일 행 메뉴: `sidebar/explorer/file-row-menu.ts:22`, `explorer-panel.ts:1132-1136`
   - 열기 가능: `explorer-panel.ts:303,588` `is-nonmd`/`isOpenableEntry`, `search-panel.ts:129,230,250`
   - 업데이트: `chrome/status-bar/update.ts:60-76,99-104`(`canStartDownload`/`canInstall`)
   - 원격 볼트 추가: `workspace/add-remote-vault.ts:44` `canSubmit`, `remote-vault-dialog.ts:104,133`
   - `workspace-sidebar.ts:111` `paintRecoveryButton`
   - mac 전용 동작: `chrome/file-actions/builtin.ts:16`
   - 루트 잠금 시 `..` 숨김: `explorer-panel.ts:828,943`
7. **캐시 eviction 패턴**
   - LRU: `chrome/viewer/epub-position.ts:151` `upsertPosition`(savedAt LRU, cap 100), `sidebar/recent/recent-docs.ts:32` `pushRecent`(cap 15)
   - TTL과 진행 중 요청 중복 제거: `workspace-sidebar.ts:43-82` `badgeCache`/`badgeProbes`(file-host listingCache를 따라 만들었다고 명시)
   - 거리 기반 축출: `pdf-viewer/index.ts:398,450,643` `MAX_RENDERED_PAGES`
   - 축출 없음: `hwp-viewer.ts:26-28`, `material-icon-glyph.ts:41`
   - 모듈 단위 Promise 캐시: `file-icons.ts:112-134`, `code-viewer/index.ts:146`
   - 루트 변경 시 clear: `explorer-panel.ts:342`
8. **늦은 비동기 결과 가드**
   - 세대 카운터: `sqlite-viewer.ts:95`, `search-panel.ts:167,278,285`, `explorer-panel.ts:352,822,870,875`(`listingRequests`: 344, 530)
   - 슬롯: `chrome/viewer/dont-stack-slot.ts:38`
   - `closed` 플래그: `epub-viewer.ts:322`, `docx:153`, `code:233`, `image-viewer.ts:310`
9. **런타임과 플랫폼 판정**: `chrome/title-bar.ts:130` `isTauriRuntime`(대 `main.ts:1421` 인라인), `:196,259` `isMac`, `file-actions/builtin.ts:16`
10. **jsdom 폴백 규칙**: `hwp-viewer.ts:43,121`, `pdf-viewer/index.ts:140,301`(리터럴 600), `epub-viewer.ts:209`, `image-viewer.ts:358`, `excel-viewer/index.ts:432`
