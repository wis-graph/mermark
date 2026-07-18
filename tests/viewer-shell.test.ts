import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// Viewer shell (full-pane rewrite, _workspace/01_architect_design.md §A/§B):
// backdrop-modal overlay → in-content pane, sibling of `.editor-host` inside
// `.main-column`. This file is Stage 0's RED — it pins the mount target, the
// hide/restore contract (`hidden`, never `inert`), the a11y shape (role=region,
// NOT role=dialog/aria-modal), the header DOM, and the shell-owned zoom state
// machine (`nextZoomFactor`/`formatZoomLabel` + `shell.zoom`).
import { openViewerShell, nextZoomFactor, formatZoomLabel } from "../src/chrome/viewer/shell";

/** The scaffold every real boot builds (main.ts): `.workspace > .main-column >
 *  (.title-bar, .editor-host, .status-bar)`. Mirrors the real DOM shape so
 *  "mounted as .editor-host's nextSibling" is verified against the actual
 *  structure the shell inserts into, not a minimal stand-in that could pass
 *  for reasons the real app doesn't share. */
function buildScaffold(): { mainColumn: HTMLElement; editorHost: HTMLElement } {
  const workspace = document.createElement("div");
  workspace.className = "workspace";
  const mainColumn = document.createElement("div");
  mainColumn.className = "main-column";
  const titleBar = document.createElement("div");
  titleBar.className = "title-bar";
  // The two title-bar slots arrangeTitleBar places (chrome/title-bar.ts's
  // createTitleSlot/createViewerSlot). The viewer has no header row of its
  // own any more — it renders its filename and controls into these.
  const docTitleSlot = document.createElement("div");
  docTitleSlot.className = "title-bar-doc-title";
  const viewerSlot = document.createElement("div");
  viewerSlot.className = "title-bar-viewer-slot";
  titleBar.append(docTitleSlot, viewerSlot);
  const editorHost = document.createElement("div");
  editorHost.className = "editor-host";
  const statusBar = document.createElement("div");
  statusBar.className = "status-bar";
  mainColumn.append(titleBar, editorHost, statusBar);
  workspace.append(mainColumn);
  document.body.append(workspace);
  return { mainColumn, editorHost };
}

let scaffold: { mainColumn: HTMLElement; editorHost: HTMLElement };

beforeEach(() => {
  scaffold = buildScaffold();
});
afterEach(() => {
  scaffold.mainColumn.closest(".workspace")?.remove();
  document.querySelector(".viewer-panel")?.remove();
});

describe("openViewerShell: mount target (design §A)", () => {
  it("mounts the pane as .editor-host's nextSibling, not document.body directly", () => {
    const shell = openViewerShell({ absPath: "/vault/doc.pdf", paneClass: "pdf-viewer", content: document.createElement("div") });
    expect(scaffold.editorHost.nextElementSibling?.classList.contains("viewer-panel")).toBe(true);
    expect(document.body.querySelector(":scope > .viewer-panel")).toBeNull();
    shell.close();
  });

  it(".viewer-backdrop never appears anywhere in the document", () => {
    const shell = openViewerShell({ absPath: "/vault/doc.pdf", paneClass: "pdf-viewer", content: document.createElement("div") });
    expect(document.querySelector(".viewer-backdrop")).toBeNull();
    shell.close();
  });

  it("falls back to document.body when no .editor-host exists (defensive, minimal fixture)", () => {
    scaffold.mainColumn.closest(".workspace")?.remove();
    const shell = openViewerShell({ absPath: "/vault/doc.pdf", paneClass: "pdf-viewer", content: document.createElement("div") });
    expect(document.body.querySelector(".viewer-panel")).toBeTruthy();
    shell.close();
    scaffold = buildScaffold(); // restore for afterEach's cleanup path
  });
});

describe("openViewerShell: hide/restore contract — hidden, never inert (design §A/§D)", () => {
  it("open sets .editor-host hidden with no inert attribute; close clears hidden and removes the pane", () => {
    const shell = openViewerShell({ absPath: "/vault/doc.pdf", paneClass: "pdf-viewer", content: document.createElement("div") });
    expect(scaffold.editorHost.hidden).toBe(true);
    expect(scaffold.editorHost.hasAttribute("inert")).toBe(false);

    shell.close();
    expect(scaffold.editorHost.hidden).toBe(false);
    expect(document.querySelector(".viewer-panel")).toBeNull();
  });
});

describe("openViewerShell: a11y — role=region, NOT role=dialog/aria-modal (design §D)", () => {
  it("pane carries role=region + aria-label=basename, and never role=dialog/aria-modal", () => {
    const shell = openViewerShell({ absPath: "/vault/report.pdf", paneClass: "pdf-viewer", content: document.createElement("div") });
    const pane = document.querySelector(".viewer-panel") as HTMLElement;
    expect(pane.getAttribute("role")).toBe("region");
    expect(pane.getAttribute("aria-label")).toBe("report.pdf");
    expect(pane.getAttribute("role")).not.toBe("dialog");
    expect(pane.hasAttribute("aria-modal")).toBe(false);
    shell.close();
  });
});

