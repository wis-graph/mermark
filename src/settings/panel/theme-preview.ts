// The "미니 앱 프레임" — a live-rendered sample mermark document, shrunk into
// its own tiny window, that IS the theme editor's click surface (design
// decision 1). Every clickable color key has a real button somewhere in this
// frame; there is no separate chip row or "전체 목록" toggle (the design
// explicitly rejects both as a fallback that would fork the click grammar in
// two).
//
// THEME_TARGETS is the SINGLE table mapping a target id → which Theme color
// key(s) it edits and which CSS var(s) it renders through. Nothing else in
// this module (or color-inspector.ts) hand-lists the targets — anything that
// needs "all targets" iterates this table.
import type { Theme } from "../theme-schema";
import "./theme-panel.css";

/** One clickable element in the mini frame. `colorKey` is always present
 *  (every target has a foreground/fill color); `bgKey` is present only for
 *  targets that also carry a background (design decision 4 of round 1: every
 *  MARKDOWN text element gets a bg pair — bg/surface/border/accent/muted/fg
 *  do not, they ARE background-ish concepts themselves).
 *
 *  `paint` says WHAT PROPERTY `colorVar` paints on this target's own button —
 *  most targets are themselves the text they color (`paint: "color"`, the
 *  default), but some are CHROME or split-container targets:
 *  - `"surface-card"` — the "찾기" card: colorVar is the card FILL, text
 *    stays --fg (round-1 polish: painting --surface as text made the card
 *    unreadable).
 *  - `"hr-line"` — the horizontal rule: colorVar is the rule's own TOP
 *    BORDER, no text to color (round-1 감사 major #3: `border`'s real anchor
 *    in the actual editor is `.cm-hr`, not the blockquote bar).
 *  - `"quote-bar"` (round 2) — the blockquote's left bar, now its OWN target
 *    (`quoteBar`) instead of riding `border`: colorVar paints the bar
 *    button's own background-color (a thin filled rectangle, not a border).
 *  - `"quote-text"` (round 2) — the blockquote's SENTENCE: colorVar paints
 *    only the text color. The blockquote's BACKGROUND (`quoteBg`) is painted
 *    on the blockquote CONTAINER separately (see `paintQuoteContainerBg`),
 *    not on this button — the container and the text button are different
 *    elements, so `paint` can't fold both onto one `el` here.
 *
 *  `colorFallback`/`bgFallback` are the CSS fallback values `paintTarget`
 *  composes into `var(--x, <fallback>)`. Round-1 targets never needed one
 *  (their vars always resolve to a real color — "없음" emits `transparent`).
 *  Round-2's OPTIONAL_KEYS "auto" family emits the guaranteed-invalid
 *  `initial` when absent (`theme-schema.ts`'s `resolveOptional`), so a naive
 *  `var(--x)` reference here would render NOTHING and silently lie about
 *  what the real editor shows — the real editor's own styles.css rule always
 *  pairs that var with a fallback (`var(--quote-color, inherit)`, etc.), and
 *  this field is how the preview mirrors that exact chain byte-for-byte
 *  (design decision 5's "미리보기가 칠할 체인" column — a mismatch here is
 *  the same class of bug as round-1's border/quote anchor mix-up). */
export interface ThemeTarget {
  id: string;
  /** Status-line / aria-label text shown on hover, focus, and while selected. */
  label: string;
  colorKey: keyof Theme["colors"];
  colorVar: string;
  colorFallback?: string;
  bgKey?: keyof Theme["colors"];
  bgVar?: string;
  bgFallback?: string;
  paint?: "color" | "surface-card" | "hr-line" | "quote-bar" | "quote-text";
}

/** The single source of "which things can be clicked, and what do they
 *  edit". Adding a future color key means adding ONE row here — theme-
 *  preview's DOM builder and color-inspector's tab logic both derive from
 *  this table, never a hand-maintained second list.
 *
 *  Declaration order is NOT required to equal DOM order for every entry
 *  (the core/chrome rows above are grouped by concept, not by where they
 *  land in the document) — but round 2's NEW rows are inserted at the
 *  positions the plan specifies relative to their neighbors (`boldItalic`/
 *  `strike` right after `italic`; `quote`/`quoteBar`/`codeBlock` right
 *  before `comment`), matching where they land in the DOM. See the
 *  "new rows sit where the plan says" test. */
