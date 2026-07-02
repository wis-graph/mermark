import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRecentPanel } from "../src/recent/recent-panel";

// The recent panel is outline-shaped chrome: a status-bar button toggling a
// lazily-rendered list. It reads getRecent() (a closure over the SSOT setting)
// and re-renders on refresh(); a click opens via the injected onOpen.

describe("recent panel", () => {
  let host: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("builds a status-bar button with the history icon + label", () => {
    const { button } = createRecentPanel({ getRecent: () => [], onOpen: () => {} });
    expect(button.classList.contains("status-btn")).toBe(true);
    expect(button.querySelector(".icon-history")).not.toBeNull();
    expect(button.textContent).toContain("최근");
  });

  it("starts hidden and toggles open/closed on button click", () => {
    const { button, row } = createRecentPanel({ getRecent: () => ["/a.md"], onOpen: () => {} });
    host.append(button, row);
    expect(row.hidden).toBe(true);
    button.click();
    expect(row.hidden).toBe(false);
    button.click();
    expect(row.hidden).toBe(true);
  });

  it("renders each recent doc as basename + full path", () => {
    const { button, row } = createRecentPanel({
      getRecent: () => ["/notes/alpha.md", "/x/beta.md"],
      onOpen: () => {},
    });
    host.append(button, row);
    button.click();
    const items = row.querySelectorAll(".recent-item");
    expect(items.length).toBe(2);
    expect(items[0].querySelector(".recent-name")?.textContent).toBe("alpha.md");
    expect(items[0].querySelector(".recent-path")?.textContent).toBe("/notes/alpha.md");
  });

  it("shows the empty state when there is no history", () => {
    const { button, row } = createRecentPanel({ getRecent: () => [], onOpen: () => {} });
    host.append(button, row);
    button.click();
    expect(row.querySelector<HTMLElement>(".recent-empty")!.hidden).toBe(false);
  });

  it("calls onOpen with the path on item mousedown", () => {
    const onOpen = vi.fn();
    const { button, row } = createRecentPanel({ getRecent: () => ["/notes/a.md"], onOpen });
    host.append(button, row);
    button.click();
    const item = row.querySelector<HTMLElement>(".recent-item")!;
    item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(onOpen).toHaveBeenCalledWith("/notes/a.md");
  });

  it("re-renders on refresh() when the live list changed (subscription sink)", () => {
    let list = ["/a.md"];
    const { button, row, refresh } = createRecentPanel({ getRecent: () => list, onOpen: () => {} });
    host.append(button, row);
    button.click();
    expect(row.querySelectorAll(".recent-item").length).toBe(1);
    list = ["/b.md", "/a.md"];
    refresh();
    expect(row.querySelectorAll(".recent-item").length).toBe(2);
    expect(row.querySelector(".recent-name")?.textContent).toBe("b.md");
  });

  it("refresh() is a no-op while the panel is closed (cost 0)", () => {
    const getRecent = vi.fn(() => ["/a.md"]);
    const { refresh } = createRecentPanel({ getRecent, onOpen: () => {} });
    refresh(); // closed → should not read the list
    expect(getRecent).not.toHaveBeenCalled();
  });
});
