// Save-status status-bar widget moved out of main.ts (2026-09-25, pure move).

import { el, setButtonContent } from "../dom";
import type { SaveStatus } from "../../editor";

/** A save-status indicator that lives inline in the status bar. Autosave runs
 *  invisibly (200ms typing-pause debounce) so there are no manual save/reload
 *  buttons — this is just a trust signal ("저장됨"/"저장 중"). On `conflict` the
 *  external-change modal owns the actual choice; here the label only reports the
 *  state ("외부 변경 감지 — 선택 필요"). */
export function makeSaveStatus(): {
  el: HTMLElement;
  set: (s: SaveStatus, detail?: string) => void;
} {
  const node = el("span", "save-status");
  const label = el("span", "save-label");
  node.append(label);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  return {
    el: node,
    set(s, detail) {
      clearTimeout(hideTimer);
      node.dataset.state = s;
      if (s === "error") {
        setButtonContent(label, "triangle-alert", `저장 실패: ${detail ?? "unknown error"}`);
      } else if (s === "conflict") {
        setButtonContent(label, "triangle-alert", "외부 변경 감지 — 선택 필요");
      } else if (s === "recovery") {
        setButtonContent(label, "triangle-alert", `복구 필요${detail ? `: ${detail}` : ""}`);
      } else if (s === "saving") {
        setButtonContent(label, "loader-circle", "저장 중");
      } else {
        setButtonContent(label, "check", "저장됨");
        hideTimer = setTimeout(() => label.replaceChildren(), 1500);
      }
    },
  };
}
