# Theme Visual Editor & Interactive Markdown Customizer Design Spec

**Date:** 2026-06-23  
**Status:** Approved by User  
**Goal:** Implement a high-fidelity visual theme customizer in the settings panel that displays live markdown elements (H1-H6, bold, italic, code, highlight) dynamically rendered with their active colors, allows picking colors for each element, resolves layout squeezing, synchronizes preset settings, and maintains backward compatibility.

---

## 1. Requirements & User Experience (UX)

### Layout & UI Adjustments
- **Squeezing Fix**: Set `.theme-editor .settings-row-control` to a vertical column flex layout (`flex-direction: column; align-items: stretch; gap: 1.2em; width: 100%;`) so the color picker grid and the advanced JSON accordion stack vertically instead of squeezing side-by-side.
- **Accordion Alignment**: Inside the `<details>` JSON accordion, center and stack the `<textarea>` and the button toolbar vertically with clean margins and HSL/accent themes.

### Preset Sync Rule
- In `src/settings/app.ts`, subscribe to `themeSetting`. Whenever a preset is changed ("dark" | "light"), check if the name of `themeJsonSetting.get()` matches the preset. If not, automatically overwrite `themeJsonSetting` with the default `builtInTheme(presetName)`.
- This ensures changing the preset segmented control immediately updates the custom color pickers and visual theme in real-time.

### Interactive Markdown Preview Customizer
- Replace the simple swatch grid with an **Interactive Markdown Preview Grid** (2-column layout).
- Each color element is rendered as a Card containing:
  - An inline markdown preview element showing the actual formatted syntax.
  - A circular color swatch picker (`width: 32px; height: 32px; border-radius: 50%`) reflecting the active element color.
  - Clicking either the card or the circular swatch triggers the native color input.
- **Live Previewing**: Styles in the preview grid are dynamically bound to the CSS variables (e.g., color set to `var(--h1-color)`). When a user picks a color, it updates both the settings preview and the main editor document simultaneously.
- **Color Mappings & Labels**:
  - **Core Colors (Column 1)**:
    - `bg`: "에디터 배경색" (bg preview)
    - `fg`: "기본 본문 글자색" (fg preview)
    - `surface`: "카드 영역 배경색" (surface block)
    - `border`: "테두리선 색상" (border line)
    - `accent`: "강조 요소 색상" (accent badge)
    - `link`: `[[위키링크 (Link)]]` (link preview)
    - `muted`: "보조 텍스트 (Muted)" (muted text)
    - `highlightBg`: `==형광펜 배경색 (Highlight Bg)==` (highlight fill background)
    - `highlight`: `==형광펜 글자색 (Highlight Text)==` (highlight text color)
  - **Markdown Elements (Column 2)**:
    - `h1`: `# 제목 1 (H1)`
    - `h2`: `## 제목 2 (H2)`
    - `h3`: `### 제목 3 (H3)`
    - `h4`: `#### 제목 4 (H4)`
    - `h5`: `##### 제목 5 (H5)`
    - `h6`: `###### 제목 6 (H6)`
    - `bold`: `**굵은 글자 (Bold)**`
    - `italic`: `*기울임꼴 (Italic)*`
    - `code`: `` `인라인 코드 (Code)` ``

---

## 2. Technical Architecture & Schema Extension

### Schema Extension (`src/settings/theme-schema.ts`)
- Extend the `Theme` interface colors with optional properties for headings and text styles to maintain backward compatibility:
```typescript
export interface Theme {
  name: string;
  colors: {
    bg: string;
    fg: string;
    accent: string;
    link: string;
    surface: string;
    border: string;
    muted: string;
    highlightBg: string;
    // New Optional Extended Properties for headings & styles
    h1?: string;
    h2?: string;
    h3?: string;
    h4?: string;
    h5?: string;
    h6?: string;
    bold?: string;
    italic?: string;
    code?: string;
    highlight?: string;
  };
  radii: { md: string; lg: string; xl: string };
  font: { sans: string };
}
```
- In `parseTheme`, map fallback colors for old schemas that lack these keys:
  - `h1`~`h5` & `bold` & `italic` fall back to the parsed `fg` color.
  - `h6` falls back to the parsed `muted` color.
  - `code` falls back to the parsed `accent` color.
  - `highlight` falls back to `#1a1300`.
- Update `themeToVars` to emit the new CSS variables:
  - `--h1-color`, `--h2-color`, `--h3-color`, `--h4-color`, `--h5-color`, `--h6-color`, `--bold-color`, `--italic-color`, `--code-color`, `--highlight-color`.
- Populate preset themes (`dark`/`light` in `builtInTheme`) with explicit values for these colors.

### CSS Styling Updates (`src/styles.css`)
- Bind CSS variables in CodeMirror elements:
  - `.cm-editor .cm-line.cm-h1` ➡️ `color: var(--h1-color)`
  - `.cm-editor .cm-line.cm-h2` ➡️ `color: var(--h2-color)`
  - ... (up to `.cm-h6` ➡️ `color: var(--h6-color)`)
  - `.cm-strong` ➡️ `color: var(--bold-color)`
  - `.cm-em` ➡️ `color: var(--italic-color)`
  - `.cm-inline-code` ➡️ `color: var(--code-color)`
  - `.cm-highlight` ➡️ `color: var(--highlight-color)`
- Add visual indicators (chevrons) for `<details>` summary elements so the collapsible action is visually discoverable.
- Support tabbing focus outlines on hidden color inputs via `:focus-within` on the wrapper circles.

### Subscription Cleanup & Memory Leaks
- Swapping settings categories or closing the settings modal causes controls to rebuild. To avoid memory leaks, keep track of the returned unsubscribe function of `setting.subscribe` in controls. Keep them in a list and expose a teardown/cleanup hook, or clear subscriptions when modal swaps categories.

---

## 3. Test & Verification Plan
- Extend `tests/theme-visual-editor.test.ts` to cover:
  - Swatches rendering for all 18 keys (core + extended headings and styles).
  - Accurate falling back when parsing themes missing extended keys.
  - Clean subscription state teardown.
