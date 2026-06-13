# SSOT Settings Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ad-hoc per-setting fan-out (theme/mode each hand-wired to ~5 sinks) with one Single-Source-of-Truth settings store that sinks subscribe to.

**Architecture:** A dependency-free generic `defineSetting<T>` primitive (localStorage-backed, listener set) declares each preference once with `{key, default}`. Concrete settings (`themeSetting`, `modeSetting`) live in one SSOT module. Leaf modules stay settings-agnostic (they expose applier functions); the composition root (`main.ts`) wires sinks via `setting.bind`/`setting.subscribe`. This removes theme's push/pull double-channel and makes "add a setting" a one-place declaration + uniform subscriptions instead of a 4–5 file edit.

**Tech Stack:** TypeScript, CodeMirror 6 (Compartment/Facet), Vitest (jsdom), Playwright/CDP Golden Master. **No state library** (fast-load constraint — plain module + callbacks only).

---

## Why this plan (source of truth)

Direction comes from `docs/reviews/architecture-review-2026-06-13.md` (pattern: **Single Source of Truth — settings store**, Golden Master required). Background symptom: `theme`/`mode` each have a single writer but fan out by hand to localStorage key + DOM/CSS-var + CM facet/compartment + mermaid re-bake + status-bar chrome; `theme` additionally has a **push** (`main.ts` calls `refreshMermaidTheme`) **+ pull** (`mermaid-widget` reads `document.documentElement.dataset.theme`) double channel and a real sync-bug history.

## Scope

In scope: SSOT store primitive; migrate **theme** then **mode** onto it; remove legacy fan-out for those two; kill theme's pull-on-change channel.

