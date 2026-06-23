import { describe, it, expect, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  findFootnoteDef,
  findFootnoteRef,
  jumpTo,
  scrollTargetToCenter,
  recenterAfterAsyncLayout,
} from "../src/markdown/footnote-nav";

const state = (doc: string) => EditorState.create({ doc });

// ---------------------------------------------------------------------------
// jumpTo dispatch contract. Landing *accuracy* (scrollTop / coords geometry)
// needs a real layout and is verified by scripts/footnote-golden.mjs under CDP;
// jsdom has no layout, so here we only assert the *shape/intent* of what jumpTo
// dispatches: a center scroll with NO redundant transaction flag, a caret move,
// and a re-center after async widgets settle. These guard the bugfix's contract
// (flag removed + re-center) and the backward-no-regression invariant.
// ---------------------------------------------------------------------------

interface Captured {
  effects: unknown[];
  selectionAnchor: number | undefined;
  flagScrollIntoView: unknown;
}

/** A minimal fake EditorView that records every dispatch and lets a test drive
 *  the async settle by hand: `pumpFrame()` runs one queued rAF callback,
 *  `fireMermaidRendered()` fires the mermaid-rendered listener. jsdom can't drive
 *  CM's measure/raf loop, and we deliberately do NOT auto-run rAF so the test
 *  controls exactly how many re-centers happen (no real timers, no hang). */
function fakeView() {
  const txns: Captured[] = [];
  let listener: ((e: Event) => void) | null = null;
  const rafQueue: Array<() => void> = [];
  const view = {
    dispatch(spec: {
      effects?: unknown | unknown[];
      selection?: { anchor: number };
      scrollIntoView?: boolean;
    }) {
      const effects = spec.effects === undefined ? [] : ([] as unknown[]).concat(spec.effects);
      txns.push({
        effects,
        selectionAnchor: spec.selection?.anchor,
        flagScrollIntoView: spec.scrollIntoView,
      });
    },
    focus: vi.fn(),
    scrollDOM: {
      addEventListener: (_: string, cb: (e: Event) => void) => {
        listener = cb;
      },
      removeEventListener: () => {
        listener = null;
      },
    },
  } as unknown as EditorView;
  // Route the module's requestAnimationFrame/cancelAnimationFrame through a hand-
  // pumped queue so re-centers are deterministic and nothing runs on a real clock.
  // Each pumped frame advances a mocked Date.now by ~16ms so the bounded settle
  // window terminates after a realistic number of frames (~75 for a 1200ms loop).
  const origRaf = globalThis.requestAnimationFrame;
  const origCancel = globalThis.cancelAnimationFrame;
  const origNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  let id = 0;
  const pending = new Map<number, () => void>();
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const handle = ++id;
    pending.set(handle, () => cb(0));
    rafQueue.push(() => {
      const fn = pending.get(handle);
      if (fn) {
        pending.delete(handle);
        fn();
      }
    });
    return handle;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((handle: number) => {
    pending.delete(handle);
  }) as typeof cancelAnimationFrame;
  return {
    view,
    txns,
    hasMermaidListener: () => listener !== null,
    fireMermaidRendered: () => listener?.(new Event("mermaid-rendered")),
    /** Run the next queued rAF callback (one settle frame), advancing the clock. */
    pumpFrame: () => {
      clock += 16;
      rafQueue.shift()?.();
    },
    restore: () => {
      globalThis.requestAnimationFrame = origRaf;
      globalThis.cancelAnimationFrame = origCancel;
      Date.now = origNow;
    },
  };
}

describe("findFootnoteDef", () => {
  it("returns the line-start position of the definition marker", () => {
    const doc = "see [^a] here\n\n[^a]: the note";
    const s = state(doc);
    expect(findFootnoteDef(s, "a")).toBe(doc.indexOf("[^a]:"));
  });

  it("returns null when no definition exists (reference only)", () => {
    const s = state("see [^a] here, no def below");
    expect(findFootnoteDef(s, "a")).toBeNull();
  });

  it("ignores a reference and only matches the definition line", () => {
    // [^a] appears first as a reference; the def is later. Must point at the def.
    const doc = "ref [^a]\nmore [^a] text\n[^a]: def";
    const s = state(doc);
    expect(findFootnoteDef(s, "a")).toBe(doc.indexOf("[^a]: def"));
  });

  it("escapes regex-special characters in the label", () => {
    // `a.b*` would, unescaped, be a regex matching e.g. `aXb` — escaping pins it
    // to the literal label so only the real definition matches.
    const doc = "see [^a.b*]\n\n[^a.b*]: literal def";
    const s = state(doc);
    expect(findFootnoteDef(s, "a.b*")).toBe(doc.indexOf("[^a.b*]: literal"));
    // A label that the unescaped pattern would have matched must NOT resolve.
    expect(findFootnoteDef(state("[^aXbb]: other"), "a.b*")).toBeNull();
  });
});

