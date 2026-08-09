import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync("src/main.ts", "utf8");

describe("main workspace/favorites wiring", () => {
  it("injects the live favorites section and toggle into the explorer", () => {
    expect(mainSource).toContain("isFavorite: (p) => isFavorite(favoriteFoldersSetting.get(), p)");
    expect(mainSource).toContain("onToggleFavorite: toggleFavorite");
    expect(mainSource).toContain("favoritesSlot: favoritesSection.el");
    expect(mainSource).toContain("focusFavorites: favoritesSection.focusFirst");
  });
});
