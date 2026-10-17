# Intent Review — 2026-10-18 · 파트 C (설정·조합 루트·API·단축키·업데이트·QA·루트 단일 파일)

**범위**: `src/settings/**`, `src/main.ts`, `src/api/**`, `src/shortcuts/**`, `src/update/**`, `src/qa/**`, `src/{clipboard,icons,pan-zoom,theme}.ts`. 테스트와 `mocks`는 제외했다. `editor.ts`는 파트 A가 본다.
**방법**: `quick-check.sh`로 1차 스캔한 뒤 전 파일을 직접 읽고 판정했다. 결론은 grep으로 교차 확인했다. 코드는 수정하지 않았다.

## 요약

- **스캔**: 30개 파일, 약 9,000줄, 명명 함수·클로저 약 320개
- **후보**: 31건 (high 11 / medium 14 / low 6). 별도로 skip(False Positive) 다수
- **CQS 위반(사기꾼 ⭐)**: 0건. 값을 반환하면서 상태를 몰래 바꾸는 함수는 찾지 못했다. `push*`/`toggle*` 계열은 새 배열을 반환하는 순수 함수라는 관례가 계속 지켜지고 있다.
- **최대 이슈**: 이름이 약속한 계약을 구현이 일부만 지키는 경우 2건이다.
  1. `controls.ts`의 모듈 계약은 "subscribe한 렌더러는 attachTeardown으로 해제한다"인데, 8개 렌더러 중 4개(segmented/select/slider/text)가 unsubscribe 함수를 그냥 버린다. 설정 모달에서 카테고리를 바꾸거나 다시 열 때마다 분리된 DOM에 reflect 클로저가 쌓인다(실제 누수).
  2. "재시작 전에 버퍼를 디스크에 확정한다"는 규칙이 `update/auto-install.ts` 한 곳에만 있다. 버전 패인의 "지금 설치하고 재시작"(`version-pane.ts:312`)과 푸터 버튼(`chrome/status-bar/update.ts:104`)은 `installAndRelaunch()`를 바로 부른다. 버전 패인 경로는 다운로드가 끝난 직후 auto-install의 `commitBeforeSwitch`와 경쟁해서 이길 수 있다.
- **main.ts 판정**: `boot()`(L152–1659, 1,508줄)은 부트스트랩 배선이라 프레임워크 관례 예외(FP 3)를 인정한다. 다만 그 안에 볼트 라우팅 규칙이 인라인으로 남아 있다. 이미 `workspace/vault-routing.ts`에 명명 함수로 있는 규칙(`resolveTargetVault`)을 우회해 6번 다시 구현하는 등, 같은 의도가 흩어진 사례가 5건 있다. 함수 길이보다 SSOT 우회가 문제다.

---

## 이전 리뷰 지적 추적 (이 파트 범위)

| 출처 | 지적 | 상태 |
|---|---|---|
| 06-13 Low | `main.ts:52 boot` (약 61줄, IO·DOM·배선 혼재) | **악화했으나 예외 인정**. 지금은 1,508줄이다. 09-25 아키텍처 진단 이후 `settings/boot-sinks.ts`, `update/auto-install.ts`, `workspace/vault-routing.ts`, `workspace/vault-selection.ts`, `document/session.ts`로 추출해 2,325줄에서 1,661줄로 줄었다. 단축키 핸들러 블록(`shortcuts/app-commands.ts` 계획)은 아직 추출하지 않았다. |
| 06-13 High #1 일부 | `applySvg` 안의 pan-zoom 배선 | **이 파트 몫은 해소**. pan-zoom은 루트 leaf `src/pan-zoom.ts`로 옮겨졌고, 09-25 진단의 "markdown→chrome 역류"도 해소됐다. `applySvg` 본체는 파트 A 소관이다. |
| 06-13 Medium | mermaid 테마 매핑 분산 | 파트 A 소관. 다만 main 쪽 테마 fan-out은 아래 교차 단서 #9에 남아 있다. |
| 07-03 Low | `main.ts:710 flashStatus` (겹침 버스트 baseline 규칙) | **잔존·변화 없음**. 지금 `main.ts:1556–1567`에 있다. `tests/flash-status.test.ts`가 계속 봉인하고 있다. 09-25 진단의 `shortcuts/app-commands.ts` 이동은 하지 않았다. |
| 07-03 skip | `main.ts:305 toggleFavorite` | **해소(이동)**. 즐겨찾기가 workspace 볼트 체계로 흡수됐고 main에는 마이그레이션 호출만 남았다(L160–185). |
| 07-03 관찰 | `shortcuts/actions.ts` | **이상 없음**. Mod+1..5를 id에 고정하는 이유까지 주석에 남아 있다. |
| 07-03 #1·#2·#3 | 경로 라벨·`basename` twin·CJK 플랭킹 | 범위 밖(파트 B/A). main은 이제 `document/path`의 공유 `basename`을 import한다(L4). |
| 09-25 진단 §1.1 | 열기 트랜잭션 4벌 | **해소**. `session.openFromPanel`/`openDocumentSafely`로 접혔다(main L785, 994, 1195). |
| 09-25 진단 §5-3 | 파사드 read-only 뷰 일반화 | **미수행**. 아래 M-11 참조. |

