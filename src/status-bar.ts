// The status-bar layout contract in one named place: the left→right order of
// the chrome. Extracted from main's boot so the ordering is a single rule (not
// an inline sequence of append/prepend calls) AND is unit-testable without a
// full editor boot. The settings ⚙ button is mounted separately (mountSettingsButton
// appends it) so it lands at the far right, after everything arranged here.

export interface StatusBarParts {
  /** Left navigation group, in left→right order. */
  explorer: HTMLElement;
  recent: HTMLElement;
  openPath: HTMLElement;
  outline: HTMLElement;
  /** Center cluster (cursor position + flexible spacer). */
  pos: HTMLElement;
  spacer: HTMLElement;
  /** Right cluster. `mode` sits after `save`, before `theme`. */
  save: HTMLElement;
  mode: HTMLElement;
  theme: HTMLElement;
}

/** Arrange the status bar to the canonical order:
 *  탐색기 · 최근 · 경로열기 · 목차 · [pos · spacer · save] · 모드 · 테마 (· 설정)
 *  Center + right are appended in order; the left nav group is prepended in
 *  reverse (prepend puts each at the front), so the four land explorer-first.
 *  Command (void). */
export function arrangeStatusBar(bar: HTMLElement, p: StatusBarParts): void {
  bar.append(p.pos, p.spacer, p.save, p.mode, p.theme);
  bar.prepend(p.outline);
  bar.prepend(p.openPath);
  bar.prepend(p.recent);
  bar.prepend(p.explorer);
}
