import {
  readingWidthSetting,
  READING_WIDTH_MIN_CH,
  READING_WIDTH_MAX_CH,
} from "./settings/app";

/** Footer reading-width slider — a compact live control over `readingWidthSetting`
 *  (the SAME SSOT as Settings › 타이포그래피 › 본문 너비; both drive `--measure`,
 *  so dragging here and the settings panel stay coherent — a change from either
 *  re-reflects the other via the shared subscribe). Bounds come from the same
 *  clamp consts the settings control uses, so the range never drifts from the
 *  valid-measure rule. Drag = live set (input event); the bind reflects any
 *  writer back onto the thumb.
 *
 *  Not in the editor measure tree (footer chrome) → zoom-guard holds. */
export function makeWidthSlider(): { el: HTMLElement } {
  const wrap = document.createElement("label");
  wrap.className = "status-width";
  wrap.title = "본문 너비";

  const input = document.createElement("input");
  input.type = "range";
  input.className = "status-width-slider";
  input.min = String(READING_WIDTH_MIN_CH);
  input.max = String(READING_WIDTH_MAX_CH);
  input.step = "1";
  input.setAttribute("aria-label", "본문 너비");
  wrap.append(input);

  // setting → thumb (apply now + on every change, from any writer)
  readingWidthSetting.bind((ch) => {
    input.value = String(ch);
  });
  // thumb → setting (live while dragging)
  input.addEventListener("input", () => {
    readingWidthSetting.set(Number(input.value));
  });

  return { el: wrap };
}
