import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTitleBar, createLeftCommandGroup } from "../src/chrome/title-bar";

// R9 (_workspace/01_architecture.md): the left-sidebar panel registry.
// No unregister exists (see sidebar/registry.ts's doc on why), so every test
// gets a FRESH module instance via vi.resetModules() + dynamic import —
// otherwise panels registered by an earlier test (and its 4th fake panel)
// would leak into the next one's assertions.
async function freshRegistry() {
  const mod = await import("../src/sidebar/registry");
  return mod;
}

function mk(id: string): HTMLButtonElement {
  const e = document.createElement("button");
  e.dataset.id = id;
  return e;
}

/** A minimal fake panel: aside.hidden IS its open/closed state, close() sets
 *  it hidden (idempotent, matches the real panels' contract). */
function fakePanel(id: string) {
  const aside = document.createElement("aside");
  aside.hidden = true;
  return {
    id,
    button: mk(id),
    aside,
    close: () => {
      aside.hidden = true;
    },
  };
}

function barWithSpacerAnchor(): HTMLElement {
  const { el: bar } = createTitleBar({ platform: "mac" });
  const spacer = document.createElement("span");
  spacer.className = "title-spacer";
  bar.append(spacer);
  return bar;
}

beforeEach(() => {
  vi.resetModules();
});

describe("registerSidebarPanel / closeOtherSidebarPanels", () => {
  it("a 4th (extension) panel joins mutual exclusion in both directions — the bug R9 fixes", async () => {
    const { registerSidebarPanel, closeOtherSidebarPanels } = await freshRegistry();
    const a = fakePanel("a");
    const b = fakePanel("b");
    const c = fakePanel("c");
    const d = fakePanel("d"); // the 4th panel — today's union type would never know it
    for (const p of [a, b, c, d]) registerSidebarPanel(p);
    a.aside.hidden = false; // simulate "a" being open

    closeOtherSidebarPanels("d");
    expect(a.aside.hidden).toBe(true);
    expect(b.aside.hidden).toBe(true);
    expect(c.aside.hidden).toBe(true);
    expect(d.aside.hidden).toBe(true); // untouched (already closed, close() is idempotent)

    d.aside.hidden = false; // simulate "d" opening
    closeOtherSidebarPanels("a");
    expect(d.aside.hidden).toBe(true); // built-in closing the extension — reverse direction
  });

  it("throws on a duplicate panel id (guard actually bites, not just declared)", async () => {
    const { registerSidebarPanel } = await freshRegistry();
    registerSidebarPanel(fakePanel("explorer"));
    expect(() => registerSidebarPanel(fakePanel("explorer"))).toThrow(/already registered/);
  });

  it("sidebarPanels() reflects registration order", async () => {
    const { registerSidebarPanel, sidebarPanels } = await freshRegistry();
    registerSidebarPanel(fakePanel("explorer"));
    registerSidebarPanel(fakePanel("recent"));
    registerSidebarPanel(fakePanel("outline"));
    expect(sidebarPanels().map((p) => p.id)).toEqual(["explorer", "recent", "outline"]);
  });
});

