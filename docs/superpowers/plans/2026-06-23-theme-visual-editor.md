# Theme Visual Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a visual theme editor in the settings panel with circular color swatches and a collapsible details panel containing the bulk JSON editor.

**Architecture:**
1. Update `renderJson(setting)` in `src/settings/panel/controls.ts` to construct a visual color picker grid mapping Korean labels to color swatches.
2. Embed the existing JSON editor textarea inside a `<details>` collapsible accordion to clean up settings layout.
3. Apply styling for circular swatches, custom input overlay, CSS grid, and accordion padding in `src/styles.css`.
4. Validate color conversion using a helper `toHex` function inside `src/settings/panel/controls.ts` to ensure color picker inputs receive valid hex strings.

**Tech Stack:** TypeScript, Vanilla CSS, Vitest.

## Global Constraints
- Avoid introducing any local database or global scans.
- Strict Type Safety with explicit `any` where needed in catch blocks.

---

### Task 1: Update renderJson in `src/settings/panel/controls.ts`

**Files:**
- Modify: `src/settings/panel/controls.ts`

**Interfaces:**
- Consumes: `parseTheme`, `serializeTheme`, and `Setting<Theme>`
- Produces: Updated `renderJson` returning custom visual grid and accordion element.

- [ ] **Step 1: Implement `toHex` color utility helper**

