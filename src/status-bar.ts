// The status-bar (footer) layout contract in one named place: the left→right
// order of the chrome. M2 shrank the footer to a pure status-report strip —
// every command/toggle button moved up to the title-bar (see title-bar.ts's
// arrangeTitleBar). What remains: a breadcrumb slot (left, M3 fills it in;
// M2 passes an empty placeholder — the slot's POSITION is the contract) and
// save/pos on the right, pos landing at the far right.

export interface StatusBarParts {
  /** Breadcrumb slot (left, full-width in M3). M2 passes an empty placeholder —
   *  the slot's POSITION is the contract; content arrives in M3. Required (not
   *  optional): the contract is fixed now, not deferred behind a branch. */
  breadcrumb: HTMLElement;
  /** Flexible filler pushing save/pos to the right. */
  spacer: HTMLElement;
  /** Right cluster: save then pos (pos = far right). */
  save: HTMLElement;
  pos: HTMLElement;
}

/** Arrange the status bar (footer) to the canonical order:
 *  브레드크럼 슬롯 · spacer · save · pos — pos lands at the far right.
 *  Command (void). */
export function arrangeStatusBar(bar: HTMLElement, p: StatusBarParts): void {
  bar.append(p.breadcrumb, p.spacer, p.save, p.pos);
}