describe("installSidebarPanels: mount contract", () => {
  function setup() {
    const bar = barWithSpacerAnchor();
    const group = createLeftCommandGroup({ openPath: mk("openPath") });
    const buttonAnchor = group.querySelector<HTMLElement>('[data-id="openPath"]')!;
    const workspace = document.createElement("div");
    const main = document.createElement("div");
    workspace.append(main);
    return { bar, group, buttonAnchor, workspace, main };
  }

  it("each aside is prepended to workspace, ahead of everything already there", async () => {
    const { registerSidebarPanel, installSidebarPanels } = await freshRegistry();
    const { bar, group, buttonAnchor, workspace, main } = setup();
    const explorer = fakePanel("explorer");
    registerSidebarPanel(explorer);
    installSidebarPanels({ workspace, bar, group, buttonAnchor });
    expect(workspace.firstElementChild).toBe(explorer.aside);
    expect([...workspace.children]).toContain(main);
  });

  it("each aside's first child is .sidebar-top-strip", async () => {
    const { registerSidebarPanel, installSidebarPanels } = await freshRegistry();
    const { bar, group, buttonAnchor, workspace } = setup();
    const explorer = fakePanel("explorer");
    registerSidebarPanel(explorer);
    installSidebarPanels({ workspace, bar, group, buttonAnchor });
    expect(explorer.aside.firstElementChild?.className).toBe("sidebar-top-strip");
  });

  it("group.children order = registered panel buttons in registration order, then openPath", async () => {
    const { registerSidebarPanel, installSidebarPanels } = await freshRegistry();
    const { bar, group, buttonAnchor, workspace } = setup();
    registerSidebarPanel(fakePanel("explorer"));
    registerSidebarPanel(fakePanel("recent"));
    registerSidebarPanel(fakePanel("outline"));
    installSidebarPanels({ workspace, bar, group, buttonAnchor });
    const ids = [...group.children].map((c) => (c as HTMLElement).dataset.id);
    expect(ids).toEqual(["explorer", "recent", "outline", "openPath"]);
  });

  it("late registration after install: mounts immediately (aside prepended, strip attached, button inserted before openPath)", async () => {
    const { registerSidebarPanel, installSidebarPanels } = await freshRegistry();
    const { bar, group, buttonAnchor, workspace } = setup();
    registerSidebarPanel(fakePanel("explorer"));
    installSidebarPanels({ workspace, bar, group, buttonAnchor });

    const late = fakePanel("late");
    registerSidebarPanel(late);

    expect(workspace.firstElementChild).toBe(late.aside);
    expect(late.aside.firstElementChild?.className).toBe("sidebar-top-strip");
    const ids = [...group.children].map((c) => (c as HTMLElement).dataset.id);
    expect(ids).toEqual(["explorer", "late", "openPath"]);
  });

  it("late registration participates in rehoming: opening its aside moves the group into its strip", async () => {
    const { registerSidebarPanel, installSidebarPanels } = await freshRegistry();
    const { bar, group, buttonAnchor, workspace } = setup();
    installSidebarPanels({ workspace, bar, group, buttonAnchor });

    const late = fakePanel("late");
    registerSidebarPanel(late);
    late.aside.hidden = false;
    await Promise.resolve(); // MutationObserver delivers on the microtask queue
    expect(group.parentElement).toBe(late.aside.querySelector(".sidebar-top-strip"));
  });

  it("a second installSidebarPanels call throws (developer error, same shape as the duplicate-id guard)", async () => {
    const { installSidebarPanels } = await freshRegistry();
    const { bar, group, buttonAnchor, workspace } = setup();
    installSidebarPanels({ workspace, bar, group, buttonAnchor });
    expect(() => installSidebarPanels({ workspace, bar, group, buttonAnchor })).toThrow(/already installed/);
  });
});

// Rehoming coverage moved from tests/title-bar.test.ts's deleted
// installLeftGroupRehoming describe block (M6 → R9: the fixed asides[] array
// is now the dynamic panel registry). Same assertions, same shape, adapted to
// register through registerSidebarPanel/installSidebarPanels instead of a raw
// asides list — this is what actually exercises the "late registration still
// rehomes" fix (installLeftGroupRehoming's array could never grow after
// construction; this registry's can, see the "late registration" tests above).
describe("installSidebarPanels: rehoming", () => {
  function setup() {
    const bar = barWithSpacerAnchor();
    const group = createLeftCommandGroup({ openPath: mk("openPath") });
    const buttonAnchor = group.querySelector<HTMLElement>('[data-id="openPath"]')!;
    const workspace = document.createElement("div");
    return { bar, group, buttonAnchor, workspace };
  }

  async function installed() {
    const { registerSidebarPanel, installSidebarPanels } = await freshRegistry();
    const { bar, group, buttonAnchor, workspace } = setup();
    const recent = fakePanel("recent");
    const explorer = fakePanel("explorer");
    const outline = fakePanel("outline");
    for (const p of [recent, explorer, outline]) registerSidebarPanel(p);
    installSidebarPanels({ workspace, bar, group, buttonAnchor });
    return { bar, group, recent, explorer, outline };
  }

  it("initial placement: every aside hidden -> the group starts in the bar", async () => {
    const { bar, group } = await installed();
    expect(group.parentElement).toBe(bar);
  });

  it("opening a rail moves the group into that rail's strip", async () => {
    const { group, explorer } = await installed();
    explorer.aside.hidden = false;
    await Promise.resolve();
    expect(group.parentElement).toBe(explorer.aside.querySelector(".sidebar-top-strip"));
  });

  it("switching rails in one task batches into a single rehome, landing in the new rail", async () => {
    const { group, explorer, outline } = await installed();
    explorer.aside.hidden = false;
    await Promise.resolve();
    explorer.aside.hidden = true;
    outline.aside.hidden = false;
    await Promise.resolve();
    expect(group.parentElement).toBe(outline.aside.querySelector(".sidebar-top-strip"));
  });

  it("closing the last open rail returns the group to the bar, before the spacer", async () => {
    const { bar, group, explorer } = await installed();
    explorer.aside.hidden = false;
    await Promise.resolve();
    explorer.aside.hidden = true;
    await Promise.resolve();
    expect(group.parentElement).toBe(bar);
    expect(group.nextElementSibling?.classList.contains("title-spacer")).toBe(true);
  });
});
