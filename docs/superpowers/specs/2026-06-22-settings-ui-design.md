# Settings UI (Modal · Sidebar · Theme-as-JSON) — Design Spec

**Date:** 2026-06-22
**Status:** Design (ready for `superpowers:writing-plans`)
**Predecessor:** `docs/superpowers/specs/2026-06-14-settings-panel-plugin-design.md` (approved, **unimplemented**). This spec **supersedes** 06-14: it keeps the registry-driven-panel skeleton but adds the user's two hard requirements — (1) a left-sidebar category navigation, (2) **the whole theme handled as a single JSON document with bulk import/export**. It also raises Colors from "4 curated tokens" to "the full theme token set, edited as one JSON object."
**Roots:** `docs/reviews/architecture-review-2026-06-13.md` (SSOT store; "settings panel is the pressure point"), `src/settings/store.ts` (`defineSetting` primitive), `src/settings/app.ts` (theme/mode/fontScale), `src/theme.ts` (`applyTheme`/`applyFontScale`), `src/main.ts` (boot sinks + status-bar), `src/styles.css:1-28` (token table), `DESIGN.md` (ElevenLabs token SSOT).

---

## 0. What changes vs the 2026-06-14 spec (inherit / update / drop)

| 06-14 decision | 06-22 verdict | reason |
|---|---|---|
| `registerSetting(def)` registry wrapper over `defineSetting` | **INHERIT** — exact same idea | one declaration site; plugin path == core path |
| `⚙` status-bar button → centered modal, 720px, two-pane (sidebar + pane) | **INHERIT** | matches user ask ("좌측 사이드바 + 우측 패널") |
| `controls.ts` RENDER dispatch table (`segmented`/`select`/`slider`/`color`) | **INHERIT**, **EXTEND** with two new kinds: `json` (textarea + import/export) and `info` (read-only row) | theme-as-JSON needs a JSON editor control |
| Colors = 4 curated CSS-var overrides (`--accent`/`--heading`/`--code-bg`/`--quote`), each a `color`/null override layered on the active theme | **DROP as the theme model**; **fold into the Theme JSON**. Colors are now *all theme tokens*, edited as one JSON object, not four separate per-token color pickers. (A future "advanced per-token picker" stays on the waiting list.) | user wants the theme as **one JSON** for bulk import/export, not piecemeal pickers |
| `mode` stays status-bar-only (in SSOT, no `ui`) | **INHERIT** | frequent doc action, not a panel preference |
| Mermaid self-registers its category + self-subscribes to theme (removes `main.ts` `refreshMermaidTheme` wiring) | **INHERIT but SCOPE OUT of round 1** — see §9. Round-1 Mermaid category exists (panZoom/themeForce settings) but the self-subscription refactor is its own step to keep the ordering risk isolated | ordering risk (§9) is the 06-14 spec's "highest risk"; don't couple it to the new theme-JSON work |
| `--editor-font-size`/`--measure` new CSS vars driven by sliders | **INHERIT** (Typography category) | unchanged |

**Net delta:** the panel skeleton + registry + most controls are carried over verbatim; the **Colors category is replaced by a Theme category whose single control is a JSON editor with import/export**, and `applyTheme` is upgraded from "set `data-theme`" to "set `data-theme` **and** fan a token map onto `documentElement` CSS vars."

---

## 1. Classification (5-kind)

- **Kind:** **setting** (dominant) + **frontend UI module** (the panel DOM, not a markdown feature). **No parser node. No inline/block feature. No new live-preview Spec.**
- **Backend (Tauri command):** **NOT required for round 1.** Theme import/export ships as **clipboard/textarea paste + download-via-Blob** (pure frontend, zero IPC). A *file-picker* import ("import theme from a `.json` file on disk") is **deferred** — if added later it reuses the existing `read_file` command unchanged (it returns `{text, mtime}`; the panel ignores `mtime`). This is called out so backend-engineer is **not** blocked or invoked for round 1. See §8.
- **Live-preview pipeline impact:** **none.** The settings panel is a sibling DOM overlay mounted on `#app`, outside the CodeMirror editor. It does **not** push Specs, does **not** add decorations, does **not** touch `core.ts`, `pickBlockLanding`, `clickEntry`, `BLOCK_SEL`, or the reveal rule. The render-smoke "block deco from StateField" invariant is untouched (no widgets added).
- **The one pipeline coupling:** changing the active theme must re-bake mermaid (theme is baked into its SVGs). This already exists as `themeSetting.subscribe(refreshMermaidTheme + editor.refresh)` in `main.ts:139-142` and is **reused unchanged**. The new theme-JSON apply path still flips `data-theme` (or sets named-theme vars), so the existing mermaid subscription still fires. See §6.

