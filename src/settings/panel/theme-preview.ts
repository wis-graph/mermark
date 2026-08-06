// The "미니 앱 프레임" — a live-rendered sample mermark document, shrunk into
// its own tiny window, that IS the theme editor's click surface (design
// decision 1). Every one of the 18 color keys + comment has a real button
// somewhere in this frame; there is no separate chip row or "전체 목록"
// toggle (the design explicitly rejects both as a fallback that would fork
// the click grammar in two).
//
// THEME_TARGETS is the SINGLE table mapping a target id → which Theme color
// key(s) it edits and which CSS var(s) it renders through. Nothing else in
// this module (or color-inspector.ts) hand-lists the 18+1 items — anything
// that needs "all targets" iterates this table.
import type { Theme } from "../theme-schema";
import "./theme-panel.css";

/** One clickable element in the mini frame. `colorKey` is always present
 *  (every target has a foreground/fill color); `bgKey` is present only for
 *  targets that also carry a background (design decision 4: every MARKDOWN
 *  text element gets a bg pair — bg/surface/border/accent/muted/fg do not,
 *  they ARE background-ish concepts themselves). `bgOptional` marks whether
 *  the background tab shows a "없음" chip — false only for highlightBg,
 *  which is a REQUIRED core key (highlight always has some fill), never a
 *  droppable one.
 *
 *  `paint` says WHAT PROPERTY `colorVar` paints on this target's own button —
 *  most targets are themselves the text they color (`paint: "color"`, the
 *  default), but `surface` and `border` are CHROME colors: their target
 *  button is a "찾기" card / the horizontal rule, and the var belongs on
 *  that card's FILL or the rule's TOP BORDER, never on the button's own
 *  text ink (2026-08 polish pass — painting --surface as `color` made the
 *  finder card unreadable, a real bug this field exists to make
 *  structurally impossible to repeat).
 *
 *  `border`'s anchor is the `.theme-hr` rule, NOT the blockquote's left bar
 *  (2026-08 감사 반영, major #3) — the real editor's `.cm-hr` genuinely
 *  consumes `--border` (`styles.css:1738`), but `.cm-blockquote` does NOT:
 *  it uses `--block-edge`, a DERIVED token (`color-mix` of --fg/--bg) with
 *  no Theme JSON key of its own. Anchoring `border` to the quote bar meant
 *  clicking it changed the PREVIEW's quote but never the real editor's
 *  quote — the exact "click here, that changes there" promise this whole UI
 *  exists to keep, broken for that one target. The quote bar is still drawn
 *  (using `var(--block-edge)` directly, matching the real editor byte-for-
 *  byte) but is decorative now, not a click target. */
export interface ThemeTarget {
  id: string;
  /** Status-line / aria-label text shown on hover, focus, and while selected. */
  label: string;
  colorKey: keyof Theme["colors"];
  colorVar: string;
  bgKey?: keyof Theme["colors"];
  bgVar?: string;
  bgOptional?: boolean;
  paint?: "color" | "surface-card" | "hr-line";
}

/** The single source of "which 19 things can be clicked, and what do they
 *  edit". Declaration order IS document order IS Tab order (design decision
 *  7). Adding a future color key means adding ONE row here — theme-preview's
 *  DOM builder and color-inspector's tab logic both derive from this table,
 *  never a hand-maintained second list. */