Out of scope (waiting list — do **not** do here): Command-Pattern click→source dedup; promoting the feature registry to a real plugin API; mermaid self-registering as a theme sink (would remove `main.ts`'s knowledge of "theme → re-bake mermaid"; deferred to the plugin round). These stay documented in the review files.

## Design decisions (locked)

- **`subscribe` is change-only**; **`bind` = apply current value now, then subscribe.** Sinks needing an initial paint use `bind`; change-only sinks use `subscribe`. This avoids a redundant initial block re-render at boot and keeps theme-path ordering explicit (the review flags theme migration as the riskiest step → stay conservative).
- **Atomic replace per setting** (not a long dual-path parallel period). The surface is tiny and the Golden Master makes an atomic swap safe; maintaining two channels would introduce its own bugs. Theme fully in Task 3, mode fully in Task 4, each gated by Golden Master.
- **`set` dedups on `Object.is`** (no notify when value unchanged).
- **Window-local store** (multi-*window* app — no cross-window shared state needed; YAGNI).
- **Composition-root wiring**: `main.ts` owns the setting singletons' subscriptions; leaf modules (`theme.ts`, `editor.ts`, `mermaid-widget.ts`) do **not** import the settings singletons — they expose applier functions and stay unit-testable.

## File Structure

- **Create `src/settings/store.ts`** — generic `defineSetting<T>` + `Setting<T>`/`SettingDef<T>` types. Pure (only touches `localStorage`). One responsibility: persisted observable value.
- **Create `src/settings/app.ts`** — declares `themeSetting`, `modeSetting`. The SSOT registry. Imports `systemTheme` from `theme.ts` and `PreviewMode` from live-preview.
- **Create `tests/settings-store.test.ts`** — locks the store contract.
- **Create `tests/settings-app.test.ts`** — locks the two SSOT declarations (keys + defaults).
- **Create `scripts/settings-golden.mjs`** — CDP Golden Master for theme+mode observable behavior.
- **Modify `src/theme.ts`** — drop `initialTheme`/`STORAGE_KEY`; refactor `makeThemeToggle` into `{btn, render}` (writer via `onToggle`, label via `render`). Keep `Theme`, `systemTheme`, `applyTheme`.
- **Modify `src/markdown/mermaid-widget.ts`** — `refreshMermaidTheme(theme: Theme)` takes the value (kills pull-on-change).
- **Modify `src/editor.ts`** — `controller.setMode` becomes a pure sink (apply mode + flush on leaving edit); drop `onMode`; add `onToggleMode`; drop `toggleMode` from the controller.
- **Modify `src/main.ts`** — drop `MODE_KEY`/`savedMode`; wire `themeSetting`/`modeSetting` at the composition root.

---

## Task 1: Settings store primitive

**Files:**
- Create: `src/settings/store.ts`
- Test: `tests/settings-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/settings-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { defineSetting } from "../src/settings/store";

describe("defineSetting", () => {
  beforeEach(() => localStorage.clear());

  it("returns the default when nothing is stored", () => {
    const s = defineSetting({ key: "k", default: "a" });
    expect(s.get()).toBe("a");
  });

  it("reads a persisted value on construction", () => {
    localStorage.setItem("k", "b");
    const s = defineSetting({ key: "k", default: "a" });
    expect(s.get()).toBe("b");
  });

  it("falls back to default when parse rejects the stored value", () => {
    localStorage.setItem("k", "garbage");
    const s = defineSetting<"x" | "y">({
      key: "k",
      default: "x",
      parse: (r) => (r === "x" || r === "y" ? r : null),
    });
    expect(s.get()).toBe("x");
  });

  it("persists to localStorage on set", () => {
    const s = defineSetting({ key: "k", default: "a" });
    s.set("z");
    expect(localStorage.getItem("k")).toBe("z");
    expect(s.get()).toBe("z");
  });

  it("notifies subscribers on change", () => {
    const s = defineSetting({ key: "k", default: "a" });
    const seen: string[] = [];
    s.subscribe((v) => seen.push(v));
    s.set("b");
    expect(seen).toEqual(["b"]);
  });

  it("does not notify when set to the current value", () => {
    const s = defineSetting({ key: "k", default: "a" });
    const fn = vi.fn();
    s.subscribe(fn);
    s.set("a");
    expect(fn).not.toHaveBeenCalled();
  });

  it("subscribe is change-only (no immediate fire)", () => {
    const s = defineSetting({ key: "k", default: "a" });
    const fn = vi.fn();
    s.subscribe(fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it("bind fires immediately with the current value, then on change", () => {
    localStorage.setItem("k", "b");
    const s = defineSetting({ key: "k", default: "a" });
    const seen: string[] = [];
    s.bind((v) => seen.push(v));
    expect(seen).toEqual(["b"]);
    s.set("c");
    expect(seen).toEqual(["b", "c"]);
  });

  it("unsubscribe stops further notifications", () => {
    const s = defineSetting({ key: "k", default: "a" });
    const fn = vi.fn();
    const off = s.subscribe(fn);
    off();
    s.set("b");
    expect(fn).not.toHaveBeenCalled();
  });

  it("uses serialize when persisting", () => {
    const s = defineSetting<{ n: number }>({
      key: "k",
      default: { n: 0 },
      parse: (r) => (r ? (JSON.parse(r) as { n: number }) : null),
      serialize: JSON.stringify,
    });
    s.set({ n: 5 });
    expect(localStorage.getItem("k")).toBe('{"n":5}');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/settings-store.test.ts`
Expected: FAIL — `Cannot find module '../src/settings/store'` (file not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/settings/store.ts`:

```ts
// A persisted, observable single value. The SSOT primitive: declare a
// preference once with { key, default }, then let any number of sinks subscribe.
// Dependency-free (plain closure + Set of listeners) to honor the fast-load
// constraint — no reactive framework.

export interface SettingDef<T> {
  /** localStorage key the value persists under. */
  key: string;
  /** Value used when nothing valid is stored. */
  default: T;
  /** Validate a raw stored string into a value; return null to use the default. */
  parse?: (raw: string | null) => T | null;
  /** Serialize a value for storage (default: String(v)). */
  serialize?: (v: T) => string;
}

export interface Setting<T> {
  get(): T;
  set(v: T): void;
  /** Register a change-only listener. Returns an unsubscribe function. */
  subscribe(fn: (v: T) => void): () => void;
  /** Apply the current value now, then on every change. Returns unsubscribe. */
  bind(fn: (v: T) => void): () => void;
}

export function defineSetting<T>(def: SettingDef<T>): Setting<T> {
  const { key, default: dflt, parse, serialize } = def;
  const raw = localStorage.getItem(key);
  const parsed = parse ? parse(raw) : (raw as T | null);
  let value: T = parsed == null ? dflt : parsed;

  const listeners = new Set<(v: T) => void>();
  const subscribe = (fn: (v: T) => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };

  return {
    get: () => value,
    set(v: T) {
      if (Object.is(v, value)) return; // SSOT: no-op when unchanged
      value = v;
      localStorage.setItem(key, serialize ? serialize(v) : String(v));
      listeners.forEach((fn) => fn(v));
    },
    subscribe,
    bind(fn) {
      fn(value);
      return subscribe(fn);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/settings-store.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/settings/store.ts tests/settings-store.test.ts
git commit -m "feat(settings): dependency-free SSOT setting primitive"
```

---

## Task 2: Declare the app settings (theme, mode)

**Files:**
- Create: `src/settings/app.ts`
- Test: `tests/settings-app.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/settings-app.test.ts`. (Imports `app.ts` dynamically after stubbing `matchMedia`, because the module computes `systemTheme()` at load and jsdom has no `matchMedia`.)

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("app settings", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
    // systemTheme() reads matchMedia; matches:false → "dark"
    vi.stubGlobal("matchMedia", () => ({ matches: false }) as unknown as MediaQueryList);
  });

  it("themeSetting defaults to the system theme and persists under mermark.theme", async () => {
    const { themeSetting } = await import("../src/settings/app");
    expect(themeSetting.get()).toBe("dark");
    themeSetting.set("light");
    expect(localStorage.getItem("mermark.theme")).toBe("light");
  });

  it("themeSetting reads a saved preference over the system theme", async () => {
    localStorage.setItem("mermark.theme", "light");
    const { themeSetting } = await import("../src/settings/app");
    expect(themeSetting.get()).toBe("light");
  });

  it("modeSetting defaults to read and persists under mermark.mode", async () => {
    const { modeSetting } = await import("../src/settings/app");
    expect(modeSetting.get()).toBe("read");
    modeSetting.set("edit");
    expect(localStorage.getItem("mermark.mode")).toBe("edit");
  });

  it("modeSetting reads a saved edit preference", async () => {
    localStorage.setItem("mermark.mode", "edit");
    const { modeSetting } = await import("../src/settings/app");
    expect(modeSetting.get()).toBe("edit");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/settings-app.test.ts`
Expected: FAIL — `Cannot find module '../src/settings/app'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/settings/app.ts`:

```ts
// The SSOT registry: every user preference declared in one place. Sinks
// subscribe (in main.ts); writers call setting.set(). Adding a preference is a
// one-line declaration here plus subscriptions at the composition root.
import { defineSetting } from "./store";
import { systemTheme, type Theme } from "../theme";
import type { PreviewMode } from "../markdown/live-preview";

/** light/dark. Saved preference wins; otherwise the OS theme. */
export const themeSetting = defineSetting<Theme>({
  key: "mermark.theme",
  default: systemTheme(),
  parse: (raw) => (raw === "light" || raw === "dark" ? raw : null),
});

/** edit (live preview) / read (fixed render). Defaults to read. */
export const modeSetting = defineSetting<PreviewMode>({
  key: "mermark.mode",
  default: "read",
  parse: (raw) => (raw === "edit" || raw === "read" ? raw : null),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/settings-app.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors. (`app.ts` is not yet imported by app code — that happens in Tasks 3–4.)

- [ ] **Step 6: Commit**

```bash
git add src/settings/app.ts tests/settings-app.test.ts
git commit -m "feat(settings): declare theme and mode as SSOT settings"
```

---

## Task 3: Migrate theme onto the SSOT store

This is the riskiest step (theme has a sync-bug history). Capture a Golden Master first, refactor, then prove behavior-identical.

**Files:**
- Create: `scripts/settings-golden.mjs`
- Modify: `src/theme.ts` (whole file)
- Modify: `src/markdown/mermaid-widget.ts:30-41` (`refreshMermaidTheme`) and its import
- Modify: `src/main.ts` (theme wiring: lines 4-5 imports, 53-54 initial apply, 82-86 toggle/append)

- [ ] **Step 1: Create the Golden Master harness**

Create `scripts/settings-golden.mjs`:

```js
// CDP Golden Master for settings behavior: theme dataset + persistence, mermaid
// re-render on theme switch, mode editability + persistence, button labels.
// Resets localStorage so each run starts from the system default, then drives
// the toggles and fingerprints observable state at each step.
//
//   node scripts/settings-golden.mjs /tmp/settings-before.json   (pre-refactor)
//   node scripts/settings-golden.mjs /tmp/settings-after.json    (post-refactor)
//
// Assumes `npm run dev:browser` + Chrome --remote-debugging-port=9222 running.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const out = process.argv[2] ?? "/tmp/settings-golden.json";
const url = process.argv[3] ?? "http://localhost:1420/?file=x.md";

const ver = await (await fetch("http://127.0.0.1:9222/json/version")).json();
const browser = await chromium.connectOverCDP(ver.webSocketDebuggerUrl);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = ctx.pages()[0] ?? (await ctx.newPage());

const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});

await page.setViewportSize({ width: 1200, height: 900 });
await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
// deterministic start: clear persisted prefs, reload to system default
await page.evaluate(() => localStorage.clear());
await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
await page.waitForTimeout(2000); // mermaid async render

const snap = (label) =>
  page.evaluate((label) => {
    const m = document.querySelector(".cm-mermaid svg");
    const content = document.querySelector(".cm-content");
    return {
      label,
      dataTheme: document.documentElement.dataset.theme ?? null,
      lsTheme: localStorage.getItem("mermark.theme"),
      lsMode: localStorage.getItem("mermark.mode"),
      editable: content?.getAttribute("contenteditable") ?? null,
      mermaidViewBox: m?.getAttribute("viewBox") ?? null,
      mermaidHasPanZoom: !!document.querySelector(".cm-mermaid .svg-pan-zoom_viewport"),
      themeBtn: document.querySelector(".theme-toggle")?.textContent ?? null,
      modeBtn: document.querySelector(".mode-toggle")?.textContent ?? null,
    };
  }, label);

const states = [];
states.push(await snap("initial"));

await page.click(".theme-toggle");
await page.waitForTimeout(1500); // theme re-bakes + re-renders mermaid
states.push(await snap("after-theme-toggle"));

await page.click(".mode-toggle");
await page.waitForTimeout(500);
states.push(await snap("after-mode-toggle"));

await page.click(".theme-toggle");
await page.click(".mode-toggle");
await page.waitForTimeout(1500);
states.push(await snap("after-toggle-back"));

writeFileSync(out, JSON.stringify({ states, errors }, null, 2));
console.log(JSON.stringify({ states, errors }, null, 2));
console.log("\nwrote", out);
await browser.close();
```

- [ ] **Step 2: Capture the BEFORE Golden Master**

Prerequisite: in one terminal `npm run dev:browser`; Chrome running with `--remote-debugging-port=9222` and the page open at `http://localhost:1420/?file=x.md` (use a file containing a ```mermaid block — `src-tauri/docs/sample.md` works via `?file=...`).

Run: `node scripts/settings-golden.mjs /tmp/settings-before.json`
Expected: prints 4 states, `errors: []`. `initial` shows `dataTheme` = system default, `editable` = `"false"` (read mode), mermaid `viewBox` present. `after-theme-toggle` shows the opposite `dataTheme`, `lsTheme` set, mermaid still rendered (viewBox present, panZoom true). `after-mode-toggle` shows `editable: "true"`, `lsMode: "edit"`.

Commit the harness now (the BEFORE snapshot is a scratch file, not committed):

```bash
git add scripts/settings-golden.mjs
git commit -m "test(settings): CDP golden-master harness for theme/mode behavior"
```

- [ ] **Step 3: Refactor `theme.ts` — toggle becomes writer + label sink**

Replace the whole of `src/theme.ts` with:

```ts
export type Theme = "dark" | "light";

export function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Apply a theme to the DOM (CSS vars switch off [data-theme]). A SSOT sink. */
export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
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
```

(Removed: `STORAGE_KEY`, `initialTheme` — persistence/initial-value now live in `themeSetting`. `makeThemeToggle` no longer reads/writes localStorage or applies the theme; those are sinks the composition root drives.)

- [ ] **Step 4: Refactor `refreshMermaidTheme` to take the theme value**

In `src/markdown/mermaid-widget.ts`, add the type import near the top (after line 3 `import { boundedCache } from "./bounded-cache";`):

```ts
import type { Theme } from "../theme";
```

Replace the existing `refreshMermaidTheme` (lines 30-41) with:

```ts
/** Re-theme mermaid live (no page reload): clear the cache, re-init mermaid with
 *  the given theme, and bump the version so widgets re-render. The theme is
 *  passed in (a SSOT sink) rather than pulled from the DOM. */
export function refreshMermaidTheme(theme: Theme) {
  themeVersion++;
  svgCache.clear();
  if (mermaidLoader) {
    const light = theme === "light";
    mermaidLoader.then((m) =>
      m.initialize({ startOnLoad: false, securityLevel: "strict", theme: light ? "default" : "dark" }),
    );
  }
}
```

(`loadMermaid` keeps reading `document.documentElement.dataset.theme` for its one-shot initial init — by the time the first diagram lazy-loads, `applyTheme` has already set the dataset at boot. The double-*channel-on-change* is gone: `refreshMermaidTheme` no longer pulls from the DOM.)

- [ ] **Step 5: Wire theme at the composition root in `main.ts`**

5a. Update imports. Replace line 4 (`import { initialTheme, applyTheme, makeThemeToggle } from "./theme";`) with:

```ts
import { applyTheme, makeThemeToggle } from "./theme";
import { themeSetting } from "./settings/app";
```

(Leave line 5 `import { refreshMermaidTheme } from "./markdown/mermaid-widget";` as is.)

5b. At the very top of `boot()`, replace the current initial-theme lines (53-54):

```ts
  const theme = initialTheme();
  applyTheme(theme);
```

with:

```ts
  // Theme is the SSOT; bind the DOM sink first so the dataset is set before the
  // editor mounts (mermaid reads it on its lazy initial load) — and so it also
  // applies on the no-file / error screens below.
  themeSetting.bind(applyTheme);
```

5c. Replace the theme-toggle creation block (current lines 80-86):

```ts
    // live theme switch: flip CSS vars + re-render mermaid (theme is baked into
    // its SVGs), no page reload — so the layout never flashes/re-mounts.
    const themeBtn = makeThemeToggle(theme, () => {
      refreshMermaidTheme();
      editor.refresh();
    });
    bar.append(mode.btn, pos, spacer, save.el, themeBtn);
```

with:

```ts
    // live theme switch: flip CSS vars + re-render mermaid (theme is baked into
    // its SVGs), no page reload — so the layout never flashes/re-mounts.
    const themeBtn = makeThemeToggle(() =>
      themeSetting.set(themeSetting.get() === "dark" ? "light" : "dark"),
    );
    themeSetting.bind(themeBtn.render); // initial icon + on change
    bar.append(mode.btn, pos, spacer, save.el, themeBtn.btn);
```

5d. After `const editor = mountEditor(...)` returns (currently ends at line 96), add the mermaid re-bake sink. Insert immediately after the `mountEditor(...)` assignment block:

```ts
    // mermaid bakes theme colors into its SVGs, so a theme change must clear its
    // cache + re-render every block. Change-only sink (no initial work needed).
    themeSetting.subscribe((t) => {
      refreshMermaidTheme(t);
      editor.refresh();
    });
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors. (If `initialTheme` is still referenced anywhere, tsc will flag it — there should be none outside the removed lines.)

- [ ] **Step 7: Run the unit suite**

Run: `npx vitest run`
Expected: all green (existing suites + settings-store 10 + settings-app 4 unaffected).

- [ ] **Step 8: Capture the AFTER Golden Master and diff**

Reload the dev:browser page (so the new bundle loads), then:

Run: `node scripts/settings-golden.mjs /tmp/settings-after.json`
Then: `diff <(jq '.states' /tmp/settings-before.json) <(jq '.states' /tmp/settings-after.json) && echo IDENTICAL`
Expected: `IDENTICAL`, and `jq '.errors' /tmp/settings-after.json` is `[]`. The `states` (dataTheme transitions, lsTheme/lsMode persistence, editable, mermaid viewBox + panZoom, button labels) must match the before snapshot exactly. If any state differs → STOP, do not commit; investigate the wiring (likely subscriber order or a missing `bind`).

- [ ] **Step 9: Commit**

```bash
git add src/theme.ts src/markdown/mermaid-widget.ts src/main.ts
git commit -m "refactor(settings): theme reads from the SSOT store, sinks subscribe"
```

---

## Task 4: Migrate mode onto the SSOT store

`mode` is the second SSOT item. The editor's `setMode` becomes a **sink** (apply mode to CM + flush autosave on leaving edit); the **writer** is `modeSetting.set` driven by the toggle button, the Mod-e keymap, and the window keydown fallback — all delegating to one command.

**Files:**
- Modify: `src/editor.ts` (controller interface + `setMode`/`toggleMode`, `mountEditor` opts, Mod-e keymap)
- Modify: `src/main.ts` (drop `MODE_KEY`/`savedMode`; wire `modeSetting`)

- [ ] **Step 1: Make `controller.setMode` a pure sink in `editor.ts`**

1a. Update the `EditorController` interface (lines 14-21). Replace:

```ts
export interface EditorController {
  view: EditorView;
  mode(): PreviewMode;
  setMode(m: PreviewMode): void;
  toggleMode(): void;
  /** Force block widgets (mermaid) to re-render — used after a live theme change. */
  refresh(): void;
}
```

with:

```ts
export interface EditorController {
  view: EditorView;
  mode(): PreviewMode;
  /** Apply a mode to the editor (SSOT sink): reconfigure CM and flush autosave
   *  when leaving edit. The setting is the writer; this only reacts. */
  setMode(m: PreviewMode): void;
  /** Force block widgets (mermaid) to re-render — used after a live theme change. */
  refresh(): void;
}
```

1b. Update `mountEditor`'s `opts` (lines 72-79). Replace the `onMode?` line with `onToggleMode?`:

```ts
  opts: {
    onStatus?: (s: SaveStatus, detail?: string) => void;
    initialMode?: PreviewMode;
    onToggleMode?: () => void;
    onCursor?: (line: number, col: number) => void;
  } = {},
```

1c. Update the destructure (line 79). Replace:

```ts
  const { onStatus = () => {}, initialMode = "read", onMode = () => {}, onCursor = () => {} } = opts;
```

with:

```ts
  const { onStatus = () => {}, initialMode = "read", onToggleMode = () => {}, onCursor = () => {} } = opts;
```

1d. Update the controller object (lines 84-100). Replace `setMode`/`toggleMode` so `setMode` no longer calls `onMode`, and `toggleMode` is removed:

```ts
  const controller: EditorController = {
    view: null as unknown as EditorView,
    mode: () => mode,
    setMode(m: PreviewMode) {
      if (m === mode) return;
      if (mode === "edit") autosave.flush(); // leaving edit = save point
      mode = m;
      controller.view.dispatch({ effects: modeCompartment.reconfigure(modeExtensions(m)) });
    },
    refresh() {
      controller.view.dispatch({ effects: refreshBlocks.of(null) });
    },
  };
```

1e. Update the Mod-e keymap (line 112). Replace:

```ts
        { key: "Mod-e", run: () => (controller.toggleMode(), true) },
```

with:

```ts
        { key: "Mod-e", run: () => (onToggleMode(), true) },
```

- [ ] **Step 2: Typecheck (expect a failure in main.ts)**

Run: `npx tsc --noEmit`
Expected: errors in `src/main.ts` — `controller.toggleMode` no longer exists and `onMode` opt is gone. This is expected; Step 3 fixes main.ts. (This confirms the only consumer is main.ts.)

- [ ] **Step 3: Wire mode at the composition root in `main.ts`**

3a. Add the import. Update the settings import line (added in Task 3) to include `modeSetting`:

```ts
import { themeSetting, modeSetting } from "./settings/app";
```

3b. Delete the now-dead mode persistence helpers (current lines 36-40):

```ts
const MODE_KEY = "mermark.mode";

function savedMode(): PreviewMode {
  return localStorage.getItem(MODE_KEY) === "edit" ? "edit" : "read";
}
```

(`PreviewMode` is still imported on line 3 for `makeModeToggle`'s `render` signature — keep that import.)

3c. Replace the `initialMode` + mode-toggle + editor + listeners block. The current code (lines 73-108) reads:

```ts
    const initialMode = savedMode();

    const mode = makeModeToggle();
    mode.render(initialMode);
    const pos = el("span", "status-pos");
    const spacer = el("span", "status-spacer");
    const save = makeSaveStatus();
```

…then the theme block (already migrated in Task 3)…

```ts
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
```

Make these changes:

- Replace the `const initialMode = savedMode();` line + `mode.render(initialMode);` line. The `mode` toggle is created the same way but its initial label and persistence now come from the setting. Replace:

```ts
    const initialMode = savedMode();

    const mode = makeModeToggle();
    mode.render(initialMode);
```

with:

```ts
    const initialMode = modeSetting.get();
    const toggleMode = () =>
      modeSetting.set(modeSetting.get() === "edit" ? "read" : "edit");

    const mode = makeModeToggle();
```

- In the `mountEditor(...)` opts, replace the `onMode` block with `onToggleMode`:

```ts
    const editor = mountEditor(host, text, baseDir, file, {
      onStatus: save.set,
      initialMode,
      onToggleMode: toggleMode,
      onCursor: (line, col) => (pos.textContent = `Ln ${line}, Col ${col}`),
    });
```

- After the `__mermark` dev-only block, replace the click + keydown wiring:

```ts
    mode.btn.addEventListener("click", () => editor.toggleMode());
    // global fallback so ⌘E works even when the editor isn't focused
    window.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e") {
        e.preventDefault();
        editor.toggleMode();
      }
    });
