# 설정 패널 비주얼 리디자인 요청서 (→ 클로드디자인)

> **수신**: 디자이너(클로드디자인) · **발신**: mermark 개발 · **대상**: 설정 패널(`Settings`) 비주얼 리뉴얼.
> 동반 문서: 기능 계약 = `docs/SETTINGS_COMPONENT_SPEC.md`(불변), 비주얼 언어 = `DESIGN_CLAUDE.md`(루트).

---

## 1. 한 줄 목표

설정 패널의 **비주얼만** Anthropic/Claude 에디토리얼 품질(`DESIGN_CLAUDE.md`)로 끌어올린다. 현재 "너무 구린" 밋밋한 패널을, 기능은 한 줄도 안 바꾸고 **보는 즐거움이 있는 패널**로.

## 2. 왜 (문제 정의)

현 패널의 약점(코드 실측 — `styles.css:662-887`):
- **행 위계가 평평**: 모든 `.settings-row`가 동일 패딩·하단 보더만. 그룹 내 묶음·서브헤딩 없음.
- **segmented 과다**: 16항목 중 8개가 동일한 pill 버튼 그룹 → 시각적 단조로움.
- **네이티브 컨트롤 미가공**: `<select>`·`<slider>`가 OS 기본 모양 그대로(화살표·트랙 커스텀 0).
- **라벨 셀 124px 고정**: 긴 라벨이 좁게 잘림.
- **완성도 불균형**: 테마 스워치 에디터는 공들였는데(원형 picker·hover scale) 일반 행들은 밋밋 — 패널 안에서 디테일 편차가 큼.
- 위계는 타이틀(12px uppercase)만 에디토리얼, 나머지 라벨/컨트롤은 13~14px로 평평.

## 3. 비주얼 언어 (DESIGN_CLAUDE.md — 핵심만)

