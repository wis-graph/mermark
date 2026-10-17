import { MENU_SEPARATOR, type ContextMenuEntry } from "../../chrome/context-menu";
import { runFileAction, type FileAction } from "../../chrome/file-actions/registry";

export interface FileRowMenuInput {
  absPath: string;
  /** Registry-provided "○○로 열기" actions for this file's extension. */
  openWithActions: readonly FileAction[];
  /** When set, every item is disabled with this reason (remote vault rows). */
  disabledReason?: string;
  handlers: {
    onOpenInNativeApp?(absPath: string): void;
    onOpenInNewWindow?(absPath: string): void;
    onRevealInFinder?(absPath: string): void;
    onCopyPath?(absPath: string): void;
  };
}

/** The file-row context menu: [registry actions, 기본 앱에서 열기, separator,
 *  새 창에서 열기, Finder에서 보기, 경로 복사]. "기본 앱에서 열기" is fixed
 *  (not a registry entry) so it always anchors the group. Pure query. */
export function fileRowMenuEntries({ absPath, openWithActions, disabledReason, handlers }: FileRowMenuInput): ContextMenuEntry[] {
  const disabled = disabledReason !== undefined;
  const item = (label: string, onSelect: () => void): ContextMenuEntry => ({ label, disabled, disabledReason, onSelect });
  return [
    ...openWithActions.map((a) => item(a.label, () => runFileAction(a, absPath))),
    item("기본 앱에서 열기", () => handlers.onOpenInNativeApp?.(absPath)),
    MENU_SEPARATOR,
    item("새 창에서 열기", () => handlers.onOpenInNewWindow?.(absPath)),
    item("Finder에서 보기", () => handlers.onRevealInFinder?.(absPath)),
    item("경로 복사", () => handlers.onCopyPath?.(absPath)),
  ];
}