---

## 🔴 High Priority

### H1. `renderSegmented`/`renderSelect`/`renderSlider`/`renderText` — ⭐⭐ — `src/settings/panel/controls.ts:73, 108, 144, 164`

**실제 책임**: 행을 만들고 `setting.subscribe(reflect)`를 건다. 반환된 unsubscribe 함수는 **버린다**.
**문제**: 모듈 머리 계약(L17–22)은 "subscribe하는 컨트롤은 unsubscribe를 넘겨서 modal이 카테고리 전환·닫기 때 해제하게 한다. 안 그러면 죽은 DOM에 reflect가 쌓인다"이다. 이 계약을 `renderJson`(L423)·`renderKeybind`(L605)·`renderViewerToggles`(L687)·`geometrySliderRow`(L304)는 지키고 위 4개는 지키지 않는다. `modal.ts:133 teardownPane`은 `attachTeardown`으로 등록된 요소만 정리하므로, 테마·타이포그래피·에디터·탐색기·Mermaid 카테고리를 열 때마다 구독이 영구히 늘어난다. 같은 의도가 렌더러마다 따로 구현되면서 생긴 결함이다.
**추출 제안**:
```ts
// before (4곳)
reflect(setting.get());
setting.subscribe(reflect);
return r;

// after — 구독과 해제를 한 동작으로 묶는다
function bindRow<T>(r: HTMLElement, setting: Setting<T>, reflect: (v: T) => void): void {
  attachTeardown(r, [setting.bind(reflect)]); // bind = 초기 반영 + subscribe
}
```
**영향 범위**: controls.ts 4개 렌더러. 회귀 가드는 "카테고리를 N번 전환한 뒤 setting.set을 하면 reflect가 1번만 불린다"는 jsdom 테스트 1개로 충분하다.

### H2. `installAndRelaunch()` — ⭐⭐ — `src/update/update-flow.ts:157` (호출부 `settings/panel/version-pane.ts:312`, `chrome/status-bar/update.ts:104`)

**실제 책임**: `downloaded → installing → install() + relaunch()`.
**문제**: `auto-install.ts:3–19`의 도메인 규칙("relaunch 전에 반드시 `commitBeforeSwitch`로 버퍼를 확정한다. 실패하면 재시작하지 않는다. 미저장 작업을 버리면서 재시작을 강행하지 않는다")이 세 설치 경로 중 자동 경로 한 곳에만 있다. 버전 패인의 `startInstall`은 `await startDownload()` 직후 곧바로 `installAndRelaunch()`를 부른다. 그런데 같은 순간 `setPhase("downloaded")`가 auto-install 구독자를 깨워 `commitBeforeSwitch`를 await하므로, 수동 경로가 먼저 `installing`으로 전이해서 커밋 전에 프로세스를 내릴 수 있다. 이름 `installAndRelaunch`는 커밋 전제를 약속하지 않고, 전제는 다른 파일 주석에만 있다.
**추출 제안**:
```ts
// update-flow.ts — 전제를 시그니처로 끌어올린다
export async function installAndRelaunch(confirmDurable: () => Promise<boolean>): Promise<void> {
  if (!canInstall(phase) || !pendingUpdate) return;
  if (!(await confirmDurable())) return;   // "재시작 전 버퍼 확정" 규칙의 유일한 위치
  ...
}
// main은 confirmDurable = session.commitBeforeSwitch를 update 모듈에 1회 주입(setRelaunchGuard)
```
**영향 범위**: update-flow, auto-install, version-pane, chrome/status-bar/update.ts. `tests/main-update-autorestart.test.ts`를 확장해야 한다.

### H3. `currentVault() ?? workspaceStore.getGlobalVault()` 6벌 — `resolveTargetVault` 우회 — `src/main.ts:726, 771, 805, 1187, 1194, 1201`

**실제 책임**: "명시 볼트 > 현재 볼트 > 글로벌" 3단 폴백.
**문제**: `workspace/vault-routing.ts:95 resolveTargetVault(explicit, fallback, global)`의 문서는 "a vault-crossing open이 잘못된 백엔드로 읽는 버그의 전체 수정이 이 한 줄 `??`로 접힌다. 그래서 직접 테스트한다"고 말한다. 그런데 main은 같은 규칙을 6번 인라인으로 다시 쓴다(1194·1201은 3단 그대로). 이 저장소가 6번 겪었다고 기록한 vault leak 계열 버그가 바로 이 폴백의 어긋남이다.
**추출 제안**: `vaultSelection`에 `currentVaultOrGlobal()`를 두고 6곳을 `resolveTargetVault(x, currentVault(), global)`로 치환한다. 매개변수 0~1개다.

### H4. "볼트 선택 커밋" 4벌 — `src/main.ts:1084–1085, 1118–1119, 1127–1128, 1138–1139`

