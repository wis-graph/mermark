import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { dirOf } from "./path";
import { mountEditor, type PreviewMode, type SaveStatus } from "./editor";
import { applyTheme, applyFontScale, makeThemeToggle } from "./theme";
import {
  themeSetting,
  modeSetting,
  fontScaleSetting,
  zoomIn,
  zoomOut,
  resetZoom,
  loadPreset,
  themeJsonSetting,
  fontFamilySetting,
  webFontSetting,
  effectiveReadingFont,
  fontSizeSetting,
  readingWidthSetting,
  lineHeightSetting,
  headingRatioSetting,
  autosaveDelaySetting,
  conflictPolicySetting,
  panZoomSetting,
  themeForceSetting,
  seedSessionMode,
} from "./settings/app";
import { themeVarsSink, cssVarSink, headingScaleSink, webFontSink } from "./settings/sinks";
import { mountSettingsButton } from "./settings/panel/modal";
import { refreshMermaidTheme } from "./markdown/mermaid-widget";
import "katex/dist/katex.min.css";
import "./fonts/fonts.css";
import "./styles.css";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

/** A save-status indicator that lives inline in the status bar. On `conflict`
 *  (the file changed on disk) it offers a one-click overwrite so the user's
 *  buffer isn't lost — autosave stays paused until they choose. */
