import { icon, type IconName } from "../../icons";
import { MATERIAL_EXT_TO_ICON, MATERIAL_FILENAME_TO_ICON, MATERIAL_DEFAULT_ICON } from "./material-icons.generated";

// ---------------------------------------------------------------------------
// Runtime consumer of the vendored Material Icon Theme subset
// (material-icons.generated.ts + ./material-icons/*.svg). PER-ICON lazy
// loading, not one big bundle: `import.meta.glob` gives Vite one code-split
// chunk PER .svg file, so a folder listing with a dozen distinct file types
// fetches a dozen tiny chunks (median ~500B) instead of the whole 480KB
// vendored set — and every chunk Vite already fetched is served from the
// module cache on repeat renders (folder re-expand, search re-query), so
// this file's own `iconSvgCache` only exists to skip that microtask, not to
// dedupe network work.
//
// Unlike src/icons.ts's Lucide set, these SVGs carry their OWN baked
// `fill="#..."` colors (Material Icon Theme's whole visual identity) — they
// are NOT stroke=currentColor glyphs, so callers must never expect
// DESIGN.md's `color` token to recolor them (see styles.css's
// `.explorer-glyph .icon` rule, which only sizes, never recolors).
// ---------------------------------------------------------------------------

/** Extension-or-name → icon id, PER-ID lazy loader. Each entry resolves
 *  directly to the raw <svg>...</svg> markup (query: "?raw") the moment it's
 *  invoked; Vite statically discovers every ./material-icons/*.svg at build
 *  time, so no id list needs to be hand-maintained here — regenerating the
 *  vendored set (scripts/generate-material-icons.mjs) is enough to keep this
 *  glob in sync. */
const rawLoaders = import.meta.glob<string>("./material-icons/*.svg", {
  query: "?raw",
  import: "default",
});

function loaderFor(iconId: string): (() => Promise<string>) | undefined {
  return rawLoaders[`./material-icons/${iconId}.svg`];
}

/** icon id → already-fetched raw SVG markup. Populated as loaders resolve;
 *  never evicted (585 ids × ~840B decoded ceiling is trivial to keep warm
 *  for a session, and eviction would just re-trigger the ES module cache
 *  hit anyway — see file banner). */
const iconSvgCache = new Map<string, string>();

/** The FILE icon id for `name` — exact filename match first (Dockerfile,
 *  .gitignore, package.json: these beat extension-based guessing), then
 *  extension, then Material's own generic-file id. Pure query; mirrors
 *  file-icons.ts's `extensionOf` case-insensitivity by lowercasing here
 *  too (this module intentionally doesn't import extensionOf from
 *  file-icons.ts, which imports back from here — see renderEntryGlyph's
 *  doc comment for why the two modules stay a one-way dependency). */
function materialIconIdFor(name: string): string {
  const lower = name.toLowerCase();
  const byName = MATERIAL_FILENAME_TO_ICON[lower];
  if (byName) return byName;
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 && dot < lower.length - 1 ? lower.slice(dot + 1) : "";
  return MATERIAL_EXT_TO_ICON[ext] ?? MATERIAL_DEFAULT_ICON;
}

/** Stamp `raw` SVG markup into `el`, sized/classed to match every other
 *  glyph in the sidebar (`.icon` sizing rules in styles.css apply to any
 *  element carrying that class, Lucide or Material alike). `el.dataset` gets
 *  the icon id (not the inner svg — that gets replaced wholesale) so tests
 *  and future callers can assert/inspect which Material glyph landed without
 *  parsing vendored SVG markup. Command (void). `raw` is vendored,
 *  generation-time-verified markup (never user input), so innerHTML here
 *  carries no injection risk. */
function stampSvg(el: HTMLElement, iconId: string, raw: string): void {
  el.innerHTML = raw;
  el.dataset.materialIcon = iconId;
  const svg = el.querySelector("svg");
  if (!svg) return;
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.classList.add("icon", "icon-material");
}

/** Render the Material file glyph for `name` into `el`, replacing its
 *  children. `fallback` (a Lucide IconName) paints INSTANTLY as a same-size
 *  placeholder — no empty box, no layout jump — for the one render that
 *  races the icon's own lazy chunk; every render after that chunk has
 *  resolved (this session, this icon id) applies synchronously from
 *  `iconSvgCache` with no placeholder frame at all. A failed/missing chunk
 *  silently keeps the fallback showing (never throws into the caller's
 *  render loop). Command (void): DOM mutation, not a query. */
export function renderMaterialFileGlyph(el: HTMLElement, name: string, fallback: IconName): void {
  const iconId = materialIconIdFor(name);
  const cached = iconSvgCache.get(iconId);
  if (cached) {
    stampSvg(el, iconId, cached);
    return;
  }
  el.replaceChildren(icon(fallback));
  delete el.dataset.materialIcon;
  const load = loaderFor(iconId);
  if (!load) return; // manifest promised an id the glob didn't find — stay on fallback
  void load().then(
    (raw) => {
      iconSvgCache.set(iconId, raw);
      stampSvg(el, iconId, raw);
    },
    () => {}, // chunk fetch failed (offline reload, etc.) — fallback glyph stands
  );
}