**실제 책임**: `workspaceStore.selectVault(id); setRoutedVault(vault)`. 사이드바 선택(영속)과 라우팅 셀(세션)을 함께 맞춘다.
**문제**: 두 SSOT를 같이 움직여야 한다는 규칙이 4곳에 손으로 풀려 있다. 한 곳에서 순서나 짝을 놓치면 `currentVault()`(=routed ?? selected)와 사이드바 표시가 어긋난다. 1084는 다른 볼트를 등록하면서 글로벌을 유지하는 변형이라 더 읽기 어렵다.
**추출 제안**: `workspace/vault-selection.ts`의 `VaultSelection`에 `commit(vault: Vault): void`를 추가한다(내부에서 store.selectVault와 routedVault 대입). main의 4곳은 `vaultSelection.commit(selectedVault)` 한 줄이 된다.

### H5. 볼트 종류별 정책 switch 3벌과 인라인 종류 비교 5곳 — `src/main.ts:361 explorerRootForCurrentSelection`, `:392 explorerRootForVault`, `:1015 baseDirForVault` / 인라인 `:237, 787, 813, 947, 1081`

**실제 책임**: persistenceKind별로 탐색기 루트, 홈 루트, 로컬 기준 폴더를 결정한다.
**문제**:
- 세 함수가 같은 `switch(kind){permanent/global/remote; default assertNever}` 모양으로 조합 루트에 있다. `vault-routing.ts:13–21`의 `assertNever` 문서가 "three more in main.ts"라고 직접 인정하는 잔여분이다.
- 같은 문서가 "모든 종류 비교를 switch로"라는 정책을 세웠는데, main 안에 `=== "global"`(813, 1081), `=== "remote"`(787. `isRemoteVault`가 있는데도 우회), `=== "permanent"`(237, 947)가 남아 있다. 새 볼트 종류가 생기면 `tsc`가 잡지 못하는 자리다.
**추출 제안**: `workspace/vault-routing.ts`에 순수 함수로 이동한다.
```ts
explorerRootFor(vault, ctx: { homeRoot, currentBaseDir, explorerFolder }): string
localAnchorDirFor(vault, explorerFolder): string        // = baseDirForVault
isGlobalVault(v) / isPermanentVault(v)                   // 인라인 비교 대체
```
`ctx` 객체 1개로 매개변수를 3개 이하로 유지한다.

### H6. `canonicalize_path` 파이프라인 4가지 정책 — `src/main.ts:179, 187–195, 210, 1058–1064`, `src/qa/native-smoke-driver.ts:133`

**실제 책임**: Rust `canonicalize_path`를 부른 뒤 JS `normalizePath`/`canonicalRootPath`를 적용해 볼트 루트·문서 경로를 정규화한다.
**문제**: 같은 도메인 연산에 실패 정책이 넷이다. 187–195는 실패하면 입력을 그대로 쓰고, 210은 `resolveHomeRoot`가 fallback한다. 1058은 `WorkspaceStateError`를 던지고, qa:133은 `.catch(() => input)`이다. qa 주석(L114–131)은 "Rust 단계를 건너뛰면 `/var`↔`/private/var` 접두 불일치로 글로벌로 오라우팅된다"는 실측 버그를 기록하고 있다. 정규화가 한 군데 있었다면 생기지 않았을 버그다. 덧붙여 `isVaultRegistered`(main:1066–1069)는 **모든 워크스페이스**의 볼트를 비교하고, `WorkspaceStore.registerCanonicalVault`(workspace-state.ts:182)의 중복 판정은 **현재 워크스페이스**만 본다. "이미 등록됐나"의 범위가 서로 다르다.
**추출 제안**: `document/` 또는 `workspace/`에 `canonicalizeLocalPath(path, onFail: "keep" | "throw"): Promise<string>`를 단일 IPC 래퍼로 둔다. `isVaultRegistered`는 `WorkspaceStore.findVaultByRoot(canonical)`로 store에 위임해 범위를 하나로 맞춘다.

### H7. "원격 볼트에서는 로컬 전용 동작을 거부한다" 규칙 분산 — `src/main.ts:615–619, 759–767, 835, 842, 941–945, 1579–1582`

**실제 책임**: 원격 볼트 행이나 문서의 vault-relative 경로가 로컬 IPC(`open_path`, `bundle_doc`, `canonicalize_path`, 뷰어 `open`)로 새지 않게 막는다.
**문제**: 판정은 `isRemoteVault`/`rowHasLocalPath`/`standardLinkRejectionFor`/`viewerSupportsRemote` 네 갈래로 나뉜다. 거부를 알리는 표면도 둘로 갈린다. 같은 `REMOTE_VAULT_LOCAL_LINK_MESSAGE`가 761에서는 `save.set("error")`, 1580에서는 `flashStatus`로 나간다. 메시지 선택도 지점마다 다르다(`remoteUnsupportedMessage` vs `REMOTE_VAULT_LOCAL_LINK_MESSAGE`). 주석은 6번 되풀이된 leak 계열이라고 경고하는데, 가드가 호출부마다 손으로 붙어 있다.
**추출 제안**: `document/document-vault.ts`에 `localOnlyRefusal(vault, action: "new-window" | "bundle" | "viewer" | …): string | null`를 두고(메시지 매핑 표), main에는 표면 하나 `reportRefusal(msg)`만 남긴다.

### H8. 프리셋 이름 규칙 3벌, 이중 타입, 토글 라벨의 순환 순서 중복 — `src/settings/app.ts:27`, `src/settings/theme-schema.ts:8, 403`, `src/settings/panel/color-inspector.ts:110`, `src/theme.ts:3, 45–51`

