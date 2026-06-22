# mermark

Tauri 2 + CodeMirror 6 + TypeScript Markdown·Mermaid 에디터 (Obsidian식 라이브프리뷰, CLI로 단일 파일 열기).

## 하네스: mermark 개발

**목표:** 기능 추가·버그픽스·리팩토링을 설계→구현→검증→감사 파이프라인으로 일관되게 처리한다.

**트리거:** mermark 코드를 *실제로 수정하는* 개발 작업(기능 추가·버그픽스·리팩토링·위젯/커맨드/설정 변경)이면 `mermark-dev` 오케스트레이터 스킬을 사용하라. 코드를 바꾸지 않는 순수 질문·조회·설명은 직접 응답한다.

**구성:** 에이전트 5 (`feature-architect` → `frontend-engineer` ∥ `backend-engineer` → `qa-verifier` → `code-auditor`) + 스킬 6. 상세는 `.claude/agents/`, `.claude/skills/`, 오케스트레이터 `mermark-dev`가 관리. 실행 모드는 에이전트 팀(`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 필요, 미설정 시 서브에이전트 폴백).

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-06-22 | 초기 구성 | 전체 (에이전트 5 + 스킬 6) | mermark 개발 하네스 구축 |
