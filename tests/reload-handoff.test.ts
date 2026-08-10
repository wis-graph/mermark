import { describe, expect, it } from "vitest";
import { createDocumentReloadUrl, readDocumentReloadHandoff } from "../src/workspace/reload-handoff";

describe("document reload handoff", () => {
  it("carries a Global Vault selection and Explorer root through a document reload", () => {
    const url = createDocumentReloadUrl("/A/B/doc.md", "/A/B");

    expect(url).toBe("index.html?file=%2FA%2FB%2Fdoc.md&vault=global&root=%2FA%2FB");
    expect(readDocumentReloadHandoff(url.slice(url.indexOf("?")))).toEqual({
      file: "/A/B/doc.md",
      globalExplorerRoot: "/A/B",
    });
  });

  it("leaves permanent-vault reloads without transient Global Vault intent", () => {
    const url = createDocumentReloadUrl("/P/doc.md", null);

    expect(url).toBe("index.html?file=%2FP%2Fdoc.md");
    expect(readDocumentReloadHandoff(url.slice(url.indexOf("?")))).toEqual({
      file: "/P/doc.md",
      globalExplorerRoot: null,
    });
  });
});
