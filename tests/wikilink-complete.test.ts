import { describe, it, expect, vi, beforeEach } from "vitest";

// The completion source's cache gate calls invoke("list_link_targets"). Stub it
// with the real LinkTarget shape (name/rel/kind) so cache + filter assertions
// mirror the Rust serde contract. A spy lets us count IPC calls (cache check).
const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import {
  detectWikilinkContext,
  filterTargets,
  completionInsertText,
  hasClosingBrackets,
  wikilinkCompletionSource,
  resetWikilinkCache,
  type LinkTarget,
} from "../src/markdown/wikilink-complete";

const TARGETS: LinkTarget[] = [
  { name: "alpha", rel: "alpha.md", kind: "markdown" },
  { name: "Beta", rel: "Beta.md", kind: "markdown" },
  { name: "gamma", rel: "gamma.md", kind: "markdown" },
  { name: "diagram.png", rel: "diagram.png", kind: "image" },
];

/** Build a CompletionContext over a doc with the cursor at `pos` (default: end). */
function ctxAt(doc: string, pos = doc.length, explicit = false): CompletionContext {
  return new CompletionContext(EditorState.create({ doc }), pos, explicit);
}

describe("detectWikilinkContext (pure)", () => {
  it("matches an open [[ query and reports where the query starts", () => {
    const text = "text [[fo";
    const r = detectWikilinkContext(text, text.length);
    expect(r).toEqual({ from: text.indexOf("fo"), query: "fo" });
  });
  it("matches an empty query right after [[", () => {
    const text = "see [[";
    expect(detectWikilinkContext(text, text.length)).toEqual({ from: text.length, query: "" });
  });
  it("matches inside an embed ![[", () => {
    const text = "![[di";
    expect(detectWikilinkContext(text, text.length)).toEqual({ from: text.indexOf("di"), query: "di" });
  });
  it("rejects an alias region [[a|", () => {
    const text = "text [[a|b";
    expect(detectWikilinkContext(text, text.length)).toBeNull();
  });
  it("rejects a single [ (not a wikilink open)", () => {
    const text = "text [foo";
    expect(detectWikilinkContext(text, text.length)).toBeNull();
  });
  it("rejects an already-closed [[a]]", () => {
    const text = "[[a]] more";
    expect(detectWikilinkContext(text, text.length)).toBeNull();
  });
});

describe("filterTargets (pure)", () => {
  it("filters case-insensitively by substring", () => {
    const out = filterTargets(TARGETS, "a").map((t) => t.name);
    expect(out).toEqual(["alpha", "Beta", "gamma", "diagram.png"]); // all contain 'a'
  });
  it("matches a specific substring case-insensitively", () => {
    expect(filterTargets(TARGETS, "bet").map((t) => t.name)).toEqual(["Beta"]);
  });
  it("returns the full list for an empty query", () => {
    expect(filterTargets(TARGETS, "").length).toBe(TARGETS.length);
  });
  it("returns a fresh array (no aliasing of the input)", () => {
    const out = filterTargets(TARGETS, "");
    expect(out).not.toBe(TARGETS);
  });
});

describe("completionInsertText (pure)", () => {
  it("inserts the basename for a markdown target (no extension)", () => {
    expect(completionInsertText({ name: "some-note", rel: "some-note.md", kind: "markdown" })).toBe("some-note");
  });
  it("inserts the filename with extension for an image target", () => {
    expect(completionInsertText({ name: "diagram.png", rel: "diagram.png", kind: "image" })).toBe("diagram.png");
  });
  it("never prepends an embed ! or appends closing brackets", () => {
    const out = completionInsertText({ name: "pic.jpg", rel: "pic.jpg", kind: "image" });
    expect(out.startsWith("!")).toBe(false);
    expect(out.endsWith("]]")).toBe(false);
  });
});

describe("hasClosingBrackets (pure)", () => {
  it("is true when the two chars after the cursor are ]]", () => {
    const doc = "see [[]]"; // cursor between [[ and ]]
    expect(hasClosingBrackets(ctxAt(doc, doc.indexOf("]]")))).toBe(true);
  });
  it("is false when there is no closing pair (closeBrackets off / user deleted)", () => {
    const doc = "see [[";
    expect(hasClosingBrackets(ctxAt(doc, doc.length))).toBe(false);
  });
});

describe("wikilinkCompletionSource (integration)", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(TARGETS);
    resetWikilinkCache();
  });

  it("returns null off a [[ context and does not hit IPC", async () => {
    const source = wikilinkCompletionSource("/vault");
    const res = await source(ctxAt("plain text"));
    expect(res).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("offers filtered targets with from set just after [[", async () => {
    const source = wikilinkCompletionSource("/vault");
    const doc = "see [[al]]"; // closeBrackets-style: query 'al' between [[ ]]
    const res = await source(ctxAt(doc, doc.indexOf("al") + 2));
    expect(res).not.toBeNull();
    expect(res!.from).toBe(doc.indexOf("[[") + 2);
    expect(res!.options.map((o) => o.label)).toEqual(["alpha"]); // 'al' substring
  });

  it("fetches list_link_targets once and serves later keystrokes from cache", async () => {
    const source = wikilinkCompletionSource("/vault");
    await source(ctxAt("see [[a]]", "see [[a".length));
    await source(ctxAt("see [[al]]", "see [[al".length));
    const fetches = mockInvoke.mock.calls.filter((c) => c[0] === "list_link_targets");
    expect(fetches.length).toBe(1); // second keystroke is cache, IPC unchanged
    expect(fetches[0][1]).toEqual({ dir: "/vault" });
  });

  it("inserts the bare target (no ]]) when closeBrackets already placed ]]", async () => {
    const source = wikilinkCompletionSource("/vault");
    const doc = "see [[al]]";
    const state = EditorState.create({ doc });
    const pos = doc.indexOf("al") + 2; // cursor before ]]
    const res = await source(new CompletionContext(state, pos, false));
    const opt = res!.options.find((o) => o.label === "alpha")!;
    // Simulate apply via a real view-like dispatch through a fresh state.
    const tx = applyToState(state, opt, res!.from, pos);
    expect(tx).toBe("see [[alpha]]"); // single ]] — no duplication
  });

  it("appends ]] when the closing pair is missing (closeBrackets off)", async () => {
    const source = wikilinkCompletionSource("/vault");
    const doc = "see [[al";
    const state = EditorState.create({ doc });
    const pos = doc.length;
    const res = await source(new CompletionContext(state, pos, false));
    const opt = res!.options.find((o) => o.label === "alpha")!;
    const tx = applyToState(state, opt, res!.from, pos);
    expect(tx).toBe("see [[alpha]]"); // ]] supplied since none was there
  });
});

/** Run a completion option's `apply` against a state by faking the minimal
 *  EditorView surface (state + dispatch) and returning the resulting doc text.
 *  The apply fn only reads `view.state` and calls `view.dispatch(spec)`. */
function applyToState(
  state: EditorState,
  opt: { apply?: unknown },
  from: number,
  to: number,
): string {
  let next = state;
  const view = {
    state,
    dispatch: (spec: Parameters<EditorState["update"]>[0]) => {
      next = state.update(spec).state;
    },
  };
  (opt.apply as (v: unknown, c: unknown, f: number, t: number) => void)(view, opt, from, to);
  return next.doc.toString();
}
