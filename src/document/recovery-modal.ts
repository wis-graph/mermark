import {
  settleRecoveryAction,
  type RecoveryActionId,
  type RecoveryActionOutcome,
  type RecoveryState,
} from "./recovery-contract";

export type RecoveryActionHandler = (action: RecoveryActionId) => RecoveryActionOutcome | Promise<RecoveryActionOutcome>;

export interface RecoveryModalOptions {
  state: RecoveryState;
  onAction: RecoveryActionHandler;
  onCancel?: () => void;
}

export interface RecoveryModalHandle {
  close(): void;
}

function trapFocus(modal: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== "Tab") return;
  const focusable = modal.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])');
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function openRecoveryModal(options: RecoveryModalOptions): RecoveryModalHandle {
  let state = options.state;
  let confirmingDiscard = false;
  const previousFocus = document.activeElement;
  const backdrop = document.createElement("div");
  backdrop.className = "recovery-backdrop";
  const modal = document.createElement("div");
  modal.className = "recovery-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", state.title);
  const title = document.createElement("h2");
  title.className = "recovery-title";
  const body = document.createElement("p");
  body.className = "recovery-body";
  const detail = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "진단 정보";
  const detailText = document.createElement("code");
  detail.append(summary, detailText);
  const actions = document.createElement("div");
  actions.className = "recovery-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "recovery-cancel";
  cancel.textContent = "계속 편집";
  modal.append(title, body, detail, actions, cancel);
  backdrop.append(modal);
  document.body.append(backdrop);
  document.querySelector<HTMLElement>(".editor-host")?.setAttribute("inert", "");

  const handle: RecoveryModalHandle = {
    close() {
      document.removeEventListener("keydown", onKeydown, true);
      backdrop.remove();
      document.querySelector<HTMLElement>(".editor-host")?.removeAttribute("inert");
      (previousFocus as HTMLElement | null)?.focus?.();
    },
  };

  const render = (): void => {
    title.textContent = state.title;
    body.textContent = state.body;
    detailText.textContent = state.diagnostic.detail;
    actions.replaceChildren();
    for (const action of state.allowedActions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `recovery-action recovery-action-${action.id}`;
      button.textContent = confirmingDiscard && action.id === "close-discard" ? "정말 닫기/버리기" : action.label;
      button.addEventListener("click", () => {
        if (action.id === "close-discard" && !confirmingDiscard) {
          confirmingDiscard = true;
          render();
          button.focus();
          return;
        }
        void Promise.resolve(options.onAction(action.id)).then((outcome) => {
          const settlement = settleRecoveryAction(state, action.id, outcome);
          if (settlement.kind === "resolved") {
            handle.close();
            return;
          }
          state = settlement.state;
          confirmingDiscard = false;
          render();
          actions.querySelector<HTMLButtonElement>(`.recovery-action-${state.focusTarget}`)?.focus();
        }).catch(() => {
          state = { ...state, focusTarget: action.id };
          confirmingDiscard = false;
          render();
          actions.querySelector<HTMLButtonElement>(`.recovery-action-${state.focusTarget}`)?.focus();
        });
      });
      actions.append(button);
    }
  };
  cancel.addEventListener("click", () => {
    options.onCancel?.();
    handle.close();
  });
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      options.onCancel?.();
      handle.close();
      return;
    }
    trapFocus(modal, event);
  };
  document.addEventListener("keydown", onKeydown, true);
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) {
      options.onCancel?.();
      handle.close();
    }
  });
  render();
  const first = actions.querySelector<HTMLButtonElement>("button");
  first?.focus();
  return handle;
}
