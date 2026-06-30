// Lucide-icon helper. One inline-SVG factory so the status bar / settings chrome
// stops shipping emoji glyphs (✎👁☾☀⚙✓●⚠✕) — those render small, font-dependent,
// and inconsistent across platforms. These are the EXACT Lucide path geometries
// (https://lucide.dev), drawn at the Lucide canvas (viewBox 0 0 24 24, no fill,
// stroke=currentColor, round caps/joins). `currentColor` means the glyph inherits
// the button's `color`, so DESIGN.md tokens (--muted → --fg on hover) drive it for
// free — no per-icon theming, no light/dark branching. Cold-load: pure string
// templates, zero dependencies, no import().

const SVG_NS = "http://www.w3.org/2000/svg";

/** Lucide icon name → its child path/shape markup (the inside of <svg>). Verbatim
 *  Lucide geometry so the glyphs read as the real icon set, not hand-drawn paths. */
const PATHS = {
  // square-pen — edit mode
  "square-pen":
    '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>' +
    '<path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>',
  // eye — read mode
  eye:
    '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/>' +
    '<circle cx="12" cy="12" r="3"/>',
  // sun — light theme
  sun:
    '<circle cx="12" cy="12" r="4"/>' +
    '<path d="M12 2v2"/><path d="M12 20v2"/>' +
    '<path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/>' +
    '<path d="M2 12h2"/><path d="M20 12h2"/>' +
    '<path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  // moon — dark theme
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9"/>',
  // settings — settings/gear
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>' +
    '<circle cx="12" cy="12" r="3"/>',
  // check — saved
  check: '<path d="M20 6 9 17l-5-5"/>',
  // loader-circle — saving (spins via CSS)
  "loader-circle": '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  // triangle-alert — error / conflict
  "triangle-alert":
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>' +
    '<path d="M12 9v4"/><path d="M12 17h.01"/>',
  // rotate-ccw — reload from disk
  "rotate-ccw":
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>' +
    '<path d="M3 3v5h5"/>',
  // save — force save (overwrite to disk)
  save:
    '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/>' +
    '<path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/>' +
    '<path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
  // x — close / callout: failure
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  // folder-open — open a document by path
  "folder-open":
    '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  // clipboard-list — callout: abstract
  "clipboard-list":
    '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/>' +
    '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>' +
    '<path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
  // info — callout: info
  info:
    '<circle cx="12" cy="12" r="10"/>' +
    '<path d="M12 16v-4"/><path d="M12 8h.01"/>',
  // circle-check — callout: todo
  "circle-check":
    '<circle cx="12" cy="12" r="10"/>' +
    '<path d="m9 12 2 2 4-4"/>',
  // flame — callout: tip
  flame:
    '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  // circle-help — callout: question
  "circle-help":
    '<circle cx="12" cy="12" r="10"/>' +
    '<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>' +
    '<path d="M12 17h.01"/>',
  // zap — callout: danger
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  // bug — callout: bug
  bug:
    '<path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/>' +
    '<path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/>' +
    '<path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/>' +
    '<path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/>' +
    '<path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/>' +
    '<path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/>' +
    '<path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>',
  // list — callout: example
  list:
    '<path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/>' +
    '<path d="M8 5h13"/><path d="M8 12h13"/><path d="M8 19h13"/>',
  // list-tree — outline / table of contents
  "list-tree":
    '<path d="M21 12h-8"/><path d="M21 6H8"/><path d="M21 18h-8"/>' +
    '<path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/>',
  // quote — callout: quote
  quote:
    '<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>' +
    '<path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>',
} as const;

export type IconName = keyof typeof PATHS;

/** Build a fresh Lucide <svg> for `name`. 16px box on the 24-unit Lucide grid,
 *  no fill, stroke=currentColor (inherits the button color → DESIGN.md tokens),
 *  1.75 stroke with round caps/joins (the Lucide line voice, a touch lighter than
 *  Lucide's default 2 so it reads crisp at 16px). `aria-hidden` because every
 *  caller pairs it with a text label or a button `title`/`aria-label`. */
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", `icon icon-${name}`);
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = PATHS[name];
  return svg;
}