export const THEME_TARGETS: readonly ThemeTarget[] = [
  { id: "bg", label: "에디터 배경색", colorKey: "bg", colorVar: "--bg" },
  { id: "surface", label: "카드 영역 배경색", colorKey: "surface", colorVar: "--surface", paint: "surface-card" },
  { id: "border", label: "테두리선 색상", colorKey: "border", colorVar: "--border", paint: "hr-line" },
  { id: "accent", label: "강조 요소 색상", colorKey: "accent", colorVar: "--accent" },
  { id: "muted", label: "보조 텍스트 (Muted)", colorKey: "muted", colorVar: "--muted" },
  { id: "fg", label: "기본 본문 글자색", colorKey: "fg", colorVar: "--fg" },
  { id: "link", label: "[[위키링크 (Link)]]", colorKey: "link", colorVar: "--link", bgKey: "linkBg", bgVar: "--link-bg", bgOptional: true },
  { id: "bold", label: "굵은 글자 (Bold)", colorKey: "bold", colorVar: "--bold-color", bgKey: "boldBg", bgVar: "--bold-bg", bgOptional: true },
  { id: "italic", label: "기울임꼴 (Italic)", colorKey: "italic", colorVar: "--italic-color", bgKey: "italicBg", bgVar: "--italic-bg", bgOptional: true },
  { id: "code", label: "인라인 코드 (Code)", colorKey: "code", colorVar: "--code-color", bgKey: "codeBg", bgVar: "--code-bg", bgOptional: true },
  { id: "highlight", label: "형광펜 (Highlight)", colorKey: "highlight", colorVar: "--highlight-color", bgKey: "highlightBg", bgVar: "--highlight-bg", bgOptional: false },
  { id: "comment", label: "주석 (Comment)", colorKey: "comment", colorVar: "--comment-color", bgKey: "commentBg", bgVar: "--comment-bg", bgOptional: true },
  { id: "h1", label: "제목 1 (H1)", colorKey: "h1", colorVar: "--h1-color", bgKey: "h1Bg", bgVar: "--h1-bg", bgOptional: true },
  { id: "h2", label: "제목 2 (H2)", colorKey: "h2", colorVar: "--h2-color", bgKey: "h2Bg", bgVar: "--h2-bg", bgOptional: true },
  { id: "h3", label: "제목 3 (H3)", colorKey: "h3", colorVar: "--h3-color", bgKey: "h3Bg", bgVar: "--h3-bg", bgOptional: true },
  { id: "h4", label: "제목 4 (H4)", colorKey: "h4", colorVar: "--h4-color", bgKey: "h4Bg", bgVar: "--h4-bg", bgOptional: true },
  { id: "h5", label: "제목 5 (H5)", colorKey: "h5", colorVar: "--h5-color", bgKey: "h5Bg", bgVar: "--h5-bg", bgOptional: true },
  { id: "h6", label: "제목 6 (H6)", colorKey: "h6", colorVar: "--h6-color", bgKey: "h6Bg", bgVar: "--h6-bg", bgOptional: true },
] as const;

export function themeTarget(id: string): ThemeTarget | undefined {
  return THEME_TARGETS.find((t) => t.id === id);
}

/** "Does this target have its own bg, or is it a core/chrome color with a
 *  single control?" Named so the inspector's tab-vs-no-tab branch reads as a
 *  rule, not an inline `if (t.bgKey)`. Pure query. */
export function hasBackgroundTab(t: ThemeTarget): boolean {
  return t.bgKey !== undefined;
}

const FRAME_SEL = ".theme-target";

/** Apply `t.colorVar`/`t.bgVar` to the right CSS property for `t.paint`
 *  (default "color" — the target IS the colored text). This is the ONLY
 *  place that maps paint→property; a target's DOM builder never sets
 *  color/background inline itself, so "which property does this var
 *  paint" can't drift between two call sites (2026-08 polish pass: the
 *  quote line and the finder card were unreadable because their chrome var
 *  was applied as text color instead of fill/border — see the ThemeTarget
 *  doc comment). Command/CQS: void (mutates the passed element's style). */
function paintTarget(el: HTMLElement, t: ThemeTarget): void {
  switch (t.paint) {
    case "surface-card":
      // The "찾기" card: colorVar (--surface) is the CARD FILL, not its own
      // text — text stays normal reading ink so the card is legible against
      // any preset, and a real border makes the card's edges visible even
      // when --surface is close to --bg (light/claude).
      el.style.background = `var(${t.colorVar})`;
      el.style.border = "1px solid var(--border)";
      el.style.color = "var(--fg)";
      break;
    case "hr-line":
      // The horizontal rule: colorVar (--border) is the RULE'S OWN TOP
      // BORDER — matching the real editor's `.cm-hr` byte-for-byte
      // (styles.css:1738). There is no text to color (the button renders
      // as a bare line), so text color is never touched here.
      el.style.borderTop = `1px solid var(${t.colorVar})`;
      break;
    default:
      el.style.color = `var(${t.colorVar})`;
      if (t.bgVar) el.style.background = `var(${t.bgVar})`;
  }
}

