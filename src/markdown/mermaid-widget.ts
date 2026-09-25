import { WidgetType } from "@codemirror/view";
import { boundedCache } from "./bounded-cache";
import { panZoomSetting, themeForceSetting, themeJsonSetting } from "../settings/app";
import { builtInTheme, type Theme as ThemeJson } from "../settings/theme-schema";
import type { Theme } from "../theme";
import { icon } from "../icons";
import { attachPanZoom } from "../pan-zoom";

type Mermaid = typeof import("mermaid").default;
type MermaidTheme = "dark" | "default";

/** The "which mermaid theme do we render with" rule in one named place. The app
 *  theme is the baseline (light → mermaid "default", dark → "dark"), but the
 *  themeForce setting overrides it: `dark`/`light` pin the diagram theme
 *  regardless of the app, `follow` (default) tracks the app. Both loadMermaid
 *  and refreshMermaidTheme route through here so the rule lives once. Pure. */
export function effectiveMermaidTheme(appTheme: Theme): MermaidTheme {
  switch (themeForceSetting.get()) {
    case "dark":
      return "dark";
    case "light":
      return "default";
    default:
      return appTheme === "light" ? "default" : "dark";
  }
}

/** Which palette mermaid's themeVariables should derive from: the SSOT
 *  themeJsonSetting normally (so a custom JSON theme — and live swatch edits —
 *  are followed automatically), but a themeForce pin overrides it with that
 *  preset's own built-in palette regardless of the live JSON theme, mirroring
 *  effectiveMermaidTheme's override branch so both rules agree. `appTheme` is
 *  unused in the "follow" branch (the JSON theme alone decides) but kept in
 *  the signature — prefixed `_` — for symmetry with effectiveMermaidTheme/
 *  mermaidThemeVariables, which every call site already threads through. Pure
 *  query. */
export function mermaidPaletteSource(_appTheme: Theme): ThemeJson["colors"] {
  switch (themeForceSetting.get()) {
    case "dark":
      return builtInTheme("dark").colors;
    case "light":
      return builtInTheme("light").colors;
    default:
      return themeJsonSetting.get().colors;
  }
}

/** True for pure white in any of the forms a theme's surface color might use
 *  (`#fff`, `#ffffff`, `white`), case-insensitively. Pure query. */
export function isPureWhite(color: string): boolean {
  const c = color.trim().toLowerCase();
  return c === "#fff" || c === "#ffffff" || c === "white";
}

/** Channel-wise 50% linear blend of two '#rrggbb' hex colors. Assumes 6-digit
 *  hex input for BOTH arguments — callers must normalize first (isPureWhite
 *  accepts `#fff`/`white` too, which this function cannot parse; see
 *  mermaidNodeFill, which passes the canonical "#ffffff" rather than the
 *  original surface string). Pure query, the shared math mermaidNodeFill uses
 *  to derive its tint. */
function mixHex(a: string, b: string): string {
  const mix = (i: number) => {
    const ca = parseInt(a.slice(1 + i * 2, 3 + i * 2), 16);
    const cb = parseInt(b.slice(1 + i * 2, 3 + i * 2), 16);
    return Math.round((ca + cb) / 2)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${mix(0)}${mix(1)}${mix(2)}`;
}

/** Domain rule (2026-07-12 design-polish pass ⑤, tour-02): a pure-white
 *  `surface` floats off the canvas as a mermaid node fill, so nodes built from
 *  it are tinted halfway toward `bg` instead of used verbatim. Themes whose
 *  surface is already tinted (claude `#efe9de`, dark `#1c1917`) pass through
 *  unchanged — this is a palette-shape rule, not a per-theme branch, so a
 *  custom JSON theme with a pure-white surface gets the same treatment. Pure
 *  query. */
export function mermaidNodeFill(colors: ThemeJson["colors"]): string {
  // isPureWhite(colors.surface) being true only proves whiteness, not that
  // colors.surface is itself 6-digit hex ("#fff"/"white" also pass it) — mix
  // the canonical "#ffffff" instead of the original string so mixHex always
  // gets input it can parse.
  return isPureWhite(colors.surface) ? mixHex("#ffffff", colors.bg) : colors.surface;
}

/** Mermaid `themeVariables`, derived from the app's theme SSOT via
 *  mermaidPaletteSource — so diagrams pick up the surrounding canvas/ink/border
 *  palette instead of mermaid's own default purple. edgeLabelBackground = bg
 *  is the direct fix for the grey label chip that otherwise occludes
 *  connecting lines (it becomes canvas-colored, so the line just breaks under
 *  it instead of showing a floating grey pill). Pure query. */
export function mermaidThemeVariables(appTheme: Theme): Record<string, string | boolean> {
  const colors = mermaidPaletteSource(appTheme);
  const nodeFill = mermaidNodeFill(colors);
  return {
    darkMode: effectiveMermaidTheme(appTheme) === "dark",
    background: colors.bg,
    primaryColor: nodeFill,
    primaryTextColor: colors.fg,
    primaryBorderColor: colors.muted,
    lineColor: colors.muted,
    secondaryColor: nodeFill,
    tertiaryColor: colors.bg,
    edgeLabelBackground: colors.bg,
    fontFamily: '"Inter", system-ui, sans-serif',
  };
}

// The last app theme passed to refreshMermaidTheme, remembered so the themeForce
// self-subscription can re-bake without main.ts handing it the app theme again.
let lastAppTheme: Theme = "dark";

// Mermaid is ~1.3MB — load it only when the first diagram renders.
let mermaidLoader: Promise<Mermaid> | null = null;
function loadMermaid(): Promise<Mermaid> {
  if (!mermaidLoader)
    mermaidLoader = import("mermaid").then(({ default: m }) => {
      const appTheme: Theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
      lastAppTheme = appTheme;
      m.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        themeVariables: mermaidThemeVariables(appTheme),
      });
      return m;
    });
  return mermaidLoader;
}