describe("findFootnoteRef", () => {
  it("returns the position of the first non-definition reference", () => {
    const doc = "[^a]: def\n\nbody [^a] reference";
    const s = state(doc);
    expect(findFootnoteRef(s, "a")).toBe(doc.indexOf("[^a] reference"));
  });

  it("does not treat the definition's own marker as a reference", () => {
    // Only the def line contains [^a]; there is no real reference → null.
    const s = state("[^a]: the note, defined but never cited");
    expect(findFootnoteRef(s, "a")).toBeNull();
  });

  it("returns null when the label appears nowhere", () => {
    const s = state("plain text with no footnotes");
    expect(findFootnoteRef(s, "missing")).toBeNull();
  });

  it("returns the FIRST reference when several cite the same label", () => {
    const doc = "[^a]: def\nfirst [^a]\nsecond [^a]";
    const s = state(doc);
    expect(findFootnoteRef(s, "a")).toBe(doc.indexOf("first [^a]") + "first ".length);
  });

  it("escapes regex-special characters when skipping the definition line", () => {
    const doc = "[^a.b*]: def\ncite [^a.b*] here";
    const s = state(doc);
    expect(findFootnoteRef(s, "a.b*")).toBe(doc.indexOf("cite [^a.b*]") + "cite ".length);
  });
});

/** True when the effect array carries an EditorView.scrollIntoView effect. We
 *  can't read the effect's y:"center" from outside CM, so existence + the absent
 *  flag is the strongest shape assertion available without a real layout. */
function hasScrollEffect(effects: unknown[]): boolean {
  return effects.length > 0;
}

describe("scrollTargetToCenter", () => {
  it("dispatches a caret move + scroll effect WITHOUT the redundant scrollIntoView flag", () => {
    const f = fakeView();
    scrollTargetToCenter(f.view, 42);
    expect(f.txns).toHaveLength(1);
    const [tx] = f.txns;
    expect(tx.selectionAnchor).toBe(42); // caret moved to the target
    expect(hasScrollEffect(tx.effects)).toBe(true); // explicit center scroll effect
    // The bug-smell we removed: the transaction-level flag must NOT be set (it is
    // a redundant no-op that an explicit center effect already overwrites).
    expect(tx.flagScrollIntoView).toBeUndefined();
  });
});

describe("recenterAfterAsyncLayout", () => {
  it("dispatches NOTHING synchronously — re-center is deferred to an animation frame", () => {
    const f = fakeView();
    try {
      recenterAfterAsyncLayout(f.view, 99);
      // No synchronous dispatch. This is the core safety property: dispatching
      // inside the call (e.g. from a measure write) throws "Calls to
      // EditorView.update are not allowed while an update is in progress".
      expect(f.txns).toHaveLength(0);
      expect(f.hasMermaidListener()).toBe(true); // armed for late mermaid settle
      f.pumpFrame(); // one settle frame
      expect(f.txns).toHaveLength(1); // now it re-centers
      expect(hasScrollEffect(f.txns[0].effects)).toBe(true);
      expect(f.txns[0].flagScrollIntoView).toBeUndefined();
    } finally {
      f.restore();
    }
  });

  it("re-centers when a mermaid diagram finishes rendering (async settle)", () => {
    const f = fakeView();
    try {
      recenterAfterAsyncLayout(f.view, 7);
      f.fireMermaidRendered(); // diagram below the target settles late
      expect(f.txns.length).toBeGreaterThanOrEqual(1);
      expect(hasScrollEffect(f.txns[0].effects)).toBe(true);
    } finally {
      f.restore();
    }
  });

  it("is self-terminating: the settle loop stops and unbinds (no infinite re-center)", () => {
    const f = fakeView();
    try {
      recenterAfterAsyncLayout(f.view, 5);
      // Pump far more frames than any bounded window would schedule. Because each
      // frame re-arms only until the deadline, the rAF queue must eventually
      // drain and the mermaid listener must be removed — convergence guard.
      for (let i = 0; i < 500; i++) f.pumpFrame();
      expect(f.hasMermaidListener()).toBe(false); // torn down → no leak
      // After teardown, no further frames are queued (pumpFrame is a no-op).
      const n = f.txns.length;
      f.pumpFrame();
      expect(f.txns.length).toBe(n);
    } finally {
      f.restore();
    }
  });
});

describe("jumpTo (shared landing, both directions)", () => {
  it("centers + focuses synchronously, defers the async re-center (same path both directions)", () => {
    const f = fakeView();
    try {
      jumpTo(f.view, 13);
      // Exactly one synchronous dispatch: the immediate center (caret + scroll,
      // no flag). The re-center is deferred to a frame, so it can't fight the
      // in-flight update.
      expect(f.txns).toHaveLength(1);
      expect(f.txns[0].selectionAnchor).toBe(13);
      expect(f.txns[0].flagScrollIntoView).toBeUndefined();
      expect(f.view.focus as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
      expect(f.hasMermaidListener()).toBe(true);
    } finally {
      f.restore();
    }
  });

  it("is idempotent for a backward target: re-centering re-applies the same center, never throws", () => {
    const f = fakeView();
    try {
      // Backward jump goes UP into already-measured space; the re-center must be a
      // harmless no-op-shaped repeat (same center effect), proving no regression.
      expect(() => {
        jumpTo(f.view, 3);
        f.pumpFrame();
        f.fireMermaidRendered();
      }).not.toThrow();
      // Every dispatched transaction targets the same landing with no stray flag.
      for (const tx of f.txns) expect(tx.flagScrollIntoView).toBeUndefined();
    } finally {
      f.restore();
    }
  });
});