Add the helper at the bottom of `src/settings/panel/controls.ts`:
```typescript
/** Convert a CSS color string (hex, rgb, rgba) to '#rrggbb' hex format required by <input type="color">. */
function toHex(color: string): string {
  const trimmed = color.trim().toLowerCase();
  if (trimmed.startsWith("#")) {
    if (trimmed.length === 4) {
      return "#" + trimmed[1] + trimmed[1] + trimmed[2] + trimmed[2] + trimmed[3] + trimmed[3];
    }
    if (trimmed.length >= 7) {
      return trimmed.slice(0, 7);
    }
    return trimmed;
  }
  const match = trimmed.match(/\d+/g);
  if (match && match.length >= 3) {
    const r = Math.min(255, Math.max(0, parseInt(match[0], 10))).toString(16).padStart(2, "0");
    const g = Math.min(255, Math.max(0, parseInt(match[1], 10))).toString(16).padStart(2, "0");
    const b = Math.min(255, Math.max(0, parseInt(match[2], 10))).toString(16).padStart(2, "0");
    return `#${r}${g}${b}`;
  }
  // Default fallback if color is transparent or named
  if (trimmed === "transparent") return "#000000";
  return "#000000";
}
```

- [ ] **Step 2: Replace `renderJson` implementation**

Replace the `renderJson` function in `src/settings/panel/controls.ts` with the visual editor layout:
```typescript
function renderJson(setting: Setting<Theme>): HTMLElement {
  const { row: r, cell } = row("");
  r.classList.add("settings-row-json");
  r.classList.add("theme-editor");

  // 1. Swatch Grid Container
  const grid = document.createElement("div");
  grid.className = "theme-swatch-grid";

  const colorLabels: Record<keyof Theme["colors"], string> = {
    bg: "배경색",
    fg: "글자색",
    surface: "카드 영역",
    border: "테두리색",
    accent: "강조색",
    link: "링크색",
    muted: "보조 글자",
    highlightBg: "형광펜 배경",
  };

  const colorInputs: Record<string, HTMLInputElement> = {};
  const swatchColors: Record<string, HTMLElement> = {};

  const keys = Object.keys(colorLabels) as Array<keyof Theme["colors"]>;

  keys.forEach((key) => {
    const card = document.createElement("div");
    card.className = "theme-swatch-card";

    const wrapper = document.createElement("div");
    wrapper.className = "theme-swatch-wrapper";

    const swatch = document.createElement("div");
    swatch.className = "theme-swatch-color";

    const input = document.createElement("input");
    input.type = "color";
    input.className = "theme-swatch-input";
    input.title = colorLabels[key];

    input.addEventListener("input", () => {
      const activeTheme = setting.get();
      const updatedTheme: Theme = {
        ...activeTheme,
        colors: {
          ...activeTheme.colors,
          [key]: input.value,
        },
      };
      setting.set(updatedTheme);
    });

    wrapper.append(swatch, input);
    colorInputs[key] = input;
    swatchColors[key] = swatch;

    const label = document.createElement("span");
    label.className = "theme-swatch-label";
    label.textContent = colorLabels[key];

    card.append(wrapper, label);
    grid.appendChild(card);
  });

  // 2. Collapsible Advanced JSON Editor Accordion
  const details = document.createElement("details");
  details.className = "theme-advanced";
  const summary = document.createElement("summary");
  summary.className = "theme-advanced-summary";
  summary.textContent = "JSON 직접 편집";
  details.appendChild(summary);

  const ta = document.createElement("textarea");
  ta.className = "settings-json";
  ta.spellcheck = false;
  ta.rows = 8;
  const error = document.createElement("div");
  error.className = "settings-json-error";

  const actions = document.createElement("div");
  actions.className = "settings-json-actions";
  const apply = button("적용", "apply");
  const copy = button("복사", "copy");
  const download = button("내려받기", "download");
  actions.append(apply, copy, download);

  apply.addEventListener("click", () => {
    const parsed = parseTheme(ta.value);
    if (parsed === null) {
      error.textContent = "유효하지 않은 테마 JSON입니다.";
      return;
    }
    error.textContent = "";
    setting.set(parsed);
  });

  copy.addEventListener("click", () => {
    void navigator.clipboard?.writeText(serializeTheme(setting.get()));
  });

  download.addEventListener("click", () => downloadTheme(setting.get()));

  details.append(ta, error, actions);

  // 3. Reflect changes and subscribe
  const reflect = (t: Theme) => {
    keys.forEach((key) => {
      const colorVal = t.colors[key];
      colorInputs[key].value = toHex(colorVal);
      swatchColors[key].style.backgroundColor = colorVal;
    });

    ta.value = serializeTheme(t);
    error.textContent = "";
  };

  reflect(setting.get());
  setting.subscribe(reflect);

  cell.append(grid, details);
  return r;
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Bundles successfully.

---

### Task 2: Add theme editor styles in `src/styles.css`

**Files:**
- Modify: `src/styles.css`

**Interfaces:**
- Produces: CSS rules styling swatch grid, circular inputs, labels, and accordion.

- [ ] **Step 1: Append styles to `src/styles.css`**

Add the styles to the end of `src/styles.css`:
```css
/* Theme Visual Editor */
.theme-editor {
  display: flex;
  flex-direction: column;
  gap: 1.5em;
  width: 100%;
}

.theme-swatch-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1em;
  margin-bottom: 0.5em;
  width: 100%;
}

.theme-swatch-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4em;
}

.theme-swatch-wrapper {
  position: relative;
  width: 44px;
  height: 44px;
}

.theme-swatch-color {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: 1px solid var(--border);
  box-shadow: 0 2px 8px color-mix(in srgb, #000 8%, transparent);
  transition: transform 0.15s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.15s ease;
  pointer-events: none;
}

.theme-swatch-wrapper:hover .theme-swatch-color {
  transform: scale(1.08);
  box-shadow: 0 4px 12px color-mix(in srgb, #000 16%, transparent);
}

.theme-swatch-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
  border: none;
  padding: 0;
  margin: 0;
}

.theme-swatch-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--muted);
  text-align: center;
}

.theme-advanced {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--fg) 2%, transparent);
  overflow: hidden;
}

.theme-advanced-summary {
  padding: 0.8em 1em;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
  list-style: none;
}

.theme-advanced-summary::-webkit-details-marker {
  display: none;
}

.theme-advanced[open] {
  padding-bottom: 1em;
}

.theme-advanced[open] .theme-advanced-summary {
  border-bottom: 1px solid var(--border);
  margin-bottom: 1em;
}

.theme-advanced .settings-json {
  width: calc(100% - 2em);
  margin: 0 1em;
  background: var(--surface);
  border: 1px solid var(--border);
}

.theme-advanced .settings-json-error {
  margin: 0.4em 1.2em;
}

.theme-advanced .settings-json-actions {
  margin: 0 1em;
  display: flex;
  gap: 0.5em;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/styles.css
git commit -m "style: add custom styles for theme visual editor swatches and accordion"
```

---

### Task 3: Write Unit Tests

**Files:**
- Create: `tests/theme-visual-editor.test.ts`

**Interfaces:**
- Consumes: Vitest framework

- [ ] **Step 1: Write `tests/theme-visual-editor.test.ts`**

Create `tests/theme-visual-editor.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RENDER } from "../src/settings/panel/controls";
import { themeJsonSetting } from "../src/settings/app";
import { builtInTheme } from "../src/settings/theme-schema";

describe("Theme Visual Editor", () => {
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
  });

  it("renders 8 swatches with correct Korean labels", () => {
    const el = RENDER.json(themeJsonSetting as any, { kind: "json" } as any);
    host.appendChild(el);

    const swatches = host.querySelectorAll(".theme-swatch-card");
    expect(swatches.length).toBe(8);

    const expectedLabels = [
      "배경색",
      "글자색",
      "카드 영역",
      "테두리색",
      "강조색",
      "링크색",
      "보조 글자",
      "형광펜 배경",
    ];

    swatches.forEach((swatch, idx) => {
      const labelText = swatch.querySelector(".theme-swatch-label")?.textContent;
      expect(labelText).toBe(expectedLabels[idx]);
    });
  });

  it("updates setting value when swatch color picker changes", () => {
    const el = RENDER.json(themeJsonSetting as any, { kind: "json" } as any);
    host.appendChild(el);

    const initialTheme = themeJsonSetting.get();

    // Trigger color change on "bg" color swatch picker (index 0)
    const bgInput = host.querySelector(".theme-swatch-input") as HTMLInputElement;
    expect(bgInput).toBeTruthy();

    bgInput.value = "#ff0000";
    bgInput.dispatchEvent(new Event("input"));

    const updatedTheme = themeJsonSetting.get();
    expect(updatedTheme.colors.bg).toBe("#ff0000");

    // Revert changes
    themeJsonSetting.set(initialTheme);
  });

  it("validates and applies theme when text JSON editing and click Apply", () => {
    const el = RENDER.json(themeJsonSetting as any, { kind: "json" } as any);
    host.appendChild(el);

    const initialTheme = themeJsonSetting.get();

    const textarea = host.querySelector(".settings-json") as HTMLTextAreaElement;
    const applyButton = host.querySelector('[data-act="apply"]') as HTMLButtonElement;
    const errorDiv = host.querySelector(".settings-json-error") as HTMLDivElement;

    // Paste invalid JSON
    textarea.value = "{ invalid json }";
    applyButton.click();

    expect(errorDiv.textContent).toBe("유효하지 않은 테마 JSON입니다.");
    expect(themeJsonSetting.get()).toEqual(initialTheme);

    // Paste valid JSON
    const customTheme = builtInTheme("light");
    customTheme.colors.bg = "#f0f0f0";
    textarea.value = JSON.stringify(customTheme);
    applyButton.click();

    expect(errorDiv.textContent).toBe("");
    expect(themeJsonSetting.get().colors.bg).toBe("#f0f0f0");

    // Revert changes
    themeJsonSetting.set(initialTheme);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm test tests/theme-visual-editor.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/theme-visual-editor.test.ts
git commit -m "test: write integration test suite for theme visual editor"
```
