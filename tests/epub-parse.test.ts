import { describe, it, expect } from "vitest";
import {
  epubRootfilePath,
  parseOpf,
  epubTocSource,
  parseNavToc,
  parseNcxToc,
  resolveEntryHref,
  hasContentEncryption,
  epubRenditionLayout,
  epubOpenErrorMessage,
  chapterIndexForMessage,
  entryDir,
} from "../src/chrome/viewer/epub-parse";

// Stage F1 (_workspace/01_architect_plan_epub.md) — the pure parsing layer,
// backend-independent. Every fixture below is an inline XML/HTML string; no
// invoke, no DOM mount, no Tauri mock.

describe("epubRootfilePath", () => {
  it("returns the rootfile's full-path", () => {
    const xml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
    expect(epubRootfilePath(xml)).toBe("OEBPS/content.opf");
  });

  it("returns null when there is no rootfile", () => {
    const xml = `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles/></container>`;
    expect(epubRootfilePath(xml)).toBeNull();
  });

  it("returns null on malformed XML", () => {
    expect(epubRootfilePath("<not-xml")).toBeNull();
  });
});

describe("epubTocSource", () => {
  const parse = (xml: string) => new DOMParser().parseFromString(xml, "application/xml");

  it("prefers a manifest item with properties~=nav, even when an ncx also exists", () => {
    const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx"/>
</package>`;
    expect(epubTocSource(parse(opf))).toEqual({ kind: "nav", href: "nav.xhtml" });
  });

  it("falls back to spine[toc] -> ncx manifest item when no nav item exists", () => {
    const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx"/>
</package>`;
    expect(epubTocSource(parse(opf))).toEqual({ kind: "ncx", href: "toc.ncx" });
  });

  it("returns null when neither a nav item nor spine[toc] resolves", () => {
    const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine/>
</package>`;
    expect(epubTocSource(parse(opf))).toBeNull();
  });
});

describe("parseOpf", () => {
  it("resolves manifest hrefs to zip-entry paths and builds the spine in reading order", () => {
    const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="img" href="../shared/cover.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`;
    const pkg = parseOpf(opf, "OEBPS");
    expect(pkg.spine).toEqual(["OEBPS/text/ch1.xhtml", "OEBPS/text/ch2.xhtml"]);
    expect(pkg.manifest.find((m) => m.id === "img")?.entry).toBe("shared/cover.png");
    expect(pkg.tocSource).toEqual({ kind: "nav", href: "OEBPS/nav.xhtml" });
    expect(pkg.layout).toBe("reflowable");
  });

  it("drops a spine itemref whose idref has no manifest match, never throws", () => {
    const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <manifest><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="ch1"/><itemref idref="missing"/></spine>
</package>`;
    const pkg = parseOpf(opf, "");
    expect(pkg.spine).toEqual(["ch1.xhtml"]);
  });

  it("degrades to an empty tocless reflowable package on malformed XML", () => {
    const pkg = parseOpf("<not-xml", "OEBPS");
    expect(pkg).toEqual({ spine: [], manifest: [], tocSource: null, layout: "reflowable" });
  });
});

describe("epubRenditionLayout", () => {
  const parse = (xml: string) => new DOMParser().parseFromString(xml, "application/xml");

  it("detects pre-paginated", () => {
    const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <metadata><meta property="rendition:layout">pre-paginated</meta></metadata>
</package>`;
    expect(epubRenditionLayout(parse(opf))).toBe("pre-paginated");
  });

  it("defaults to reflowable when absent", () => {
    const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata/></package>`;
    expect(epubRenditionLayout(parse(opf))).toBe("reflowable");
  });
});

describe("parseNavToc", () => {
  it("parses nested toc entries with level and resolved href/fragment", () => {
    const nav = `<!DOCTYPE html>
<html xmlns:epub="http://www.idpf.org/2007/ops">
<body>
  <nav epub:type="toc">
    <ol>
      <li><a href="text/ch1.xhtml">Chapter 1</a>
        <ol>
          <li><a href="text/ch1.xhtml#s2">Section 2</a></li>
        </ol>
      </li>
      <li><a href="../back/notes.xhtml">Notes</a></li>
    </ol>
  </nav>
</body>
</html>`;
    const entries = parseNavToc(nav, "OEBPS/");
    expect(entries).toEqual([
      { level: 1, text: "Chapter 1", entry: "OEBPS/text/ch1.xhtml", fragment: null },
      { level: 2, text: "Section 2", entry: "OEBPS/text/ch1.xhtml", fragment: "s2" },
      { level: 1, text: "Notes", entry: "back/notes.xhtml", fragment: null },
    ]);
  });

  it("returns [] when there is no toc nav element", () => {
    const nav = `<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="landmarks"><ol><li><a href="x">x</a></li></ol></nav></body></html>`;
    expect(parseNavToc(nav, "")).toEqual([]);
  });
});

describe("parseNcxToc", () => {
  it("parses nested navPoints into the same EpubTocEntry shape as parseNavToc", () => {
    const ncx = `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/">
  <navMap>
    <navPoint id="np1">
      <navLabel><text>Chapter 1</text></navLabel>
      <content src="text/ch1.xhtml"/>
      <navPoint id="np1-1">
        <navLabel><text>Section 2</text></navLabel>
        <content src="text/ch1.xhtml#s2"/>
      </navPoint>
    </navPoint>
  </navMap>
</ncx>`;
    const entries = parseNcxToc(ncx, "OEBPS");
    expect(entries).toEqual([
      { level: 1, text: "Chapter 1", entry: "OEBPS/text/ch1.xhtml", fragment: null },
      { level: 2, text: "Section 2", entry: "OEBPS/text/ch1.xhtml", fragment: "s2" },
    ]);
  });

  it("returns [] on malformed XML or a missing navMap", () => {
    expect(parseNcxToc("<not-xml", "")).toEqual([]);
    expect(parseNcxToc(`<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"/>`, "")).toEqual([]);
  });
});