describe("openViewerShell: header DOM (design §B/§C)", () => {
  // The viewer renders NO header row: its filename goes to the title-bar's
  // doc-title slot and its controls to the title-bar's viewer slot, as
  // ordinary `.chrome-btn`s (사용자 지정 2026-07-19 — the bordered in-pane
  // header both wasted a row and looked alien beside the app's flat chrome).
  it("renders filename + controls into the TITLE BAR slots, with no header row in the pane", () => {
    const shell = openViewerShell({ absPath: "/vault/report.pdf", paneClass: "pdf-viewer", content: document.createElement("div") });

    // The old in-pane header must be gone — this is the regression guard for
    // "don't grow a second toolbar again".
    expect(document.querySelector(".viewer-panel-header")).toBeNull();

    const titleSlot = document.querySelector(".title-bar-doc-title") as HTMLElement;
    const caption = titleSlot.querySelector(".viewer-panel-caption") as HTMLElement;
    expect(caption.textContent).toBe("report.pdf");

    const viewerSlot = document.querySelector(".title-bar-viewer-slot") as HTMLElement;
    const zoomOut = viewerSlot.querySelector(".viewer-panel-zoom-out") as HTMLElement;
    const zoomLabel = viewerSlot.querySelector(".viewer-panel-zoom-label") as HTMLElement;
    const zoomIn = viewerSlot.querySelector(".viewer-panel-zoom-in") as HTMLElement;
    const closeBtn = viewerSlot.querySelector(".viewer-panel-close") as HTMLElement;
    expect(zoomOut).toBeTruthy();
    expect(zoomIn).toBeTruthy();
    expect(closeBtn).toBeTruthy();
    expect(zoomLabel.textContent).toBe("100%");

    // They must BE the app's chrome button, not a lookalike — this is the
    // assertion that keeps the two from drifting apart again.
    for (const b of [zoomOut, zoomIn, closeBtn]) {
      expect(b.classList.contains("chrome-btn")).toBe(true);
      expect(b.classList.contains("icon-only")).toBe(true);
      expect(b.querySelector("svg.icon")).toBeTruthy(); // Lucide glyph, not a text "✕"/"+"
    }
    expect(zoomLabel.classList.contains("chrome-btn")).toBe(true);
    expect(viewerSlot.querySelector(".title-bar-divider")).toBeTruthy(); // the `|`

    // Closing returns the title-bar to its no-viewer state (both slots empty).
    shell.close();
    expect(titleSlot.childElementCount).toBe(0);
    expect(viewerSlot.childElementCount).toBe(0);
  });
});

describe("openViewerShell: close paths (Esc / button / idempotent / focus)", () => {
  it("Escape (capture phase) closes and restores prior focus", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();

    openViewerShell({ absPath: "/vault/doc.pdf", paneClass: "pdf-viewer", content: document.createElement("div") });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(document.querySelector(".viewer-panel")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("the close button closes the pane", () => {
    openViewerShell({ absPath: "/vault/doc.pdf", paneClass: "pdf-viewer", content: document.createElement("div") });
    const closeBtn = document.querySelector(".viewer-panel-close") as HTMLButtonElement;
    closeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".viewer-panel")).toBeNull();
  });

  it("close() is idempotent", () => {
    const shell = openViewerShell({ absPath: "/vault/doc.pdf", paneClass: "pdf-viewer", content: document.createElement("div") });
    shell.close();
    expect(() => shell.close()).not.toThrow();
  });

  it("focuses the close button on open", () => {
    const shell = openViewerShell({ absPath: "/vault/doc.pdf", paneClass: "pdf-viewer", content: document.createElement("div") });
    const closeBtn = document.querySelector(".viewer-panel-close") as HTMLButtonElement;
    expect(document.activeElement).toBe(closeBtn);
    shell.close();
  });
});

