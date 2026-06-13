import { describe, it, expect } from "vitest";
import { boundedCache } from "../src/markdown/bounded-cache";

describe("boundedCache", () => {
  it("stores and retrieves values", () => {
    const c = boundedCache<string, number>(3);
    c.put("a", 1);
    c.put("b", 2);
    expect(c.get("a")).toBe(1);
    expect(c.get("b")).toBe(2);
    expect(c.get("missing")).toBeUndefined();
    expect(c.size).toBe(2);
  });

  it("holds up to max entries", () => {
    const c = boundedCache<string, number>(3);
    c.put("a", 1);
    c.put("b", 2);
    c.put("c", 3);
    expect(c.size).toBe(3);
    expect(c.get("a")).toBe(1);
  });

  it("evicts the oldest-inserted key when exceeding max", () => {
    const c = boundedCache<string, number>(3);
    c.put("a", 1);
    c.put("b", 2);
    c.put("c", 3);
    c.put("d", 4); // overflow → drop "a" (oldest)
    expect(c.size).toBe(3);
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe(2);
    expect(c.get("d")).toBe(4);
  });

  it("evicts in insertion order across multiple overflows", () => {
    const c = boundedCache<string, number>(2);
    c.put("a", 1);
    c.put("b", 2);
    c.put("c", 3); // drop a
    c.put("d", 4); // drop b
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBeUndefined();
    expect(c.get("c")).toBe(3);
    expect(c.get("d")).toBe(4);
  });

  it("clear() empties the cache", () => {
    const c = boundedCache<string, number>(3);
    c.put("a", 1);
    c.put("b", 2);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.get("a")).toBeUndefined();
  });

  it("updating an existing key does not grow size past its entry", () => {
    const c = boundedCache<string, number>(3);
    c.put("a", 1);
    c.put("a", 2);
    expect(c.get("a")).toBe(2);
    expect(c.size).toBe(1);
  });
});
