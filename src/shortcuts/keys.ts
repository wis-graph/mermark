// Keyboard-chord serialization, normalization, and platform display — pure
// functions, no DOM/state, so they unit-test in jsdom and the registry can lean
// on them as its single source of "what did the user press / how is it stored /
// how is it shown".
//
// The canonical (stored) format is "Mod+Shift+B": modifier tokens in a FIXED
// order (Mod, Alt, Shift) then the key token, joined by "+". `Mod` is the
// platform-agnostic primary modifier — ⌘ on macOS, Ctrl elsewhere — so one
// stored binding works on every platform. The key token is derived from
// `e.code` (the PHYSICAL key: KeyB→"B", Equal→"=", Digit0→"0"), not `e.key`, so
// a binding fires the same under non-Latin layouts (e.g. Korean) — the same
// reason the legacy ⌘E toggle used e.code.

/** A parsed chord: the primary modifier (Mod), Alt, Shift, and the physical key
 *  token. Structured form used for normalization + display; the stored form is
 *  its formatChord() string. */
export interface Chord {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  /** Physical key token, e.g. "B", "=", "0", "Enter". Never a modifier. */
  key: string;
}

/** Map a KeyboardEvent.code (physical key) to its canonical key token, or null
 *  when the code is itself a modifier (so it can't stand alone as a chord key).
 *  Named so the "which physical keys are bindable" rule lives in one place. */
function codeToKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3); // KeyB → B
  if (/^Digit[0-9]$/.test(code)) return code.slice(5); // Digit0 → 0
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6); // Numpad0 → 0
  const punct: Record<string, string> = {
    Equal: "=",
    Minus: "-",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backslash: "\\",
    BracketLeft: "[",
    BracketRight: "]",
    Semicolon: ";",
    Quote: "'",
    Backquote: "`",
  };
  if (code in punct) return punct[code];
  // Named non-printing keys that can carry a chord.
  const named = new Set([
    "Enter",
    "Space",
    "Tab",
    "Backspace",
    "Delete",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Home",
    "End",
    "PageUp",
    "PageDown",
  ]);
  if (named.has(code)) return code;
  return null; // MetaLeft/ControlLeft/ShiftLeft/AltLeft/… → not a standalone key
}

/** Does Shift fold away on this physical key — i.e. is `+` the same chord as `=`?
 *  On `Equal`, Shift produces `+`, and browsers treat ⌘+ and ⌘= as the SAME zoom
 *  command, so we normalize ⌘+ → "Mod+=" (⌘= aliases ⌘+). Named so this browser
 *  zoom-parity rule lives in one place, shared by capture (rebind UI) and dispatch
 *  — otherwise the two would store/look-up different strings and a rebind of ⌘+
 *  would silently miss. Only `Equal` folds; letters (⌘⇧C) keep their Shift. */
function foldsShiftAway(code: string): boolean {
  return code === "Equal";
}

/** The single "read a keydown into a chord" rule. Returns the canonical stored
 *  string, or null when the event is not a complete chord (a lone modifier
 *  press, or a key that carries no bindable token). Pure query. */
export function eventToChord(e: KeyboardEvent): string | null {
  const key = codeToKey(e.code);
  if (key === null) return null; // lone modifier / unbindable key
  return formatChord({
    mod: e.metaKey || e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey && !foldsShiftAway(e.code),
    key,
  });
}

/** Serialize a chord to its canonical stored string: modifiers in fixed order
 *  (Mod, Alt, Shift) then the key. Pure. */
export function formatChord(c: Chord): string {
  const parts: string[] = [];
  if (c.mod) parts.push("Mod");
  if (c.alt) parts.push("Alt");
  if (c.shift) parts.push("Shift");
  parts.push(c.key);
  return parts.join("+");
}

/** Parse a stored chord string back into structure, normalizing modifier order
 *  and rejecting malformed input (no key, unknown token, duplicate). Returns
 *  null on invalid input. Pure query — round-trips with formatChord:
 *  formatChord(parseChord(s)) re-emits the canonical order. */
export function parseChord(s: string): Chord | null {
  const tokens = s.split("+").filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  let mod = false;
  let alt = false;
  let shift = false;
  let key: string | null = null;
  for (const t of tokens) {
    if (t === "Mod") mod = true;
    else if (t === "Alt") alt = true;
    else if (t === "Shift") shift = true;
    else if (key === null) key = t;
    else return null; // a second non-modifier token → malformed
  }
  if (key === null) return null; // modifiers only → not a chord
  return { mod, alt, shift, key };
}

/** Is this running on macOS? Drives the default display style (⌘ symbols vs
 *  Ctrl+ words) and the Mod→⌘/Ctrl meaning. Guarded for non-browser envs. */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
}

export type Platform = "mac" | "other";

/** Render a stored chord for display: macOS uses the ⌘⌥⇧ symbol run with no
 *  separators ("⌘⇧B"); other platforms use the Ctrl+Alt+Shift+ word form
 *  ("Ctrl+Shift+B"). Invalid input is echoed back unchanged so a corrupt stored
 *  value never throws in the panel. Pure query. Platform defaults to the host. */
export function displayChord(s: string, platform: Platform = isMac() ? "mac" : "other"): string {
  const c = parseChord(s);
  if (!c) return s;
  if (platform === "mac") {
    let out = "";
    if (c.mod) out += "⌘";
    if (c.alt) out += "⌥";
    if (c.shift) out += "⇧";
    return out + c.key;
  }
  const parts: string[] = [];
  if (c.mod) parts.push("Ctrl");
  if (c.alt) parts.push("Alt");
  if (c.shift) parts.push("Shift");
  parts.push(c.key);
  return parts.join("+");
}