// SVG cache keyed by diagram source: reveal/unreveal cycles and scrolling
// must not re-run the mermaid renderer.
const svgCache = boundedCache<string, string>(50);

let idSeq = 0;

/** The single dispatch point for entering mermaid fullscreen: a bubbling
 *  CustomEvent carrying the diagram's rendered SVG markup (`svg.outerHTML`,
 *  already themed — self-contained, needs no extra context to redraw). The
 *  markdown layer must not import chrome (layering rule), so this is the
 *  widget's entire contribution — chrome/main.ts is the one listener that
 *  turns it into the actual lightbox, mirroring how `mermaid-rendered`
 *  already crosses that same boundary. Command (void). */
function dispatchOpenFullscreen(host: HTMLElement, svg: SVGSVGElement): void {
  host.dispatchEvent(
    new CustomEvent("mermaid-open-fullscreen", { bubbles: true, detail: { svgHtml: svg.outerHTML } }),
  );
}

// Bumped whenever the theme changes. Mermaid bakes theme colors into the SVG,
// so a theme switch must re-render every diagram; widgets compare this version
// in eq() so CM redraws them even though the source code is unchanged.
let themeVersion = 0;

/** Re-theme mermaid live (no page reload): clear the cache, re-init mermaid with
 *  the effective theme, and bump the version so widgets re-render. The app theme
 *  is passed in (a SSOT sink) rather than pulled from the DOM, and remembered so
 *  the themeForce self-subscription can re-bake with it. */
export function refreshMermaidTheme(theme: Theme) {
  lastAppTheme = theme;
  themeVersion++;
  svgCache.clear();
  if (mermaidLoader) {
    mermaidLoader.then((m) =>
      m.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        themeVariables: mermaidThemeVariables(theme),
      }),
    );
  }
}

// themeForce is a mermaid-domain rule, so the widget layer owns its re-bake:
// when the user pins/unpins the diagram theme, re-bake against the last app
// theme. The redraw dispatch (refreshBlocks) is main.ts's job since only it
// holds the editor handle — main stays free of mermaid theme knowledge.
themeForceSetting.subscribe(() => refreshMermaidTheme(lastAppTheme));

// Height of the most recently rendered diagram. When a re-render misses the
// cache (the source was edited), we reserve this height on the new host while
// mermaid renders async, so leaving the block doesn't collapse the box to 0 and
// jump the page. Cleared once the real height is set.
let lastHeight = 0;

/** Explicit pixel size declared on the diagram's first line (`300, 400`); `null`
 *  on an axis means "use natural size". Parsed in features/mermaid.ts. */
export interface MermaidDims {
  width: number | null;
  height: number | null;
}