`DESIGN_CLAUDE.md` 전체가 정본. 설정 패널에 직결되는 요점:
- **크림 + 코랄 + 잉크 트리니티**. 크림 캔버스(#faf9f5)·웜 잉크(#141413)·코랄 액센트(#cc785c, **scarce** — primary 컨트롤·active state에만). 네 번째 surface 톤 금지.
- **헤어라인 우선, 그림자 희소**(`0 1px 3px rgba(20,20,19,0.08)` 정도만 드물게). 깊이는 surface 색대비로.
- **세리프 디스플레이 + 휴머니스트 산스 body**. 카테고리/섹션 제목에 세리프(Cormorant/EB Garamond/시스템세리프) 검토 — 단 설정 라벨 등 UI 텍스트는 산스.
- **라운드 위계**: 버튼/입력 8px(`rounded.md`), 카드 12px(`rounded.lg`), 배지 pill.
- **넉넉한 내부 패딩**(카드 32px / 24px). 단 이건 **데스크탑 설정 패널** — 마케팅 96px 섹션 리듬이 아니라 **컴팩트하게 적응**할 것(패널은 `min(720px,92vw)×min(560px,86vh)`).
- do/don't 준수: 쿨그레이/퓨어화이트 금지, 코랄 남발 금지, 세리프 bold 금지(weight 400), hover 과장 금지(press만 darken).

> **번역 주의**: `DESIGN_CLAUDE.md`는 1200px 마케팅 페이지용이다. 설정 패널은 작은 앱 크롬이므로 **토큰(색·라운드·타이포 위계·헤어라인 철학)은 가져오되 스케일(섹션 96px·display 64px)은 패널 크기에 맞게 축소**하라.

## 4. 작업 범위 (컴포넌트별)

`docs/SETTINGS_COMPONENT_SPEC.md`의 요소를 1:1로 재스타일. 컴포넌트별 리디자인:

1. **패널 셸**: 모달/백드롭/헤더/2-pane(사이드바+pane). 헤더 타이틀 위계, 백드롭 톤.
2. **사이드바 카테고리**: 5개 버튼 + active 상태(코랄 또는 surface-card active). 세로 리듬.
3. **행(row)**: 라벨↔컨트롤 정렬, **행 위계 도입**(그룹 서브헤딩·구분), 고정 124px 라벨 폭 문제 해소.
4. **컨트롤 6종 재가공**:
   - segmented(pill 그룹) — Claude category-tab 느낌으로.
   - select(드롭다운) — 네이티브 화살표 대체, `rounded.md`.
   - slider — 트랙/thumb 커스텀 + 라이브 값 readout 스타일.
   - text input — `text-input` + focus 시 코랄 3px 15%-alpha 링(DESIGN_CLAUDE.md `text-input-focused`).
   - json 테마 에디터 — 18 스워치 그리드 + JSON 아코디언(이미 비교적 공들임 — Claude 톤으로 정돈).
   - info — 정적 안내 카드.
5. **상태 표현**: active/press/focus/disabled. hover는 시스템이 인코딩한 것 이상 추가 금지(press darken만).

## 5. 제약 (반드시 지킬 것)

- **기능 불변**: `docs/SETTINGS_COMPONENT_SPEC.md §7 체크리스트`의 모든 계약 보존(lazy build·포커스트랩·ESC·라운드트립·등록순서·테마에디터 기능·kind별 의미). **DOM 구조를 바꾸려면** 그 계약을 깨지 않는 선에서만(클래스 추가는 자유, 컨트롤 동작 시맨틱은 불변).
- **테마 인식 필수**: 패널은 다크/라이트/**클로드** 3테마 모두에서 일관돼야 한다. 하드코딩 hex 금지 — `--bg`/`--fg`/`--surface`/`--border`/`--accent`/`--muted` 등 **테마 var를 통해** 색을 쓸 것(클로드 테마가 곧 출시 — 패널이 크림/코랄로 자동으로 맞아야 함). 즉 Claude 디자인 토큰을 **테마 var에 매핑**하는 방식.
- **줌 가드**: 패널은 에디터 측정 트리(`.cm-content`/`.cm-line`) 밖 — 이미 충족, 유지(패널에 font-size 자유).
- **의존성 0**: 새 CSS 프레임워크·폰트 번들 금지(콜드로드 비용). 시스템 폰트 스택 또는 기존 번들만.
- **범위**: `src/styles.css`의 `.settings-*`·`.theme-*` 블록(:662-887)이 주 작업면. DOM 구조는 `src/settings/panel/controls.ts`·`modal.ts`가 생성하므로, 클래스/마크업 변경이 필요하면 그 파일의 렌더러도 함께(단 §7 계약 보존).

## 6. 기대 산출물

- **비주얼 디자인 스펙** 또는 **직접 CSS 구현**(`.settings-*`/`.theme-*` 리뉴얼) — 발신자와 합의.
- 컴포넌트 6종 + 셸 + 사이드바 + 행 위계의 Claude 토큰 매핑.
- 다크/라이트/클로드 3테마에서의 일관성 확인(스크린샷 or 토큰 매핑 표).
- 기능 계약 무손상(`SETTINGS_COMPONENT_SPEC.md §7`) 자기 점검.

## 7. 참조 파일 (작업 시작점)

| 무엇 | 파일 |
|------|------|
| 비주얼 언어 정본 | `DESIGN_CLAUDE.md` |
| 기능 계약(불변) | `docs/SETTINGS_COMPONENT_SPEC.md` |
| 패널 셸 DOM | `src/settings/panel/modal.ts` |
| 컨트롤 DOM 렌더러 | `src/settings/panel/controls.ts` |
| 현재 스타일(주 작업면) | `src/styles.css:662-887` |
| 테마 var 토큰 | `src/styles.css:1-96`(`:root` / `[data-theme]`), `src/settings/theme-schema.ts`(JSON↔var 매핑) |