function makeSaveStatus(): {
  el: HTMLElement;
  set: (s: SaveStatus, detail?: string) => void;
  onForceSave: (fn: () => void) => void;
} {
  const node = el("span", "save-status");
  const label = el("span", "save-label");
  const force = el("button", "status-btn force-save") as HTMLButtonElement;
  force.textContent = "강제 저장";
  force.title = "디스크의 외부 변경을 덮어쓰고 현재 내용을 저장합니다";
  force.hidden = true;
  node.append(label, force);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  return {
    el: node,
    set(s, detail) {
      clearTimeout(hideTimer);
      node.dataset.state = s;
      force.hidden = s !== "conflict";
      if (s === "error") {
        label.textContent = `⚠ 저장 실패: ${detail ?? "unknown error"}`;
      } else if (s === "conflict") {
        label.textContent = "⚠ 파일이 외부에서 변경됨 — 자동저장 중단";
      } else if (s === "saving") {
        label.textContent = "● 저장 중";
      } else {
        label.textContent = "✓ 저장됨";
        hideTimer = setTimeout(() => (label.textContent = ""), 1500);
      }
    },
    onForceSave(fn) {
      force.addEventListener("click", fn);
    },
  };
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
  // Theme is the SSOT; bind the DOM sink first so the dataset is set before the
  // editor mounts (mermaid reads it on its lazy initial load) — and so it also
  // applies on the no-file / error screens below.
  themeSetting.bind(applyTheme);
  // The theme JSON is the effective source: fan its token map onto documentElement
  // (inline vars beat :root[data-theme]). Bind here, before the editor mounts, so
  // the vars are on the DOM for the editor + the no-file/error screens — and so a
  // saved/custom theme applies on first paint with no flash.
  themeJsonSetting.bind(themeVarsSink());
  // Body text scale is the SSOT too: bind the CSS-var sink here (same place,
  // same reason as theme) so the saved scale is on the DOM before the editor
  // mounts, and so it applies on the no-file / error screens below.
  fontScaleSetting.bind(applyFontScale);
  // Typography sinks — one setting.bind(sink) line each, no hand fan-out. These
  // drive CSS vars composed in styles.css (--editor-font-size composes with
  // --font-scale; --measure caps the reading column; --line-height the leading).
  // --reading-font has a SINGLE writer: webFontSink. The web font (if any) and the
  // font-family select are composed by effectiveReadingFont into {family, stack}
  // and fed to that one sink, so the head <link> + the var never have two writers
  // racing. webFontSetting.bind does the boot-time first apply; fontFamily only
  // re-composes on change (subscribe), so they don't double-apply at boot.
  const applyReadingFont = webFontSink();
  const composeReadingFont = () =>
    applyReadingFont(effectiveReadingFont(webFontSetting.get(), fontFamilySetting.get()));
  webFontSetting.bind(composeReadingFont); // initial + on web-font change
  fontFamilySetting.subscribe(composeReadingFont); // re-compose when the select changes
  fontSizeSetting.bind(cssVarSink("--editor-font-size", (px: number) => `${px}px`));
  readingWidthSetting.bind(cssVarSink("--measure", (ch: number) => `${ch}ch`));
  lineHeightSetting.bind(cssVarSink("--line-height"));
  // Heading typescale: one ratio → six --hN-scale vars (headingScaleSink fans
  // them; styles.css multiplies each into its line's font-size calc).
  headingRatioSetting.bind(headingScaleSink());
  const root = document.querySelector<HTMLDivElement>("#app")!;
  const file = new URLSearchParams(location.search).get("file");
  if (!file) {
    root.textContent = "No file specified.";
    return;
  }
  try {
    // mtime is the autosave baseline: handed back on every write so the backend
    // can refuse to clobber an external change to the file.
    const { text, mtime } = await invoke<{ text: string; mtime: number }>("read_file", { path: file });
    root.innerHTML = "";

    // #app is a flex column: the editor scrolls inside `host`, with a fixed
    // status bar pinned below it that holds all the chrome (toggles, save state,
    // cursor position) — no more controls floating over the content.
    const host = el("div", "editor-host");
    const bar = el("div", "status-bar");
    root.append(host, bar);

    const baseDir = dirOf(file);
    // Boot mode = the panel's defaultMode (seed the live modeSetting from it),
    // then read it. After boot, ⌘E only moves modeSetting; defaultMode re-seeds
    // on the next launch. The two settings stay distinct (boot source vs session).
    seedSessionMode();
    const initialMode = modeSetting.get();
    const toggleMode = () => modeSetting.set(modeSetting.get() === "edit" ? "read" : "edit");

    const mode = makeModeToggle();
    const pos = el("span", "status-pos");
    const spacer = el("span", "status-spacer");
    const save = makeSaveStatus();
    // live theme switch: flip the preset (loadPreset writes themeJson + themeSetting
    // in one place, keeping them coherent) → vars + data-theme + mermaid re-bake
    // track together, no page reload, so the layout never flashes/re-mounts.
    const themeBtn = makeThemeToggle(() =>
      loadPreset(themeSetting.get() === "dark" ? "light" : "dark"),
    );
    themeSetting.bind(themeBtn.render); // initial icon + on change
    bar.append(mode.btn, pos, spacer, save.el, themeBtn.btn);
    // ⚙ settings: append after the theme toggle. Boot-cheap — the modal DOM is
    // built lazily on first open (cold-load constraint).
    mountSettingsButton(bar);

    const editor = mountEditor(host, text, baseDir, file, {
      onStatus: save.set,
      initialMode,
      onToggleMode: toggleMode,
      onCursor: (line, col) => (pos.textContent = `Ln ${line}, Col ${col}`),
      baseMtime: mtime,
      autosaveDelay: autosaveDelaySetting.get(),
      conflictPolicy: conflictPolicySetting.get(),
    });
    save.onForceSave(() => editor.forceSave());
    // Don't lose the last keystrokes typed within the autosave debounce window:
    // intercept the window close, persist the live buffer, then close. Guarded so
    // it only runs under Tauri (the browser-mock dev mode has no window IPC).
    // `await` the registration so a close fired right after boot still finds the
    // handler installed; `beginClose()` stops a late keystroke from scheduling a
    // timer that destroy() would orphan.
    if ("__TAURI_INTERNALS__" in window) {
      const win = getCurrentWindow();
      await win.onCloseRequested(async (e) => {
        if (!editor.hasUnsaved()) return;
        e.preventDefault();
        editor.beginClose();
        try {
          await editor.saveOnClose();
        } finally {
          await win.destroy();
        }
      });
    }
    // mermaid bakes theme colors into its SVGs, so a theme change must clear its
    // cache + re-render every block. Change-only sink (no initial work needed).
    themeSetting.subscribe((t) => {
      refreshMermaidTheme(t);
      editor.refresh();
    });
    // Editor-behavior sinks: the settings are the writers, the editor controller
    // is the single sink for each (no hand fan-out). autosaveDelay/conflictPolicy
    // were seeded via mountEditor opts above; these keep them live.
    autosaveDelaySetting.subscribe((ms) => editor.setAutosaveDelay(ms));
    conflictPolicySetting.subscribe((p) => editor.setConflictPolicy(p));
    // themeForce re-bake is owned by mermaid-widget (self-subscription); main
    // only triggers the redraw it alone can dispatch — symmetric with the
    // themeSetting sink above, minus mermaid's theme knowledge.
    themeForceSetting.subscribe(() => editor.refresh());
    // panZoom toggle: re-render blocks so MermaidWidget (which snapshots panZoom
    // in eq) re-creates and attachPanZoom re-runs with the new value.
    panZoomSetting.subscribe(() => editor.refresh());
    // dev-only: expose the controller so the debug harness can read real editor
    // state (selection offsets, block specs) instead of guessing from the DOM.
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV)
      (window as unknown as { __mermark?: unknown }).__mermark = editor;
    mode.btn.addEventListener("click", toggleMode);
    // global capture-phase listener so ⌘E works reliably even under different
    // keyboard layouts (like Korean) and regardless of editor focus states
    window.addEventListener(
      "keydown",
      (e) => {
        if ((e.metaKey || e.ctrlKey) && e.code === "KeyE") {
          e.preventDefault();
          e.stopPropagation();
          toggleMode();
        }
      },
      { capture: true }
    );
    // Body-text zoom (Cmd =/-/0). Same global-keydown spot as ⌘E so it works in
    // read mode and when the editor isn't focused. preventDefault intercepts the
    // webview's built-in page zoom so only the .cm-line text scale changes.
    // '=' and '+' both zoom in (US layout needs Shift for '+'); '-' and '_' out.
    window.addEventListener("keydown", (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomIn();
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        resetZoom();
      }
    });
    // mode is the SSOT: the button label binds to it; the editor reacts to
    // changes (reconfigure CM + flush autosave on leaving edit). Persistence is
    // handled by the store.
    modeSetting.bind(mode.render); // initial label + on change
    modeSetting.subscribe((m) => editor.setMode(m));
  } catch (e) {
    root.textContent = `Failed to open: ${String(e)}`;
  }
}

boot();
