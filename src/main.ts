import { invoke } from "@tauri-apps/api/core";
import { dirOf } from "./path";
import { mountEditor, type PreviewMode, type SaveStatus } from "./editor";
import { initialTheme, applyTheme, makeThemeToggle } from "./theme";
import { refreshMermaidTheme } from "./markdown/mermaid-widget";
import "katex/dist/katex.min.css";
import "./styles.css";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

/** A save-status indicator that lives inline in the status bar. */
function makeSaveStatus(): { el: HTMLElement; set: (s: SaveStatus, detail?: string) => void } {
  const node = el("span", "save-status");
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  return {
    el: node,
    set(s, detail) {
      clearTimeout(hideTimer);
      node.dataset.state = s;
      if (s === "error") {
        node.textContent = `⚠ 저장 실패: ${detail ?? "unknown error"}`;
      } else if (s === "saving") {
        node.textContent = "● 저장 중";
      } else {
        node.textContent = "✓ 저장됨";
        hideTimer = setTimeout(() => (node.textContent = ""), 1500);
      }
    },
  };
}

const MODE_KEY = "mermark.mode";

function savedMode(): PreviewMode {
  return localStorage.getItem(MODE_KEY) === "edit" ? "edit" : "read";
}

/** Edit/read toggle that lives in the status bar (icon + label). */
function makeModeToggle(): { btn: HTMLButtonElement; render: (m: PreviewMode) => void } {
  const btn = el("button", "status-btn mode-toggle");
  const render = (m: PreviewMode) => {
    btn.textContent = m === "edit" ? "✎ 편집" : "👁 리더";
    btn.title = m === "edit" ? "편집 모드 (⌘E: 리더 모드로)" : "리더 모드 (⌘E: 편집 모드로)";
  };
  return { btn, render };
}

async function boot() {
  const theme = initialTheme();
  applyTheme(theme);
  const root = document.querySelector<HTMLDivElement>("#app")!;
  const file = new URLSearchParams(location.search).get("file");
  if (!file) {
    root.textContent = "No file specified.";
    return;
  }
  try {
    const text = await invoke<string>("read_file", { path: file });
    root.innerHTML = "";

    // #app is a flex column: the editor scrolls inside `host`, with a fixed
    // status bar pinned below it that holds all the chrome (toggles, save state,
    // cursor position) — no more controls floating over the content.
    const host = el("div", "editor-host");
    const bar = el("div", "status-bar");
    root.append(host, bar);

    const baseDir = dirOf(file);
    const initialMode = savedMode();

    const mode = makeModeToggle();
    mode.render(initialMode);
    const pos = el("span", "status-pos");
    const spacer = el("span", "status-spacer");
    const save = makeSaveStatus();
    // live theme switch: flip CSS vars + re-render mermaid (theme is baked into
    // its SVGs), no page reload — so the layout never flashes/re-mounts.
    const themeBtn = makeThemeToggle(theme, () => {
      refreshMermaidTheme();
      editor.refresh();
    });
    bar.append(mode.btn, pos, spacer, save.el, themeBtn);

    const editor = mountEditor(host, text, baseDir, file, {
      onStatus: save.set,
      initialMode,
      onMode: (m) => {
        localStorage.setItem(MODE_KEY, m);
        mode.render(m);
      },
      onCursor: (line, col) => (pos.textContent = `Ln ${line}, Col ${col}`),
    });
    // dev-only: expose the controller so the debug harness can read real editor
    // state (selection offsets, block specs) instead of guessing from the DOM.
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV)
      (window as unknown as { __mermark?: unknown }).__mermark = editor;
    mode.btn.addEventListener("click", () => editor.toggleMode());
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