### Files this feature will touch

**New:**
- `/Users/wis/Documents/programming/mermark/src/settings/registry.ts` — `registerSetting(def)` + `groups()`.
- `/Users/wis/Documents/programming/mermark/src/settings/theme-schema.ts` — `Theme` JSON type, built-in `dark`/`light` themes (from `styles.css`/`DESIGN.md`), `parseTheme(raw): Theme | null`, `serializeTheme(t): string`, `themeToVars(t): Record<string,string>`.
- `/Users/wis/Documents/programming/mermark/src/settings/sinks.ts` — `cssVarSink(varName, format?)` and `themeVarsSink()` (fan a token map onto `documentElement`).
- `/Users/wis/Documents/programming/mermark/src/settings/panel/modal.ts` — `mountSettingsButton(bar)` + modal open/close (ESC, backdrop, focus trap), sidebar(groups) + pane build, live re-render via `setting.subscribe`.
- `/Users/wis/Documents/programming/mermark/src/settings/panel/controls.ts` — RENDER dispatch table (`segmented`/`select`/`slider`/`json`/`info`).
- `/Users/wis/Documents/programming/mermark/tests/settings-registry.test.ts`, `tests/settings-theme-schema.test.ts`, `tests/settings-controls.test.ts` — new unit tests.

**Edited:**
- `/Users/wis/Documents/programming/mermark/src/settings/store.ts` — add optional DOM-free `ui` field to `SettingDef<T>` (storage ignores it).
- `/Users/wis/Documents/programming/mermark/src/settings/app.ts` — migrate `themeSetting`→`registerSetting` (group "테마"); add `themeJsonSetting` (the JSON SSOT, see §3), `fontFamilySetting`, `fontSizeSetting`, `readingWidthSetting`, `lineHeightSetting`, mermaid `panZoomSetting`/`themeForceSetting`. `mode` stays `defineSetting` (no `ui`).
- `/Users/wis/Documents/programming/mermark/src/theme.ts` — extend `applyTheme` to also set token vars (or add `applyThemeVars`); keep the `data-theme` flip for the existing light/dark CSS in `styles.css`.
- `/Users/wis/Documents/programming/mermark/src/main.ts` — call `mountSettingsButton(bar)`; bind the new typography/theme sinks. **No hand fan-out** — bindings are one `setting.bind(sink)` line each.
- `/Users/wis/Documents/programming/mermark/src/styles.css` — introduce `--editor-font-size`, `--measure`, `--line-height` vars (route existing `820px`/`line-height: 1.6` through them); add `.settings-modal`/`.settings-sidebar`/`.settings-pane`/control styles.
- `/Users/wis/Documents/programming/mermark/src/markdown/mermaid-widget.ts` — (round 1) read `panZoomSetting` in `initPanZoom`. (Self-subscription refactor deferred to §9.)

---

## 2. Settings category enumeration (research)

mermark is a single-file Markdown+Mermaid editor/viewer. The panel exposes **everything about the editor as a document viewer**. Categories, ordered as they appear in the sidebar:

