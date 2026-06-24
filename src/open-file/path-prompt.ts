import { icon } from "../icons";

/** Open-by-path footer chrome: a status-bar button that toggles a lazily-built
 *  inline input row (text field + error slot). Enter submits the typed path,
 *  Esc cancels. This module is the INPUT SURFACE only — it returns the raw
 *  string the user typed and reports failures back into the row; the actual
 *  document switch (resolve → read_file → re-mount) is the caller's job
 *  (CQS: this is a query surface, opening is a command elsewhere).
 *
 *  Lazy by design (cold-load): the input row DOM is built on first button
 *  click, not at boot. */

export interface OpenPathPrompt {
  /** The button to append into the status bar. */
  readonly button: HTMLButtonElement;
  /** The inline input row (hidden until the button is first clicked). Append
   *  this where it should appear (above/within the status bar). */
  readonly row: HTMLElement;
}

export interface OpenPathHandlers {
  /** Invoked with the raw typed path on Enter. Resolve/read/re-mount happens
   *  here. Throw (or reject) to signal "couldn't open" — the prompt catches it
   *  and shows the message in the row WITHOUT closing it, so the user can fix
   *  the path. Resolve normally on success; the prompt then closes the row. */
  onOpen(raw: string): Promise<void>;
}

const create = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

export function createOpenPathPrompt({ onOpen }: OpenPathHandlers): OpenPathPrompt {
  const button = create("button", "status-btn open-path") as HTMLButtonElement;
  button.append(icon("folder-open"));
  const label = create("span", "status-btn-label");
  label.textContent = "경로 열기";
  button.append(label);
  button.title = "경로를 입력해 다른 문서를 이 창에서 엽니다";

  const row = create("div", "open-path-row");
  row.hidden = true;
  const input = create("input", "open-path-input") as HTMLInputElement;
  input.type = "text";
  input.placeholder = "경로 입력 (절대 / ~/ / 상대) — Enter 열기, Esc 취소";
  input.spellcheck = false;
  const error = create("span", "open-path-error");
  error.hidden = true;
  row.append(input, error);

  const clearError = () => {
    error.hidden = true;
    error.textContent = "";
  };
  const showError = (msg: string) => {
    error.textContent = msg;
    error.hidden = false;
  };
  const close = () => {
    row.hidden = true;
    clearError();
    input.value = "";
  };
  const open = () => {
    row.hidden = false;
    clearError();
    input.focus();
    input.select();
  };

  // Toggle the row on each button click; opening focuses the field.
  button.addEventListener("click", () => {
    if (row.hidden) open();
    else close();
  });

  // Esc cancels (row closes, editor untouched). Enter submits the typed path.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const raw = input.value;
      clearError();
      // The switch is async (read_file). On failure keep the row open with the
      // message so the user can correct the path; on success close the row.
      void onOpen(raw)
        .then(() => close())
        .catch((err: unknown) => showError(`열 수 없음: ${String(err)}`));
    }
  });
  input.addEventListener("input", clearError);

  return { button, row };
}
