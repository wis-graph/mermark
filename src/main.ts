import { invoke } from "@tauri-apps/api/core";
import { mountEditor, type SaveStatus } from "./editor";
import { initialTheme, applyTheme, mountThemeToggle } from "./theme";
import "katex/dist/katex.min.css";
import "./styles.css";

function mountSaveStatus(): (s: SaveStatus, detail?: string) => void {
  const el = document.createElement("div");
  el.className = "save-status";
  document.body.appendChild(el);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  return (s, detail) => {
    clearTimeout(hideTimer);
    el.dataset.state = s;
    if (s === "error") {
      el.textContent = `⚠ save failed: ${detail ?? "unknown error"}`;
    } else if (s === "saving") {
      el.textContent = "●";
    } else {
      el.textContent = "✓ saved";
      hideTimer = setTimeout(() => (el.textContent = ""), 1500);
    }
  };
}

async function boot() {
  const theme = initialTheme();
  applyTheme(theme);
  mountThemeToggle(theme);
  const root = document.querySelector<HTMLDivElement>("#app")!;
  const file = new URLSearchParams(location.search).get("file");
  if (!file) {
    root.textContent = "No file specified.";
    return;
  }
  try {
    const text = await invoke<string>("read_file", { path: file });
    root.innerHTML = "";
    const baseDir = file.slice(0, Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")));
    mountEditor(root, text, baseDir, file, mountSaveStatus());
  } catch (e) {
    root.textContent = `Failed to open: ${String(e)}`;
  }
}

boot();
