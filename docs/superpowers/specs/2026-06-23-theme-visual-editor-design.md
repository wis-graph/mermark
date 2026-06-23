# Theme Visual Editor Design Spec

**Date:** 2026-06-23  
**Status:** Approved by User  
**Goal:** Replace the raw JSON theme textarea setting control with a beautiful visual theme color editor consisting of a color swatch grid (visual-only, no text box) and a collapsible advanced JSON editor accordion.

---

## 1. Requirements & User Experience (UX)

### Swatch Grid (Visual Editor)
- Grid layout: CSS Grid displaying the 8 theme colors in a 4x2 grid.
- Each grid card contains:
  - A large circular color swatch (`width: 44px; height: 44px; border-radius: 50%`) reflecting the active theme color value.
  - Clicking the swatch opens the browser's native color picker (`<input type="color">`).
  - An HSL/color-mix border around the swatch to maintain contrast on identical backgrounds.
  - A friendly Korean label centered below the swatch.
- Label Mapping:
  - `bg`: "배경"
  - `fg`: "글자"
  - `surface`: "카드 영역"
  - `border`: "테두리"
  - `accent`: "강조색"
  - `link`: "링크색"
  - `muted`: "보조 글자"
  - `highlightBg`: "형광펜 배경"
- Interaction: Whenever a color picker changes, update the specific color field in the theme, validate it, and call `setting.set(newTheme)` immediately for real-time application theme preview.

### Collapsible Advanced JSON Editor
- An accordion element using `<details class="theme-advanced">` with `<summary class="theme-advanced-summary">JSON 직접 편집</summary>`.
- Inside the accordion:
  - A `<textarea class="settings-json" rows="8">` containing the serialized theme JSON.
  - A horizontal button bar below the textarea containing three flat, premium-style buttons:
    - **[적용]** (Apply): Validates textarea contents and sets `themeJsonSetting`. Shows an inline error message if JSON is invalid.
    - **[복사]** (Copy): Copies current theme JSON to the clipboard.
    - **[내려받기]** (Download): Triggers a download of `theme.json`.

---

## 2. Technical Architecture & File Changes

### `src/settings/panel/controls.ts`
- Modify `renderJson(setting: Setting<Theme>): HTMLElement`:
  - Build the visual editor DOM.
  - Construct the 8 color swatches by mapping over theme colors. Add change listeners that rebuild the `Theme` object and invoke `setting.set(theme)`.
  - Construct the `<details>` accordion.
  - Put the textarea, error label, and action buttons (`apply`, `copy`, `download`) inside the accordion.
  - Subscribe to settings changes:
    - Update both the swatches (background color of the swatch circles) and the textarea values to stay synchronized in case of external preset/theme changes.

### `src/styles.css`
- Add CSS classes for:
  - `.theme-editor`: Flex column container.
  - `.theme-swatch-grid`: Grid for swatches.
  - `.theme-swatch-card`: Flex column aligning swatch and label.
  - `.theme-swatch-wrapper`: Position relative container for color input.
  - `.theme-swatch-color`: Custom circular swatch rendering.
  - `.theme-swatch-input`: Invisible color input overlaying the swatch.
  - `.theme-swatch-label`: Centered label typography.
  - `.theme-advanced`: Accordion styles.
  - `.theme-advanced-summary`: Summary marker styles.

---

## 3. Test & Verification Plan

### Test File: `tests/theme-visual-editor.test.ts`
- Mount the theme visual editor using `RENDER.json`.
- Verify it renders 8 color swatches with matching labels.
- Verify that changing a swatch's color value triggers `setting.set` with the updated theme color configuration.
- Verify the `<details>` accordion contains the textarea and action buttons.
- Verify that entering invalid JSON inside the textarea and clicking "적용" displays an error message and does not update the setting.
- Verify that entering valid JSON inside the textarea and clicking "적용" updates the setting successfully.