describe("openViewerShell: zoom contract — shell is the single writer (design §B)", () => {
  it("zoom.get() starts at 1 (fit)", () => {
    const shell = openViewerShell({ absPath: "/vault/doc.pdf", paneClass: "pdf-viewer", content: document.createElement("div") });
    expect(shell.zoom.get()).toBe(1);
    shell.close();
  });

  it("+ click steps to the next ladder rung, updates the label, and writes --viewer-zoom on the pane root", () => {
    const shell = openViewerShell({ absPath: "/vault/doc.pdf", paneClass: "pdf-viewer", content: document.createElement("div") });
    const pane = document.querySelector(".viewer-panel") as HTMLElement;
    const zoomIn = document.querySelector(".viewer-panel-zoom-in") as HTMLButtonElement;
    const zoomLabel = document.querySelector(".viewer-panel-zoom-label") as HTMLElement;

    zoomIn.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(shell.zoom.get()).toBeCloseTo(1.1, 10);
    expect(zoomLabel.textContent).toBe("110%");
    expect(pane.style.getPropertyValue("--viewer-zoom")).toBe("1.1");

    shell.close();
  });

  it("- click steps down the ladder", () => {
    const shell = openViewerShell({ absPath: "/vault/doc.pdf", paneClass: "pdf-viewer", content: document.createElement("div") });
    const zoomOut = document.querySelector(".viewer-panel-zoom-out") as HTMLButtonElement;
    zoomOut.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(shell.zoom.get()).toBeCloseTo(0.9, 10);
    shell.close();
  });

  it("zoom.bind(fn) calls immediately with the current factor, then on every change; unsubscribe stops it", () => {
    const shell = openViewerShell({ absPath: "/vault/doc.pdf", paneClass: "pdf-viewer", content: document.createElement("div") });
    const calls: number[] = [];
    const unsubscribe = shell.zoom.bind((f) => calls.push(f));
    expect(calls).toEqual([1]);

    const zoomIn = document.querySelector(".viewer-panel-zoom-in") as HTMLButtonElement;
    zoomIn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(calls).toEqual([1, 1.1]);

    unsubscribe();
    zoomIn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(calls).toEqual([1, 1.1]); // unchanged — unsubscribed

    shell.close();
  });

  it("clamps at both ladder ends — an extra click at the extreme is a no-op", () => {
    const shell = openViewerShell({ absPath: "/vault/doc.pdf", paneClass: "pdf-viewer", content: document.createElement("div") });
    const zoomIn = document.querySelector(".viewer-panel-zoom-in") as HTMLButtonElement;
    const zoomOut = document.querySelector(".viewer-panel-zoom-out") as HTMLButtonElement;

    for (let i = 0; i < 20; i += 1) zoomIn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(shell.zoom.get()).toBeCloseTo(3, 10); // ladder max

    for (let i = 0; i < 30; i += 1) zoomOut.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(shell.zoom.get()).toBeCloseTo(0.5, 10); // ladder min

    shell.close();
  });

  it("clicking the zoom label resets to 1.0 (fit)", () => {
    const shell = openViewerShell({ absPath: "/vault/doc.pdf", paneClass: "pdf-viewer", content: document.createElement("div") });
    const zoomIn = document.querySelector(".viewer-panel-zoom-in") as HTMLButtonElement;
    const zoomLabel = document.querySelector(".viewer-panel-zoom-label") as HTMLButtonElement;

    zoomIn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    zoomIn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(shell.zoom.get()).not.toBe(1);

    zoomLabel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(shell.zoom.get()).toBe(1);
    expect(zoomLabel.textContent).toBe("100%");

    shell.close();
  });

  it("zoom is ephemeral: a fresh open() always starts at 1.0, independent of a prior instance's zoom", () => {
    const first = openViewerShell({ absPath: "/vault/a.pdf", paneClass: "pdf-viewer", content: document.createElement("div") });
    const zoomIn = document.querySelector(".viewer-panel-zoom-in") as HTMLButtonElement;
    zoomIn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(first.zoom.get()).not.toBe(1);
    first.close();

    const second = openViewerShell({ absPath: "/vault/b.pdf", paneClass: "pdf-viewer", content: document.createElement("div") });
    expect(second.zoom.get()).toBe(1);
    second.close();
  });
});

describe("nextZoomFactor / formatZoomLabel (pure — the zoom ladder)", () => {
  it("steps to the next rung in each direction from an on-ladder value", () => {
    expect(nextZoomFactor(1, "in")).toBeCloseTo(1.1, 10);
    expect(nextZoomFactor(1, "out")).toBeCloseTo(0.9, 10);
    expect(nextZoomFactor(0.9, "in")).toBeCloseTo(1, 10);
  });

  it("clamps at both ends", () => {
    expect(nextZoomFactor(3, "in")).toBe(3);
    expect(nextZoomFactor(0.5, "out")).toBe(0.5);
  });

  it("formats a rounded whole-percent label", () => {
    expect(formatZoomLabel(1)).toBe("100%");
    expect(formatZoomLabel(0.5)).toBe("50%");
    expect(formatZoomLabel(1.1)).toBe("110%");
    expect(formatZoomLabel(2.5)).toBe("250%");
  });
});

describe("styles.css: .editor-host[hidden] beats .welcome-host's display:flex (design §A trap)", () => {
  // jsdom doesn't apply stylesheets, so this is a static text assertion (same
  // convention as viewer-zoom.test.ts) — the real cascade-wins behavior is a
  // golden/real-app concern (G15, plan §Stage 6).
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const css = readFileSync(join(ROOT, "src", "styles.css"), "utf8");

  it("declares .editor-host[hidden] { display: none; } (specificity 0,2,0 beats .welcome-host's 0,1,0)", () => {
    expect(css).toMatch(/\.editor-host\[hidden\]\s*\{[^}]*display:\s*none/);
  });
});
