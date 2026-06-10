import mermaid from "mermaid";

export type Theme = "dark" | "light";

export function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: t === "light" ? "default" : "dark" });
}

/** Mount a toggle button; returns nothing. */
export function mountThemeToggle(initial: Theme) {
  const btn = document.createElement("button");
  btn.className = "theme-toggle";
  let cur = initial;
  const label = () => (btn.textContent = cur === "dark" ? "☾" : "☀");
  label();
  btn.addEventListener("click", () => {
    cur = cur === "dark" ? "light" : "dark";
    applyTheme(cur);
    label();
    // re-render is required for mermaid theme change; simplest is reload
    location.reload();
  });
  document.body.appendChild(btn);
}
