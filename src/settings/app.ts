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
