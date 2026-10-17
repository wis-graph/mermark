import { describe, it, expect, vi, afterEach } from "vitest";
import { openContextMenu } from "../src/chrome/context-menu";

afterEach(() => {
  document.querySelectorAll('[role="menu"]').forEach((n) => n.remove());
});

describe("openContextMenu (T4, 0.17.1 — reusable UI primitive)", () => {
  it("Esc로 닫으면 포커스가 원래 행으로 돌아간다", () => {
    const row = document.createElement("div");
    row.tabIndex = 0;
    document.body.append(row);
    row.focus();
    openContextMenu({ x: 10, y: 10, items: [{ label: "A", onSelect: () => {} }], returnFocusTo: row });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(row);
    row.remove();
  });

  it("항목 선택 시 onSelect가 정확히 한 번 실행되고 메뉴가 닫힌다", () => {
    const row = document.createElement("div");
    row.tabIndex = 0;
    document.body.append(row);
    const spy = vi.fn();
    openContextMenu({ x: 0, y: 0, items: [{ label: "A", onSelect: spy }], returnFocusTo: row });
    document.querySelector<HTMLElement>('[role="menuitem"]')!.click();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    row.remove();
  });

  it("비활성 항목은 실행되지 않지만 이유가 보인다 (숨기지 않는다)", () => {
    const row = document.createElement("div");
    row.tabIndex = 0;
    document.body.append(row);
    const spy = vi.fn();
    openContextMenu({
      x: 0,
      y: 0,
      returnFocusTo: row,
      items: [{ label: "경로 복사", disabled: true, onSelect: spy }],
    });
    const item = document.querySelector<HTMLElement>('[role="menuitem"]')!;
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toContain("경로 복사"); // 사라지지 않는다 — 조용한 강등 금지
    item.click();
    expect(spy).not.toHaveBeenCalled();
    row.remove();
  });

  it("화살표로 항목을 옮기고 두 번째 메뉴를 열면 첫 메뉴는 닫힌다", () => {
    const row = document.createElement("div");
    row.tabIndex = 0;
    document.body.append(row);
    openContextMenu({
      x: 0,
      y: 0,
      returnFocusTo: row,
      items: [
        { label: "A", onSelect: () => {} },
        { label: "B", onSelect: () => {} },
      ],
    });
    const items = document.querySelectorAll<HTMLElement>('[role="menuitem"]');
    expect(document.activeElement).toBe(items[0]);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(items[1]);

    // opening a second menu closes the first — only one instance at a time.
    openContextMenu({ x: 5, y: 5, returnFocusTo: row, items: [{ label: "C", onSelect: () => {} }] });
    const menus = document.querySelectorAll('[role="menu"]');
    expect(menus).toHaveLength(1);
    expect(menus[0].textContent).toContain("C");
    row.remove();
  });

  it("바깥 클릭 시 닫힌다", () => {
    const row = document.createElement("div");
    row.tabIndex = 0;
    document.body.append(row);
    openContextMenu({ x: 0, y: 0, returnFocusTo: row, items: [{ label: "A", onSelect: () => {} }] });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    row.remove();
  });
});

describe("openContextMenu — 구분선 (MENU_SEPARATOR)", () => {
  const mkRow = () => {
    const row = document.createElement("div");
    row.tabIndex = 0;
    document.body.append(row);
    return row;
  };
  const key = (k: string) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

  it("구분선은 role=separator, 포커스 불가, menuitem 개수에 안 들어간다", async () => {
    const { MENU_SEPARATOR } = await import("../src/chrome/context-menu");
    const row = mkRow();
    openContextMenu({
      x: 0, y: 0, returnFocusTo: row,
      items: [{ label: "A", onSelect: () => {} }, MENU_SEPARATOR, { label: "B", onSelect: () => {} }],
    });
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
    const sep = document.querySelectorAll<HTMLElement>('[role="separator"]');
    expect(sep).toHaveLength(1);
    expect(sep[0].hasAttribute("tabindex")).toBe(false);
    row.remove();
  });

  it("구분선 뒤 항목에서 Enter는 그 항목의 onSelect만 실행한다 (인덱스 정렬)", async () => {
    const { MENU_SEPARATOR } = await import("../src/chrome/context-menu");
    const row = mkRow();
    const a = vi.fn();
    const b = vi.fn();
    openContextMenu({
      x: 0, y: 0, returnFocusTo: row,
      items: [{ label: "A", onSelect: a }, MENU_SEPARATOR, { label: "B", onSelect: b }],
    });
    key("ArrowDown");
    expect(document.activeElement?.textContent).toBe("B");
    key("Enter");
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    row.remove();
  });

  it("End는 마지막 menuitem에 포커스한다 (구분선이 아님)", async () => {
    const { MENU_SEPARATOR } = await import("../src/chrome/context-menu");
    const row = mkRow();
    openContextMenu({
      x: 0, y: 0, returnFocusTo: row,
      items: [{ label: "A", onSelect: () => {} }, MENU_SEPARATOR, { label: "B", onSelect: () => {} }, { label: "C", onSelect: () => {} }],
    });
    key("End");
    expect(document.activeElement?.textContent).toBe("C");
    key("Home");
    expect(document.activeElement?.textContent).toBe("A");
    row.remove();
  });

  it("앞 항목이 비활성이어도 구분선 뒤 첫 활성 항목이 초기 포커스를 받는다", async () => {
    const { MENU_SEPARATOR } = await import("../src/chrome/context-menu");
    const row = mkRow();
    openContextMenu({
      x: 0, y: 0, returnFocusTo: row,
      items: [MENU_SEPARATOR, { label: "A", disabled: true, onSelect: () => {} }, MENU_SEPARATOR, { label: "B", onSelect: () => {} }],
    });
    expect(document.activeElement?.textContent).toBe("B");
    row.remove();
  });
});