**실제 책임**: `"dark" | "light" | "claude"` 판정과 다음 프리셋 순환.
**문제**:
- `isPresetName` 가드가 문자열 리터럴 비교로 세 곳에 있다(app parse, upgradePristinePreset, presetDefaultFor).
- 같은 도메인 타입이 `theme.ts:3 Theme`와 `theme-schema.ts:8 PresetName`으로 두 번 선언돼 있다.
- `makeThemeToggle`의 라벨 "(클릭: 라이트)/(클릭: 클로드)/(클릭: 다크)"가 `nextPreset`(app.ts:64)의 순환 순서를 하드코딩으로 복제한다. 순서를 바꾸면 툴팁과 aria-label이 거짓말을 하게 된다.

네 번째 프리셋을 추가하려면 5곳을 고쳐야 한다.
**추출 제안**: `theme-schema.ts`에 `PRESETS = ["dark","light","claude"] as const`, `isPresetName(s)`, `PRESET_LABEL`을 둔다. `theme.ts`의 `Theme`은 `PresetName` 별칭으로 바꾼다. 라벨은 `` `${PRESET_LABEL[t]} (클릭: ${PRESET_LABEL[nextPreset(t)]})` ``로 만든다.

### H9. 테마 키→CSS 변수·폴백 체인 이중 정의 — `src/settings/theme-schema.ts:528–591 themeToVars` ↔ `src/settings/panel/theme-preview.ts:80–171 THEME_TARGETS`

**실제 책임**: 색 키 → `--x` 변수명 매핑, 그리고 미설정 키의 폴백 체인.
**문제**: 두 파일이 모두 스스로를 단일 출처라고 주장한다("The single source of which CSS var each theme field drives" / "The single source of which things can be clicked"). 실제로는 `bold → --bold-color`, `quoteBg → --quote-bg` 같은 매핑을 두 번 쓴다. `THEME_TARGETS.highlight`의 폴백 `#1a1300`/`#fff3a3`(L120)는 `HIGHLIGHT_INK`(theme-schema:226)와 light 프리셋 값을 하드코딩으로 복제한다. theme-preview 자신의 doc(L53–54)이 "체인 불일치는 round-1 border/quote 앵커 혼동과 같은 부류의 버그"라고 경고하고 있다.
**추출 제안**: `theme-schema.ts`에 `COLOR_VAR: Record<keyof Theme["colors"], string>`를 두고 `themeToVars`와 `THEME_TARGETS`가 둘 다 이 표에서 `colorVar`/`bgVar`를 파생한다. highlight 폴백은 `HIGHLIGHT_INK`를 export해서 참조한다.

### H10. `shareStartErrorMessage` / `shareStartCliErrorMessage` 오류 분류 중복 — `src/settings/remote-share-port.ts:49–58, 63–72`

**실제 책임**: `remote_share_start` 거부 문자열(`PORT_IN_USE:`/`PORT_INVALID:`/기타)을 사람이 읽을 문장으로 바꾼다.
**문제**: 접두 분류 로직과 `err instanceof Error ? … : String(err)`가 두 함수에 똑같이 있고, 문장만 다르다(패널: "아래 '공유 포트'", CLI: "설정 › 원격 공유 › 공유 포트"). Rust 쪽에 세 번째 접두가 생기면 두 곳을 따로 고쳐야 한다.
**추출 제안**:
```ts
type ShareStartFailure = { kind: "port-in-use"; port: number; alt: number } | { kind: "port-invalid" } | { kind: "other"; text: string };
export function classifyShareStartError(err: unknown, port: number): ShareStartFailure
// 패널/CLI는 각자 render(failure)만 소유
```

### H11. 바인드 방식 기본값 규칙 이중 구현 — `src/settings/remote-share-cli.ts:84 chooseBindMode`, `:108` ↔ `src/settings/remote-share-panel.ts:262, 471–479`

**실제 책임**: "기억값이 있으면 그 방식, 없으면 Tailscale 감지 여부(프로브 실패 시 낙관적 true)".
**문제**: `chooseBindMode`의 doc은 "패널 pending 기본값 규칙과 동일"이라고 약속한다. 그런데 패널은 이 함수를 쓰지 않고 `bindMode = "tailscale"` 초기값, `refreshTailscaleAvailability`의 catch→true, 그리고 미실행일 때만 내려주는 조건으로 같은 결론을 따로 낸다. "동일"이 주석으로만 보장되는 셈이다.
**추출 제안**: 패널의 `refreshTailscaleAvailability`가 `if (!running) bindMode = chooseBindMode(lastSelection, tailscaleAvailable)`를 부르게 한다. 프로브 실패 시 낙관 정책은 `probeTailscale(): Promise<boolean>`(catch→true) 하나로 모아 두 곳이 공유한다.

---

## 🟡 Medium / 🟢 Low

