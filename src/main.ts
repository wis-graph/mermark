import { invoke } from "@tauri-apps/api/core";
import { dirOf } from "./path";
import { mountEditor, type PreviewMode, type SaveStatus } from "./editor";
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

const MODE_KEY = "mermark.mode";

function savedMode(): PreviewMode {
  return localStorage.getItem(MODE_KEY) === "edit" ? "edit" : "read";
}

function mountModeToggle(): { btn: HTMLButtonElement; render: (m: PreviewMode) => void } {
  const btn = document.createElement("button");
  btn.className = "mode-toggle";
  const render = (m: PreviewMode) => {
    btn.textContent = m === "edit" ? "✎" : "👁";
    btn.title = m === "edit" ? "편집 모드 (⌘E: 리더 모드로)" : "리더 모드 (⌘E: 편집 모드로)";
  };
  document.body.appendChild(btn);
  return { btn, render };
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
    const baseDir = dirOf(file);
    const { btn, render } = mountModeToggle();
    const initialMode = savedMode();
    render(initialMode);
    const editor = mountEditor(root, text, baseDir, file, {
      onStatus: mountSaveStatus(),
      initialMode,
      onMode: (m) => {
        localStorage.setItem(MODE_KEY, m);
        render(m);
      },
    });
    // dev-only: expose the controller so the debug harness can read real editor
    // state (selection offsets, block specs) instead of guessing from the DOM.
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV)
      (window as unknown as { __mermark?: unknown }).__mermark = editor;
    btn.addEventListener("click", () => editor.toggleMode());
    // global fallback so ⌘E works even when the editor isn't focused
    window.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e") {
        e.preventDefault();
        editor.toggleMode();
      }
    });
  } catch (e) {
    root.textContent = `Failed to open: ${String(e)}`;
  }
}

boot();