export class MermaidWidget extends WidgetType {
  readonly version = themeVersion; // captured at construction; see refreshMermaidTheme
  // Snapshot the pan/zoom setting at construction so a live toggle makes eq()
  // false → CM re-creates the host → attachPanZoom re-runs with the new value.
  // (refreshBlocks alone wouldn't redraw an eq()-equal widget.)
  readonly panZoom = panZoomSetting.get();
  constructor(
    readonly code: string,
    readonly dims: MermaidDims = { width: null, height: null },
  ) {
    super();
  }
  eq(o: MermaidWidget) {
    return (
      o.code === this.code &&
      o.version === this.version &&
      o.panZoom === this.panZoom &&
      o.dims.width === this.dims.width &&
      o.dims.height === this.dims.height
    );
  }
  toDOM(): HTMLElement {
    const host = document.createElement("div");
    host.className = "cm-mermaid";
    applyDimensions(host, this.dims);
    const cached = svgCache.get(this.code);
    if (cached !== undefined) {
      this.applySvg(host, cached);
    } else {
      // reserve the last diagram's height so the box doesn't collapse (and jump
      // the page) during the async render after an edit
      if (lastHeight) host.style.minHeight = `${lastHeight}px`;
      loadMermaid()
        .then((mermaid) => mermaid.render(`mmd-${idSeq++}`, this.code))
        .then(({ svg }) => {
          svgCache.put(this.code, svg);
          this.applySvg(host, svg);
        })
        .catch((err) => {
          host.style.minHeight = "";
          host.innerHTML = "";
          const pre = document.createElement("pre");
          pre.className = "cm-mermaid-error";
          pre.textContent = `Mermaid error: ${err?.message ?? err}\n\n${this.code}`;
          host.appendChild(pre);
        });
    }
    return host;
  }
  private applySvg(host: HTMLElement, svg: string) {
    host.innerHTML = svg;
    const el = host.querySelector<SVGSVGElement>("svg");
    if (!el) return;
    // The fullscreen button lives HERE, not inside attachPanZoom: attachPanZoom
    // early-returns when panZoomSetting is "off", but fullscreen is a viewer
    // affordance independent of that setting — it must exist either way.
    const fullscreenBtn = document.createElement("button");
    fullscreenBtn.type = "button";
    fullscreenBtn.className = "cm-mermaid-fullscreen";
    fullscreenBtn.title = "전체화면";
    fullscreenBtn.setAttribute("aria-label", "전체화면");
    fullscreenBtn.appendChild(icon("maximize"));
    // Swallow the button's own mousedown so a click can't also start a host
    // pan drag (same reasoning as attachPanZoom's onResetMouseDown in ../pan-zoom.ts).
    fullscreenBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    fullscreenBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      dispatchOpenFullscreen(host, el);
    });
    host.appendChild(fullscreenBtn);
    // No matching cleanup in destroy(): the button and both listeners are
    // scoped to `host` (never window/document), so when CM discards this host
    // (re-render/unmount) the button and its listeners are garbage-collected
    // along with it — unlike attachPanZoom's window mousemove/mouseup, which
    // DOES need an explicit remove.
    //
    // CSS transform doesn't change the layout box, so the SVG keeps its natural
    // (or column-capped) size and the host auto-fits it: no height pin needed.
    // Attach the pan/zoom handler synchronously (no laid-out gate required — the
    // handler reads geometry lazily per-event, not at attach time).
    (host as unknown as { __pz?: { destroy(): void } }).__pz = attachPanZoom(host, el);
    // One rAF later the host has laid out: record its rendered height as the
    // anti-jump placeholder for the NEXT async render, and drop any reserved
    // minHeight now that the real diagram is present.
    requestAnimationFrame(() => recordRenderedHeight(host));
    // Click-to-edit is handled centrally in live-preview/core (a capture-phase
    // listener), so the widget stays mode-agnostic.
    host.dispatchEvent(new CustomEvent("mermaid-rendered", { bubbles: true }));
  }
  ignoreEvent() {
    return true;
  }
  destroy(dom: HTMLElement): void {
    const pz = (dom as unknown as { __pz?: { destroy(): void } }).__pz;
    try {
      pz?.destroy();
    } catch {
      /* already gone */
    }
  }
}

/** Apply an explicit pixel size declaration to the host. A declared axis pins
 *  the host to that many px and lets it scroll if the diagram overflows; an
 *  undeclared axis (`null`) is left to natural sizing + the CSS column cap. */
function applyDimensions(host: HTMLElement, dims: MermaidDims): void {
  if (dims.width !== null) {
    host.style.width = `${dims.width}px`;
    host.style.overflowX = "auto";
  }
  if (dims.height !== null) {
    host.style.height = `${dims.height}px`;
    host.style.overflowY = "auto";
  }
}

/** Command: once the diagram has laid out, drop the reserved anti-jump
 *  placeholder (minHeight) and record the host's rendered height so the NEXT
 *  async render (cache miss after an edit) can reserve it and not jump the page.
 *  If offsetHeight is still 0 (jsdom / not yet painted) the placeholder is kept,
 *  preserving the render-smoke 0-height guard. CSS transform doesn't change the
 *  layout box, so host.offsetHeight is the diagram's displayed height. */
export function recordRenderedHeight(host: HTMLElement): void {
  const h = host.offsetHeight;
  if (h > 0) {
    lastHeight = h;
    host.style.minHeight = "";
  }
}