```

with:

```ts
    mode.btn.addEventListener("click", toggleMode);
    // global fallback so ⌘E works even when the editor isn't focused
    window.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e") {
        e.preventDefault();
        toggleMode();
      }
    });
    // mode is the SSOT: the button label binds to it; the editor reacts to
    // changes (reconfigure CM + flush autosave on leaving edit). Persistence is
    // handled by the store.
    modeSetting.bind(mode.render); // initial label + on change
    modeSetting.subscribe((m) => editor.setMode(m));
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Run the unit suite**

Run: `npx vitest run`
Expected: all green.

- [ ] **Step 6: Golden Master + manual mode verification**

Reload the dev:browser page, then:

Run: `node scripts/settings-golden.mjs /tmp/settings-after-mode.json`
Then: `diff <(jq '.states' /tmp/settings-before.json) <(jq '.states' /tmp/settings-after-mode.json) && echo IDENTICAL`
Expected: `IDENTICAL` and `errors: []`. Specifically `after-mode-toggle` must still show `editable: "true"`, `lsMode: "edit"`, `modeBtn` label switched to the edit label.

Manual autosave-flush check (the historically sensitive path): in the dev:browser page, switch to edit mode, type a character, and immediately press ⌘E to switch to read mode before the 500ms autosave debounce elapses. Confirm via the network/console (or `write_file` mock log) that the write fired on the mode switch (flush), not only after the debounce. Confirm no console errors.

