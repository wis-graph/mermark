import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { markdownLang } from "../src/markdown/parser";
import { blockPreview, modeFacet, type BlockFeature } from "../src/markdown/live-preview/core";

// The domain rule computeSpecs now enforces (core.ts's firstClaimWins): a
// single syntax node may become at most one block widget. Before this, ALL
// matching features pushed a spec for the same node — harmless while
// mermaid/codeBlock's own hand-rolled mutual exclusion was the only pair
// sharing a node, but unsafe the instant a runtime-registered feature claims
// a node another feature already owns (e.g. a new fenced-language widget vs.
// codeBlock's FencedCode catch-all).

class FirstWidget extends WidgetType {
  toDOM() {
    const d = document.createElement("div");
    d.className = "cm-first-widget";
    return d;
  }
  eq() {
    return true;
  }
}

class SecondWidget extends WidgetType {
  toDOM() {
    const d = document.createElement("div");
    d.className = "cm-second-widget";
    return d;
  }
  eq() {
    return true;
  }
}

describe("first-claim-wins (block feature dispatch)", () => {
  it("renders only the FIRST feature's widget when two block features claim the same node", () => {
    const first: BlockFeature = {
      nodes: ["FencedCode"],
      match: (node) => ({ kind: "first", from: node.from, to: node.to, src: "", widget: () => new FirstWidget() }),
    };
    const second: BlockFeature = {
      nodes: ["FencedCode"],
      match: (node) => ({ kind: "second", from: node.from, to: node.to, src: "", widget: () => new SecondWidget() }),
    };
    const doc = "intro\n\n```txt\nbody\n```\n\ntail";
    const state = EditorState.create({
      doc,
      extensions: [markdownLang(), modeFacet.of("read"), blockPreview([first, second])],
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView({ state, parent: host });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.querySelector(".cm-first-widget")).not.toBeNull();
    expect(view.contentDOM.querySelector(".cm-second-widget")).toBeNull();
    view.destroy();
  });

  it("order matters: swapping registration order swaps the winner", () => {
    const first: BlockFeature = {
      nodes: ["FencedCode"],
      match: (node) => ({ kind: "first", from: node.from, to: node.to, src: "", widget: () => new FirstWidget() }),
    };
    const second: BlockFeature = {
      nodes: ["FencedCode"],
      match: (node) => ({ kind: "second", from: node.from, to: node.to, src: "", widget: () => new SecondWidget() }),
    };
    const doc = "intro\n\n```txt\nbody\n```\n\ntail";
    const state = EditorState.create({
      doc,
      extensions: [markdownLang(), modeFacet.of("read"), blockPreview([second, first])],
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView({ state, parent: host });
    (view as unknown as { measure(): void }).measure();
    expect(view.contentDOM.querySelector(".cm-second-widget")).not.toBeNull();
    expect(view.contentDOM.querySelector(".cm-first-widget")).toBeNull();
    view.destroy();
  });
});
