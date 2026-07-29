// EPUB reading-position memory — pure geometry/key/LRU arithmetic, no
// storage/DOM (_workspace/01_architect_design_epub_position.md §1-§6).
// `epubPositionsSetting` (settings/app.ts) is the SSOT; these compute the
// next value it should hold, and the position a scroll offset represents.
// Kept pure so the coordinate-system conversion (the design's "구현 함정
// 1순위") is unit-tested without a mounted editor or a real iframe.
//
// COORDINATE SYSTEM (read before touching anything below): `anchors` (from
// measure.js, already landed in epub-viewer.ts's `chapter.anchors`) are
// UNSCALED — offsets inside the chapter iframe's OWN internal document at
// its current reflow width. `top`/`height` in `EpubChapterGeom` are SCALED —
// `chapter.placeholder.offsetTop`/`offsetHeight`, i.e. pane-scroll pixels,
// which already include the viewer-local zoom factor (epub-viewer.ts sets
// `placeholder.style.height = height * zoomFactor`). Converting between the
// two ALWAYS multiplies/divides by `zoom` — never mixed without that factor.

/** One saved reading position, keyed by `epubPositionKey`'s output in
 *  `epubPositionsSetting`'s map. */
export interface EpubReadingPosition {
  /** Spine zip-entry path — the chapter to restore to. Ignored (not
   *  restored) if this entry is no longer in the book's spine
   *  (`shouldRestorePosition`'s identifier-collision safety net). */
  readonly entry: string;
  /** Position within the chapter, 0..1, dimensionless (scroll/zoom/window
   *  size independent — computed from SCALED coordinates that cancel the
   *  zoom factor out, see `readingPositionAt`). */
  readonly ratio: number;
  /** The nearest `[id]` anchor at or before the saved scroll position
   *  (UNSCALED, chapter-internal), or `null` when the chapter reported none
   *  yet / the position was before the first anchor. Preferred over `ratio`
   *  on restore when present (more robust to reflow). */
  readonly anchor: string | null;
  /** Epoch ms — LRU pruning key (`upsertPosition`). */
  readonly savedAt: number;
}

/** One chapter's current geometry, as needed to compute or restore a
 *  reading position — a plain data snapshot (no DOM reads happen in this
 *  file) so every function below is testable with inline fixtures. */
export interface EpubChapterGeom {
  readonly entry: string;
  /** SCALED (pane px) — `chapter.placeholder.offsetTop`. */
  readonly top: number;
  /** SCALED (pane px) — `chapter.placeholder.offsetHeight`. */
  readonly height: number;
  /** UNSCALED (chapter-internal px) — `chapter.anchors`, measure.js's
   *  latest `id → offsetTop` report for this chapter. */
  readonly anchors: Readonly<Record<string, number>>;
}

/** The single place the "identifier vs. path" key rule lives (design §2) —
 *  a non-blank `identifier` (OPF `dc:identifier`, already trimmed) wins so a
 *  book's position survives a file move/rename and is shared across copies;
 *  otherwise the absolute path is the fallback key. The `"id:"`/`"path:"`
 *  prefixes keep the two namespaces from ever colliding (an identifier that
 *  happens to equal some other book's path string, however unlikely, cannot
 *  alias). Pure query. */
export function epubPositionKey(identifier: string | null, absPath: string): string {
  const trimmed = identifier?.trim();
  return trimmed ? `id:${trimmed}` : `path:${absPath}`;
}

/** The `id` (from `anchors`) whose UNSCALED offset is the LARGEST one at or
 *  before `offset` — "the anchor the reader most recently scrolled past".
 *  `null` when `anchors` is empty or every anchor lies AFTER `offset`. Pure
 *  query. */
function anchorAtOrBefore(anchors: Readonly<Record<string, number>>, offset: number): string | null {
  let best: string | null = null;
  let bestOffset = -Infinity;
  for (const [id, at] of Object.entries(anchors)) {
    if (at <= offset && at > bestOffset) {
      best = id;
      bestOffset = at;
    }
  }
  return best;
}

/** The chapter whose SCALED `[top, top+height)` span contains `scrollTop`
 *  (the viewport's top edge — design §3: "뷰포트 상단이 걸친 챕터"), or the
 *  LAST chapter when `scrollTop` is past every span's end (scrolled to the
 *  bottom of the book). At an exact chapter boundary, the chapter that
 *  STARTS there wins (its own span begins at that scrollTop). Pure query. */
function geomAtScrollTop(scrollTop: number, geoms: readonly EpubChapterGeom[]): EpubChapterGeom {
  return geoms.find((g) => scrollTop < g.top + g.height) ?? geoms[geoms.length - 1];
}

