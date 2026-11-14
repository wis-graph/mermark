import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Edge-hover peek controller. installEdgePeek leaves listeners on document/
// window, so each test imports a FRESH module (resetModules) and builds fresh
// options — a leaked listener from an earlier test then points at its own
// (stale) spies and never touches this test's.
type Mod = typeof import("../src/sidebar/edge-peek");

let st = { peeking: false };
let workspace: HTMLElement, aside: HTMLElement, editor: HTMLElement, toggleBtn: HTMLElement;
let opts: { mayPeek: ReturnType<typeof vi.fn>; peek: ReturnType<typeof vi.fn>; dismiss: ReturnType<typeof vi.fn> };
let mod: Mod;

const move = (target: Element, x: number, y: number, buttons = 0) =>
  target.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y, buttons, bubbles: true }));

async function setup() {
  vi.resetModules();
  mod = await import("../src/sidebar/edge-peek");
  const mineSt = { peeking: false };
  st = mineSt;
  workspace = document.createElement("div");
  aside = document.createElement("aside");
  editor = document.createElement("div");
  toggleBtn = document.createElement("button");
  workspace.append(aside, editor);
  document.body.append(workspace, toggleBtn);
  // 로컬 캡처: 이전 테스트가 남긴 리스너는 자기 옵션(옛 spy)만 호출한다.
  const mine = {
    mayPeek: vi.fn(() => true),
    peek: vi.fn(() => { mineSt.peeking = true; }),
    dismiss: vi.fn(() => { mineSt.peeking = false; }),
  };
  opts = mine;
  const myAside = aside;
  mod.installEdgePeek({
    workspace, aside: myAside, keepTargets: [toggleBtn],
    mayPeek: () => mine.mayPeek(), isPeeking: () => mineSt.peeking,
    peek: () => mine.peek(), dismiss: () => mine.dismiss(),
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  await setup();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("inEdgeZone", () => {
  it("진리표", () => {
    expect(mod.inEdgeZone(0, 300)).toBe(true);
    expect(mod.inEdgeZone(5, 300)).toBe(true);
    expect(mod.inEdgeZone(6, 300)).toBe(false);
    expect(mod.inEdgeZone(3, 35)).toBe(false);
    expect(mod.inEdgeZone(3, 36)).toBe(true);
  });
});

describe("dwell", () => {
  it("200ms 뒤에 peek 1회", () => {
    move(editor, 3, 300);
    vi.advanceTimersByTime(199);
    expect(opts.peek).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(opts.peek).toHaveBeenCalledTimes(1);
  });

  it("띠 진입 시점 기준 — 띠 안에서 움직여도 재시작 안 함", () => {
    move(editor, 3, 300);
    vi.advanceTimersByTime(150);
    move(editor, 4, 310);
    vi.advanceTimersByTime(50);
    expect(opts.peek).toHaveBeenCalledTimes(1);
  });

  it("띠 이탈 시 취소", () => {
    move(editor, 3, 300);
    vi.advanceTimersByTime(100);
    move(editor, 50, 300);
    vi.advanceTimersByTime(500);
    expect(opts.peek).not.toHaveBeenCalled();
  });

  it("버튼 누름: 시작 안 함 / dwell 중 누르면 취소", () => {
    move(editor, 3, 300, 1);
    vi.advanceTimersByTime(500);
    expect(opts.peek).not.toHaveBeenCalled();
    move(editor, 50, 300);
    move(editor, 3, 300);
    vi.advanceTimersByTime(100);
    move(editor, 3, 301, 1);
    vi.advanceTimersByTime(500);
    expect(opts.peek).not.toHaveBeenCalled();
  });

  it("title-bar 밴드(y<36)는 제외", () => {
    move(editor, 3, 10);
    vi.advanceTimersByTime(500);
    expect(opts.peek).not.toHaveBeenCalled();
  });

  it("workspace 밖 target(모달 대역)은 시작 안 함", () => {
    const modal = document.createElement("div");
    document.body.append(modal);
    move(modal, 3, 300);
    vi.advanceTimersByTime(500);
    expect(opts.peek).not.toHaveBeenCalled();
  });

  it("document.hasFocus() false면 시작 안 함", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    move(editor, 3, 300);
    vi.advanceTimersByTime(500);
    expect(opts.peek).not.toHaveBeenCalled();
  });

  it("mayPeek는 만료 시점에 재평가", () => {
    move(editor, 3, 300);
    vi.advanceTimersByTime(100);
    opts.mayPeek.mockReturnValue(false);
    vi.advanceTimersByTime(100);
    expect(opts.peek).not.toHaveBeenCalled();
  });

  it("창 이탈(mouseout relatedTarget null)·window blur는 dwell 취소", () => {
    move(editor, 3, 300);
    vi.advanceTimersByTime(100);
    document.dispatchEvent(new MouseEvent("mouseout", { relatedTarget: null }));
    vi.advanceTimersByTime(500);
    expect(opts.peek).not.toHaveBeenCalled();

    move(editor, 50, 300);
    move(editor, 3, 300);
    vi.advanceTimersByTime(100);
    window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(500);
    expect(opts.peek).not.toHaveBeenCalled();
  });
});

async function startPeek() {
  move(editor, 3, 300);
  vi.advanceTimersByTime(200);
  expect(st.peeking).toBe(true);
}

describe("leave grace", () => {
  it("밖으로 나가면 300ms 뒤 dismiss", async () => {
    await startPeek();
    move(editor, 600, 300);
    vi.advanceTimersByTime(299);
    expect(opts.dismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(opts.dismiss).toHaveBeenCalledTimes(1);
  });

  it("grace 중 aside로 복귀하면 취소", async () => {
    await startPeek();
    move(editor, 600, 300);
    vi.advanceTimersByTime(200);
    move(aside, 100, 300);
    vi.advanceTimersByTime(1000);
    expect(opts.dismiss).not.toHaveBeenCalled();
  });

  it("컨텍스트메뉴 열림 중엔 보류, 닫히면 자가 회복", async () => {
    const { openContextMenu } = await import("../src/chrome/context-menu");
    await startPeek();
    openContextMenu({ x: 5, y: 5, items: [{ label: "A", onSelect: () => {} }], returnFocusTo: toggleBtn });
    move(editor, 600, 300);
    vi.advanceTimersByTime(900);
    expect(opts.dismiss).not.toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    vi.advanceTimersByTime(300);
    expect(opts.dismiss).toHaveBeenCalledTimes(1);
  });

  it("포인터 버튼 눌림(드래그) 중엔 보류, 떼면 회복", async () => {
    await startPeek();
    move(editor, 600, 300, 1);
    vi.advanceTimersByTime(900);
    expect(opts.dismiss).not.toHaveBeenCalled();
    move(editor, 601, 300, 0);
    vi.advanceTimersByTime(300);
    expect(opts.dismiss).toHaveBeenCalledTimes(1);
  });

  it("peek 중이 아니면 바깥 이동해도 dismiss 안 함", () => {
    move(editor, 600, 300);
    vi.advanceTimersByTime(1000);
    expect(opts.dismiss).not.toHaveBeenCalled();
  });

  it("외부 경로로 이미 닫힌 뒤 grace가 만료돼도 dismiss 안 함", async () => {
    await startPeek();
    move(editor, 600, 300);
    st.peeking = false;
    vi.advanceTimersByTime(400);
    expect(opts.dismiss).not.toHaveBeenCalled();
  });
});

describe("Esc", () => {
  const esc = () => {
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(e);
    return e;
  };

  it("peek 중 Esc → dismiss, preventDefault 안 함", async () => {
    await startPeek();
    const e = esc();
    expect(opts.dismiss).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(false);
  });

  it("peek 아닐 때 Esc는 무시", () => {
    esc();
    expect(opts.dismiss).not.toHaveBeenCalled();
  });

  it("메뉴 열림 중 Esc는 무시", async () => {
    const { openContextMenu } = await import("../src/chrome/context-menu");
    await startPeek();
    openContextMenu({ x: 5, y: 5, items: [{ label: "A", onSelect: () => {} }], returnFocusTo: toggleBtn });
    esc();
    expect(opts.dismiss).not.toHaveBeenCalled();
  });
});

describe("바깥 pointerdown", () => {
  const down = (t: Element) => t.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));

  it("에디터 클릭은 즉시 dismiss, aside·토글 버튼은 유지", async () => {
    await startPeek();
    down(aside);
    down(toggleBtn);
    expect(opts.dismiss).not.toHaveBeenCalled();
    down(editor);
    expect(opts.dismiss).toHaveBeenCalledTimes(1);
  });

  it("메뉴 열림 중 바깥 pointerdown은 무시", async () => {
    const { openContextMenu } = await import("../src/chrome/context-menu");
    await startPeek();
    openContextMenu({ x: 5, y: 5, items: [{ label: "A", onSelect: () => {} }], returnFocusTo: toggleBtn });
    down(editor);
    expect(opts.dismiss).not.toHaveBeenCalled();
  });
});

describe("re-arm", () => {
  it("Esc로 닫은 뒤 같은 띠에 머물면 재오픈 없음, 한 번 나갔다 오면 재오픈", async () => {
    await startPeek();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(st.peeking).toBe(false);
    opts.peek.mockClear();
    for (let i = 0; i < 5; i++) { move(editor, 3, 300 + i); vi.advanceTimersByTime(100); }
    expect(opts.peek).not.toHaveBeenCalled();
    move(editor, 50, 300);
    move(editor, 3, 300);
    vi.advanceTimersByTime(200);
    expect(opts.peek).toHaveBeenCalledTimes(1);
  });
});