| # | Category (sidebar) | Settings | SSOT mapping |
|---|---|---|---|
| 1 | **테마 (Theme)** ★ required | `theme` (segmented dark/light — picks which built-in theme is active) · **`themeJson`** (the active theme as one editable JSON object + import/export) | `themeSetting` (exists, migrate to registry) · **`themeJsonSetting` NEW** (§3) |
| 2 | **타이포그래피 (Typography)** | `fontFamily` (select) · `fontSize` (slider, base body px — note: distinct from the existing `fontScale` ⌘± zoom, which is a transient multiplier; see §2.1) · `readingWidth` (slider) · `lineHeight` (slider) · `headingRatio` (select: 1.2 / 1.25 / 1.333) | `fontFamilySetting` NEW · `fontSizeSetting` NEW · `readingWidthSetting` NEW · `lineHeightSetting` NEW · `headingRatioSetting` NEW |
| 3 | **에디터 (Editor / Behavior)** | `defaultMode` (segmented edit/read — the boot default; the live ⌘E toggle stays in the status bar) · `autosaveDelay` (slider ms) · `conflictPolicy` (segmented: pause / overwrite — currently hardcoded "pause + 강제 저장") | `defaultModeSetting` NEW (boot reads it; `modeSetting` remains the live value) · `autosaveDelaySetting` NEW · `conflictPolicySetting` NEW (round-1: declare + sink-stub; wiring optional) |
| 4 | **Mermaid** (plugin-registered, proves the plugin path) | `panZoom` (segmented on/off) · `themeForce` (segmented: follow-app-theme / always-dark / always-light) | `panZoomSetting` NEW · `themeForceSetting` NEW |
| 5 | **플러그인 (Plugins)** | *(placeholder; empty in round 1)* — any future feature that calls `registerSetting` with its own `ui.group` shows up automatically | n/a — emergent from registry |

★ = user-required. Categories 3–5 are declared but their **sinks may be stubbed** in round 1 (see §10 phasing) — the point is the registry renders them and the SSOT holds them, so wiring each one later is a one-line sink binding, never a panel change.

### 2.1 fontSize vs fontScale (disambiguation — must be in the plan)

- `fontScaleSetting` (exists) = a **transient multiplier** driven by ⌘+/-/0, persisted, applied to `--font-scale` on `.cm-line`. Keep as-is.
- `fontSizeSetting` (new) = the **base body size in px**, set in the panel, applied to `--editor-font-size`.
- styles.css must compose them: `.cm-line { font-size: calc(var(--editor-font-size, 1rem) * var(--font-scale, 1)); }`. The plan must state this so the two don't fight. Default `--editor-font-size` = `1rem` (16px) to preserve current visuals.

---

## 3. Theme = a single JSON document (the headline feature)

### 3.1 Schema

A theme is one plain-data object. All values are strings (CSS color / length / font-stack); the schema is intentionally flat-ish so a user can hand-edit it.

```ts
// settings/theme-schema.ts
export interface Theme {
  name: string;                 // "dark" | "light" | a user name
  colors: {
    bg: string; fg: string; accent: string; link: string;
    surface: string; border: string; muted: string; highlightBg: string;
  };
  radii: { md: string; lg: string; xl: string };   // --radius-md/lg/xl
  font: { sans: string };                            // --font-sans (CSS font stack)
}
```

Token → CSS-var map (the single source of which var each field drives) lives in `themeToVars`:

```ts
export function themeToVars(t: Theme): Record<string, string> {
  return {
    "--bg": t.colors.bg, "--fg": t.colors.fg, "--accent": t.colors.accent,
    "--link": t.colors.link, "--surface": t.colors.surface, "--border": t.colors.border,
    "--muted": t.colors.muted, "--highlight-bg": t.colors.highlightBg,
    "--radius-md": t.radii.md, "--radius-lg": t.radii.lg, "--radius-xl": t.radii.xl,
    "--font-sans": t.font.sans,
  };
}
```

The field set is taken **verbatim from `styles.css:1-28`** (the `:root` token block). Built-in `dark`/`light` themes are constructed from those exact current values so adopting the JSON model causes **zero visual drift** (this is a Golden Master assertion, §7).

### 3.2 The named domain functions (intent-review)

Per the naming discipline, the theme rules are **named functions, not inline `if`s**:

- `parseTheme(raw: string | null): Theme | null` — validate a JSON string into a `Theme` (shape check + every color is a non-empty string). Returns `null` on malformed input → `defineSetting` falls back to the default. **This is the import-validation rule, named once.**
- `serializeTheme(t: Theme): string` — pretty-printed JSON (2-space) so the textarea is human-editable. Used as `defineSetting.serialize`.
- `themeToVars(t): Record<string,string>` — the field→var map above (query, pure).
- `builtInTheme(name: "dark" | "light"): Theme` — the two presets (query, pure).
- `themeVarsSink(): (t: Theme) => void` — the **command** sink: `applyThemeVars(themeToVars(t))` writes every var onto `documentElement`. CQS: void.

