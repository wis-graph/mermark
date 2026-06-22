export type Theme = "dark" | "light";

export function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Apply a theme to the DOM (CSS vars switch off [data-theme]). A SSOT sink. */
export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
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
  btn.className = "status-btn theme-toggle";
  const render = (t: Theme) => {
    btn.textContent = t === "dark" ? "☾" : "☀";
    btn.title = t === "dark" ? "다크 모드 (클릭: 라이트)" : "라이트 모드 (클릭: 다크)";
  };
  btn.addEventListener("click", onToggle);
  return { btn, render };
}