| # | 파일:라인 | 함수/대상 | 별점 | 실제 책임 (1줄) | 가치 |
|---|---|---|:-:|---|:-:|
| M-1 | `main.ts:152` | `boot` | ⭐⭐⭐ | 조합 루트(FP 3 예외). 단, 아래 M-2~M-7의 인라인 본문을 품고 있다 | medium |
| M-2 | `main.ts:1490–1612` | 단축키 `registerHandler` 블록 + `flashStatus` + `openReplacePanel` + `replaceHintEntry` | ⭐⭐⭐⭐ | 18개 핸들러 본문. 09-25 진단이 계획한 `shortcuts/app-commands.ts` 이동을 아직 하지 않았다 | medium |
| M-3 | `main.ts:1439–1472, 1622–1623` | 에디터 행동 설정 sink 9건 | ⭐⭐⭐⭐ | `setting.subscribe(() => session.current?.x())`. `bindBootSettingSinks`와 짝을 이룰 `bindEditorSettingSinks(session)`가 없다 | medium |
| M-4 | `main.ts:1360` | `resolveExternalChange` | ⭐⭐⭐ | 충돌 판정, 3-way 복구 상태기, 모달 배선, DEV 전역 노출(44줄). 09-25 계획은 `document/external-change-flow.ts` | medium |
| M-5 | `main.ts:1071` | `toggleExplorerVault` | ⭐⭐⭐ | 등록/해제 토글 + "글로벌에 있었으면 글로벌 유지 / 현재 볼트 해제 시 라우팅 해제" 규칙이 인라인. 이름은 등록 토글만 약속하고 라우팅 셀 변경은 숨긴다 | medium |
| M-6 | `main.ts:316` | `initialBaseDir` 인라인 | ⭐⭐⭐⭐ | `dirOf(f) \|\| SAFE_EXPLORER_BASE_PATH`. `baseDirForOpenedDocument`(L133–150)의 doc은 "재인라인 금지"를 약속한다. 지금은 초기 파일이 로컬만이라 정답이지만 약속을 위반한다 | medium |
| M-7 | `main.ts:1522–1527, 1001–1004` | `replaceHintEntry`, welcome `openFolderChord` | ⭐⭐⭐⭐ | "액션의 표시용 chord" 규칙 2벌. 1524의 `?? "Mod+Alt+F"`는 `actions.ts:70` 기본값을 하드코딩 복제한 죽은 폴백이다 | medium |
| M-8 | `main.ts:182, 192, 1091` + `remote-share-panel.ts:125`, `remote-share-port.ts:50,64`, `remote-share-cli.ts:118`, `qa:253` | "예상된 오류" 술어 / `errorText` | — | `e instanceof Error \|\| typeof e === "string"`, `err instanceof Error ? err.message : String(err)`가 9곳 이상. 1091의 `instanceof WorkspaceStateError`는 Error의 하위라 중복이다 | medium |
| M-9 | `settings/app.ts:355–439` | on/off 설정 선언 5벌 | ⭐⭐⭐⭐ | parse `raw==="on"\|\|raw==="off"`와 `{켜기,끄기}` options를 vim·recursiveImageSearch·showHiddenFiles·panZoom(+htmlScripts boolean)마다 복붙한다. 소비처도 `=== "on"` 변환을 반복한다(main:771, 1188, 1458, 1502). → `onOffSetting(key, default, label, group)` | medium |
| M-10 | `settings/panel/modal.ts:105–186, 141, 225–227` | 독립 카테고리(버전·원격 공유) 배선 | ⭐⭐⭐⭐ | 버튼 생성 2벌, `select*Category` 3벌, `ActiveCategory` 유니온과 `open()`의 if 체인. 세 번째 독립 패인을 추가하려면 4곳을 고쳐야 한다. → `STANDALONE_PANES: {kind,label,render}[]` 디스패치 테이블 | medium |
| M-11 | `api/index.ts:144–160` | `fontScale`, `htmlViewerScripts` | ⭐⭐⭐⭐ | read-only 투영(set 제거 + freeze)을 손으로 2번 쓴다. doc은 "Reusable on purpose"라고 하는데 재사용 함수가 없다. → `readonlyView<T>(s: Setting<T>): ReadonlySetting<T>` | medium |
| M-12 | `settings/remote-share-panel.ts:151` | `renderRemoteSharePane` | ⭐⭐⭐ | 이름은 "render"인데, 마운트 시 IPC 2건, 전역 이벤트 listen, 설정 쓰기(L583)를 한다. 500줄 팩토리(공유 클로저라 FP 7 적용)지만 내부에 아래 도메인 규칙이 인라인으로 있다 | medium |
| M-13 | `remote-share-panel.ts:318–323` | 클라이언트 호스트 칸 힌트 | — | `ssh://사용자@호스트?share-port=N` / `<이름>:N` 형식 규칙이 인라인이다. 이 형식을 파싱하는 쪽(`document/remote-host-field`)과 짝인 생성 규칙 → `clientHostHint(port, bindMode)` | medium |
| M-14 | `remote-share-panel.ts:486, 515, 588, 603` | `applyStart`/`applyStop`/`onIssueCode`/`onRevokeDevice` | ⭐⭐⭐⭐ | `busy` 가드 → clearError → try/catch(showError) → finally(busy=false; render) 4벌. → `runExclusive(op, onError)` | medium |
| L-1 | `settings/panel/controls.ts:76, 113, 166` + `:43` ↔ `remote-share-panel.ts:132` | help 힌트 블록 3벌, `row()` vs `labeledRow()`, 켜기/끄기 세그먼트 수작업 2벌(controls:653, panel:175) | — | 표면 중복 | low |
| L-2 | `controls.ts:472` | `renderKeybind` (138줄) | ⭐⭐⭐⭐ | 행 빌드는 FP 6이지만 chord 캡처 상태기(L558–592)가 인라인이다. → `armChordCapture(onChord, onCancel)` | low |
| L-3 | `qa/native-smoke-driver.ts:132` | `seedVault` | ⭐⭐⭐⭐ | `makeVaultId`(workspace-state:142)와 displayName 파생(:177, 180)을 "Mirrors exactly"라고 주석을 달고 복제한다. dev 전용이지만 하네스가 실제와 갈라지는 지점이다 | low |
| L-4 | `pan-zoom.ts:204` | `attachPanZoom`의 `panZoomSetting.get()` | ⭐⭐⭐⭐ | 루트 leaf 프리미티브가 settings를 직접 읽는다(`opts.force`로 우회하는 구조). 게이트는 호출자(mermaid widget)에 두는 편이 의존 방향상 깔끔하다. reset-to-identity 3줄이 2벌(L299–301, 312–314)이다 | low |
| L-5 | `settings/app.ts:682, 620–628, 1–5, 334, 442, 536–539` / `api/index.ts:15` / `qa:87` | 주석 드리프트 | — | `clampFontScale` doc은 0.8–2.0인데 코드는 MAX 3.0이다. `isEpubReadingPosition` doc은 "recentDocs는 배열 전체를 거부"라고 하는데 실제 recentDocs parse는 원소별로 필터한다(L590 doc과 모순). "Sinks subscribe (in main.ts)"는 boot-sinks 이전 문구다. "Round 1: sink deferred"는 이미 연결됐다. `toggleViewerDisabled` doc은 존재하지 않는 main.ts 함수를 참조한다. api header의 `shortcuts/app.ts`는 `settings/app.ts`의 오기다. qa doc은 `__mermark` writer를 main `openInWindow`라고 하는데 실제는 `document/session.ts:537`이다 | low |
| L-6 | `settings/theme-schema.ts:441`, `panel/color-inspector.ts:136` | `parseTheme`(76줄), `storedValue` | ⭐⭐⭐⭐ | 검증기라 응집적이다. `typeof x==="object"&&x!==null` 5벌, `storedValue`는 `isToken` 규칙을 재구현한다 | low |