describe("resolveEntryHref", () => {
  it("resolves a relative href with .. segments and a fragment", () => {
    expect(resolveEntryHref("OEBPS/", "../images/x.png#top")).toEqual({ entry: "images/x.png", fragment: "top" });
  });

  it("resolves a same-directory href with no fragment", () => {
    expect(resolveEntryHref("OEBPS/text/", "ch2.xhtml")).toEqual({ entry: "OEBPS/text/ch2.xhtml", fragment: null });
  });

  it("treats a leading-slash href as zip-root-absolute, ignoring baseDir", () => {
    expect(resolveEntryHref("OEBPS/text/", "/META-INF/x.xml")).toEqual({ entry: "META-INF/x.xml", fragment: null });
  });

  it("decodes percent-encoded path and fragment", () => {
    expect(resolveEntryHref("", "a%20b.xhtml#se%C3%A7%C3%A3o")).toEqual({ entry: "a b.xhtml", fragment: "seção" });
  });
});

describe("hasContentEncryption", () => {
  it("returns false when only font-obfuscation algorithms are present (no over-reject)", () => {
    const xml = `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <EncryptedData>
    <EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
  </EncryptedData>
  <EncryptedData>
    <EncryptionMethod Algorithm="http://ns.adobe.com/pdf/enc#RC"/>
  </EncryptedData>
</encryption>`;
    expect(hasContentEncryption(xml)).toBe(false);
  });

  it("returns true when a real content-encryption algorithm is present", () => {
    const xml = `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <EncryptedData>
    <EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes256-cbc"/>
  </EncryptedData>
</encryption>`;
    expect(hasContentEncryption(xml)).toBe(true);
  });

  it("returns false on malformed XML (absence of encryption.xml is the caller's job, not this one's)", () => {
    expect(hasContentEncryption("<not-xml")).toBe(false);
  });
});

describe("epubRenditionLayout + epubOpenErrorMessage table", () => {
  it("maps every kind to its own korean message", () => {
    expect(epubOpenErrorMessage("drm")).toContain("DRM");
    expect(epubOpenErrorMessage("not-zip")).toContain("형식이 아닙니다");
    expect(epubOpenErrorMessage("no-rootfile")).toContain("container.xml");
    expect(epubOpenErrorMessage("corrupt")).toContain("손상된");
    expect(epubOpenErrorMessage("unknown")).toContain("알 수 없는");
  });
});

describe("chapterIndexForMessage", () => {
  const winA = {};
  const winB = {};
  const frames = [
    { origin: "epub://tok123", contentWindow: winA },
    { origin: "epub://tok123", contentWindow: winB },
  ];

  it("returns the matching frame's index when origin and source both match", () => {
    expect(chapterIndexForMessage({ origin: "epub://tok123", source: winB }, frames)).toBe(1);
  });

  it("returns null on an origin mismatch even if source matches some frame", () => {
    expect(chapterIndexForMessage({ origin: "epub://forged", source: winA }, frames)).toBeNull();
  });

  it("returns null on a source mismatch even if origin matches", () => {
    expect(chapterIndexForMessage({ origin: "epub://tok123", source: {} }, frames)).toBeNull();
  });
});

describe("entryDir", () => {
  it("returns the directory (with trailing slash) of a nested entry", () => {
    expect(entryDir("OEBPS/text/ch1.xhtml")).toBe("OEBPS/text/");
  });

  it("returns '' for a root-level entry", () => {
    expect(entryDir("content.opf")).toBe("");
  });
});