/** Build one target button. `text` is the visible sample text — and per the
 *  "미리보기는 편집 모드의 모습을 보여준다" rule (see `EDIT_MODE_SAMPLE_TEXT`
 *  below), it is always the RAW markdown source (with its `#`/`##`/`[[ ]]`/
 *  `==` marker syntax intact) — only color/weight/background are themed, the
 *  text itself is never concealed. The target's label is NOT painted as a
 *  floating callout on the button itself (that overlapped neighboring lines
 *  — 2026-08 polish pass); it is shown in the single persistent status line
 *  above the frame instead. */
function targetButton(t: ThemeTarget, text: string, extraClass?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = extraClass ? `theme-target ${extraClass}` : "theme-target";
  b.dataset.target = t.id;
  b.dataset.label = t.label;
  b.setAttribute("aria-label", t.label);
  b.setAttribute("aria-pressed", "false");
  paintTarget(b, t);
  b.textContent = text;
  return b;
}

/** "미리보기는 편집 모드의 모습을 보여준다 — 모든 요소가 마커를 포함한 원문
 *  형태로 렌더되고, 스타일(색·굵기·배경)만 적용된다" (team-lead 2026-08
 *  폴리시 리뷰 2차 — 1차 결정을 사용자가 직접 뒤집었다: "마커째 들어와도
 *  돼, 편집모드에선 마커 보이잖아 어차피"). 1차 리뷰가 지적한 진짜 문제는
 *  "마커가 보인다"가 아니라 **일관성 없음**이었다 — 제목/하이라이트/
 *  위키링크는 마커가 보이는데 bold/italic만 마커 없이 렌더돼 있었다.
 *  사용자가 마커를 허용했으므로 반대 방향(전부 마커 포함)으로 통일한다.
 *  이 상수가 "모든 샘플 텍스트는 raw 마크다운 문법을 포함한다"는 규칙을
 *  한 곳에 고정한다 — 향후 샘플을 늘릴 때 다시 "일부는 마커/일부는 렌더"로
 *  갈라지는 걸 구조적으로 막는다. */
const EDIT_MODE_SAMPLE_TEXT = {
  h1: "# 제주 여행 준비",
  h2: "## 사흘째 아침",
  link: "[[제주 숙소 목록]]",
  highlight: "==환전은 출발 전에==",
  footnoteRef: "[^1]",
  bold: "**가볍게**",
  italic: "*느슨하게*",
  code: "`JX-2041`",
  comment: "<!-- 지난 여행에서는 우산을 두 번 잃어버렸다 -->",
} as const;

export interface ThemePreview {
  el: HTMLElement;
  /** Currently selected target, or null. Pure query (reads local state). */
  getSelected(): ThemeTarget | null;
  /** Select a target by id (used by tests + Enter/Space on a real button
   *  fires this via the click listener already). Command/CQS: void. */
  select(id: string): void;
  clearSelection(): void;
  teardown(): void;
}

/** Build the mini app frame: a shrunk mermark window rendering a fixed
 *  Korean sample document, every element of which is a real `<button>` (or,
 *  for the canvas margin, a `role="button"` div — design decision 7's one
 *  sanctioned exception, since the frame itself can't BE a <button> while
 *  also containing dozens of real ones). `onSelect` fires with the newly
 *  selected target (or null on clear) — the color inspector is the only
 *  subscriber. Colors are NOT tracked/reflected here: every target paints
 *  itself via `var(--x)`, and themeVarsSink is the single writer of those
 *  vars, so the frame updates for free on every setting change — no
 *  subscription, no re-render, no drift between two color sources. */
