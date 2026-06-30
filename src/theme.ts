import { icon } from "./icons";

export type Theme = "dark" | "light" | "claude";

export function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Apply a theme to the DOM (CSS vars switch off [data-theme]). A SSOT sink.
 *  Kept as the safety-net layer: the data-theme CSS in styles.css supplies any
 *  var the JSON theme doesn't carry. The JSON sink (applyThemeVars) sets inline
 *  vars that WIN over these :root[data-theme] rules. */
export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
}

/** Fan a token map onto documentElement as inline CSS vars. A SSOT sink (the
 *  command behind themeVarsSink). Inline setProperty beats the :root[data-theme]
 *  rules, so this map is the effective theme source. Command/CQS: writes the
 *  DOM, returns nothing. The ~12-var loop is synchronous and cheap. */
export function applyThemeVars(map: Record<string, string>) {
  const style = document.documentElement.style;
  for (const [name, value] of Object.entries(map)) style.setProperty(name, value);
}

/** Apply the body text scale to the DOM via a CSS var. A SSOT sink, symmetric
 *  with applyTheme (command/CQS: writes the DOM, returns nothing). styles.css
 *  reads --font-scale on .cm-line; falls back to 1 when unset. */
export function applyFontScale(scale: number) {
  document.documentElement.style.setProperty("--font-scale", String(scale));
}

/** Status-bar theme toggle. `onToggle` is the writer (flips the setting);
 *  `render` is the label sink the caller binds to the setting. */
export function makeThemeToggle(onToggle: () => void): {
  btn: HTMLButtonElement;
  render: (t: Theme) => void;
} {
  const btn = document.createElement("button");
  btn.className = "status-btn theme-toggle icon-only";
  const render = (t: Theme) => {
    // Show the CURRENT theme's icon + the NEXT one in the title (the toggle now
    // cycles dark→light→claude→dark via nextPreset, so each label names where a
    // click lands). moon=dark, sun=light, palette=claude.
    btn.replaceChildren(icon(t === "dark" ? "moon" : t === "light" ? "sun" : "palette"));
    btn.title =
      t === "dark"
        ? "다크 모드 (클릭: 라이트)"
        : t === "light"
          ? "라이트 모드 (클릭: 클로드)"
          : "클로드 테마 (클릭: 다크)";
  };
  btn.addEventListener("click", onToggle);
  return { btn, render };
}