> **False Positive로 제외했다**: `buildModal`·`buildThemePreview`·`buildColorInspector`·`attachPanZoom`·`renderRemoteSharePane`의 구조 자체는 공유 클로저 팩토리(FP 7)로 보아 길이만으로 분해를 권하지 않는다. 도메인 규칙만 위에서 따로 짚었다. `color-inspector.render`, `version-pane.showAvailable`, `theme-preview` DOM 빌더는 렌더링 순차 호출(FP 6)이다. `icons.ts PATHS`, `theme-schema` 키 목록·`builtInTheme`·`themeToVars` 본문, `actions.ts`, `app.ts` 선언부는 선언 모음(FP 5)이다. `shortcuts/registry.ts`·`keys.ts`, `settings/store.ts`·`registry.ts`·`sinks.ts`·`boot-sinks.ts`, `update/update-flow.ts`(H2의 전제 누락 제외)·`update-progress.ts`, `clipboard.ts`, `remote-share-ipc.ts`는 네이밍과 CQS가 모두 모범적이라 skip했다.
>
> **quick-check 한계**: `pan-zoom.ts:199 attachPanZoom`(약 204줄)은 여러 줄 시그니처 때문에 플래그되지 않았다. 직접 읽어서 FP 7로 판정했다.

---

## 패턴 분석

### 분산된 의도 (Scattered Intent) — 9건

1. **3단 볼트 폴백**: main ×6, 단일 출처 `resolveTargetVault`는 우회됐다(H3).
2. **볼트 선택 커밋**: main ×4(H4).
3. **볼트 종류 정책**: main switch ×3과 인라인 비교 ×5, `vault-routing`의 정책을 위반한다(H5).
4. **경로 canonicalize 정책**: main ×4, qa ×1, local-doc-link ×3(파트 A). 실패 정책이 넷이고 "등록됨" 범위도 둘이다(H6).
5. **원격 로컬전용 거부**: 판정 4갈래 × 표면 2갈래(H7).
6. **프리셋 열거·순환**: 3 가드, 2 타입, 1 하드코딩 라벨(H8).
7. **테마 키→CSS 변수**: themeToVars ↔ THEME_TARGETS ↔ styles.css(H9).
8. **share-start 오류 분류**: 2벌(H10). **바인드 기본값**: 2벌(H11).
9. **구독 해제 계약**: 8 렌더러 중 4개만 이행(H1). **재시작 전 확정**: 3 경로 중 1개만 이행(H2). "규칙을 일부 호출부에만 적용한" 같은 유형이다.