### 3.3 SSOT wiring

```ts
// settings/app.ts
export const themeJsonSetting = registerSetting<Theme>({
  key: "mermark.themeJson",
  default: builtInTheme(systemTheme()),
  parse: parseTheme,            // import-validation rule, named
  serialize: serializeTheme,    // pretty JSON for the textarea
  ui: { label: "테마 JSON", group: "테마", control: { kind: "json" } },
});
```

- **Apply path (sink):** `themeJsonSetting.bind(themeVarsSink())` in `main.ts` → on every change, fan the token map onto `documentElement` style. **Single writer, subscribing sinks — no hand fan-out.**
- **Relationship to the existing light/dark `data-theme` toggle:** the segmented `theme` control (`themeSetting`, dark/light) is a **preset picker**. Flipping it calls `themeJsonSetting.set(builtInTheme(newTheme))` (loads that preset into the JSON) **and** keeps `applyTheme` flipping `data-theme` (so the `:root[data-theme="light"]` CSS in styles.css still works as the fallback layer). Inline-set vars from `themeToVars` **win over** the `data-theme` defaults (a set property beats a `:root` rule), so the JSON is the effective source while `data-theme` remains the safety net for any var the JSON doesn't carry. The named function tying these is `loadPreset(theme: Theme): void` (writes `themeJsonSetting` + flips `themeSetting`), so the two stay coherent in one place.
- **Import:** paste JSON into the textarea → on "적용" the control calls `parseTheme`; valid → `themeJsonSetting.set(parsed)` (sink fans vars live, persists to localStorage); invalid → inline error, no set. **Import == a normal `set` through the SSOT**, nothing special.
- **Export:** "복사" copies `serializeTheme(themeJsonSetting.get())` to clipboard; "내려받기" creates a `Blob` + `<a download="theme.json">` (pure frontend, no IPC).

### 3.4 Why JSON-as-one-setting (not N color pickers)

The user asked for "테마를 단일 JSON으로 다뤄 일괄 import/export." One `Theme` value in one `defineSetting` gives: atomic import/export, copy-paste portability, and a trivially-correct apply path (one sink fans all vars). It also keeps the SSOT honest — the theme is **one identity**, persisted under one key, with one writer.

---

## 4. UI structure / implementation path

### 4.1 Surface: modal overlay (not a route)

The app is a single `#app` opened with `?file=`. The settings screen is a **centered modal overlay** mounted as a sibling of the editor host inside `#app`:

- **Why modal, not route:** a route (`?settings`) would tear down the mounted editor (losing the live CM state / unsaved buffer) or require a second mount path. A modal overlays the editor, leaves CM mounted and the document intact, and closes back to exactly where the user was. Matches 06-14's locked decision.
- **DOM:** `mountSettingsButton(bar)` appends a `⚙` `status-btn` to the status bar. Click → build/show `.settings-backdrop` > `.settings-modal` (centered, ~720px) containing `.settings-sidebar` (category list) + `.settings-pane` (controls for the selected category). ESC and backdrop-click close; focus is trapped while open; the editor underneath is `inert`/non-interactive while the modal is up.
- **Sidebar:** `groups()` from the registry → one button per category (insertion order). Clicking a category swaps the pane. First category ("테마") selected on open.
- **Pane:** for each registry entry in the group, `RENDER[entry.ui.control.kind](entry.setting, entry.ui.control)` builds a labeled row.

### 4.2 Cold-load constraint (1st-class)

- **Zero new dependencies.** Plain DOM (`document.createElement`) + `defineSetting` subscriptions. No state library, no reactive framework, no UI kit. (06-13 review: "fast load is a 1st-class constraint.")
- **Lazy build:** the modal DOM is built on first open, not at boot. The `⚙` button and the `setting.bind` sinks are the only boot-time cost (negligible). The JSON `<textarea>` is a native element — no editor library.
- **No web-font downloads** from the font-family select (stacks only), per 06-14.

### 4.3 Control kinds (RENDER dispatch table)