/** Compute the reading position `scrollTop` (the pane's current scroll
 *  offset, SCALED) represents, or `null` when there is nothing to compute
 *  from (`scrollTop < 0` or no chapters yet — design §3/plan (d): "챕터
 *  스택 밖"). `ratio` is derived entirely from SCALED numbers (`scrollTop`,
 *  `geom.top`, `geom.height`), so the zoom factor cancels out of it —
 *  restoring at a DIFFERENT zoom than it was saved at still lands in
 *  roughly the same spot via `ratio` alone; `anchor` is the more precise
 *  fallback when present. `now` defaults to `Date.now()` — overridable so
 *  callers stay pure/deterministic under test; production code never passes
 *  it. Pure query (given `now`). */
export function readingPositionAt(
  scrollTop: number,
  geoms: readonly EpubChapterGeom[],
  zoom: number,
  now: number = Date.now(),
): EpubReadingPosition | null {
  if (scrollTop < 0 || geoms.length === 0) return null;
  const geom = geomAtScrollTop(scrollTop, geoms);
  const withinScaled = scrollTop - geom.top;
  const ratio = geom.height > 0 ? Math.max(0, Math.min(1, withinScaled / geom.height)) : 0;
  const withinUnscaled = Math.max(0, withinScaled / zoom);
  const anchor = anchorAtOrBefore(geom.anchors, withinUnscaled);
  return { entry: geom.entry, ratio, anchor, savedAt: now };
}

/** The SCALED offset (pane px) `pos` represents WITHIN `geom`'s chapter —
 *  the caller adds `geom.top` (the chapter's CURRENT `offsetTop`, which
 *  moves as neighboring chapters load/reflow) to get an absolute scrollTop
 *  target. Prefers `pos.anchor` when `geom`'s LATEST anchors map still has
 *  it (scaled by the CURRENT `zoom`, not whatever zoom was active when
 *  `pos` was saved — anchors are re-read fresh from `geom` every call, so a
 *  zoom change between save and restore is absorbed automatically); falls
 *  back to `pos.ratio × geom.height` otherwise (a book that hasn't
 *  reported/kept that anchor id, or was saved with none). Pure query. */
export function restoreOffsetInChapter(pos: EpubReadingPosition, geom: EpubChapterGeom, zoom: number): number {
  if (pos.anchor !== null && pos.anchor in geom.anchors) {
    return geom.anchors[pos.anchor] * zoom;
  }
  return pos.ratio * geom.height;
}

/** Default LRU cap — "책 100권" (design §1). Named so the cap rule lives in
 *  one place, mirroring `RECENT_CAP` (recent-docs.ts). */
export const EPUB_POSITIONS_CAP = 100;

/** Upsert `pos` under `key`, evicting the OLDEST entries (smallest
 *  `savedAt`) first if the map would grow past `cap` — the map-shaped
 *  sibling of `pushRecent`'s array LRU. A key already present is updated
 *  in place (the map never grows on a re-save of a book already tracked).
 *  Returns a NEW map (never mutates `map`) — same immutability contract
 *  every other settings-arithmetic helper in this codebase follows. Pure
 *  query. */
export function upsertPosition(
  map: Readonly<Record<string, EpubReadingPosition>>,
  key: string,
  pos: EpubReadingPosition,
  cap: number = EPUB_POSITIONS_CAP,
): Record<string, EpubReadingPosition> {
  const next: Record<string, EpubReadingPosition> = { ...map, [key]: pos };
  while (Object.keys(next).length > cap) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of Object.entries(next)) {
      if (v.savedAt < oldestAt) {
        oldestAt = v.savedAt;
        oldestKey = k;
      }
    }
    if (oldestKey === null) break; // unreachable (loop only runs when next is non-empty)
    delete next[oldestKey];
  }
  return next;
}

/** How close to the very start of the book's first chapter counts as
 *  "still at the start" (design §6) — restoring a save this close would
 *  just be an unnecessary/invisible scroll attempt, so it's skipped
 *  entirely. Named constant, not a magic number inline in
 *  `shouldRestorePosition`. */
const START_RATIO_EPSILON = 0.02;

/** Whether `pos` should actually be restored (design §6/§2's two gates):
 *  ① `pos.entry` must still be in the CURRENT book's `spine` — an identifier
 *  collision (two different books sharing a key) or a spine that changed
 *  between saves means the saved chapter no longer exists here, and jumping
 *  to a stale/foreign entry would be worse than doing nothing. ② the FIRST
 *  chapter at (near) `ratio` 0 with no anchor is treated as "never really
 *  left the start" — restoring there is a no-op the reader would never
 *  notice, so it's skipped (no restore-scroll attempt at all). Pure query. */
export function shouldRestorePosition(pos: EpubReadingPosition, spine: readonly string[]): boolean {
  if (!spine.includes(pos.entry)) return false;
  const isFirstChapter = spine[0] === pos.entry;
  const nearStart = pos.ratio < START_RATIO_EPSILON && pos.anchor === null;
  return !(isFirstChapter && nearStart);
}
