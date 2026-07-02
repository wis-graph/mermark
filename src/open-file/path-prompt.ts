import { icon } from "../icons";

/** Open-by-path status-bar chrome, "footer-becomes-input" style: a status-bar
 *  button that, when clicked, turns the STATUS BAR ITSELF into a full-width path
 *  input — no separate row opens below, so the bar keeps its height and the
 *  layout never shifts. Toggling adds `.path-editing` to the bar; CSS hides the
 *  other chrome and shows the input + inline error. Enter submits, Esc / blur
 *  cancels (restoring the normal bar).
 *
 *  This module is the INPUT SURFACE only — it returns the raw string the user
 *  typed and reports failures inline; the actual document switch (resolve →
 *  read_file → re-mount) is the caller's onOpen (CQS: this is a query surface,
 *  opening is a command elsewhere).
 *
 *  Lazy by design (cold-load): the input + error nodes are created here but stay
 *  display:none via CSS until `.path-editing` is toggled on. */

export interface OpenPathPrompt {
  /** The button to place in the status bar (toggles path-editing). */
  readonly button: HTMLButtonElement;
  /** The path input (a direct child of the bar, hidden until editing). Exposed
   *  for tests / focus wiring. */
  readonly input: HTMLInputElement;
}

export interface OpenPathHandlers {
  /** The status bar the prompt turns into an input. The button is returned for
   *  the caller to position; the input + error are appended into `bar` here so
   *  the `.path-editing` toggle can hide the siblings and show them. */
  bar: HTMLElement;
  /** Invoked with the raw typed path on Enter. Resolve/read/re-mount happens
   *  here. Throw (or reject) to signal "couldn't open" — the prompt catches it
   *  and shows the message inline WITHOUT leaving editing, so the user can fix
   *  the path. Resolve on success; the prompt then restores the normal bar. */
  onOpen(raw: string): Promise<void>;
}

const create = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

export function createOpenPathPrompt({ bar, onOpen }: OpenPathHandlers): OpenPathPrompt {
  const button = create("button", "status-btn open-path") as HTMLButtonElement;
  button.append(icon("folder-open"));
  const buttonLabel = create("span", "status-btn-label");
  buttonLabel.textContent = "경로 열기";
  button.append(buttonLabel);
  button.title = "경로를 입력해 다른 문서를 이 창에서 엽니다";

  const input = create("input", "open-path-input") as HTMLInputElement;
  input.type = "text";
  input.placeholder = "경로 입력 (절대 / ~/ / 상대) — Enter 열기, Esc 취소";
  input.spellcheck = false;
  const error = create("span", "open-path-error");
  error.hidden = true;
  // The input + error live in the bar; `.path-editing` (CSS) reveals them and
  // hides the other chrome. They stay display:none otherwise (bar height held).
  bar.append(input, error);

  // While a submit is in flight, blur must NOT deactivate (the async onOpen still
  // owns the outcome — success closes, failure keeps editing with the error).
  let submitting = false;

  const clearError = () => {
    error.hidden = true;
    error.textContent = "";
  };
  const showError = (msg: string) => {
    error.textContent = msg;
    error.hidden = false;
  };
  const activate = () => {
    bar.classList.add("path-editing");
    clearError();
    input.focus();
    input.select();
  };
  const deactivate = () => {
    bar.classList.remove("path-editing");
    clearError();
    input.value = "";
  };

  // Toggle path-editing on each button click; entering focuses the field.
  button.addEventListener("click", () => {
    if (bar.classList.contains("path-editing")) deactivate();
    else activate();
  });

  // Esc cancels (restore the bar, editor untouched). Enter submits the path.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      deactivate();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const raw = input.value;
      clearError();
      submitting = true;
      // The switch is async (read_file). On failure keep editing with the message
      // so the user can correct the path; on success restore the bar.
      void onOpen(raw)
        .then(() => {
          submitting = false;
          deactivate();
        })
        .catch((err: unknown) => {
          submitting = false;
          showError(`열 수 없음: ${String(err)}`);
        });
    }
  });
  input.addEventListener("input", clearError);
  // Clicking away cancels — but not while a submit is resolving (that path owns
  // the outcome). Guard against the Enter→blur race.
  input.addEventListener("blur", () => {
    if (submitting) return;
    if (bar.classList.contains("path-editing")) deactivate();
  });

  return { button, input };
}