```ts
type Control<T> =
  | { kind: "segmented"; options: { value: T; label: string }[] }
  | { kind: "select";    options: { value: T; label: string }[] }
  | { kind: "slider";    min: number; max: number; step: number; unit?: string }
  | { kind: "json" }      // NEW: textarea + 적용/복사/내려받기 + inline parse error
  | { kind: "info" };     // NEW: read-only row (placeholder categories)
```

Each renderer: builds the control reflecting `setting.get()`, wires input → `setting.set(v)`, and `setting.subscribe(v => reflect)` so external changes update the control live (round-trip). The `json` renderer additionally owns import (parse-on-적용) and export (copy/download) buttons and renders a parse-error message without calling `set`.

---

## 5. SSOT compliance

- **Every setting is one `registerSetting` declaration.** Sinks subscribe; controls are the writers (input → `setting.set`). No preference is fanned out by hand into main.ts or a widget.
- **`defineSetting` stays pure** (storage only, jsdom-testable). The new `ui` field is plain data (`{label, group, control}`) with no DOM. The panel module is the only DOM consumer. `registerSetting` = `defineSetting` for storage + (iff `def.ui`) push `{setting, ui}` to a module-level ordered registry.
- **Adding a setting later** = one `registerSetting(...)` + (if it drives the DOM) one sink binding in main.ts. Nothing in the panel changes — it iterates the registry.
- **Theme apply is a single sink fanning a map**, not N hand-written `setProperty` calls scattered across boot.
- **mermaid theme re-bake** stays the existing `themeSetting.subscribe` path in round 1 (reused, not rewritten). The self-subscription move is §9 (separate, gated by its own Golden Master).

---

## 6. Security & performance

- **No new IPC surface** in round 1 (export is `Blob`, import is textarea/clipboard). CSP, asset-protocol scope, atomic fs write, and the mtime conflict guard are **untouched**. If a file-picker theme import is added later (§8), it reuses `read_file` (already returns `{text, mtime}`; panel uses `text`, ignores `mtime`) and `write_file`'s atomic temp+rename + baseline conflict guard remain the only write path — the panel never writes the user's `.md`.
- **Browser mock:** **no `read_file`/`write_file` signature change in round 1**, so `src/mocks/tauri-core.ts` needs **no edit**. (Plan must reassert this: only touch the mock if §8 file-import is pulled into scope.)
- **Cold-load:** zero new deps; modal DOM built lazily on first open; native `<textarea>` for JSON (no editor lib). Theme apply is a synchronous `setProperty` loop over ~12 vars — cheap.
- **Heavy render:** none added. The only heavy re-render is the *existing* mermaid re-bake on theme change, already cache-clearing via `refreshMermaidTheme` + `bounded-cache`. Reused unchanged.

---

## 7. Reuse map

| Need | Reuse (existing) | New |
|---|---|---|
| SSOT primitive | `defineSetting` (`store.ts`) | thin `registerSetting` wrapper |
| Theme dark/light value | `themeSetting`, `systemTheme()` (`app.ts`/`theme.ts`) | migrate to registry; add `themeJsonSetting` |
| DOM theme apply | `applyTheme` (`theme.ts`, flips `data-theme`) | extend with `applyThemeVars(map)` / `themeVarsSink()` |
| Token field set | `styles.css:1-28` `:root` block + `DESIGN.md` | `builtInTheme()` constructed from those exact values |
| Body scale | `fontScaleSetting` + `applyFontScale` (keep) | `fontSizeSetting` + `--editor-font-size` (compose, §2.1) |
| Mermaid theme re-bake | `refreshMermaidTheme` + `themeSetting.subscribe` (`main.ts`/`mermaid-widget.ts`) | reused; self-subscription deferred (§9) |
| Status-bar button pattern | `makeThemeToggle`/`makeModeToggle` (`main.ts`/`theme.ts`) | `mountSettingsButton` follows the same `status-btn` pattern |
| File import (deferred) | `read_file` command (returns `{text, mtime}`) | none — reused as-is if §8 lands |

**Nothing new is built where an existing asset suffices.** No new widget, no new parser node, no new Tauri command.

---

## 8. Backend / branch decision (explicit)