export function buildThemePreview(onSelect: (t: ThemeTarget | null) => void): ThemePreview {
  const wrap = document.createElement("div");
  wrap.className = "theme-preview";

  const DEFAULT_HINT = "문서에서 요소를 클릭해 색을 바꿉니다 · Tab으로 이동할 수 있습니다";
  const hint = document.createElement("p");
  hint.className = "theme-preview-hint";
  hint.textContent = DEFAULT_HINT;
  wrap.appendChild(hint);

  const frame = document.createElement("div");
  frame.className = "theme-frame";
  frame.setAttribute("role", "button");
  frame.tabIndex = 0;
  frame.dataset.target = "bg";
  frame.dataset.label = themeTarget("bg")!.label;
  frame.setAttribute("aria-label", themeTarget("bg")!.label);
  frame.setAttribute("aria-pressed", "false");
  frame.style.background = "var(--bg)";
  frame.style.color = "var(--fg)";
  wrap.appendChild(frame);

  const toolbar = document.createElement("div");
  toolbar.className = "theme-frame-toolbar";
  const finder = targetButton(themeTarget("surface")!, "찾기 ⌘F", "theme-frame-finder");
  toolbar.appendChild(finder);
  frame.appendChild(toolbar);

  const doc = document.createElement("div");
  doc.className = "theme-doc";
  frame.appendChild(doc);

  const h1 = targetButton(themeTarget("h1")!, EDIT_MODE_SAMPLE_TEXT.h1, "theme-line theme-h1");
  doc.appendChild(h1);

  const h2 = targetButton(themeTarget("h2")!, EDIT_MODE_SAMPLE_TEXT.h2, "theme-line theme-h2");
  doc.appendChild(h2);

  const scaleStrip = document.createElement("div");
  scaleStrip.className = "theme-scale-strip";
  (["h3", "h4", "h5", "h6"] as const).forEach((id, i) => {
    if (i > 0) scaleStrip.appendChild(document.createTextNode(" · "));
    scaleStrip.appendChild(targetButton(themeTarget(id)!, `제목 ${i + 3}`, `theme-scale theme-scale-${id}`));
  });
  doc.appendChild(scaleStrip);

  const p = document.createElement("p");
  p.className = "theme-p";
  p.append(
    targetButton(themeTarget("fg")!, "짐은", "theme-inline"),
    " ",
    targetButton(themeTarget("bold")!, EDIT_MODE_SAMPLE_TEXT.bold, "theme-inline"),
    " 싸고, 일정은 ",
    targetButton(themeTarget("italic")!, EDIT_MODE_SAMPLE_TEXT.italic, "theme-inline"),
    " 잡는다. 숙소는 ",
    targetButton(themeTarget("link")!, EDIT_MODE_SAMPLE_TEXT.link, "theme-inline"),
    "에서 고르고, ",
    targetButton(themeTarget("highlight")!, EDIT_MODE_SAMPLE_TEXT.highlight, "theme-inline"),
    " 끝낸다. 예약 번호 ",
    targetButton(themeTarget("code")!, EDIT_MODE_SAMPLE_TEXT.code, "theme-inline theme-code"),
    "은 지갑에도 적어 둔다",
    targetButton(themeTarget("accent")!, EDIT_MODE_SAMPLE_TEXT.footnoteRef, "theme-inline theme-footnote"),
    ".",
  );
  doc.appendChild(p);

  // Decorative only — NOT a click target (2026-08 감사 반영, major #3: the
  // real editor's `.cm-blockquote` paints its left bar with `--block-edge`,
  // a derived color-mix token with no Theme JSON key, so a `border` click
  // target here would change this bar but never the real editor's). Styled
  // with `var(--block-edge)` directly in theme-panel.css so it still LOOKS
  // exactly like the real blockquote — it just isn't wired to anything.
  const quote = document.createElement("blockquote");
  quote.className = "theme-quote";
  const quoteText = document.createElement("p");
  quoteText.className = "theme-quote-text";
  quoteText.textContent = "짐을 줄이는 가장 확실한 방법은 가방을 작게 사는 것이다.";
  quote.appendChild(quoteText);
  doc.appendChild(quote);

  const comment = targetButton(themeTarget("comment")!, EDIT_MODE_SAMPLE_TEXT.comment, "theme-line theme-comment-line");
  doc.appendChild(comment);

  // The `border` target's REAL anchor (2026-08 감사 반영, major #3) — the
  // real editor's `.cm-hr` genuinely consumes `--border` (styles.css:1738),
  // unlike the blockquote bar above. A <button>, not a decorative <hr>: it
  // renders as a bare full-width top border via `paintTarget`'s "hr-line"
  // case, with no visible text — its accessible name comes from aria-label.
  const hr = targetButton(themeTarget("border")!, "", "theme-hr");
  doc.appendChild(hr);

  const status = targetButton(themeTarget("muted")!, "제주-준비.md · 방금 저장됨", "theme-status");
  doc.appendChild(status);

  let selected: ThemeTarget | null = null;
  // The hovered/focused target's id, or null. Hover/focus takes priority
  // over the selected target while active, so a user exploring the frame
  // with the mouse or Tab always sees THAT element's name — falling back to
  // the selected target's name once the pointer/focus leaves.
  let hoveredId: string | null = null;

  const allButtons = (): HTMLElement[] => Array.from(wrap.querySelectorAll<HTMLElement>(FRAME_SEL)).concat(frame);

  function reflectSelection(): void {
    for (const el of allButtons()) {
      el.setAttribute("aria-pressed", String(el.dataset.target === selected?.id));
    }
  }

  // The single persistent status line (2026-08 polish pass replacement for
  // the floating callout chip, which overlapped neighboring content — see
  // `paintTarget`'s doc comment for the sibling fix). Never obscures the
  // document: it lives in its own row above the frame, not anchored to
  // whatever element happens to be hovered/selected.
  function renderStatusLine(): void {
    const t = themeTarget(hoveredId ?? selected?.id ?? "");
    if (t) {
      hint.textContent = t.label;
      hint.classList.add("is-active");
    } else {
      hint.textContent = DEFAULT_HINT;
      hint.classList.remove("is-active");
    }
  }

  function select(id: string): void {
    const t = themeTarget(id);
    if (!t) return;
    selected = t;
    reflectSelection();
    renderStatusLine();
    onSelect(t);
  }

  function clearSelection(): void {
    selected = null;
    reflectSelection();
    renderStatusLine();
    onSelect(null);
  }

  function onPointerOver(e: Event): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-target]");
    if (!el) return;
    hoveredId = el.dataset.target ?? null;
    renderStatusLine();
  }
  function onPointerOut(e: Event): void {
    if (!(e.target as HTMLElement).closest?.("[data-target]")) return;
    hoveredId = null;
    renderStatusLine();
  }
  function onFocusIn(e: Event): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-target]");
    if (!el) return;
    hoveredId = el.dataset.target ?? null;
    renderStatusLine();
  }
  function onFocusOut(): void {
    hoveredId = null;
    renderStatusLine();
  }
  wrap.addEventListener("pointerover", onPointerOver);
  wrap.addEventListener("pointerout", onPointerOut);
  wrap.addEventListener("focusin", onFocusIn);
  wrap.addEventListener("focusout", onFocusOut);

  function onClick(e: MouseEvent): void {
    const el = e.target as HTMLElement;
    const targetEl = el.closest<HTMLElement>("[data-target]");
    if (!targetEl) return;
    // The frame div's own click listener also sees clicks on its descendant
    // buttons (event bubbling) — only select "bg" when the click landed on
    // the frame margin itself, not a nested target.
    if (targetEl === frame && el !== frame) return;
    select(targetEl.dataset.target!);
  }
  wrap.addEventListener("click", onClick);

  // The frame's role="button" div needs manual Enter/Space handling — real
  // <button>s (every other target) get this for free from the browser.
  function onFrameKeydown(e: KeyboardEvent): void {
    if (e.target !== frame) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      select("bg");
    }
  }
  frame.addEventListener("keydown", onFrameKeydown);

  // Escape clears selection regardless of which target currently has focus —
  // attached on the wrapper so it fires for any focused descendant without a
  // global (document-level) listener that would need its own leak-guard.
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      clearSelection();
    }
  }
  wrap.addEventListener("keydown", onKeydown);

  return {
    el: wrap,
    getSelected: () => selected,
    select,
    clearSelection,
    teardown() {
      wrap.removeEventListener("click", onClick);
      wrap.removeEventListener("keydown", onKeydown);
      wrap.removeEventListener("pointerover", onPointerOver);
      wrap.removeEventListener("pointerout", onPointerOut);
      wrap.removeEventListener("focusin", onFocusIn);
      wrap.removeEventListener("focusout", onFocusOut);
      frame.removeEventListener("keydown", onFrameKeydown);
    },
  };
}
