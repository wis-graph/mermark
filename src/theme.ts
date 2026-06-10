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

/** Mount a toggle button; persists the choice across reloads. */
export function mountThemeToggle(initial: Theme) {
  const btn = document.createElement("button");
  btn.className = "theme-toggle";
  let cur = initial;
  const label = () => (btn.textContent = cur === "dark" ? "☾" : "☀");
  label();
  btn.addEventListener("click", () => {
    cur = cur === "dark" ? "light" : "dark";
    localStorage.setItem(STORAGE_KEY, cur);
    applyTheme(cur);
    label();
    // mermaid bakes its theme into rendered SVGs; reload re-renders everything
    location.reload();
  });
  document.body.appendChild(btn);
}
