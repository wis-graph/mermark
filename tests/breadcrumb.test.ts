import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBreadcrumb } from "../src/chrome/breadcrumb";

// ---------------------------------------------------------------------------
// Footer breadcrumb chrome — plain DOM, no editor/live-preview intersection.
// The contract this owns:
//   1. render(root) lays out one .breadcrumb-seg button per breadcrumbSegments
//      entry, .breadcrumb-sep between them, last segment aria-current.
//   2. Clicking a segment calls onJump(seg.abs) — the REAL path, not the label.
//   3. render("") clears; re-render never accumulates stale segments.
// ---------------------------------------------------------------------------

let host: HTMLElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => {
  host.remove();
});

const segs = (el: HTMLElement) => [...el.querySelectorAll(".breadcrumb-seg")] as HTMLElement[];
const seps = (el: HTMLElement) => [...el.querySelectorAll(".breadcrumb-sep")] as HTMLElement[];
const clickLabel = (el: HTMLElement, label: string) => {
  const btn = segs(el).find((b) => b.textContent === label);
  btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
};

describe("createBreadcrumb", () => {
  it("renders one segment button per breadcrumbSegments entry, last one aria-current", () => {
    const bc = createBreadcrumb({ onJump: vi.fn() });
    host.append(bc.el);
    bc.render("/Users/wis/docs");

    const buttons = segs(bc.el);
    expect(buttons.map((b) => b.textContent)).toEqual(["~", "docs"]);
    expect(buttons[0].getAttribute("aria-current")).toBeNull();
    expect(buttons[1].getAttribute("aria-current")).toBe("true");
  });

  it("places a separator between segments (n-1 separators for n segments)", () => {
    const bc = createBreadcrumb({ onJump: vi.fn() });
    host.append(bc.el);
    bc.render("/Users/wis/docs/superpowers");
    expect(segs(bc.el)).toHaveLength(3);
    expect(seps(bc.el)).toHaveLength(2);
  });

  it("title carries the full real path", () => {
    const bc = createBreadcrumb({ onJump: vi.fn() });
    host.append(bc.el);
    bc.render("/Users/wis/docs");
    expect(bc.el.title).toBe("/Users/wis/docs");
  });

  it("clicking a segment calls onJump with THAT segment's real abs path", () => {
    const onJump = vi.fn();
    const bc = createBreadcrumb({ onJump });
    host.append(bc.el);
    bc.render("/Users/wis/docs");

    clickLabel(bc.el, "docs");
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith("/Users/wis/docs");

    clickLabel(bc.el, "~");
    expect(onJump).toHaveBeenCalledTimes(2);
    expect(onJump).toHaveBeenLastCalledWith("/Users/wis");
  });

  it("render('') clears the breadcrumb", () => {
    const bc = createBreadcrumb({ onJump: vi.fn() });
    host.append(bc.el);
    bc.render("/Users/wis/docs");
    expect(segs(bc.el).length).toBeGreaterThan(0);

    bc.render("");
    expect(bc.el.children.length).toBe(0);
  });

  it("re-render replaces — no accumulation across calls", () => {
    const bc = createBreadcrumb({ onJump: vi.fn() });
    host.append(bc.el);
    bc.render("/Users/wis/docs");
    bc.render("/etc/nginx");
    expect(segs(bc.el).map((b) => b.textContent)).toEqual(["/", "etc", "nginx"]);
  });

  // renderLabel — the explorer's "내 컴퓨터" (My Computer) virtual root: a
  // single non-clickable label, not a real jumpable path.
  it("renderLabel shows a single non-clickable segment carrying the label", () => {
    const onJump = vi.fn();
    const bc = createBreadcrumb({ onJump });
    host.append(bc.el);
    bc.renderLabel("내 컴퓨터");

    const buttons = segs(bc.el);
    expect(buttons.map((b) => b.textContent)).toEqual(["내 컴퓨터"]);
    expect(bc.el.querySelectorAll("button").length).toBe(0); // not clickable
    buttons[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onJump).not.toHaveBeenCalled();
  });

  it("renderLabel replaces a prior render (and vice versa) — no accumulation", () => {
    const bc = createBreadcrumb({ onJump: vi.fn() });
    host.append(bc.el);
    bc.render("/Users/wis/docs");
    bc.renderLabel("내 컴퓨터");
    expect(segs(bc.el).map((b) => b.textContent)).toEqual(["내 컴퓨터"]);

    bc.render("/etc");
    expect(segs(bc.el).map((b) => b.textContent)).toEqual(["/", "etc"]);
  });
});