- [ ] **Step 7: Commit**

```bash
git add src/editor.ts src/main.ts
git commit -m "refactor(settings): mode reads from the SSOT store, editor is a sink"
```

---

## Task 5: Final sweep + close out the review

**Files:**
- Modify: `docs/reviews/architecture-review-2026-06-13.md` (mark the SSOT round resolved)

- [ ] **Step 1: Confirm no legacy fan-out remains**

Run: `grep -rn "initialTheme\|savedMode\|MODE_KEY\|toggleMode\b" src/`
Expected: only `toggleMode` as the local const + its references in `src/main.ts`. No `initialTheme`, no `savedMode`, no `MODE_KEY`. `grep -rn "dataset.theme" src/` should show only `mermaid-widget.ts` `loadMermaid` (one-shot initial) and `theme.ts` `applyTheme` (the sink) — `main.ts` no longer touches it directly and `refreshMermaidTheme` no longer reads it.

- [ ] **Step 2: Full green gate**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc 0 errors; all tests pass (existing + settings-store 10 + settings-app 4).

- [ ] **Step 3: Final no-regression Golden Master**

Reload dev:browser. Run: `node scripts/settings-golden.mjs /tmp/settings-final.json`
Then: `diff <(jq '.states' /tmp/settings-before.json) <(jq '.states' /tmp/settings-final.json) && echo IDENTICAL`
Expected: `IDENTICAL`, `errors: []`.

