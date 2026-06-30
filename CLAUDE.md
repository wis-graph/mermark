# mermark

Tauri 2 + CodeMirror 6 + TypeScript Markdown·Mermaid 에디터 (Obsidian식 라이브프리뷰, CLI로 단일 파일 열기).

## 하네스: mermark 개발

**목표:** 기능 추가·버그픽스·리팩토링을 설계→구현→검증→감사 파이프라인으로 일관되게 처리한다.

**트리거:** mermark 코드를 *실제로 수정하는* 개발 작업(기능 추가·버그픽스·리팩토링·위젯/커맨드/설정 변경)이면 `mermark-dev` 오케스트레이터 스킬을 사용하라. 코드를 바꾸지 않는 순수 질문·조회·설명은 직접 응답한다.

**구성:** 에이전트 5 (`feature-architect` → `frontend-engineer` ∥ `backend-engineer` → `qa-verifier` → `code-auditor`) + 스킬 6. 상세는 `.claude/agents/`, `.claude/skills/`, 오케스트레이터 `mermark-dev`가 관리. 실행 모드는 에이전트 팀(`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 필요, 미설정 시 서브에이전트 폴백).

**기능 계층 문서:** `docs/FEATURES.md`는 mermark 전체 기능을 아키텍처 계층(L1 백엔드 ~ L5 UI 크롬)으로 구조화한 단일 참조다. **사용자 관측 기능을 추가/변경/제거할 때마다 같은 커밋 묶음에서 갱신한다**(mermark-dev Phase 6 규약). 순수 내부 리팩토링·버그픽스로 기능 표면이 안 바뀌면 생략.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-06-22 | 초기 구성 | 전체 (에이전트 5 + 스킬 6) | mermark 개발 하네스 구축 |
| 2026-07-01 | 기능 계층 문서 + 갱신 규약 | `docs/FEATURES.md`, mermark-dev Phase 6 | 기능 추가 시 계층 문서 자동 갱신 |
