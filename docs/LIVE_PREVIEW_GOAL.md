# Goal: Obsidian-style Live Preview

목표 = "옵시디언급 selection-aware live preview".
완료 = 아래 체크리스트 전부 PASS. 검증 가능한 조건만 기재.

핵심 메커니즘:
> 커서(셀렉션)가 노드 범위에 **들어오면** → 위젯/숨김 해제, 원문 노출.
> **나가면** → 다시 렌더. 모든 decoration이 selection-aware여야 함.

권장 로드맵: **A → B → C → D검증 → E**.
A 끝나면 버그 1·4·5·6·7 구조적 소멸, B·C는 작은 증분.

---

## A. 토대 (선행 — 버그 소멸 게이트)
- [x] **A1 파스 동결 없음.** StateField가 `syntaxTree(start) !== syntaxTree(state)` 비교로 백그라운드 파스 진행 트랜잭션에 반응 → 큰 파일 뒷부분도 파스 완료 즉시 렌더. (버그1)
- [x] **A2 정규식 레이어 → 트리 기반.** wikilink/inline·block math/footnote는 커스텀 Lezer 확장(parser.ts), image/link/checkbox는 GFM 노드 사용. 원문 정규식 스캔 0. (버그4·5·6·7 근원)
- [x] **A3 코드블럭 면역.** 트리 기반이라 펜스/인라인코드 안은 구조적으로 노드 미생성. 테스트: parser.test + render-smoke "A3". (버그6)
- [x] **A4 공유 decorator.** decorate.ts: 인라인 전부 = ViewPlugin 1개(트리워크 1회), 블럭 전부 = StateField 1개(spec 캐시). (버그10)

## B. Selection-aware reveal (핵심)
- [x] **B1 진입 노출.** conceal 플래그 decoration이 셀렉션 라인에서 드랍 → 원문 노출. 블럭 위젯도 동일 (커서 들어오면 소스). 테스트: render-smoke "B1/B2", 표 reveal.
- [x] **B2 이탈 복귀.** 커서 이탈 → 재렌더. mermaid svg/katex html 캐시로 flicker 최소화.
- [x] **B3 라인 단위 일관.** reveal 단위 = 라인 (Obsidian 동일).
- [x] **B4 부분 겹침 무손상.** 트리 well-nested → 겹침 자체가 구조적으로 불가. (버그5)

## C. 편집 + 저장
- [x] **C1 readOnly off.** defaultKeymap + history 포함, 타이핑/undo 가능.
- [x] **C2 자동저장.** 500ms 디바운스 → Rust `write_file`. 실패 시 우하단 ⚠ 배너 (save-status).
- [x] **C3 docChanged 반응.** Lezer 증분 재파스 + 블럭 스캔은 Paragraph/Heading 하위 미진입(skip-descend) + 인라인은 viewport만.

## D. 회귀 (이전 리뷰 버그 닫힘 확인)
- [x] **D1** `[text](url)` → cm-link 마크 + data-href, 클릭 시 opener plugin으로 외부 브라우저. 테스트 有.
- [x] **D2** 테마 localStorage 영속.
- [x] **D3** `$5 and $10` 평문 (pandoc 규칙: opener 뒤 공백 금지, closer 앞 공백/뒤 숫자 금지). 테스트 有.
- [x] **D4** CodeInfo 노드로 infoLang 추출(인용구 무관) + blockquote depth만큼 `> ` strip. 인용구 표 테스트 有.
- [x] **D5** 25k자 한 줄 펜스 테스트 통과 (Decoration.set(sorted) + 라인 dedupe).
- [x] **D6** `[[note#sec]]` → note.md, `[[#sec]]` → 현재 파일, `![[img.png]]` → 이미지 임베드, open_path 실패 → 에러 표시. 테스트 有.

## E. 성능
- [x] **E1** 인라인 플러그인 visibleRanges만 트리워크. 블럭 StateField는 doc/tree 변화시에만 spec 재계산(셀렉션 변화는 캐시 재필터).
- [x] **E2** mermaid 렌더 SVG 캐시(50) + katex HTML 캐시(200) + widget eq() → 스크롤/reveal 사이클 재렌더 0.
- [x] **E3** mermaid(~1.3MB)/katex(~260KB) dynamic import — 빌드에서 별도 chunk 분리 확인.

**상태: 전 항목 완료 (2026-06-10). 테스트 35개 green, tsc/cargo/vite build green.**

---

## 버그 레퍼런스 (근원 = 정규식-원문 스캔 레이어가 구문 트리와 분리됨)

| # | 버그 | 위치 | 증상 |
|---|---|---|---|
| 1 | StateField 부분 파스 트리 동결 | mermaid/table/math-widget | 큰 파일 뒷부분 영영 미렌더 |
| 2 | 일반 링크 깨짐 | inline.ts | `[text](url)` → `texturl` 평문, `<a>` 없음 |
| 3 | 테마 토글 no-op | theme.ts | reload 후 OS 테마 복귀 |
| 4 | `$$` 정규식 폭주 | math-widget | 문단 사이 `$$` → 사이 전부 수식 흡수 |
| 5 | replace 부분 겹침 손상 | wikilink × math | 텍스트 소실+중복 (무에러) |
| 6 | 코드블럭 안 위젯 렌더 | image/wikilink/footnote/checkbox | 펜스 안 변조 |
| 7 | 인용구 속 펜스/표 깨짐 | mermaid/table-widget | `> ` 미제거 → 위젯 미생성/`>` 셀 |
| 8 | codeblock 크래시 | codeblock.ts | 한 줄 ≥20k → RangeSetBuilder throw → 영구 비활성 |
| 9 | 위키링크 구멍 | wikilink.ts | 앵커 미지원, 임베드 반쪽, open_path 실패 무시 |
| 10 | 구조/성능 클러스터 | 전반 | 스크롤 재스캔, 재렌더, 즉시 로드, 9중 복붙 |
