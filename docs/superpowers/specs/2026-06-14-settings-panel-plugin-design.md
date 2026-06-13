# Settings Panel + Plugin-Settings API — Design Spec

**Date:** 2026-06-14
**Status:** Approved (brainstorming) — ready for `superpowers:writing-plans`
**Predecessor:** Builds on the Track 2 SSOT settings store (`src/settings/store.ts`, `defineSetting`). Closes architecture-review waiting-list items: *plugin settings registration API* + *mermaid self-registers as a theme sink* (`docs/reviews/architecture-review-2026-06-13.md`).

## Goal

A registry-driven settings panel (modal) where every preference — core or plugin — is declared once and rendered automatically. Delivers the roadmap's settings panel (theme/font/layout/color) and the first-class plugin-settings path, without a heavy state library (fast-load constraint preserved).

## Locked decisions (from brainstorming)

1. **Surface**: a `⚙ 설정` button in the status bar opens a **centered modal** (dimmed backdrop, ESC / outside-click closes). Modal is **720px wide**, two-pane: **left sidebar** = categories, **right pane** = the selected category's controls.
2. **Registry-driven from day one**: all settings declared uniformly; the sidebar's categories come from each setting's `group`; plugins register the same way and may add their own categories.
3. **Settings this round**:
   - **모양 (Appearance)**: theme (segmented dark/light) — migrate the existing `themeSetting` into the registry.
   - **타이포그래피**: font family (select), font size (slider), reading column width (slider).
   - **색상 (Colors)**: theme-token overrides — accent/link, heading, code-block background, quote block. Curated **4 tokens** this round.
   - **Mermaid** (plugin-registered category, proves the plugin path): pan/zoom enable (segmented on/off) + mermaid self-subscribes to theme (item 3).
4. **Control kinds (4)**: `segmented`, `select`, `slider`, `color`.
5. **Color model**: **global override** layered on the active theme. Value = `color | null`; `null` = unset → CSS var untouched → theme default shows through. A set color writes the CSS var (wins over the theme). Reset (`↺`) sets `null`.
6. **`mode` (edit/read)** stays a **status-bar-only** toggle (frequent doc action, not a panel preference). It remains in the SSOT store via `defineSetting` with **no** `ui` metadata, so it is not rendered in the panel.

## Architecture approach (chosen)

**Registry self-describe.** Keep Track 2's `defineSetting` pure (storage only — no DOM, stays jsdom-testable). Add a thin `registerSetting(def)` wrapper: it calls `defineSetting` for storage and, **iff** the def carries `ui` metadata, appends `{ setting, ui }` to an ordered module-level registry. Core and plugins call the identical `registerSetting`. The panel iterates the registry, groups by `ui.group`, and dispatches on `ui.control.kind` to render each control.

