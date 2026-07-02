// The rebindable-action catalog — pure data, no handlers. Each entry is one
// user-facing command the shortcut system can trigger: its stable `id` (the key
// overrides are stored under), its display `label` (shown in the settings UI),
// and its `defaultBinding` (the canonical chord it ships with, or null for
// "listed but unbound by default").
//
// WHY handlers live elsewhere: a handler closes over boot state (the live
// editor, the explorer/outline/recent panels, the zoom commands), so keeping
// the catalog pure data lets it be imported and iterated in jsdom tests and by
// the settings UI without dragging main's boot graph in. The registry binds
// id → handler at boot (registerHandler), mirroring the settings store's
// declare-here / subscribe-there sink pattern.
//
// Insertion order === settings-UI row order.

export interface ShortcutAction {
  /** Stable id; the key user overrides are stored under (never rename). */
  id: string;
  /** Human label shown in the settings 단축키 category. */
  label: string;
  /** Canonical chord shipped by default (formatChord form), or null for an
   *  action that is listed but unbound until the user assigns a chord. */
  defaultBinding: string | null;
}

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: "mode.toggle", label: "편집/리더 모드 전환", defaultBinding: "Mod+E" },
  { id: "explorer.toggle", label: "탐색기 토글", defaultBinding: "Mod+B" },
  { id: "recent.toggle", label: "최근 문서", defaultBinding: null },
  { id: "outline.toggle", label: "목차", defaultBinding: null },
  { id: "history.back", label: "이전 문서", defaultBinding: "Mod+[" },
  { id: "history.forward", label: "다음 문서", defaultBinding: "Mod+]" },
  { id: "openPath.toggle", label: "경로 열기", defaultBinding: null },
  { id: "zoom.in", label: "본문 확대", defaultBinding: "Mod+=" },
  { id: "zoom.out", label: "본문 축소", defaultBinding: "Mod+-" },
  { id: "zoom.reset", label: "본문 배율 초기화", defaultBinding: "Mod+0" },
  { id: "bundle.copy", label: "LLM 번들 복사", defaultBinding: "Mod+Shift+C" },
  { id: "vim.toggle", label: "Vim 모드 토글", defaultBinding: null },
  { id: "save.flush", label: "저장 (강제 플러시)", defaultBinding: null },
];
