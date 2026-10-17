import { describe, it, expect, vi } from "vitest";
import { fileRowMenuEntries } from "../src/sidebar/explorer/file-row-menu";
import { isMenuSeparator } from "../src/chrome/context-menu";
import type { FileAction } from "../src/chrome/file-actions/registry";

const act = (id: string, label: string): FileAction => ({ id, label, extensions: ["png"], run: vi.fn() });
const labels = (es: ReturnType<typeof fileRowMenuEntries>) => es.map((e) => (isMenuSeparator(e) ? "—" : e.label));
const base = { absPath: "/r/a.png", handlers: { onOpenInNativeApp: vi.fn(), onOpenInNewWindow: vi.fn(), onRevealInFinder: vi.fn(), onCopyPath: vi.fn() } };

describe("fileRowMenuEntries", () => {
  it("no actions: default app + separator + fixed tail", () => {
    expect(labels(fileRowMenuEntries({ ...base, openWithActions: [] }))).toEqual([
      "기본 앱에서 열기", "—", "새 창에서 열기", "Finder에서 보기", "경로 복사",
    ]);
  });

  it("registry actions come first, in order", () => {
    const es = fileRowMenuEntries({ ...base, openWithActions: [act("preview", "미리보기로 열기"), act("browser", "브라우저로 열기")] });
    expect(labels(es).slice(0, 4)).toEqual(["미리보기로 열기", "브라우저로 열기", "기본 앱에서 열기", "—"]);
  });

  it("disabledReason disables every menuitem (incl. registry ones) but not the separator", () => {
    const es = fileRowMenuEntries({ ...base, openWithActions: [act("p", "P")], disabledReason: "no local" });
    for (const e of es) {
      if (isMenuSeparator(e)) continue;
      expect(e.disabled).toBe(true);
      expect(e.disabledReason).toBe("no local");
    }
  });

  it("selecting runs the action with absPath; default-app routes to onOpenInNativeApp", () => {
    const a = act("p", "P");
    const es = fileRowMenuEntries({ ...base, openWithActions: [a] });
    const items = es.filter((e) => !isMenuSeparator(e)) as { label: string; onSelect(): void }[];
    items[0].onSelect();
    expect(a.run).toHaveBeenCalledWith("/r/a.png");
    items[1].onSelect();
    expect(base.handlers.onOpenInNativeApp).toHaveBeenCalledWith("/r/a.png");
  });
});