### 표면적 중복
- `err instanceof Error ? err.message : String(err)` 9곳 이상(M-8), on/off 설정 5벌(M-9), JSON parse 가드 4벌(app.ts keybindings/disabledViewers/recentDocs/epubPositions), busy 래퍼 4벌(M-14), 행 빌더 2벌(L-1).

### 새 모듈 후보
- **`workspace/vault-routing.ts` 확장**: `explorerRootFor`/`localAnchorDirFor`/`isGlobalVault`/`isPermanentVault`(H5). `VaultSelection.commit`·`currentVaultOrGlobal`(H3·H4)
- **`document/local-path-ipc.ts`**: `canonicalizeLocalPath(path, onFail)`(H6). 09-25 진단의 "타입 있는 IPC 클라이언트 부재"의 첫 조각이다.
- **`document/document-vault.ts` 확장**: `localOnlyRefusal(vault, action)`(H7)
- **`settings/theme-schema.ts`**: `PRESETS`/`isPresetName`/`PRESET_LABEL`/`COLOR_VAR`(H8·H9)
- **`shortcuts/app-commands.ts`**: main 핸들러 블록(M-2). **`settings/editor-sinks.ts`**: `bindEditorSettingSinks(session)`(M-3)

---

## 아키텍처 제안

1. **main.ts에는 "배선"만 남기고 "판단"은 내보낸다.** 길이(1,508줄)는 예외로 둘 수 있다. 문제는 `vault-routing.ts`/`vault-selection.ts`가 이미 있는데도 그 규칙을 main에서 다시 인라인한다는 점이다(H3·H4·H5). 순수 함수 이동이라 `main-wiring.test.ts` 68건이 회귀를 막아 준다. 위험이 낮고 효과가 커서 이번 파트에서 첫 번째로 권한다.
2. **"부분 적용된 계약"은 구조로 강제한다.** H1(구독 해제)과 H2(재시작 전 확정)는 둘 다 규칙이 주석이나 다른 파일에 있고 호출부가 자율로 지키게 되어 있다. 계약을 시그니처로 끌어올리면(`bindRow`, `installAndRelaunch(confirmDurable)`) 다음 호출부가 같은 실수를 할 수 없다. H1은 실제 누수이고 H2는 잠재적 데이터 유실 경로다. 둘 다 작은 diff로 고칠 수 있다.
3. **테마 도메인 사전 하나**(H8·H9): 프리셋 열거, 키→변수, 폴백을 `theme-schema.ts` 한 곳에 표로 두고 preview·inspector·toggle·parse가 파생하게 한다. styles.css 폴백 체인과의 대조는 기존 golden 체크를 이용한다.

---

## 다음 단계 권장

이번 파트에서 **분산된 의도 9건**이 나왔다(임계 ≥3 초과). 그중 H3–H7 다섯 건은 **볼트 라우팅이라는 같은 관심사가 조합 루트와 도메인 모듈 사이를 오가는 경로 문제**다. 함수 하나를 추출하는 것으로는 닫히지 않는다.

→ 다음 단계로 **`/architecture-review`** 실행을 권장한다. 초점은 (a) 볼트 판정·폴백·커밋의 단일 경로, (b) 로컬 IPC(`canonicalize_path` 등)의 타입 있는 클라이언트, (c) 설정→에디터 sink fan-out을 어디에 둘지다. 09-25 진단의 단계 9(`app-commands`·`external-change-flow` 추출)와 함께 묶으면 좋다.

H1·H2는 아키텍처 작업과 독립적으로 바로 고칠 수 있다(테스트 1~2개씩 추가).

---

## 교차 영역 단서

이 파트의 코드에서 인라인으로 본 도메인 규칙이다. 다른 파트(A: markdown/document/text/editor, B: chrome/sidebar/workspace/extensions, D: src-tauri)의 정의와 대조할 것.

