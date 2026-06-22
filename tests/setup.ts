// Global test setup. jsdom does not implement window.matchMedia, which
// systemTheme() (src/theme.ts) calls at module-init of settings/app.ts. Now that
// the settings registry is imported transitively (e.g. mermaid-widget reads
// panZoomSetting), ANY test that mounts the editor or a widget pulls app.ts in,
// so matchMedia must exist environment-wide. Default matches:false → dark, the
// app's default. Individual tests can still vi.stubGlobal a different value.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}