- **Round 1: frontend-only. Backend-engineer is NOT needed.** State this in the handoff so backend isn't idled-waiting or invoked.
- Theme import/export is clipboard + textarea + Blob download — no disk, no IPC.
- **Deferred (waiting list):** "import theme from a `.json` file via OS file picker." If pulled in, it is a **frontend-only** addition that calls the existing `read_file` (no signature change → **no `tauri-core.ts` mock edit**). Only if a brand-new command were added would backend + mock sync be required — and round 1 adds none.

---

## 9. Mermaid self-subscription (carried from 06-14, scoped to its own step)

The 06-14 spec's item 3 (mermaid self-subscribes to theme; remove the `main.ts` `refreshMermaidTheme` wiring) is **valuable but orthogonal** to the theme-JSON work, and carries the spec's highest-rated risk (ordering: cache-clear/version-bump must run **before** the editor block redraw or widgets redraw stale). To keep the new theme-JSON change low-risk:

- **Round 1 keeps the existing `main.ts` `themeSetting.subscribe(refreshMermaidTheme + editor.refresh)` wiring as-is.** The new `themeVarsSink` runs alongside it (both subscribe to their respective settings; on a preset flip both `themeSetting` and `themeJsonSetting` change).
- **Ordering note for the plan:** `themeVarsSink` (vars) and `refreshMermaidTheme` (re-bake) are independent — vars set CSS, re-bake regenerates SVGs. Order between them doesn't matter for correctness; what matters (and is preserved) is that `refreshMermaidTheme` runs **before** `editor.refresh()`, which the existing single subscriber already guarantees by calling them in sequence.
- The self-subscription refactor is a **separate, later step** with its own Golden Master (theme switch → mermaid re-bakes correctly). Do not fold it into round 1.

---

## 10. Phased implementation plan (overview for `writing-plans` / next mermark-dev run)

All steps are **frontend-engineer** (no backend). TDD: red test first.

**Step A — Registry + `ui` field (skeleton).**
- `store.ts`: add optional `ui` to `SettingDef` (storage ignores it). `registry.ts`: `registerSetting` + `groups()`.
- RED: `tests/settings-registry.test.ts` — `registerSetting` with `ui` adds to a group; without `ui` does not; group order = insertion order; storage behavior unchanged.

**Step B — Theme schema (the headline).**
- `theme-schema.ts`: `Theme`, `builtInTheme`, `parseTheme`, `serializeTheme`, `themeToVars`. `sinks.ts`: `themeVarsSink`/`cssVarSink`. `theme.ts`: `applyThemeVars`.
- RED: `tests/settings-theme-schema.test.ts` — `parseTheme` accepts a valid theme JSON and rejects malformed (→ null); `serializeTheme`∘`parseTheme` round-trips; `themeToVars` maps every field to the right `--var`; `builtInTheme("dark"/"light")` equals the current styles.css values.

**Step C — Controls + modal.**
- `controls.ts` (`segmented`/`select`/`slider`/`json`/`info`), `panel/modal.ts` (button, open/close, sidebar+pane).
- RED: `tests/settings-controls.test.ts` — each `RENDER[kind]` reflects `setting.get()`, an input event calls `setting.set` with the right value, and `setting.subscribe` updates the control live. For `json`: a valid paste → `set`; malformed paste → error, no `set`; export produces `serializeTheme(get())`.

**Step D — Wire app.ts + main.ts + styles.css.**
- Migrate `themeSetting` to registry; add `themeJsonSetting` (+ `loadPreset`); add Typography settings; declare Editor/Mermaid/Plugins categories (sinks stubbed where noted). `main.ts`: `mountSettingsButton(bar)`, bind sinks. `styles.css`: `--editor-font-size`/`--measure`/`--line-height` vars + modal styles.
- RED: extend `tests/settings-app.test.ts` — `themeJsonSetting` defaults to the system preset, persists under `mermark.themeJson`, parses a saved JSON; `loadPreset` writes both `themeJsonSetting` and `themeSetting`.

**Step E — Typography/Editor/Mermaid sinks (round-1 subset).**
- Bind `fontFamily`/`fontSize`/`readingWidth`/`lineHeight` to their CSS-var sinks. Mermaid `panZoom` consulted in `initPanZoom`. (Editor `defaultMode`/`autosaveDelay`/`conflictPolicy` may declare-only + stub-sink this round.)

