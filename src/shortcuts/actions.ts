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
  /** The PRIMARY chord shipped by default (formatChord form), or null for an
   *  action that is listed but unbound until the user assigns a chord. This is
   *  the one slot a user override (keybindingsSetting) replaces — reassigning
   *  a chord in settings always retargets the primary, never a secondary. */
  defaultBinding: string | null;
  /** Additional default-only chords that also fire this action (e.g. a
   *  numbered panel shortcut riding alongside a chord users already have
   *  muscle memory for). Read-only: never stored in keybindingsSetting, never
   *  reassignable via the settings capture control — only shown there as a
   *  muted alias next to the (editable) primary. Omitted/empty === none. */
  secondaryBindings?: readonly string[];
}

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: "mode.toggle", label: "편집/리더 모드 전환", defaultBinding: "Mod+E" },
  // Mod+1..Mod+5 mirror the LEFT sidebar panel registration order in main.ts
  // (workspace, explorer, recent, outline, search — see registerSidebarPanel
  // call sequence there). Fixed to the action id, NOT computed from that
  // registration order at runtime: if a 6th panel is inserted between two
  // existing ones, panel index would shift and silently retarget a chord the
  // user already has muscle memory for. Pinning the number to the id means a
  // newly inserted panel just gets the next free number instead.
  { id: "workspace.toggle", label: "워크스페이스", defaultBinding: "Mod+1" },
  // Primary stays Mod+B (not Mod+2): a settings-UI reassignment always targets
  // the primary, and Mod+B is the chord users already have saved overrides
  // and muscle memory for — putting the number on the primary would silently
  // invalidate both. Mod+2 rides along as a read-only secondary instead.
  { id: "explorer.toggle", label: "탐색기 토글", defaultBinding: "Mod+B", secondaryBindings: ["Mod+2"] },
  { id: "recent.toggle", label: "최근 문서", defaultBinding: "Mod+3" },
  { id: "outline.toggle", label: "목차", defaultBinding: "Mod+4" },
  { id: "history.back", label: "이전 문서", defaultBinding: "Mod+[" },
  { id: "history.forward", label: "다음 문서", defaultBinding: "Mod+]" },
  { id: "openPath.toggle", label: "경로 열기", defaultBinding: null },
  { id: "zoom.in", label: "본문 확대", defaultBinding: "Mod+=" },
  { id: "zoom.out", label: "본문 축소", defaultBinding: "Mod+-" },
  { id: "zoom.reset", label: "본문 배율 초기화", defaultBinding: "Mod+0" },
  { id: "bundle.copy", label: "LLM 번들 복사", defaultBinding: "Mod+Shift+C" },
  // Mod+Alt+C is the CANONICAL serialized form (keys.ts formatChord fixes the
  // order Mod, Alt, Shift, key) for ⌥⌘C — do not write "Alt+Mod+C" or any
  // other ordering here, or eventToChord's lookup will never match it.
  { id: "path.copy", label: "문서 경로 복사", defaultBinding: "Mod+Alt+C" },
  { id: "vim.toggle", label: "Vim 모드 토글", defaultBinding: null },
  { id: "save.flush", label: "저장 (강제 플러시)", defaultBinding: null },
  { id: "search.document", label: "문서 내 찾기/바꾸기", defaultBinding: "Mod+F" },
  // Reader mode hides @codemirror/search's replace row (package branches on
  // state.readOnly), and mermark's default mode IS reader — so without a
  // dedicated action, replace was unreachable from boot (v0.9.12 real-app
  // bug). This action switches to edit mode first, then opens the panel —
  // see main.ts's openReplacePanel.
  { id: "search.replace", label: "찾아 바꾸기 (편집 모드로 전환)", defaultBinding: "Mod+Alt+F" },
  // Same primary-stays-put reasoning as explorer.toggle above: Mod+Shift+F
  // remains the reassignable primary, Mod+5 rides along as a secondary.
  { id: "search.files", label: "파일 찾기", defaultBinding: "Mod+Shift+F", secondaryBindings: ["Mod+5"] },
  // Permanent-vault image import (single-window-opening Wave 2, Todo 5) —
  // unbound by default (listed but no chord ships), same as recent/outline/
  // openPath/vim above; a user opts in through the settings panel.
  { id: "image.attach", label: "이미지 첨부", defaultBinding: null },
];
