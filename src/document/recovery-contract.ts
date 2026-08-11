export const RECOVERY_KINDS = [
  "open-read",
  "workspace-list",
  "external-change",
  "deleted",
  "unreadable",
  "save",
] as const;

export type RecoveryKind = (typeof RECOVERY_KINDS)[number];

export const RECOVERY_ACTION_IDS = [
  "retry",
  "open-another",
  "reselect-root",
  "keep-buffer",
  "reload-from-disk",
  "merge",
  "save-recovered-copy",
  "save-as",
  "close-discard",
] as const;

export type RecoveryActionId = (typeof RECOVERY_ACTION_IDS)[number];

export type RecoveryPreservation = "keep-buffer-and-tab" | "keep-workspace-and-selection";

export type RecoveryDiagnostic = {
  readonly policy: "collapsed";
  readonly detail: string;
};

export type RecoveryAction = {
  readonly id: RecoveryActionId;
  readonly label: string;
  readonly requiresConfirmation: boolean;
};

export type RecoveryState = {
  readonly kind: RecoveryKind;
  readonly title: string;
  readonly body: string;
  readonly diagnostic: RecoveryDiagnostic;
  readonly focusTarget: RecoveryActionId;
  readonly preservation: RecoveryPreservation;
  readonly allowedActions: readonly RecoveryAction[];
};

export type RecoveryActionOutcome = "succeeded" | "cancelled" | "failed";

export type RecoverySettlement =
  | { readonly kind: "resolved"; readonly action: RecoveryActionId }
  | {
      readonly kind: "preserved";
      readonly reason: RecoveryActionOutcome | "rejected";
      readonly state: RecoveryState;
    };

type RecoveryDefinition = Omit<RecoveryState, "diagnostic" | "focusTarget">;

const ACTIONS = {
  retry: { id: "retry", label: "다시 시도", requiresConfirmation: false },
  "open-another": { id: "open-another", label: "다른 파일 열기", requiresConfirmation: false },
  "reselect-root": { id: "reselect-root", label: "루트 다시 선택", requiresConfirmation: false },
  "keep-buffer": { id: "keep-buffer", label: "현재 내용 유지", requiresConfirmation: false },
  "reload-from-disk": { id: "reload-from-disk", label: "디스크에서 다시 읽기", requiresConfirmation: false },
  merge: { id: "merge", label: "병합", requiresConfirmation: false },
  "save-recovered-copy": { id: "save-recovered-copy", label: "복구 사본 저장", requiresConfirmation: false },
  "save-as": { id: "save-as", label: "다른 이름으로 저장", requiresConfirmation: false },
  "close-discard": { id: "close-discard", label: "닫기/버리기", requiresConfirmation: true },
} as const satisfies Readonly<Record<RecoveryActionId, RecoveryAction>>;

const DEFINITIONS = {
  "open-read": {
    kind: "open-read",
    title: "파일을 열 수 없습니다",
    body: "파일을 읽지 못했습니다. 다시 시도하거나 다른 파일을 여세요.",
    preservation: "keep-buffer-and-tab",
    allowedActions: [ACTIONS.retry, ACTIONS["open-another"]],
  },
  "workspace-list": {
    kind: "workspace-list",
    title: "작업공간을 불러올 수 없습니다",
    body: "폴더 목록을 읽지 못했습니다. 다시 시도하거나 루트를 다시 선택하세요.",
    preservation: "keep-workspace-and-selection",
    allowedActions: [ACTIONS.retry, ACTIONS["reselect-root"]],
  },
  "external-change": {
    kind: "external-change",
    title: "외부 변경이 감지되었습니다",
    body: "디스크의 변경과 현재 버퍼 중 유지할 내용을 선택하세요.",
    preservation: "keep-buffer-and-tab",
    allowedActions: [ACTIONS["keep-buffer"], ACTIONS["reload-from-disk"], ACTIONS.merge],
  },
  deleted: {
    kind: "deleted",
    title: "파일이 삭제되었습니다",
    body: "현재 편집 내용은 유지됩니다. 복구 사본을 저장하거나 닫기/버리기를 선택하세요.",
    preservation: "keep-buffer-and-tab",
    allowedActions: [ACTIONS.retry, ACTIONS["save-recovered-copy"], ACTIONS["save-as"], ACTIONS["close-discard"]],
  },
  unreadable: {
    kind: "unreadable",
    title: "파일을 읽을 수 없습니다",
    body: "현재 편집 내용은 유지됩니다. 다시 시도하거나 안전한 위치에 저장하세요.",
    preservation: "keep-buffer-and-tab",
    allowedActions: [ACTIONS.retry, ACTIONS["save-recovered-copy"], ACTIONS["save-as"], ACTIONS["close-discard"]],
  },
  save: {
    kind: "save",
    title: "저장하지 못했습니다",
    body: "현재 편집 내용은 유지됩니다. 다시 시도하거나 다른 위치에 저장하세요.",
    preservation: "keep-buffer-and-tab",
    allowedActions: [ACTIONS.retry, ACTIONS["save-recovered-copy"], ACTIONS["save-as"], ACTIONS["close-discard"]],
  },
} as const satisfies Readonly<Record<RecoveryKind, RecoveryDefinition>>;

export function createRecoveryState(kind: RecoveryKind, detail: string): RecoveryState {
  const definition = DEFINITIONS[kind];
  const firstAction = definition.allowedActions[0];
  if (!firstAction) throw new Error(`Recovery state has no focusable action: ${kind}`);

  return {
    ...definition,
    diagnostic: { policy: "collapsed", detail },
    focusTarget: firstAction.id,
  };
}

function isRecoveryOutcome(value: unknown): value is RecoveryActionOutcome {
  return value === "succeeded" || value === "cancelled" || value === "failed";
}

export function settleRecoveryAction(state: RecoveryState, action: unknown, outcome: unknown): RecoverySettlement {
  const allowedAction = state.allowedActions.find((candidate) => candidate.id === action);
  if (!allowedAction || !isRecoveryOutcome(outcome)) {
    return { kind: "preserved", reason: "rejected", state };
  }

  if (outcome === "succeeded") return { kind: "resolved", action: allowedAction.id };

  return {
    kind: "preserved",
    reason: outcome,
    state: { ...state, focusTarget: allowedAction.id },
  };
}