- [ ] **Step 4: Mark the architecture-review round resolved**

In `docs/reviews/architecture-review-2026-06-13.md`, append to the end of the file:

```markdown

---

## 실행 완료 (2026-06-13)

SSOT 설정 스토어 이주 완료 (`docs/superpowers/plans/2026-06-13-ssot-settings-store.md`).
- `src/settings/store.ts` (`defineSetting`) + `src/settings/app.ts` (`themeSetting`/`modeSetting`) 도입.
- theme·mode가 SSOT를 읽고 sink가 구독(`bind`/`subscribe`). localStorage 영속은 스토어가 담당.
- theme의 push/pull 이중 채널 제거: `refreshMermaidTheme(theme)`가 값을 받음(DOM pull-on-change 제거).
- Golden Master(`scripts/settings-golden.mjs`) 전/후 동일, 콘솔 에러 0.
- **대기 리스트 잔존**: Command-Pattern 클릭→소스 단일화, 플러그인 설정 등록 API, mermaid의 theme sink 자기등록(main.ts의 도메인 지식 제거)은 다음 라운드.
```

- [ ] **Step 5: Commit**

```bash
git add docs/reviews/architecture-review-2026-06-13.md
git commit -m "docs(reviews): record SSOT settings store migration"
```

---

## Golden Master scenarios (summary)

