export type Theme = "dark" | "light";

const STORAGE_KEY = "mermark.theme";

export function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Saved preference wins; falls back to the OS theme. */
export function initialTheme(): Theme {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === "light" || saved === "dark" ? saved : systemTheme();
}

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
}

/** Build a theme toggle button; persists the choice across reloads. Returns the
 *  element so the caller can place it (e.g. in the status bar). */
export function makeThemeToggle(initial: Theme): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "status-btn theme-toggle";
  let cur = initial;
  const label = () => {
    btn.textContent = cur === "dark" ? "☾" : "☀";
    btn.title = cur === "dark" ? "다크 모드 (클릭: 라이트)" : "라이트 모드 (클릭: 다크)";
  };
  label();
  btn.addEventListener("click", () => {
    cur = cur === "dark" ? "light" : "dark";
    localStorage.setItem(STORAGE_KEY, cur);
    applyTheme(cur);
    label();
    // mermaid bakes its theme into rendered SVGs; reload re-renders everything
    location.reload();
  });
  return btn;
}