Rejected alternatives: (2) two-layer `defineSetting` + separate `describeSetting` — two declaration sites, easy to forget, link by reference; (3) central static manifest — anti-plugin (plugins can't extend a central array without mutating it).

Why this fits: it is the natural extension of the Track 2 SSOT round (one declaration site), the plugin path is byte-identical to the core path, and storage stays pure because `ui` is plain data (`{label, group, control}` with no DOM) — the panel module is the only DOM consumer.

## Module structure

```
src/settings/
  store.ts        (unchanged) defineSetting / Setting<T> / SettingDef<T>
  registry.ts     NEW  registerSetting(def): Setting<T>  + groups(): Group[]
  app.ts          EXTEND  theme(ui)·fontFamily·fontSize·readingWidth·color.* via registerSetting;
                          mode via defineSetting (no ui)
  sinks.ts        NEW  cssVarSink(varName, format?) → (v) => set/clear a CSS var
  panel/
    modal.ts      NEW  ⚙ button + modal open/close (ESC, backdrop), sidebar(groups)+pane build,
                       live re-render of a control's value via setting.subscribe
    controls.ts   NEW  RENDER dispatch table: control.kind → (setting, control) => HTMLElement
src/markdown/
  mermaid-widget.ts  EXTEND  self-register "Mermaid" group + panZoom setting; self-subscribe themeSetting (item 3)
src/main.ts       EXTEND  add ⚙ button to status bar; bind cssVar sinks for typography/colors;
                          REMOVE the theme→refreshMermaidTheme wiring (mermaid now self-subscribes)
src/styles.css    EXTEND  introduce CSS vars the sinks drive (see "CSS variables")
```

## Interfaces

Extend `SettingDef<T>` (in `store.ts`) with an optional, DOM-free `ui` field:

```ts
export interface SettingUI<T> {
  label: string;                 // row label, e.g. "폰트 크기"
  group: string;                 // sidebar category, e.g. "타이포그래피"
  control: Control<T>;
}
export interface SettingDef<T> {
  key: string;
  default: T;
  parse?: (raw: string | null) => T | null;
  serialize?: (v: T) => string;
  ui?: SettingUI<T>;             // NEW — present ⇒ shown in the panel
}
```

`defineSetting` ignores `ui` (storage only). `registry.ts`:

```ts
export interface RegEntry { setting: Setting<unknown>; ui: SettingUI<unknown> }
export interface Group { name: string; entries: RegEntry[] }   // insertion order preserved

export function registerSetting<T>(def: SettingDef<T>): Setting<T>; // defineSetting + (def.ui ? push)
export function groups(): Group[];                                  // ordered groups for the sidebar
```

Control kinds (the dispatch table's domain):

```ts
type Control<T> =
  | { kind: "segmented"; options: { value: T; label: string }[] }
  | { kind: "select";    options: { value: T; label: string }[] }
  | { kind: "slider";    min: number; max: number; step: number; unit?: string } // T = number
  | { kind: "color" };                                                            // T = string | null
```

`controls.ts`:

```ts
const RENDER: Record<Control["kind"], (s: Setting<any>, c: any) => HTMLElement> = {
  segmented, select, slider, color,
};
// each renderer: builds the control reflecting s.get(), wires input → s.set(v),
// and s.subscribe(v => reflect) so external changes update the control live.
```

`sinks.ts`:

```ts
// Drives one CSS custom property off a setting. null/undefined → removeProperty
// (falls back to the theme default — the color override model).
export function cssVarSink(varName: string, format?: (v: unknown) => string): (v: unknown) => void;
```

## Data flow (named paths)

```
declare   registerSetting({ key, default, ui:{label, group, control} })
            → defineSetting(storage)  +  registry.push (iff ui)
open      modal: groups() → sidebar entries (per group) + pane (control.kind → RENDER)
edit      control onChange → setting.set(v)        ← single writer (Track 2 SSOT, unchanged)
apply     setting.subscribe → sink + localStorage  (live, no reload)
            theme → applyTheme; font*/color* → cssVarSink(--var); mermaid → self re-bake
```

Adding a setting = one `registerSetting(...)` + one sink binding. Nothing else.

## Settings table (this round)

| Setting | key | default | group | control | sink |
|---|---|---|---|---|---|
| Theme | `mermark.theme` (exists) | systemTheme | 모양 | segmented dark/light | `applyTheme` (exists) |
| Font family | `mermark.fontFamily` | `"Inter"` | 타이포그래피 | select: Inter / system-ui / serif / mono | `cssVarSink("--font-sans", stack)` |
| Font size | `mermark.fontSize` | current px (read from styles.css) | 타이포그래피 | slider 12–22 step 1, unit px | `cssVarSink("--editor-font-size", px)` |
| Reading width | `mermark.readingWidth` | current measure (≈820) | 타이포그래피 | slider 600–1100 step 20, unit px | `cssVarSink("--measure", px)` |
| Accent/link | `mermark.color.accent` | `null` | 색상 | color | `cssVarSink("--accent")` |
| Heading | `mermark.color.heading` | `null` | 색상 | color | `cssVarSink("--heading")` |
| Code-block bg | `mermark.color.codeBg` | `null` | 색상 | color | `cssVarSink("--code-bg")` |
| Quote | `mermark.color.quote` | `null` | 색상 | color | `cssVarSink("--quote")` |
| Mermaid pan/zoom | `mermark.mermaid.panZoom` | `true` | Mermaid | segmented on/off | mermaid re-bake (refresh blocks) |
| Mode (edit/read) | `mermark.mode` (exists) | read | — (no ui) | — (status bar only) | editor (exists) |

Font family `select` value is a CSS font stack string; options map a label → stack (e.g. `mono` → `ui-monospace, monospace`). No web-font downloads (fast-load).

## Plugin contract + Mermaid (item 3)

A feature/plugin registers its own settings by calling `registerSetting` at module load with a `ui.group` of its choice; that group appears in the sidebar automatically. **Mermaid is the concrete proof**:

1. `mermaid-widget.ts` registers `mermark.mermaid.panZoom` with `ui.group = "Mermaid"` → a "Mermaid" sidebar category with an on/off control. `initPanZoom` consults the setting; toggling it re-renders mermaid blocks.
2. `mermaid-widget.ts` **self-subscribes** to `themeSetting` (clear cache + bump `themeVersion`), replacing the `main.ts` `themeSetting.subscribe(t => { refreshMermaidTheme(t); editor.refresh() })` wiring. `main.ts` keeps only the generic **block-redraw** subscription (`editor.refresh()` on theme change).

**Ordering risk (must be honored in the plan):** the mermaid cache-clear/version-bump must run **before** the editor's block redraw, or widgets redraw with the stale `themeVersion` and `eq()` skips them. Mermaid's self-subscription is registered at module load (during editor-extension construction, before `main.ts` adds its `editor.refresh` subscription), so it fires first. The plan must assert this order with a Golden Master (theme switch → mermaid actually re-bakes).

To keep `defineSetting`/the registry import-side-effect-free for tests, feature self-registration happens in the app/widget modules (already imported only by app code), not in the pure `store.ts`/`registry.ts`.

## Color model details

Each color setting is `string | null` (`parse`: valid CSS hex/color or `null`; `null` when unset). `cssVarSink` sets the property when a color is present and `removeProperty` when `null` — so an unset token falls through to the active theme's value (defined in `:root` / `:root[data-theme="light"]`). The color control shows the resolved swatch (computed style when unset) and a `↺` reset that calls `setting.set(null)`. Overrides are **global** (not per-theme): a set color persists across theme switches; an unset color follows the theme.

## CSS variables

`styles.css` must expose the vars the sinks drive, and existing rules must consume them so changes take effect live:

- `--font-sans` (exists) ← font family.
- `--editor-font-size` (new) — apply to `.cm-content` (or the editor root); default = the current hardcoded size.
- `--measure` (new) — the reading column width; replace the current fixed ≈820px max-width rule.
- `--heading`, `--code-bg`, `--quote` (new color tokens) — add to `:root` and `:root[data-theme="light"]` with defaults equal to today's values, and route the relevant selectors (headings, `.cm-code-line`/code background, blockquote) through them. `--accent` already exists.

The plan reads `styles.css` to capture exact current values as the defaults.

## Testing

**Unit (jsdom):**
- `registry`: `registerSetting` with `ui` adds to a group; without `ui` does not; group order = insertion order; `defineSetting` storage behavior unchanged.
- `controls`: each `RENDER[kind]` builds a control reflecting `setting.get()`, an input event calls `setting.set` with the right value, and `setting.subscribe` updates the control (round-trip).
- `cssVarSink`: sets the property for a value; `removeProperty` for `null`; format applied.

**Golden Master (CDP, `scripts/`):** open ⚙ → for each control (theme, font family, font size, reading width, each color, mermaid pan/zoom): change it → assert the CSS var / DOM / mermaid reflects it, `localStorage` persists, and a reload restores it. Theme switch still re-bakes mermaid (item 3, ordering). Assert before/after invariants + `errors: []`.

## Out of scope (waiting list)

- Full color palette / theme editor (more tokens, per-theme overrides, import/export).
- Per-theme color overrides (this round is global only).
- Settings search, keyboard nav within the panel, settings sync across windows.
- Generalizing the live-preview feature registry into a full plugin manifest/lifecycle (this round adds settings registration only; features still self-register at module load).

## Risks

1. **Mermaid theme-sink ordering** (above) — highest risk; gate with Golden Master.
2. **CSS var retrofit** — routing existing hardcoded styles through new vars without visual drift; defaults must equal current values (Golden Master / visual check).
3. **Color contrast across themes** — a global override may clash in the non-active theme; accepted per the global model (user re-picks). Documented, not engineered around.