**Deferred (waiting list):** mermaid theme self-subscription (§9), file-picker theme import (§8), advanced per-token color picker (the dropped 06-14 Colors), per-theme overrides, settings search/keyboard-nav, full plugin lifecycle.

---

## 11. Testing & Golden Master surface

**Unit (vitest / jsdom):**
- `tests/settings-registry.test.ts` (Step A asserts).
- `tests/settings-theme-schema.test.ts` (Step B asserts — parse/serialize round-trip, var map, built-in == current values).
- `tests/settings-controls.test.ts` (Step C asserts — control round-trip, JSON import/export, malformed-no-set).
- `tests/settings-app.test.ts` (EXTEND — themeJson default/persist/parse, loadPreset).
- **render-smoke.test.ts is unaffected** (no live-preview change) — but the plan must run it as a regression guard to prove the panel didn't perturb the editor.

**Golden Master (CDP, `scripts/`):**
- **`scripts/settings-golden.mjs` (EXTEND)** — the primary gate. New scenario: open `⚙` → switch sidebar category → for Theme: paste a modified theme JSON → 적용 → assert the corresponding `--var`s on `documentElement` changed, `localStorage["mermark.themeJson"]` persisted, reload restores it; flip dark/light preset → assert `data-theme` + vars track and **mermaid re-bakes** (existing assertion reused). Assert `errors: []` and the **zero-drift invariant**: with no edits, adopting the JSON theme produces byte-identical `--var` values to before (built-in == current).
- **`scripts/mermaid-golden.mjs`** — applies because preset flip re-bakes mermaid; assert the diagram re-renders for the new theme (no invisible-SVG regression — the historical theme bug).
- **`scripts/nav-trace.mjs` / `cdp-debug.mjs`** — **not applicable** (no cursor/motion/block-entry change).
- **Mock update needed:** **No** (no `read_file`/`write_file` signature change in round 1).

**Verify commands:** `npm test` (vitest) · `tsc --noEmit` · `node scripts/settings-golden.mjs` + `node scripts/mermaid-golden.mjs` (with `npm run dev:browser` + Chrome `:9222`). **No `cargo test`** (no backend change).

---

## 12. Risks

1. **Zero-drift on adopting JSON theme** — `builtInTheme("dark"/"light")` must equal the exact `styles.css:1-28` values, or every user sees a color shift on first load. Gate with the Golden Master zero-drift assertion (§11). Plan reads styles.css to capture exact values.
2. **`data-theme` vs inline-var layering** — inline `setProperty` from `themeToVars` wins over `:root[data-theme]` rules; confirm no var is set by JSON yet *also* expected to follow `data-theme` independently (it isn't — JSON carries all of them). Documented; verified by the preset-flip Golden Master.
3. **fontSize × fontScale composition** (§2.1) — if styles.css doesn't compose both, panel font-size and ⌘± zoom fight. Plan pins the `calc()` and the `1rem` default.
4. **Scope creep** — categories 3–5 are declared-but-stubbed by design; resist wiring all of them in round 1. The registry makes later wiring a one-liner, so deferring costs nothing.

---

## 13. Self-check

- [x] Classified: setting + frontend UI module; **no** parser/inline/block/Tauri-command.
- [x] Live-preview invariants (StateField blocks, reveal rule, clickEntry/BLOCK_SEL, pickBlockLanding) **untouched** — explicitly, the panel is outside CM.
- [x] SSOT honored — every setting one `registerSetting`; theme apply is one sink fanning a map; no hand fan-out.
- [x] Reuse-first — `defineSetting`, `themeSetting`, `applyTheme`, `refreshMermaidTheme`, `read_file` (deferred), `status-btn` pattern.
- [x] Backend branch decided: **frontend-only round 1**; backend-engineer not needed; mock unchanged.
- [x] Named domain functions specified (`parseTheme`, `serializeTheme`, `themeToVars`, `builtInTheme`, `loadPreset`, `themeVarsSink`) — rules have names, not inline ifs.
- [x] Cold-load: zero new deps, lazy modal, native textarea.
- [x] 2026-06-14 delta documented (§0): inherit skeleton, replace Colors-as-4-pickers with Theme-as-JSON, scope-out mermaid self-subscription.
- [x] Testing + Golden Master surface enumerated; zero-drift invariant gated.