Captured by `scripts/settings-golden.mjs` at four steps (`initial`, `after-theme-toggle`, `after-mode-toggle`, `after-toggle-back`), asserting before==after across the whole migration:

1. **Theme switch** — `dataset.theme` flips, `mermark.theme` persists, mermaid re-renders (viewBox + pan-zoom present), 0 console errors. *(Historically buggy: layout break / mermaid invisible after re-render.)*
2. **Mode toggle** — `.cm-content[contenteditable]` flips true/false, `mermark.mode` persists, button labels update.
3. **Autosave flush on leaving edit** — manual check: edit + type + ⌘E within the debounce window → write fires on the mode switch.

## What this plan deliberately leaves for later (waiting list)

- **Command Pattern: click→source dedup** — consolidate onto `core.ts:clickEntry`, delete per-widget `mousedown` in `table-widget`/`math-widget`. Carries a read-mode behavior decision; not a pure refactor.
- **Plugin settings registration** — let features/plugins declare their own settings against the same `defineSetting` primitive and subscribe sinks. The store is built to allow it; the API surface is a separate round.
- **mermaid self-registers as a theme sink** — would remove `main.ts`'s knowledge that "theme change → re-bake mermaid". Deferred with the plugin round (needs an ordering-safe registration hook so the version bump precedes the block redraw).
```