| # | 규칙 | 위치(이 파트) | 대조 대상 |
|---|---|---|---|
| 1 | **3단 볼트 폴백** (`x ?? currentVault() ?? global`) | `main.ts:726, 771, 805, 1187, 1194, 1201` | `workspace/vault-routing.ts:95 resolveTargetVault` (B) |
| 2 | **볼트 선택 커밋** (`selectVault` + `setRoutedVault`) | `main.ts:1084–1085, 1118–1119, 1127–1128, 1138–1139` | `workspace/vault-selection.ts:28` (B) |
| 3 | **볼트 종류 판정 인라인** | `main.ts:237, 787, 813, 947, 1081` / switch `:361, 392, 1015` / `settings/remote-share-panel.ts:92` | `document/document-vault.ts:44 isRemoteVault`, `:65 rowHasLocalPath`, `vault-routing.ts:10, 35, 58, 81, 148` (A/B) |
| 4 | **원격 볼트 판정 → 로컬 전용 동작 거부** | `main.ts:615–619, 759–767, 835, 842, 941–945, 1579–1582` | `markdown/local-doc-link.ts REMOTE_VAULT_LOCAL_LINK_MESSAGE`, `document/remote-unsupported-message.ts`, `chrome/viewer/registry viewerSupportsRemote` (A/B) |
| 5 | **경로 canonicalize(Rust→JS normalize)와 실패 정책** | `main.ts:179, 187–195, 210, 1058–1064`, `qa/native-smoke-driver.ts:133–134` | `markdown/local-doc-link.ts:244, 251, 263`, `vault-routing.ts:132 resolveHomeRoot`, `workspace-state.ts:57 canonicalRootPath`, `src-tauri canonicalize_path` (A/B/D) |
| 6 | **"이미 등록된 볼트" 범위** (전 워크스페이스 vs 현재 워크스페이스) | `main.ts:1066–1069, 1075` | `workspace/workspace-state.ts:182 registerCanonicalVault` (B) |
| 7 | **볼트 id 인코딩과 displayName 파생** | `qa/native-smoke-driver.ts:135–136` | `workspace-state.ts:142 makeVaultId`, `:177, 180` (B). workspace-state 안에서도 2벌이다. `document/path basename`과도 겹친다 |
| 8 | **문서 기준 폴더 폴백** (로컬 "/" vs 원격 "") | `main.ts:148–150`(명명됨), `:316`(재인라인) | `document/session.ts`의 `currentBaseDir` 대입부, `workspace-state REMOTE_VAULT_WIRE_ROOT` (A/B) |
| 9 | **테마 변경 이벤트 fan-out** (theme/themeJson 이중 발화 + 프리셋 동기화) | `main.ts:1439–1452`, `settings/boot-sinks.ts:26–38`, `main.ts:1468–1472` | `markdown/mermaid-widget.ts refreshMermaidTheme/subscribeThemeForceRebake` (A) |
| 10 | **설정→에디터 sink fan-out** (`session.current?.x`) | `main.ts:1456–1458, 1464, 1469, 1472, 1623` | `document/session.ts`, `editor.ts` 옵션 seed (A) |
| 11 | **원격 오류 → 사용자 문구 매핑** | `main.ts:491–493 recoveryDetailFor` (`badgeFor(classifyRemoteError)`) | `document/file-host.ts:55`, `workspace/add-remote-vault.ts:15`, `workspace-sidebar.ts:139` (A/B) |
| 12 | **share-start 오류 접두 → 문구** | `settings/remote-share-port.ts:49–72` | `src-tauri remote_host::bind PORT_IN_USE:`/`PORT_INVALID:`, `remote-vault-dialog pairingErrorMessage` (B/D) |
| 13 | **원격 클라이언트 호스트 문자열 형식** (`<이름>:포트`, `ssh://…?share-port=`) | `settings/remote-share-panel.ts:318–323` | `document/remote-host-field`(파서), `src-tauri remote_ssh.rs` (A/D) |
| 14 | **바인드 방식 기본값 + Tailscale 프로브 낙관** | `remote-share-cli.ts:84, 108`, `remote-share-panel.ts:262, 471–479` | `src-tauri resolve_bind_ip`/`remote_tailscale_available` (D) |
| 15 | **CLI 경로형 인자 판정** `startsWith("/")` | `settings/remote-share-cli.ts:23` | `document/path.ts isResolvedAbsolutePath`·`windowsPathPrefix` (A). Windows 경로가 이름형으로 오분류될 수 있다 |
| 16 | **복구 사본 파일명** (`${file}.recovered.md` vs `.mermark-recovered`) | `main.ts:1046` | `editor.ts:120`, `mocks/tauri-core.ts:376`, `src-tauri is_mermark_artifact` (A/D). 사용자 대상 save-as 기본명이 아티팩트 필터에 걸리지 않는 것이 의도인지 확인 필요 |
| 17 | **설정 SSOT 우회: 하드코딩 기본 chord** | `main.ts:1524 ?? "Mod+Alt+F"` | `shortcuts/actions.ts:70` (이 파트 내부) |
| 18 | **플랫폼 판정** `isMac() ? "mac" : "other"` | `main.ts:556` | `chrome/title-bar.ts:196, 259`, `shortcuts/keys.ts:147` (B) |
| 19 | **재시작 전 버퍼 확정** | `update/auto-install.ts:34–47` (유일) | `settings/panel/version-pane.ts:312`, `chrome/status-bar/update.ts:104`(B), `document/session.ts commitBeforeSwitch` (A) |
| 20 | **localStorage 직접 접근(두 번째 영속 계층)** | `main.ts:161–162`, `qa/native-smoke-driver.ts:146` | `workspace/favorite-vault-migration.ts`, `workspace-state.ts`, `recent-vault-migration.ts` (B). 09-25 진단 §1.7 |
| 21 | **오류 메시지 추출** `err instanceof Error ? … : String(err)` | `main.ts:1092`, `remote-share-panel.ts:125`, `remote-share-port.ts:50, 64`, `remote-share-cli.ts:118`, `qa:253` | 전 파트 공통 유틸 후보 |
| 22 | **프리셋 이름 열거** | `settings/app.ts:27`, `theme-schema.ts:403`, `panel/color-inspector.ts:110`, `theme.ts:3, 45–51` | `styles.css :root[data-theme]` 블록, `markdown/mermaid-widget` 테마 매핑 (A) |
| 23 | **강조 잉크/배경 하드코딩** `#1a1300`/`#fff3a3` | `panel/theme-preview.ts:120` | `theme-schema.ts:226 HIGHLIGHT_INK`, `styles.css .cm-highlight` (A) |

**교차 단서: 23개**