export const THEME_TARGETS: readonly ThemeTarget[] = [
  { id: "bg", label: "에디터 배경색", colorKey: "bg", colorVar: "--bg" },
  { id: "surface", label: "카드 영역 배경색", colorKey: "surface", colorVar: "--surface", paint: "surface-card" },
  { id: "border", label: "테두리선 색상", colorKey: "border", colorVar: "--border", paint: "hr-line" },
  { id: "accent", label: "강조 요소 색상", colorKey: "accent", colorVar: "--accent" },
  { id: "muted", label: "보조 텍스트 (Muted)", colorKey: "muted", colorVar: "--muted" },
  { id: "fg", label: "기본 본문 글자색", colorKey: "fg", colorVar: "--fg" },
  { id: "link", label: "[[위키링크 (Link)]]", colorKey: "link", colorVar: "--link", bgKey: "linkBg", bgVar: "--link-bg", bgFallback: "transparent" },
  { id: "bold", label: "굵은 글자 (Bold)", colorKey: "bold", colorVar: "--bold-color", colorFallback: "inherit", bgKey: "boldBg", bgVar: "--bold-bg", bgFallback: "transparent" },
  { id: "italic", label: "기울임꼴 (Italic)", colorKey: "italic", colorVar: "--italic-color", colorFallback: "inherit", bgKey: "italicBg", bgVar: "--italic-bg", bgFallback: "transparent" },
  // ── round 2: 볼드이탤릭·취소선 (italic 바로 뒤 — 문단 1의 DOM 순서와 일치) ──
  {
    id: "boldItalic",
    label: "볼드+이탤릭 (Bold+Italic)",
    colorKey: "boldItalic",
    colorVar: "--bold-italic-color",
    // `.cm-strong.cm-em`(한 엘리먼트가 두 클래스를 동시에 갖는 경우)은 죽은
    // 셀렉터다 — Emphasis/StrongEmphasis는 항상 중첩되고, 어느 쪽이 안쪽인지는
    // 마커 순서에 따라 갈린다(fe-schema 실측). 실앱은 `.cm-em .cm-strong`
    // (볼드가 이김) / `.cm-strong .cm-em`(이탤릭이 이김) 두 방향을 각각
    // styles.css에서 처리한다. 이 미리보기 샘플 문구(아래 "***사흘째만은***")는
    // 트리플스타 → 볼드가 이기는 방향이므로 그 체인(`--bold-color`/`--bold-bg`)을
    // 미러링한다. 이 값은 크로스파일 테스트가 styles.css와 문자 그대로
    // 대조한다(tests/theme-css-fallback-parity.test.ts).
    colorFallback: "var(--bold-color, inherit)",
    bgKey: "boldItalicBg",
    bgVar: "--bold-italic-bg",
    bgFallback: "var(--bold-bg, transparent)",
  },
  {
    id: "strike",
    label: "취소선 (Strikethrough)",
    colorKey: "strike",
    colorVar: "--strike-color",
    colorFallback: "inherit",
    bgKey: "strikeBg",
    bgVar: "--strike-bg",
    bgFallback: "transparent",
  },
  { id: "code", label: "인라인 코드 (Code)", colorKey: "code", colorVar: "--code-color", colorFallback: "inherit", bgKey: "codeBg", bgVar: "--code-bg", bgFallback: "var(--surface-veil)" },
  { id: "highlight", label: "형광펜 (Highlight)", colorKey: "highlight", colorVar: "--highlight-color", colorFallback: "#1a1300", bgKey: "highlightBg", bgVar: "--highlight-bg", bgFallback: "#fff3a3" },
  // ── round 2: 인용구·코드블럭 (comment 바로 앞 — 문서 자연 순서상 인용/코드가 주석보다 앞) ──
  {
    id: "quote",
    label: "인용구 글자 (Quote)",
    colorKey: "quote",
    colorVar: "--quote-color",
    colorFallback: "inherit",
    bgKey: "quoteBg",
    bgVar: "--quote-bg",
    bgFallback: "var(--block-fill)",
    paint: "quote-text",
  },
  {
    id: "quoteBar",
    label: "인용구 세로 바",
    colorKey: "quoteBar",
    colorVar: "--quote-bar",
    colorFallback: "var(--block-edge)",
    paint: "quote-bar",
  },
  {
    id: "codeBlock",
    label: "코드블럭 (Code Block)",
    colorKey: "codeBlock",
    colorVar: "--codeblock-color",
    colorFallback: "inherit",
    bgKey: "codeBlockBg",
    bgVar: "--codeblock-bg",
    bgFallback: "var(--block-fill)",
  },
  { id: "comment", label: "주석 (Comment)", colorKey: "comment", colorVar: "--comment-color", colorFallback: "var(--muted)", bgKey: "commentBg", bgVar: "--comment-bg", bgFallback: "transparent" },
  { id: "h1", label: "제목 1 (H1)", colorKey: "h1", colorVar: "--h1-color", colorFallback: "var(--fg)", bgKey: "h1Bg", bgVar: "--h1-bg", bgFallback: "transparent" },
  { id: "h2", label: "제목 2 (H2)", colorKey: "h2", colorVar: "--h2-color", colorFallback: "var(--fg)", bgKey: "h2Bg", bgVar: "--h2-bg", bgFallback: "transparent" },
  { id: "h3", label: "제목 3 (H3)", colorKey: "h3", colorVar: "--h3-color", colorFallback: "var(--fg)", bgKey: "h3Bg", bgVar: "--h3-bg", bgFallback: "transparent" },
  { id: "h4", label: "제목 4 (H4)", colorKey: "h4", colorVar: "--h4-color", colorFallback: "var(--fg)", bgKey: "h4Bg", bgVar: "--h4-bg", bgFallback: "transparent" },
  { id: "h5", label: "제목 5 (H5)", colorKey: "h5", colorVar: "--h5-color", colorFallback: "var(--fg)", bgKey: "h5Bg", bgVar: "--h5-bg", bgFallback: "transparent" },
  { id: "h6", label: "제목 6 (H6)", colorKey: "h6", colorVar: "--h6-color", colorFallback: "var(--muted)", bgKey: "h6Bg", bgVar: "--h6-bg", bgFallback: "transparent" },
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

/** `var(name)` or `var(name, fallback)` — the ONE place a CSS var reference
 *  string gets composed, so every paint path (and every test asserting an
 *  exact chain string) goes through the same formatting rule. Pure query. */
function cssVar(name: string, fallback?: string): string {
  return fallback ? `var(${name}, ${fallback})` : `var(${name})`;
}

/** Apply `t.colorVar`/`t.bgVar` (with their fallbacks) to the right CSS
 *  property for `t.paint` (default "color" — the target IS the colored
 *  text). This is the ONLY place that maps paint→property; a target's DOM
 *  builder never sets color/background inline itself, so "which property
 *  does this var paint" can't drift between two call sites (round-1 polish
 *  pass: the quote line and the finder card were unreadable because their
 *  chrome var was applied as text color instead of fill/border — see the
 *  ThemeTarget doc comment). Command/CQS: void (mutates the passed
 *  element's style). */
function paintTarget(el: HTMLElement, t: ThemeTarget): void {
  switch (t.paint) {
    case "surface-card":
      // The "찾기" card: colorVar (--surface) is the CARD FILL, not its own
      // text — text stays normal reading ink so the card is legible against
      // any preset, and a real border makes the card's edges visible even
      // when --surface is close to --bg (light/claude).
      el.style.background = cssVar(t.colorVar, t.bgFallback);
      el.style.border = "1px solid var(--border)";
      el.style.color = "var(--fg)";
      break;
    case "hr-line":
      // The horizontal rule: colorVar (--border) is the RULE'S OWN TOP
      // BORDER — matching the real editor's `.cm-hr` byte-for-byte
      // (styles.css:1738). There is no text to color (the button renders
      // as a bare line), so text color is never touched here.
      el.style.borderTop = `1px solid ${cssVar(t.colorVar, t.colorFallback)}`;
      break;
    case "quote-bar":
      // The blockquote's left bar as its OWN target (round 2 — no longer
      // riding `border`, see the ThemeTarget doc comment). A thin filled
      // rectangle: colorVar paints background-color, not a border property.
      el.style.backgroundColor = cssVar(t.colorVar, t.colorFallback);
      break;
    case "quote-text":
      // The blockquote's sentence: text color only. The blockquote's own
      // BACKGROUND is painted on the CONTAINER by `paintQuoteContainerBg`,
      // not here — this button and that container are different elements.
      el.style.color = cssVar(t.colorVar, t.colorFallback);
      break;
    default:
      el.style.color = cssVar(t.colorVar, t.colorFallback);
      if (t.bgVar) el.style.background = cssVar(t.bgVar, t.bgFallback);
  }
}

/** Paint the blockquote CONTAINER's background from the `quote` target's bg
 *  chain (`--quote-bg`, fallback `--block-fill`) — the one case where a
 *  target's background lands on an element other than its own button (see
 *  the ThemeTarget doc comment on `"quote-text"`). Takes the target
 *  explicitly rather than looking it up, so a caller can't accidentally
 *  paint the wrong target's chain here. Command/CQS: void. */
function paintQuoteContainerBg(el: HTMLElement, quoteTarget: ThemeTarget): void {
  if (!quoteTarget.bgVar) return;
  el.style.background = cssVar(quoteTarget.bgVar, quoteTarget.bgFallback);
}

/** Build one target button. `text` is the visible sample text — and per the
 *  "미리보기는 편집 모드의 모습을 보여준다" rule (see `EDIT_MODE_SAMPLE_TEXT`
 *  below), it is always the RAW markdown source (with its `#`/`##`/`[[ ]]`/
 *  `==` marker syntax intact) — only color/weight/background are themed, the
 *  text itself is never concealed. The target's label is NOT painted as a
 *  floating callout on the button itself (that overlapped neighboring lines
 *  — round-1 polish pass); it is shown in the single persistent status line
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

/** "평문은 어디를 눌러도 fg" (round-2 감사 반영, 결정 6) — every plain/
 *  unstyled run of sample text shares the SAME `fg` target, so no run is a
 *  dead click zone (round-1's bug: only the literal two syllables "짐은" were
 *  a target; the rest of every paragraph's plain text was inert). Exactly
 *  ONE run is a real `<button>` (`focusable: true`, used once per paragraph
 *  — one Tab stop per paragraph, not one per run: a button per word would be
 *  Tab-order noise for what is conceptually a single target). Every other
 *  run is a plain `<span data-target="fg">` — unfocusable, but the existing
 *  click delegation (`closest("[data-target]")`) and the group-hover
 *  mechanism (`setHoverGroup`, keyed on `dataset.target`) both already
 *  operate on ANY element carrying `[data-target]`, not just buttons, so
 *  these spans participate fully in selection and hover feedback without
 *  needing their own listeners. */
function fgRun(text: string, opts: { focusable: boolean } = { focusable: false }): HTMLElement {
  const fg = themeTarget("fg")!;
  if (opts.focusable) return targetButton(fg, text, "theme-inline theme-fg-run");
  const span = document.createElement("span");
  span.className = "theme-target theme-inline theme-fg-run";
  span.dataset.target = fg.id;
  span.dataset.label = fg.label;
  span.style.color = "var(--fg)";
  span.textContent = text;
  return span;
}

/** "미리보기는 편집 모드의 모습을 보여준다 — 모든 요소가 마커를 포함한 원문
 *  형태로 렌더되고, 스타일(색·굵기·배경)만 적용된다" (2026-08 폴리시 리뷰 2차
 *  — 1차 결정을 사용자가 직접 뒤집었다: "마커째 들어와도 돼, 편집모드에선
 *  마커 보이잖아 어차피"). 이 상수가 "모든 샘플 텍스트는 raw 마크다운 문법을
 *  포함한다"는 규칙을 한 곳에 고정한다 — 향후 샘플을 늘릴 때 다시 "일부는
 *  마커/일부는 렌더"로 갈라지는 걸 구조적으로 막는다.
 *
 *  **명시적 예외 3건** (2026-08 감사 Minor 지적 반영 — 예외를 이 주석에 적어
 *  둔다, 규칙과 별개 장소에 흩어두지 않는다):
 *  - **스케일 스트립**(`제목 3`~`제목 6`): `###`~`######` 마커를 그대로 쓰면
 *    스트립이 마커 반복으로 도배된다 — 압축 표현이 목적이므로 마커를 뺀
 *    라벨을 쓴다(round 1 결정).
 *  - **인용구**: 마커 `>`를 표기하지 **않는다**. 실앱 편집 모드에서 blockquote
 *    마커는 conceal되고 좌측 바+배경으로만 렌더되므로("> " 자체가 안 보임),
 *    마커 없는 현재 형태가 오히려 실앱과 일치한다 — 이 항목만은 "마커 포함"
 *    규칙의 적용 대상이 아니라 애초에 실앱이 그렇게 안 보여준다.
 *  - **코드블럭**: 펜스(```) 마커를 표기하지 않는다. 코드블럭은 atomic 블록
 *    위젯이라 편집 모드에서도 커서가 밖에 있으면 펜스 없는 위젯 형태로
 *    렌더된다 — 인용구와 같은 이유(실앱이 그렇게 안 보여준다). */
const EDIT_MODE_SAMPLE_TEXT = {
  h1: "# 제주 여행 준비",
  h2: "## 사흘째 아침",
  link: "[[제주 숙소 목록]]",
  highlight: "==환전은 출발 전에==",
  footnoteRef: "[^1]",
  bold: "**가볍게**",
  italic: "*느슨하게*",
  boldItalic: "***사흘째만은***",
  strike: "~~완벽한 동선~~",
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
 *  selected target (or null on clear) and the DOM element the selection came
 *  from (the specific clicked/focused element — matters for `fg`, which has
 *  many elements sharing one target; the floating inspector needs to scroll
 *  THAT element into view and measure THAT rect, not an arbitrary one). The
 *  color inspector is the only subscriber. Colors are NOT tracked/reflected
 *  here: every target paints itself via `var(--x)`, and themeVarsSink is the
 *  single writer of those vars, so the frame updates for free on every
 *  setting change — no subscription, no re-render, no drift between two
 *  color sources. */
export function buildThemePreview(onSelect: (t: ThemeTarget | null, el?: HTMLElement) => void): ThemePreview {
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

  // 문단 1: 기존 인라인 3종(fg/bold/italic) + 신규 2종(boldItalic/strike) —
  // 설계 결정 4의 문단 분할(밀도 완화) + 결정 6의 fg 전체-런 타깃화.
  const p1 = document.createElement("p");
  p1.className = "theme-p";
  p1.append(
    fgRun("짐은", { focusable: true }),
    fgRun(" "),
    targetButton(themeTarget("bold")!, EDIT_MODE_SAMPLE_TEXT.bold, "theme-inline"),
    fgRun(" 싸고, 일정은 "),
    targetButton(themeTarget("italic")!, EDIT_MODE_SAMPLE_TEXT.italic, "theme-inline"),
    fgRun(" 잡는다. "),
    targetButton(themeTarget("boldItalic")!, EDIT_MODE_SAMPLE_TEXT.boldItalic, "theme-inline"),
    fgRun(" 아무 계획 없이, "),
    targetButton(themeTarget("strike")!, EDIT_MODE_SAMPLE_TEXT.strike, "theme-inline"),
    fgRun("은 잊는다."),
  );
  doc.appendChild(p1);

  // 문단 2: 링크/하이라이트/코드/각주 — 기존 문단 그대로, 별도 문단으로 분리.
  const p2 = document.createElement("p");
  p2.className = "theme-p";
  p2.append(
    fgRun("숙소는", { focusable: true }),
    " ",
    targetButton(themeTarget("link")!, EDIT_MODE_SAMPLE_TEXT.link, "theme-inline"),
    fgRun("에서 고르고, "),
    targetButton(themeTarget("highlight")!, EDIT_MODE_SAMPLE_TEXT.highlight, "theme-inline"),
    fgRun(" 끝낸다. 예약 번호 "),
    targetButton(themeTarget("code")!, EDIT_MODE_SAMPLE_TEXT.code, "theme-inline theme-code"),
    fgRun("은 지갑에도 적어 둔다"),
    targetButton(themeTarget("accent")!, EDIT_MODE_SAMPLE_TEXT.footnoteRef, "theme-inline theme-footnote"),
    fgRun("."),
  );
  doc.appendChild(p2);

  // 인용구(round 2): 이제 quote/quoteBar 둘 다 실제 타깃이다(round-1 감사
  // major #3로 강등됐던 자리를 각자 자기 키로 복구). 컨테이너 자체가
  // `data-target="quote"`를 들고 있어(버튼 아님) 바/글자 버튼이 아닌 패딩
  // 클릭도 "quote"로 귀속된다(결정 6 장치 2: 최내곽 승리 — 바/글자 버튼이
  // 컨테이너보다 가까운 조상이라 그 둘을 클릭하면 당연히 그 둘이 이긴다).
  const quoteTarget = themeTarget("quote")!;
  const quote = document.createElement("blockquote");
  quote.className = "theme-quote";
  quote.dataset.target = quoteTarget.id;
  paintQuoteContainerBg(quote, quoteTarget);
  const quoteBar = targetButton(themeTarget("quoteBar")!, "", "theme-quote-bar");
  const quoteTextBtn = targetButton(quoteTarget, "짐을 줄이는 가장 확실한 방법은 가방을 작게 사는 것이다.", "theme-quote-text");
  quote.append(quoteBar, quoteTextBtn);
  doc.appendChild(quote);

  // 코드블럭(round 2): 블록 전체가 버튼 1개(설계 결정 1 — 내부 분할 없음,
  // 글자/배경은 인스펙터 탭이 구분). 펜스(```) 마커는 표기하지 않는다
  // (EDIT_MODE_SAMPLE_TEXT의 doc comment 예외 3 — atomic 블록 위젯 규칙).
  const codeBlockBtn = targetButton(themeTarget("codeBlock")!, "", "theme-codeblock");
  const codeBlockLine1 = document.createElement("span");
  codeBlockLine1.className = "theme-codeblock-line";
  codeBlockLine1.textContent = 'const bag = pack("가볍게");';
  const codeBlockLine2 = document.createElement("span");
  codeBlockLine2.className = "theme-codeblock-line";
  codeBlockLine2.textContent = "bag.weigh();";
  codeBlockBtn.append(codeBlockLine1, codeBlockLine2);
  doc.appendChild(codeBlockBtn);

  const comment = targetButton(themeTarget("comment")!, EDIT_MODE_SAMPLE_TEXT.comment, "theme-line theme-comment-line");
  doc.appendChild(comment);

  // The `border` target's REAL anchor (round-1 감사 반영, major #3) — the
  // real editor's `.cm-hr` genuinely consumes `--border` (styles.css:1738).
  // A <button>, not a decorative <hr>: it renders as a bare full-width top
  // border via `paintTarget`'s "hr-line" case, with no visible text — its
  // accessible name comes from aria-label.
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

  // The single persistent status line (round-1 polish pass replacement for
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

  // "그룹 호버" (설계 결정 6) — `dataset.target`이 같은 모든 엘리먼트에
  // 함께 `is-hover-group`을 건다. fg처럼 여러 DOM 노드가 한 타깃을 나눠
  // 갖는 경우, 마우스가 어느 조각에 있든 "이게 다 한 대상"임이 보이게
  // 하려는 장치 — 단일 엘리먼트 타깃(대부분)은 이 클래스가 붙어도 CSS가
  // `.theme-fg-run.is-hover-group`에만 시각 효과를 주므로 겉보기 동작이
  // 그대로다(기존 `:hover` 링이 여전히 그 역할을 한다). CSS 클래스 토글만
  // 하는 순수 DOM 조작이라 새 리스너 없이 기존 pointerover/out·focusin/out
  // 위임에 얹는다.
  function setHoverGroup(id: string | null): void {
    wrap.querySelectorAll(".is-hover-group").forEach((el) => el.classList.remove("is-hover-group"));
    if (id == null) return;
    wrap.querySelectorAll(`[data-target="${id}"]`).forEach((el) => el.classList.add("is-hover-group"));
  }

  function select(id: string, sourceEl?: HTMLElement): void {
    const t = themeTarget(id);
    if (!t) return;
    selected = t;
    reflectSelection();
    renderStatusLine();
    onSelect(t, sourceEl ?? wrap.querySelector<HTMLElement>(`[data-target="${id}"]`) ?? undefined);
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
    setHoverGroup(hoveredId);
  }
  function onPointerOut(e: Event): void {
    if (!(e.target as HTMLElement).closest?.("[data-target]")) return;
    hoveredId = null;
    renderStatusLine();
    setHoverGroup(null);
  }
  function onFocusIn(e: Event): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-target]");
    if (!el) return;
    hoveredId = el.dataset.target ?? null;
    renderStatusLine();
    setHoverGroup(hoveredId);
  }
  function onFocusOut(): void {
    hoveredId = null;
    renderStatusLine();
    setHoverGroup(null);
  }
  wrap.addEventListener("pointerover", onPointerOver);
  wrap.addEventListener("pointerout", onPointerOut);
  wrap.addEventListener("focusin", onFocusIn);
  wrap.addEventListener("focusout", onFocusOut);

  // 설계 결정 6, 장치 3: 프레임 내부에서 어떤 타깃도 점유하지 않은 클릭은
  // 전부 bg로 낙하한다 — 그 픽셀은 실제로 캔버스(--bg)가 보이는 자리라
  // 정직하다. 이전 버전은 여기서 `targetEl === frame && el !== frame`이면
  // return(무반응)했다 — 이게 "죽은 영역"의 본체였다(스케일 스트립 구분자,
  // 문단 사이 틈, 툴바 여백 전부 무반응). 가드를 없애면 closest()가 자연히
  // frame까지 올라가 bg를 고른다 — 별도 처리 불필요, 삭제가 곧 수정이다.
  function onClick(e: MouseEvent): void {
    const el = e.target as HTMLElement;
    const targetEl = el.closest<HTMLElement>("[data-target]");
    if (!targetEl) return; // 프레임 바깥(예: 힌트 줄) 클릭 — 고를 게 없다
    select(targetEl.dataset.target!, targetEl);
  }
  wrap.addEventListener("click", onClick);

  // The frame's role="button" div needs manual Enter/Space handling — real
  // <button>s (every other target) get this for free from the browser.
  function onFrameKeydown(e: KeyboardEvent): void {
    if (e.target !== frame) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      select("bg", frame);
    }
  }
  frame.addEventListener("keydown", onFrameKeydown);

  // Escape clears selection regardless of which target currently has focus —
  // attached on the wrapper so it fires for any focused descendant without a
  // global (document-level) listener that would need its own leak-guard.
  // NOTE: this only covers focus INSIDE the preview frame. Round-2 감사
  // Minor(직전 라운드) — 포커스가 인스펙터 내부에 있을 때는 Escape가 이
  // 리스너에 안 걸린다. controls.ts가 preview+inspector 합성 컨테이너에
  // 별도 Escape 리스너를 얹어(`clearSelection` 재사용) 그 범위를 승격한다
  // — 이 리스너를 지우거나 옮기지 않는다(프리뷰 단독 사용 시에도 여전히
  // 동작해야 함).
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
