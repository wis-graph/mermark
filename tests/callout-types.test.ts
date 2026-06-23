import { describe, it, expect } from "vitest";
import { resolveCalloutType, parseCalloutHead } from "../src/markdown/live-preview/features/callout-types";
import { icon, type IconName } from "../src/icons";

describe("resolveCalloutType — canonical types", () => {
  const cases: Array<[string, string, string, IconName]> = [
    ["note", "note", "Note", "square-pen"],
    ["abstract", "abstract", "Abstract", "clipboard-list"],
    ["info", "info", "Info", "info"],
    ["todo", "todo", "Todo", "circle-check"],
    ["tip", "tip", "Tip", "flame"],
    ["success", "success", "Success", "check"],
    ["question", "question", "Question", "circle-help"],
    ["warning", "warning", "Warning", "triangle-alert"],
    ["failure", "failure", "Failure", "x"],
    ["danger", "danger", "Danger", "zap"],
    ["bug", "bug", "Bug", "bug"],
    ["example", "example", "Example", "list"],
    ["quote", "quote", "Quote", "quote"],
  ];
  it.each(cases)("%s → key=%s label=%s icon=%s", (raw, key, label, ic) => {
    const t = resolveCalloutType(raw);
    expect(t.key).toBe(key);
    expect(t.label).toBe(label);
    expect(t.icon).toBe(ic);
  });
});

describe("resolveCalloutType — aliases", () => {
  const aliases: Array<[string, string]> = [
    ["summary", "abstract"],
    ["tldr", "abstract"],
    ["hint", "tip"],
    ["important", "tip"],
    ["check", "success"],
    ["done", "success"],
    ["help", "question"],
    ["faq", "question"],
    ["caution", "warning"],
    ["attention", "warning"],
    ["fail", "failure"],
    ["missing", "failure"],
    ["error", "danger"],
    ["cite", "quote"],
  ];
  it.each(aliases)("%s → key=%s", (raw, key) => {
    expect(resolveCalloutType(raw).key).toBe(key);
  });
});

describe("resolveCalloutType — case insensitivity", () => {
  it.each(["WARNING", "Warning", "WaRnInG"])("%s → warning", (raw) => {
    expect(resolveCalloutType(raw).key).toBe("warning");
  });
  it("ERROR alias is case-insensitive", () => {
    expect(resolveCalloutType("ERROR").key).toBe("danger");
  });
});

describe("resolveCalloutType — unsupported fallback", () => {
  it("falls back to note styling with the raw spelling as label", () => {
    const t = resolveCalloutType("frobnicate");
    expect(t.key).toBe("note");
    expect(t.label).toBe("Frobnicate");
    expect(t.icon).toBe("square-pen");
  });
});

describe("resolveCalloutType — every icon is a real IconName", () => {
  it.each([
    "note", "abstract", "info", "todo", "tip", "success",
    "question", "warning", "failure", "danger", "bug", "example", "quote",
  ])("icon(%s's icon) builds an <svg>", (raw) => {
    const t = resolveCalloutType(raw);
    const svg = icon(t.icon);
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.innerHTML.length).toBeGreaterThan(0);
  });
});

describe("parseCalloutHead", () => {
  it("parses type + title", () => {
    expect(parseCalloutHead("> [!tip] Pro move")).toEqual({ type: "tip", title: "Pro move" });
  });
  it("empty title when none given", () => {
    expect(parseCalloutHead("> [!note]")).toEqual({ type: "note", title: "" });
  });
  it("trims whitespace-only title to empty", () => {
    expect(parseCalloutHead("> [!warning]   ")).toEqual({ type: "warning", title: "" });
  });
  it("absorbs the `-` fold sign, not into the title", () => {
    expect(parseCalloutHead("> [!note]- Folded")).toEqual({ type: "note", title: "Folded" });
  });
  it("absorbs the `+` fold sign", () => {
    expect(parseCalloutHead("> [!info]+ Open")).toEqual({ type: "info", title: "Open" });
  });
  it("returns null for a plain quote", () => {
    expect(parseCalloutHead("> plain quote")).toBeNull();
  });
  it("eats nested `>` marks", () => {
    expect(parseCalloutHead(">> [!note] Nested")).toEqual({ type: "note", title: "Nested" });
  });
});
